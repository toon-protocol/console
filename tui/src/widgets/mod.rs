//! Small, reusable pieces of UI shared by more than one view.
//!
//! `input` is the first of these (#141): a masked, zeroizing text field.
//! #142's Chain Seed import and #146's New workload form reuse it rather
//! than growing their own.
//!
//! `confirm` (#142) is a minimal two-key confirmation modal for an action a
//! single keypress must not reach — publishing a Chain Seed is a paid relay
//! write. #143 is building a shared confirm modal for the whole TUI in
//! parallel on another branch; this one is scoped to the view that needs it
//! now and is meant to be swapped for that one once it lands.

pub mod confirm;
pub mod input;
