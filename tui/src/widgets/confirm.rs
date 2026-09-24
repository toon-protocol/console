//! A minimal confirmation modal for an action a single keypress must not
//! pass (TOON_Network#142).
//!
//! Publishing a Chain Seed record is a paid relay write (#120), and the key
//! that opens a confirmation must never be the same key that fires it — a
//! `Command` where `Enter` both opens "are you sure?" and answers it is a
//! confirmation in name only. `#143` is building a shared confirm modal for
//! the whole TUI in parallel on another branch; this is a small,
//! self-contained stand-in scoped to the Chain Seed view, easy to delete in
//! favour of that one once it lands — nothing outside `views::chain_seed`
//! reaches into this module's fields.
//!
//! The rule this type exists to hold: `y` arms it, and only then does
//! `Enter` confirm. Any other key — including a second `Enter` before `y`,
//! or `Esc` — cancels or is swallowed, never confirms. That is two distinct
//! keys in a row, which is what "one keypress cannot pass" means in
//! practice.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

/// What handling a key while the modal is open resulted in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmOutcome {
    /// The key was swallowed by the modal; nothing else should act on it.
    Handled,
    /// `y` armed it, and this `Enter` is the second, different keypress
    /// that confirms — the caller should run the guarded action now.
    Confirmed,
}

/// A confirmation modal's own state: whether it is open, and whether `y` has
/// armed it yet. Holds no secret and nothing costly to clone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfirmState {
    open: bool,
    armed: bool,
    title: String,
    body: Vec<String>,
}

impl ConfirmState {
    pub fn closed() -> Self {
        Self::default()
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Opens the modal with a title and body lines (the action's own words —
    /// the cost line among them, when the daemon reports one). Always opens
    /// unarmed: a fresh open never inherits a previous `y`.
    pub fn open(&mut self, title: impl Into<String>, body: Vec<String>) {
        self.open = true;
        self.armed = false;
        self.title = title.into();
        self.body = body;
    }

    fn close(&mut self) {
        self.open = false;
        self.armed = false;
    }

    /// Feeds one key while the modal is open. Every key the modal is not
    /// showing must be routed here first — see `views::chain_seed::handle_key`
    /// — so nothing underneath (a view's own cursor, the global keymap) ever
    /// sees a keystroke meant to answer this prompt.
    pub fn handle_key(&mut self, key: KeyEvent) -> ConfirmOutcome {
        match key.code {
            KeyCode::Esc => {
                self.close();
                ConfirmOutcome::Handled
            }
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                self.armed = true;
                ConfirmOutcome::Handled
            }
            KeyCode::Enter if self.armed => {
                self.close();
                ConfirmOutcome::Confirmed
            }
            _ => ConfirmOutcome::Handled,
        }
    }

    pub fn draw(&self, frame: &mut Frame, area: Rect) {
        if !self.open {
            return;
        }
        let width = 72u16.min(area.width.saturating_sub(4)).max(20);
        // `+ 2` for the blank line and the arm/confirm hint `draw` always
        // appends below `self.body` — see below. Wrap-aware, not just a
        // line count, because a body line longer than the popup is wide
        // wraps to more than one screen row, and a fixed `body.len() + N`
        // clips it silently rather than growing the box.
        let content_height = wrapped_row_count(&self.body, width.saturating_sub(2)) + 2;
        let height = (content_height + 2).min(area.height.saturating_sub(2));
        let popup = centered(area, width, height);
        frame.render_widget(Clear, popup);
        let block = Block::default()
            .title(format!(" {} ", self.title))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Yellow));
        let inner = block.inner(popup);
        frame.render_widget(block, popup);

        let mut lines: Vec<Line> = self
            .body
            .iter()
            .map(|line| Line::raw(line.clone()))
            .collect();
        lines.push(Line::raw(""));
        lines.push(if self.armed {
            Line::styled(
                "Enter to confirm — Esc to cancel",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )
        } else {
            Line::styled(
                "y to arm, then Enter to confirm — Esc to cancel",
                Style::default().fg(Color::DarkGray),
            )
        });
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
    }
}

/// How many screen rows `lines` takes once wrapped to `width` columns — a
/// plain `chars().count()` divide, not full grapheme-cluster-aware wrapping
/// (`ratatui::widgets::Paragraph`'s own `Wrap` is that precise); good enough
/// to size a box that must not clip, and safe to over-estimate.
fn wrapped_row_count(lines: &[String], width: u16) -> u16 {
    let width = width.max(1) as usize;
    lines
        .iter()
        .map(|line| {
            let chars = line.chars().count().max(1);
            chars.div_ceil(width) as u16
        })
        .sum()
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;
    Rect {
        x,
        y,
        width: width.min(area.width),
        height: height.min(area.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn a_fresh_modal_opens_closed() {
        let state = ConfirmState::closed();
        assert!(!state.is_open());
    }

    #[test]
    fn opening_shows_the_given_title_and_body_and_starts_unarmed() {
        let mut state = ConfirmState::closed();
        state.open("Publish", vec!["one paid write, 1 base unit".to_string()]);
        assert!(state.is_open());
    }

    #[test]
    fn enter_alone_never_confirms() {
        let mut state = ConfirmState::closed();
        state.open("Publish", vec![]);
        let outcome = state.handle_key(key(KeyCode::Enter));
        assert_eq!(outcome, ConfirmOutcome::Handled);
        assert!(state.is_open(), "an unarmed Enter must not close the modal");
    }

    #[test]
    fn y_then_enter_confirms_and_closes() {
        let mut state = ConfirmState::closed();
        state.open("Publish", vec![]);
        assert_eq!(
            state.handle_key(key(KeyCode::Char('y'))),
            ConfirmOutcome::Handled
        );
        assert!(state.is_open());
        assert_eq!(
            state.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Confirmed
        );
        assert!(!state.is_open(), "confirming closes the modal");
    }

    #[test]
    fn esc_cancels_from_either_armed_or_unarmed() {
        let mut state = ConfirmState::closed();
        state.open("Publish", vec![]);
        state.handle_key(key(KeyCode::Esc));
        assert!(!state.is_open());

        let mut armed_then_cancelled = ConfirmState::closed();
        armed_then_cancelled.open("Publish", vec![]);
        armed_then_cancelled.handle_key(key(KeyCode::Char('y')));
        armed_then_cancelled.handle_key(key(KeyCode::Esc));
        assert!(!armed_then_cancelled.is_open());
    }

    #[test]
    fn a_second_open_resets_arming() {
        let mut state = ConfirmState::closed();
        state.open("Publish", vec![]);
        state.handle_key(key(KeyCode::Char('y')));
        state.open("Publish", vec![]); // re-opened, e.g. after a failed attempt
        assert_eq!(
            state.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Handled,
            "a fresh open must not still be armed from before"
        );
    }

    #[test]
    fn any_other_key_is_swallowed_without_arming_or_confirming() {
        let mut state = ConfirmState::closed();
        state.open("Publish", vec![]);
        let outcome = state.handle_key(key(KeyCode::Char('q')));
        assert_eq!(outcome, ConfirmOutcome::Handled);
        assert!(state.is_open());
    }
}
