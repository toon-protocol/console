//! One mechanism for copying anything on screen (TOON_Network#138's "I want
//! to be able to copy and paste my address and copy urls and other info").
//!
//! Every view exposes its own `fn copyables(...) -> Vec<(String, String)>` —
//! a `(label, value)` per thing on screen (or selected) worth copying, in
//! the order it should be offered. `app::handle_key`'s `y` binding is the
//! one place that list becomes a decision: zero items does nothing, exactly
//! one copies it straight away (no modal for a view with only one thing to
//! copy), and two or more open this widget — a small modal `j`/`k` moves
//! through, `Enter` copies the highlighted one via the existing
//! `widgets::clipboard`/`wl-copy` path, `Esc` closes it without copying
//! anything. This is a pure state machine (no `Command` of its own, unlike
//! [`crate::widgets::confirm::Confirm`]) — the caller decides what
//! [`CopyPickerOutcome::Copy`] becomes, the same way `views::workloads` and
//! `views::funds` already built their own one-shot `y` before this ticket
//! merged both into this shared widget (their existing copy is simply the
//! first item their own `copyables` now returns).

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem};
use ratatui::Frame;

/// What is offered right now: every `(label, value)` [`crate::app::App`]'s
/// current view produced, and which one is highlighted.
#[derive(Debug, Clone)]
pub struct CopyPicker {
    items: Vec<(String, String)>,
    selected: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyPickerOutcome {
    /// Still open; a keystroke was consumed (moving the selection, or an
    /// unrecognised key).
    Pending,
    Cancelled,
    /// `Enter` on a real row — what to copy, and its label for the status
    /// line (`main.rs` never shows the value itself once it is long).
    Copy {
        label: String,
        value: String,
    },
}

impl CopyPicker {
    /// `items` must not be empty — `app::handle_key` only ever opens this
    /// widget once it has already checked there are at least two (one copies
    /// straight away with no modal at all).
    pub fn new(items: Vec<(String, String)>) -> Self {
        Self { items, selected: 0 }
    }

    pub fn items(&self) -> &[(String, String)] {
        &self.items
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Every key while this picker is open is consumed here — nothing
    /// (view switching, quitting, `?` help) leaks through while a person is
    /// choosing what to copy, the same "modal swallows everything" rule
    /// [`crate::widgets::confirm::Confirm`] and the help overlay both follow.
    pub fn handle_key(&mut self, key: KeyEvent) -> CopyPickerOutcome {
        match key.code {
            KeyCode::Esc => CopyPickerOutcome::Cancelled,
            KeyCode::Char('j') | KeyCode::Down => {
                if !self.items.is_empty() {
                    self.selected = (self.selected + 1).min(self.items.len() - 1);
                }
                CopyPickerOutcome::Pending
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
                CopyPickerOutcome::Pending
            }
            KeyCode::Enter => match self.items.get(self.selected) {
                Some((label, value)) => CopyPickerOutcome::Copy {
                    label: label.clone(),
                    value: value.clone(),
                },
                None => CopyPickerOutcome::Cancelled,
            },
            _ => CopyPickerOutcome::Pending,
        }
    }
}

pub fn draw(frame: &mut Frame, area: Rect, picker: &CopyPicker) {
    let width = 60u16.min(area.width.saturating_sub(4)).max(20);
    let height = (picker.items.len() as u16 + 2).min(area.height.saturating_sub(2));
    let popup = centered(area, width, height);
    frame.render_widget(Clear, popup);

    let block = Block::default()
        .title(" Copy ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let rows: Vec<ListItem> = picker
        .items
        .iter()
        .enumerate()
        .map(|(index, (label, _))| {
            let style = if index == picker.selected {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(Span::styled(label.clone(), style)))
        })
        .collect();

    frame.render_widget(List::new(rows), inner);
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

    fn items() -> Vec<(String, String)> {
        vec![
            ("npub".to_string(), "npub1abc".to_string()),
            ("Pubkey (hex)".to_string(), "a".repeat(64)),
            ("Relay URL".to_string(), "wss://relay.example".to_string()),
        ]
    }

    #[test]
    fn starts_on_the_first_item() {
        let picker = CopyPicker::new(items());
        assert_eq!(picker.selected(), 0);
    }

    #[test]
    fn j_and_k_move_selection_without_running_off_either_end() {
        let mut picker = CopyPicker::new(items());
        assert_eq!(
            picker.handle_key(key(KeyCode::Char('k'))),
            CopyPickerOutcome::Pending
        );
        assert_eq!(picker.selected(), 0, "k at the top stays at the top");

        picker.handle_key(key(KeyCode::Char('j')));
        picker.handle_key(key(KeyCode::Char('j')));
        assert_eq!(picker.selected(), 2);

        picker.handle_key(key(KeyCode::Char('j')));
        assert_eq!(picker.selected(), 2, "j at the bottom stays at the bottom");
    }

    #[test]
    fn enter_copies_the_highlighted_item() {
        let mut picker = CopyPicker::new(items());
        picker.handle_key(key(KeyCode::Char('j')));
        assert_eq!(
            picker.handle_key(key(KeyCode::Enter)),
            CopyPickerOutcome::Copy {
                label: "Pubkey (hex)".to_string(),
                value: "a".repeat(64),
            }
        );
    }

    #[test]
    fn esc_cancels_without_copying_anything() {
        let mut picker = CopyPicker::new(items());
        assert_eq!(
            picker.handle_key(key(KeyCode::Esc)),
            CopyPickerOutcome::Cancelled
        );
    }

    #[test]
    fn an_unrecognised_key_is_pending_not_ignored_a_picker_swallows_everything() {
        let mut picker = CopyPicker::new(items());
        assert_eq!(
            picker.handle_key(key(KeyCode::Char('q'))),
            CopyPickerOutcome::Pending
        );
        assert_eq!(
            picker.handle_key(key(KeyCode::Char('1'))),
            CopyPickerOutcome::Pending
        );
    }

    #[test]
    fn draws_without_panicking() {
        let picker = CopyPicker::new(items());
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), &picker))
            .unwrap();
    }

    fn buffer_to_string(buffer: &ratatui::buffer::Buffer) -> String {
        let area = buffer.area;
        let mut out = String::new();
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn renders_a_sample_picker() {
        let picker = CopyPicker::new(items());
        let backend = TestBackend::new(70, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), &picker))
            .unwrap();
        insta::assert_snapshot!(buffer_to_string(terminal.backend().buffer()));
    }
}
