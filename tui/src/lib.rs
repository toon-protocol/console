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
//! - `widgets::*`— small reusable UI pieces shared by more than one view.
//! - `format`    — small display formatters shared by views.
//! - `markdown`  — Markdown -> ratatui `Text`, for the Docs view.
//! - `clipboard` — `wl-copy`, or a message saying it is not there.
//! - `confirm`   — a minimal confirm-before-spending modal (TOON_Network#147).

pub mod app;
pub mod client;
pub mod clipboard;
pub mod confirm;
pub mod desktop;
pub mod format;
pub mod launch;
pub mod markdown;
pub mod types;
pub mod ui;
pub mod views;
pub mod widgets;
