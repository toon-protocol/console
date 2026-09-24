//! End-to-end coverage of the 401-then-reread contract from the issue:
//! "On a 401 it re-reads the record, which covers a daemon that restarted."
//!
//! A tiny hand-rolled HTTP/1.1 server stands in for the daemon — enough to
//! read a request line and an `Authorization` header and answer 401 or 200,
//! which is all `DaemonClient` needs from it. No new dependency for this:
//! the real behaviour under test is entirely inside `DaemonClient::get`.
//!
//! Every read and write here goes through `tokio::io`, never `std::io`'s
//! blocking calls — `#[tokio::test]` defaults to a single-thread runtime, and
//! a blocking syscall on that thread would stall the client's own request
//! future alongside it (there is no second thread for either to run on).

use std::net::TcpListener;
use std::path::PathBuf;

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;

use toon_console_tui::client::{ClientError, DaemonClient};

#[derive(Debug, Deserialize, PartialEq)]
struct Pong {
    ok: bool,
}

/// Accepts connections forever (until the listener is dropped by the test
/// ending) and answers based on the presented bearer token: `accepted_token`
/// gets 200 `{"ok":true}`, anything else gets 401.
fn spawn_stub_daemon(accepted_token: &'static str) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let async_listener = tokio::net::TcpListener::from_std(listener).unwrap();

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = async_listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let request = read_request(&mut stream).await;
                let authorized = request.to_ascii_lowercase().contains(
                    &format!("authorization: bearer {accepted_token}").to_ascii_lowercase(),
                );
                let body = if authorized {
                    "{\"ok\":true}"
                } else {
                    "{\"message\":\"unauthorized\"}"
                };
                let status = if authorized {
                    "200 OK"
                } else {
                    "401 Unauthorized"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (url, handle)
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
    let mut buf = [0u8; 4096];
    let mut text = String::new();
    loop {
        let read = stream.read(&mut buf).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        text.push_str(&String::from_utf8_lossy(&buf[..read]));
        if text.contains("\r\n\r\n") {
            break;
        }
    }
    text
}

fn write_record(path: &std::path::Path, url: &str, token: &str) {
    std::fs::write(
        path,
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
}

#[tokio::test]
async fn a_401_re_reads_the_record_and_succeeds_on_the_daemons_new_token() {
    let (url, _server) = spawn_stub_daemon("new-token");
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");

    // The client is built holding the OLD token — as if it read the record
    // before the daemon restarted and minted a new one.
    write_record(&path, &url, "old-token");
    let client = DaemonClient::connect(path.clone()).await.unwrap();

    // The daemon already restarted by the time the client asks: the record on
    // disk now names the token the stub actually accepts.
    write_record(&path, &url, "new-token");

    let pong: Pong = client.get("/pong").await.unwrap();
    assert_eq!(pong, Pong { ok: true });
}

#[tokio::test]
async fn a_401_that_survives_a_reread_is_reported_as_unauthorized_not_retried_forever() {
    let (url, _server) = spawn_stub_daemon("only-this-token-works");
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");

    write_record(&path, &url, "wrong-token");
    let client = DaemonClient::connect(path).await.unwrap();
    // Nothing rewrites the record this time: the token was simply wrong.

    let result: Result<Pong, ClientError> = client.get("/pong").await;
    match result {
        Err(ClientError::Unauthorized) => {}
        other => panic!("expected Unauthorized, got {other:?}"),
    }
}

/// The same 401-then-reread contract, exercised through `post` — added for
/// TOON_Network#141, which is the first ticket to post a body (sign-in,
/// sign-out, a profile switch) rather than only ever reading, and confirmed
/// again by TOON_Network#147's spending routes (opening a channel, buying
/// gas). `send` in `client.rs` is the one place this retry lives; this
/// proves it applies to every verb, not only `get`.
#[tokio::test]
async fn a_401_re_reads_the_record_and_retries_a_post_on_the_daemons_new_token() {
    let (url, _server) = spawn_stub_daemon("new-token");
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");

    write_record(&path, &url, "old-token");
    let client = DaemonClient::connect(path.clone()).await.unwrap();
    write_record(&path, &url, "new-token");

    let pong: Pong = client
        .post("/pong", &serde_json::json!({ "id": "whatever" }))
        .await
        .unwrap();
    assert_eq!(pong, Pong { ok: true });
}
