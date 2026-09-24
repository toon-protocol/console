//! Small, reusable pieces of UI shared by more than one view.
//!
//! - `input`   — a masked, zeroizing text field (#141). #142's Chain Seed
//!   import and #146's New workload form reuse it rather than growing their
//!   own.
//! - `list`    — a filterable, `j`/`k`-navigable list's pure state machine
//!   (#143).
//! - `confirm` — a confirmation modal that one keypress cannot pass (#143):
//!   typed `yes` + Enter, generic over the action it carries out. #144's
//!   auto-extend/rotate/gateway actions, #142's Chain Seed publish and
//!   #147's Funds spending routes all reuse this one rather than their own.

pub mod confirm;
pub mod input;
pub mod list;
