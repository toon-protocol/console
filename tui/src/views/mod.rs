//! One module per view (ADR 0028's sidebar), so parallel tickets touch
//! distinct files. `tui/README.md` says how to add one.

pub mod account;
pub mod chain_seed;
pub mod directory;
pub mod docs;
pub mod funds;
pub mod health;
pub mod network;
pub mod new_workload;
pub mod placeholder;
pub mod workloads;
