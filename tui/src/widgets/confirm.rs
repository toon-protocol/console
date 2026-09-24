//! A confirmation modal that one keypress cannot pass (ADR 0028, spec §6.6,
//! `docs/agents`'s note on destructive/spending actions).
//!
//! Every destructive or spending action in this console — extend, terminate,
//! rotate, a gateway handover or withdrawal, opening a channel, buying gas —
//! asks first, and the web UI's own rule for "asks" is two presses where the
//! second names what it did (`workload-card.tsx`'s `Actions`: pressing
//! **Terminate** shows **Yes — destroy this workload** and **Keep it**, not a
//! second `Terminate`). This widget is that rule as a keyboard state machine:
//! the key that opens a confirmation is never the key that carries it out,
//! and carrying it out additionally takes typing the word `yes` — so neither
//! a repeated action key nor a stray `Enter` can complete it by accident.
//!
//! Generic over `A`, the action to run once confirmed, so #144 (auto-extend,
//! rotate, gateway), #145 (directory), #146 (new workload) and #147 (funds)
//! each bring their own small action type and reuse this exact behaviour and
//! rendering.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crossterm::event::{KeyCode, KeyEvent};

#[derive(Debug, Clone)]
pub struct Confirm<A> {
    pub title: String,
    /// What it costs or what it ends — shown above the prompt, verbatim.
    pub lines: Vec<String>,
    pub action: A,
    typed: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmOutcome<A> {
    /// Still open; a keystroke was consumed (typed into the confirmation
    /// word, or an `Enter` that did not yet spell `yes`).
    Pending,
    Cancelled,
    Confirmed(A),
}

const CONFIRM_WORD: &str = "yes";

impl<A> Confirm<A> {
    pub fn new(title: impl Into<String>, lines: Vec<String>, action: A) -> Self {
        Self {
            title: title.into(),
            lines,
            action,
            typed: String::new(),
        }
    }

    pub fn typed(&self) -> &str {
        &self.typed
    }
}

impl<A: Clone> Confirm<A> {
    /// Every key while a confirmation is open is consumed here — nothing
    /// (view switching, quitting, `?` help) leaks through while a person is
    /// mid-way through confirming something that spends money or destroys a
    /// workload.
    pub fn handle_key(&mut self, key: KeyEvent) -> ConfirmOutcome<A> {
        match key.code {
            KeyCode::Esc => ConfirmOutcome::Cancelled,
            KeyCode::Enter => {
                if self.typed.eq_ignore_ascii_case(CONFIRM_WORD) {
                    ConfirmOutcome::Confirmed(self.action.clone())
                } else {
                    ConfirmOutcome::Pending
                }
            }
            KeyCode::Backspace => {
                self.typed.pop();
                ConfirmOutcome::Pending
            }
            KeyCode::Char(c) => {
                self.typed.push(c);
                ConfirmOutcome::Pending
            }
            _ => ConfirmOutcome::Pending,
        }
    }
}

pub fn draw<A>(frame: &mut Frame, area: Rect, confirm: &Confirm<A>) {
    let width = 60u16.min(area.width.saturating_sub(4)).max(20);
    let body_lines = confirm.lines.len() as u16;
    let height = (body_lines + 6).min(area.height.saturating_sub(2));
    let popup = centered(area, width, height);
    frame.render_widget(Clear, popup);

    let block = Block::default()
        .title(format!(" {} ", confirm.title))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let mut lines: Vec<Line> = confirm
        .lines
        .iter()
        .map(|line| Line::from(line.clone()))
        .collect();
    lines.push(Line::raw(""));
    lines.push(Line::from(vec![
        Span::styled("Type ", Style::default().fg(Color::DarkGray)),
        Span::styled(
            "yes",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            " and press Enter to confirm. Esc cancels.",
            Style::default().fg(Color::DarkGray),
        ),
    ]));
    lines.push(Line::from(vec![
        Span::raw("> "),
        Span::styled(
            confirm.typed().to_string(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled("\u{2588}", Style::default().fg(Color::DarkGray)),
    ]));

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
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
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn enter_alone_does_not_confirm() {
        let mut confirm = Confirm::new("Terminate", vec!["Ends now.".to_string()], "terminate");
        assert_eq!(
            confirm.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Pending
        );
    }

    #[test]
    fn the_opening_key_pressed_again_does_not_confirm() {
        // The regression this widget exists to prevent: pressing `x` twice
        // (once to open, once more by reflex) must not terminate anything.
        let mut confirm = Confirm::new("Terminate", vec![], "terminate");
        assert_eq!(
            confirm.handle_key(key(KeyCode::Char('x'))),
            ConfirmOutcome::Pending
        );
        assert_eq!(
            confirm.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Pending
        );
    }

    #[test]
    fn typing_yes_then_enter_confirms_with_the_carried_action() {
        let mut confirm = Confirm::new("Extend", vec![], "extend:workload-1".to_string());
        for c in "yes".chars() {
            assert_eq!(
                confirm.handle_key(key(KeyCode::Char(c))),
                ConfirmOutcome::Pending
            );
        }
        assert_eq!(
            confirm.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Confirmed("extend:workload-1".to_string())
        );
    }

    #[test]
    fn yes_is_case_insensitive() {
        let mut confirm = Confirm::new("Extend", vec![], "extend");
        for c in "YES".chars() {
            confirm.handle_key(key(KeyCode::Char(c)));
        }
        assert_eq!(
            confirm.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Confirmed("extend")
        );
    }

    #[test]
    fn esc_cancels_regardless_of_what_was_typed() {
        let mut confirm = Confirm::new("Terminate", vec![], "terminate");
        confirm.handle_key(key(KeyCode::Char('y')));
        assert_eq!(
            confirm.handle_key(key(KeyCode::Esc)),
            ConfirmOutcome::Cancelled
        );
    }

    #[test]
    fn backspace_edits_the_typed_word() {
        let mut confirm = Confirm::new("Extend", vec![], "extend");
        confirm.handle_key(key(KeyCode::Char('y')));
        confirm.handle_key(key(KeyCode::Char('e')));
        confirm.handle_key(key(KeyCode::Char('z')));
        confirm.handle_key(key(KeyCode::Backspace));
        confirm.handle_key(key(KeyCode::Char('s')));
        assert_eq!(
            confirm.handle_key(key(KeyCode::Enter)),
            ConfirmOutcome::Confirmed("extend")
        );
    }

    #[test]
    fn draws_without_panicking_with_cost_lines() {
        let confirm = Confirm::new(
            "Extend",
            vec!["1000 base units for 3600 s.".to_string()],
            "extend",
        );
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), &confirm))
            .unwrap();
    }
}
