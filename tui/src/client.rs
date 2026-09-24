//! Talking to the daemon.
//!
//! One rule above the others: **the token is never logged, printed or
//! written anywhere by this module.** It lives in the `LaunchRecord` this
//! holds and in one `Authorization` header per request, and nowhere else —
//! not in a `Debug` impl reachable from a log line, not in an error message.
//!
//! A restarted daemon mints a new token, so a request can fail with 401 for a
//! reason that has nothing to do with anybody being wrong: the daemon simply
//! came back up since the record was last read. On a 401 this client re-reads
//! the record from disk and retries exactly once with whatever it finds —
//! which is either the new token (daemon restarted: the retry succeeds) or
//! the same token again (something else is wrong: the retry fails the same
//! way, and that failure is what the caller sees).

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::RwLock;

use crate::launch::{read_launch_record, LaunchError, LaunchRecord};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error(transparent)]
    Launch(#[from] LaunchError),
    #[error("the daemon at {url} did not answer: {reason}")]
    Unreachable { url: String, reason: String },
    /// A 401 survived a re-read-and-retry: the daemon is up, but this token
    /// is wrong and re-reading the record did not produce a better one.
    #[error("the daemon rejected this window's token even after re-reading the launch record")]
    Unauthorized,
    #[error("the daemon at {url} answered {status}: {body}")]
    Status {
        url: String,
        status: u16,
        body: String,
    },
    #[error("the daemon's answer was not the shape this build expects: {0}")]
    Decode(String),
}

pub struct DaemonClient {
    http: reqwest::Client,
    launch_file: PathBuf,
    record: RwLock<LaunchRecord>,
}

impl DaemonClient {
    /// Read the launch record once and build a client around it. Called at
    /// startup, after the caller has already handled `LaunchError::NotRunning`
    /// by showing the actionable message — this is the "we found it" path.
    pub async fn connect(launch_file: PathBuf) -> Result<Arc<Self>, LaunchError> {
        let record = read_launch_record(&launch_file)?;
        Ok(Arc::new(Self {
            http: reqwest::Client::new(),
            launch_file,
            record: RwLock::new(record),
        }))
    }

    /// The base URL this client is currently talking to, for the header bar.
    pub async fn base_url(&self) -> String {
        self.record.read().await.url.clone()
    }

    /// `GET <path>`, decoded as `T`. `path` is joined onto the record's `url`.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, ClientError> {
        self.send(Method::GET, path, None).await
    }

    /// `POST <path>` with a JSON body, decoded as `T`. Same 401-then-reread
    /// retry as `get` (via `send`) — a route that spends money (opening a
    /// channel, buying gas, TOON_Network#147) still answers 401 rather than
    /// doing anything the FIRST time a window holds a stale token, exactly
    /// like a read would.
    pub async fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, ClientError> {
        let value =
            serde_json::to_value(body).map_err(|err| ClientError::Decode(err.to_string()))?;
        self.send(Method::POST, path, Some(value)).await
    }

    /// `POST <path>` with no body (a sign-out, say), decoded as `T`.
    pub async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> Result<T, ClientError> {
        self.send(Method::POST, path, None).await
    }

    /// `DELETE <path>`, decoded as `T`.
    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T, ClientError> {
        self.send(Method::DELETE, path, None).await
    }

    /// One request, with the daemon's 401-then-restarted-daemon retry from
    /// this module's doc comment. Every public method above is this call
    /// with a fixed `Method` — the retry-on-401 contract lives here once,
    /// rather than once per verb.
    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, ClientError> {
        let first = self.try_send(method.clone(), path, body.as_ref()).await;
        match first {
            Err(ClientError::Status { status: 401, .. }) => {
                // Covers a daemon that restarted since we last read the
                // record: re-read it, and if the token actually changed,
                // retry once with the new one.
                let reread = read_launch_record(&self.launch_file)?;
                let changed = reread.token != self.record.read().await.token;
                *self.record.write().await = reread;
                if changed {
                    self.try_send(method, path, body.as_ref())
                        .await
                        .map_err(|err| match err {
                            ClientError::Status { status: 401, .. } => ClientError::Unauthorized,
                            other => other,
                        })
                } else {
                    Err(ClientError::Unauthorized)
                }
            }
            other => other,
        }
    }

    async fn try_send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<T, ClientError> {
        let (url, token) = {
            let record = self.record.read().await;
            (join_url(&record.url, path), record.token.clone())
        };
        let mut request = self.http.request(method, &url).bearer_auth(&token);
        if let Some(value) = body {
            request = request.json(value);
        }
        let response = request
            .send()
            .await
            .map_err(|err| ClientError::Unreachable {
                url: url.clone(),
                reason: err.to_string(),
            })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ClientError::Status {
                url,
                status: status.as_u16(),
                body: truncate(&body),
            });
        }
        response
            .json::<T>()
            .await
            .map_err(|err| ClientError::Decode(err.to_string()))
    }
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

/// A body in an error message is a debugging aid, not a transcript — and the
/// daemon's own error bodies are small, so a body worth truncating is
/// unexpected input, not a legitimate answer.
fn truncate(body: &str) -> String {
    const MAX: usize = 500;
    if body.len() <= MAX {
        body.to_string()
    } else {
        format!("{}…", &body[..MAX])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_record(dir: &std::path::Path, url: &str, token: &str) -> PathBuf {
        let path = dir.join("launch.json");
        fs::write(
            &path,
            serde_json::json!({
                "url": url,
                "token": token,
                "launchUrl": format!("{url}/?t={token}"),
                "pid": 1,
                "startedAt": "2026-09-24T00:00:00.000Z",
            })
            .to_string(),
        )
        .unwrap();
        path
    }

    #[tokio::test]
    async fn connect_surfaces_not_running_when_there_is_no_record() {
        // Not `.unwrap_err()`: that needs `T: Debug`, and `DaemonClient`
        // deliberately has no `Debug` impl (it would risk a token reaching a
        // log line through `{:?}` some day), so this matches instead.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("launch.json");
        match DaemonClient::connect(missing).await {
            Err(LaunchError::NotRunning) => {}
            Err(other) => panic!("expected NotRunning, got {other}"),
            Ok(_) => panic!("expected an error connecting to a missing launch file"),
        }
    }

    #[tokio::test]
    async fn join_url_never_double_slashes() {
        assert_eq!(
            join_url("http://127.0.0.1:7797", "/api/health"),
            "http://127.0.0.1:7797/api/health"
        );
        assert_eq!(
            join_url("http://127.0.0.1:7797/", "/api/health"),
            "http://127.0.0.1:7797/api/health"
        );
    }

    #[tokio::test]
    async fn base_url_reflects_the_record_it_was_built_from() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_record(dir.path(), "http://127.0.0.1:7797", "tok");
        let client = DaemonClient::connect(path).await.unwrap();
        assert_eq!(client.base_url().await, "http://127.0.0.1:7797");
    }

    // A live re-read-on-401 round trip against a real daemon is covered by
    // `client_reread.rs`, which starts a tiny HTTP server of its own so the
    // 401-then-restart sequence is exercised end to end without depending on
    // the Node daemon being built.
}
