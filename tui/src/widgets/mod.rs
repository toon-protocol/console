//! Reusable pieces shared across views (TOON_Network#143 built these for the
//! Workloads view; #144, #145, #146 and #147 reuse them from their own
//! views).
//!
//! - `list`   — a filterable, `j`/`k`-navigable list's pure state machine.
//! - `confirm` — a confirmation modal that one keypress cannot pass.

pub mod confirm;
pub mod list;
