//! Small, reusable pieces of UI shared by more than one view.
//!
//! `input` is the first of these (#141): a masked, zeroizing text field.
//! #142's Chain Seed import and #146's New workload form reuse it rather
//! than growing their own.

pub mod input;
