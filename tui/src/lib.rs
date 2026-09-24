//! The TOON Console TUI's library surface, so both `main.rs` and the
//! `tests/` integration tests can reach every module.
//!
//! Module layout, for later view tickets:
//! - `app`       — `View`, `App`, the keymap (`handle_key`, `handle_mouse`).
//! - `client`    — `DaemonClient`: the one place an HTTP request is made.
//! - `launch`    — the launch-record reader.
//! - `types`     — hand-kept API types, mirroring `packages/ui/src/lib/daemon.ts`.
//! - `desktop`   — the `/api/desktop` long poll.
//! - `ui`        — the shell (header, sidebar, footer, help overlay).
//! - `views::*`  — one module per sidebar view.
//! - `format`    — small display formatters shared by views.

pub mod app;
pub mod client;
pub mod desktop;
pub mod format;
pub mod launch;
pub mod types;
pub mod ui;
pub mod views;
