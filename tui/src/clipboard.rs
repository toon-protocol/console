//! Copying access details to the clipboard (TOON_Network#143's `y`), the
//! Omarchy way: `wl-copy` when it is there, a plain message saying so when it
//! is not — never a shell, so nothing typed into a workload's own access
//! details (a hostname, an SSH command) is ever interpreted as shell syntax.
//!
//! `copy_with` takes the program to run rather than always spawning literally
//! `"wl-copy"` by name, which is what lets the tests below exercise both the
//! "found and it worked" and "not found" paths without touching `$PATH` — a
//! test that mutated the process's real environment would be a test that
//! could flake next to any other test spawning a child process in parallel.

use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardOutcome {
    Copied,
    /// The program named could not be found. The message says so plainly —
    /// no attempt to guess an install command for whatever this machine is.
    Unavailable(String),
    Failed(String),
}

pub fn copy(text: &str) -> ClipboardOutcome {
    copy_with("wl-copy", text)
}

pub fn copy_with(program: impl AsRef<std::ffi::OsStr>, text: &str) -> ClipboardOutcome {
    let mut child = match spawn_retrying_text_busy(program.as_ref()) {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return ClipboardOutcome::Unavailable(
                "wl-copy is not installed, so this could not be copied automatically.".to_string(),
            );
        }
        Err(err) => return ClipboardOutcome::Failed(err.to_string()),
    };

    if let Some(stdin) = child.stdin.as_mut() {
        if let Err(err) = stdin.write_all(text.as_bytes()) {
            return ClipboardOutcome::Failed(err.to_string());
        }
    }
    // Drop stdin explicitly (closing the pipe) before waiting: `wl-copy`
    // forks a background process that outlives this one to hold the
    // selection, and it only does that once it has read EOF.
    drop(child.stdin.take());

    match child.wait() {
        Ok(status) if status.success() => ClipboardOutcome::Copied,
        Ok(status) => ClipboardOutcome::Failed(format!("exited with {status}")),
        Err(err) => ClipboardOutcome::Failed(err.to_string()),
    }
}

/// `ETXTBSY` ("Text file busy", raw OS error 26 on Linux) is a real, if rare,
/// `fork`+`exec` race: another thread in this same multi-threaded process can
/// hold the target executable open for writing for a moment even after its
/// own `File` has been dropped, because `fork()` duplicates the whole
/// process's file descriptor table at the instant it runs — see
/// rust-lang/rust#114554. It is transient by nature, so a couple of retries a
/// few milliseconds apart resolve it without this module needing to know
/// which thread was in the way.
fn spawn_retrying_text_busy(program: &std::ffi::OsStr) -> std::io::Result<std::process::Child> {
    const ATTEMPTS: u32 = 5;
    let mut last_err = None;
    for attempt in 0..ATTEMPTS {
        match Command::new(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(err) if err.raw_os_error() == Some(26) && attempt + 1 < ATTEMPTS => {
                std::thread::sleep(std::time::Duration::from_millis(5));
                last_err = Some(err);
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_err.expect("loop always sets last_err before falling through"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn fake_program(dir: &std::path::Path, name: &str, script: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn a_missing_program_is_reported_as_unavailable_not_failed() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("this-does-not-exist-anywhere");
        match copy_with(missing, "hello") {
            ClipboardOutcome::Unavailable(message) => {
                assert!(message.contains("not installed"));
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn a_program_that_reads_stdin_and_exits_0_reports_copied() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_program(dir.path(), "fake-wl-copy", "cat > /dev/null\nexit 0");
        assert_eq!(
            copy_with(program, "ssh -p 22 tenant@host"),
            ClipboardOutcome::Copied
        );
    }

    #[test]
    fn a_program_that_exits_nonzero_reports_failed() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_program(dir.path(), "fake-wl-copy-broken", "cat > /dev/null\nexit 1");
        match copy_with(program, "hello") {
            ClipboardOutcome::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
