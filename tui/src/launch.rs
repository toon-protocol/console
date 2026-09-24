//! Where the TUI finds the daemon.
//!
//! The daemon mints a fresh token on every launch and writes it, with the URL
//! it bound, to a JSON record in the runtime directory — the one place a
//! process belonging to this login session can read without being handed
//! anything (`packages/daemon/src/launch-token.ts`, `paths.ts`). This module
//! is the Rust side of the same contract: same path, same shape, same
//! never-log-the-token rule.
//!
//! The path logic mirrors `consolePaths` in `packages/daemon/src/paths.ts`
//! exactly (XDG, with the same fallback), so a daemon and a TUI started in the
//! same session always agree on where the record lives.

use std::env;
use std::path::PathBuf;

use serde::Deserialize;

const APP: &str = "toon-console";

/// The record the daemon writes. Field names match `LaunchRecord` in
/// `packages/daemon/src/launch-token.ts` byte for byte, via `serde`'s
/// `camelCase` rename — this struct is never constructed by hand outside
/// tests, only deserialized.
///
/// `Debug` is hand-written, not derived, and redacts `token` — a `{:?}` of
/// this struct reaching a log line by accident must not be the thing that
/// leaks the launch token.
#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct LaunchRecord {
    /// The base URL the daemon is serving on, with no token in it.
    pub url: String,
    /// The secret this process presents on every API call. Never logged,
    /// printed or written anywhere by this crate.
    pub token: String,
    #[serde(rename = "launchUrl")]
    pub launch_url: String,
    pub pid: i64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

impl std::fmt::Debug for LaunchRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchRecord")
            .field("url", &self.url)
            .field("token", &"<redacted>")
            .field("launch_url", &"<redacted>")
            .field("pid", &self.pid)
            .field("started_at", &self.started_at)
            .finish()
    }
}

/// A relative XDG variable is invalid per spec and is ignored, exactly like
/// `paths.ts`'s `xdg()`.
fn xdg_abs(value: Option<String>) -> Option<PathBuf> {
    value.filter(|v| v.starts_with('/')).map(PathBuf::from)
}

/// `$XDG_RUNTIME_DIR/toon-console`, falling back to the data directory the
/// same way the daemon does, so the two agree even on a machine with no
/// `XDG_RUNTIME_DIR` (a container, some display managers).
///
/// The fallback really does end in `toon-console/toon-console` — `paths.ts`
/// builds its data dir as `<XDG_DATA_HOME or ~/.local/share>/toon-console`
/// and then, with no runtime dir, joins `toon-console` onto THAT again for
/// the runtime path. Looks like a bug; is not one to fix here, because the
/// daemon writes `launch.json` at exactly this doubled path when it falls
/// back the same way, and disagreeing with it would mean never finding the
/// record on such a machine.
pub fn runtime_dir_from_env<F>(get: F) -> PathBuf
where
    F: Fn(&str) -> Option<String>,
{
    let home = get("HOME").unwrap_or_else(|| "/".to_string());
    let data_fallback = xdg_abs(get("XDG_DATA_HOME"))
        .unwrap_or_else(|| PathBuf::from(&home).join(".local").join("share"))
        .join(APP);
    let runtime_base = xdg_abs(get("XDG_RUNTIME_DIR")).unwrap_or(data_fallback);
    runtime_base.join(APP)
}

pub fn runtime_dir() -> PathBuf {
    runtime_dir_from_env(|key| env::var(key).ok())
}

/// The file the daemon writes so a launcher — or this TUI — can find it.
pub fn launch_file_path() -> PathBuf {
    runtime_dir().join("launch.json")
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    /// No record on disk at all: the daemon has never started, or it is not
    /// running right now. The message is what the TUI shows instead of a
    /// blank screen — actionable, with the exact `journalctl` command.
    #[error(
        "the TOON Console daemon is not running.\n\nStart it with:\n  systemctl --user start toon-console.service\n\nIf it will not start, see:\n  journalctl --user -u toon-console.service"
    )]
    NotRunning,
    #[error("the launch record at {path} is not valid JSON: {source}")]
    Malformed {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("could not read the launch record at {path}: {source}")]
    Unreadable {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// Read and parse the launch record at `path`.
///
/// A missing file is folded into `LaunchError::NotRunning` regardless of the
/// underlying `io::Error` kind (not just `NotFound`) — WSL and some overlay
/// filesystems report a missing parent directory as `PermissionDenied` or
/// `Other`, and every one of those means the same thing to a person: the
/// daemon has not written a record here, so open it and see.
pub fn read_launch_record(path: &std::path::Path) -> Result<LaunchRecord, LaunchError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(source) => {
            if source.kind() == std::io::ErrorKind::NotFound {
                return Err(LaunchError::NotRunning);
            }
            // A directory that does not exist yet also means "not running".
            if path.parent().is_some_and(|parent| !parent.exists()) {
                return Err(LaunchError::NotRunning);
            }
            return Err(LaunchError::Unreadable {
                path: path.display().to_string(),
                source,
            });
        }
    };
    serde_json::from_str(&text).map_err(|source| LaunchError::Malformed {
        path: path.display().to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &std::path::Path, body: &str) -> PathBuf {
        let path = dir.join("launch.json");
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn reads_a_well_formed_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            r#"{
              "url": "http://127.0.0.1:7797",
              "token": "secret-token",
              "launchUrl": "http://127.0.0.1:7797/?t=secret-token",
              "pid": 4242,
              "startedAt": "2026-09-24T00:00:00.000Z"
            }"#,
        );
        let record = read_launch_record(&path).unwrap();
        assert_eq!(record.url, "http://127.0.0.1:7797");
        assert_eq!(record.token, "secret-token");
        assert_eq!(record.pid, 4242);
    }

    #[test]
    fn a_missing_file_is_reported_as_not_running_with_the_journalctl_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent").join("launch.json");
        let err = read_launch_record(&path).unwrap_err();
        assert!(matches!(err, LaunchError::NotRunning));
        let message = err.to_string();
        assert!(message.contains("journalctl --user -u toon-console.service"));
        assert!(message.contains("systemctl --user start toon-console.service"));
    }

    #[test]
    fn malformed_json_is_its_own_error_and_not_confused_with_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "not json");
        let err = read_launch_record(&path).unwrap_err();
        assert!(matches!(err, LaunchError::Malformed { .. }));
    }

    #[test]
    fn the_error_message_never_contains_a_token() {
        // A record NEVER appears in an error message: reading one that parses
        // fine returns Ok, and every Err path here is built from a path or a
        // parse error, never from the record's fields. This test pins that by
        // construction — grepping the source of `LaunchError` finds no
        // `record.token` anywhere near a `format!` or `#[error(...)]`.
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "not json at all, token-shaped-ish: abc123");
        let err = read_launch_record(&path).unwrap_err();
        assert!(!err.to_string().contains("abc123"));
    }

    #[test]
    fn runtime_dir_prefers_xdg_runtime_dir() {
        let dir = runtime_dir_from_env(|key| match key {
            "XDG_RUNTIME_DIR" => Some("/run/user/1000".to_string()),
            "HOME" => Some("/home/tester".to_string()),
            _ => None,
        });
        assert_eq!(dir, PathBuf::from("/run/user/1000/toon-console"));
    }

    #[test]
    fn runtime_dir_ignores_a_relative_xdg_runtime_dir() {
        let dir = runtime_dir_from_env(|key| match key {
            "XDG_RUNTIME_DIR" => Some("relative/path".to_string()),
            "HOME" => Some("/home/tester".to_string()),
            _ => None,
        });
        // Falls all the way through to the data-dir fallback, same as
        // `runtime_dir_falls_back_to_xdg_data_home_then_home` below — see
        // that test for why `toon-console` appears twice.
        assert_eq!(
            dir,
            PathBuf::from("/home/tester/.local/share/toon-console/toon-console")
        );
    }

    #[test]
    fn debug_formatting_a_launch_record_never_shows_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            r#"{
              "url": "http://127.0.0.1:7797",
              "token": "super-secret-token",
              "launchUrl": "http://127.0.0.1:7797/?t=super-secret-token",
              "pid": 1,
              "startedAt": "2026-09-24T00:00:00.000Z"
            }"#,
        );
        let record = read_launch_record(&path).unwrap();
        let debugged = format!("{record:?}");
        assert!(!debugged.contains("super-secret-token"));
    }

    #[test]
    fn runtime_dir_falls_back_to_xdg_data_home_then_home() {
        // `paths.ts`'s `consolePaths` (which this mirrors byte for byte) sets
        // `data = join(XDG_DATA_HOME ?? ~/.local/share, APP)` and, with no
        // `XDG_RUNTIME_DIR`, `runtime = join(runtimeBase = data, APP)` — so
        // the fallback path really does end in `toon-console/toon-console`.
        // A daemon on a machine with no `XDG_RUNTIME_DIR` writes its
        // `launch.json` there, so the TUI has to look in the same place.
        let with_data_home = runtime_dir_from_env(|key| match key {
            "XDG_DATA_HOME" => Some("/srv/data".to_string()),
            "HOME" => Some("/home/tester".to_string()),
            _ => None,
        });
        assert_eq!(
            with_data_home,
            PathBuf::from("/srv/data/toon-console/toon-console")
        );

        let with_home_only = runtime_dir_from_env(|key| match key {
            "HOME" => Some("/home/tester".to_string()),
            _ => None,
        });
        assert_eq!(
            with_home_only,
            PathBuf::from("/home/tester/.local/share/toon-console/toon-console")
        );
    }
}
