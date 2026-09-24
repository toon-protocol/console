//! `wl-copy`, or a message saying it is not there (ADR 0028's shell is
//! Omarchy/Wayland-first; there is no X11 fallback here).
//!
//! Run with `std::process::Command` directly — never through a shell — and
//! the text is written to the child's stdin rather than passed as an
//! argument, so an address or a quote id with an unusual byte in it is never
//! parsed as a shell word in the first place.

use std::io::Write;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardResult {
    Copied,
    /// `wl-copy` is not on `PATH` — not an error, just a fact with a
    /// fallback: the value is still shown on screen to copy by hand.
    Unavailable(String),
    Failed(String),
}

/// Copies `text` with `wl-copy`.
pub fn copy(text: &str) -> ClipboardResult {
    copy_with(text, "wl-copy")
}

/// `copy`, with the binary name overridable — the seam the tests use to
/// exercise the "not found" path without depending on whether this machine
/// actually has `wl-copy` installed.
fn copy_with(text: &str, program: &str) -> ClipboardResult {
    let mut child = match Command::new(program)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return ClipboardResult::Unavailable(format!(
                "{program} is not installed — copy this by hand"
            ));
        }
        Err(err) => return ClipboardResult::Failed(err.to_string()),
    };

    if let Some(stdin) = child.stdin.as_mut() {
        if let Err(err) = stdin.write_all(text.as_bytes()) {
            return ClipboardResult::Failed(err.to_string());
        }
    }

    match child.wait() {
        Ok(status) if status.success() => ClipboardResult::Copied,
        Ok(status) => ClipboardResult::Failed(format!("{program} exited with {status}")),
        Err(err) => ClipboardResult::Failed(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_binary_is_reported_as_unavailable_not_an_error() {
        let result = copy_with("hello", "definitely-not-a-real-binary-toon-console-tui");
        assert_eq!(
            result,
            ClipboardResult::Unavailable(
                "definitely-not-a-real-binary-toon-console-tui is not installed — copy this by hand"
                    .to_string()
            )
        );
    }

    #[test]
    fn copying_through_a_real_program_succeeds() {
        // `cat` reads stdin and exits 0 without a shell — proof the spawn,
        // the stdin write and the exit-status check all work, without
        // depending on `wl-copy` (or any clipboard) being installed here.
        assert_eq!(copy_with("some text", "cat"), ClipboardResult::Copied);
    }

    #[test]
    fn a_program_that_exits_non_zero_is_reported_as_failed() {
        match copy_with("x", "false") {
            ClipboardResult::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
