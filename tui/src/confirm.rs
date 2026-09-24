//! A minimal confirmation modal for a spending action.
//!
//! TOON_Network#147's ticket text says it plainly: opening a channel and
//! buying gas each go through a confirmation that ONE keypress cannot pass,
//! and sibling ticket #143 is building a shared confirm modal in parallel.
//! Rather than block on that, or guess its shape, this is a small,
//! self-contained one behind a narrow interface — a `Confirm` value plus one
//! pure `handle_key` function and one `draw` function — so `views::funds` is
//! the only caller, and swapping this out for #143's later touches nothing
//! outside this file and that one call site.
//!
//! The one keypress this exists to stop: opening the modal does not arm it,
//! `y` arms it, and only `Enter` while armed confirms. Any other key
//! (including a second `y`, or a stray `Enter` before `y`) disarms it rather
//! than confirming, and `Esc`/`n` cancels outright.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

/// What is being confirmed: a title and the lines describing it — always
/// including the amount, per the ticket. Plain data; the caller decides what
/// confirming it means.
#[derive(Debug, Clone, PartialEq)]
pub struct Confirm {
    pub title: String,
    pub lines: Vec<String>,
    /// Set once `y` has been pressed. Only `Enter` while this is set
    /// confirms; everything else (including `y` again) is a fresh arm.
    pub armed: bool,
}

impl Confirm {
    pub fn new(title: impl Into<String>, lines: Vec<String>) -> Self {
        Self {
            title: title.into(),
            lines,
            armed: false,
        }
    }
}

/// What a keypress against an open `Confirm` decided. The caller owns the
/// `Option<Confirm>` and acts on `Confirmed`/`Cancelled` by clearing it;
/// `Pending` means keep showing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Confirmed,
    Cancelled,
}

pub fn handle_key(confirm: &mut Confirm, key: KeyEvent) -> Outcome {
    match key.code {
        KeyCode::Enter if confirm.armed => Outcome::Confirmed,
        KeyCode::Char('y') | KeyCode::Char('Y') => {
            confirm.armed = true;
            Outcome::Pending
        }
        KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => Outcome::Cancelled,
        _ => {
            // Includes a bare `Enter` before `y`, and re-presses: nothing
            // here is one keypress away from spending money.
            confirm.armed = false;
            Outcome::Pending
        }
    }
}

pub fn draw(frame: &mut Frame, area: Rect, confirm: &Confirm) {
    let width = 56u16.min(area.width.saturating_sub(4)).max(20);
    let height = (confirm.lines.len() as u16 + 4).min(area.height.saturating_sub(2));
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
        Span::styled(
            "y",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" then "),
        Span::styled(
            "Enter",
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(if confirm.armed {
            " confirms — armed, press Enter"
        } else {
            " confirms"
        }),
        Span::raw("   "),
        Span::styled("Esc", Style::default().fg(Color::Red)),
        Span::raw(" cancels"),
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

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    #[test]
    fn enter_alone_does_not_confirm() {
        let mut confirm = Confirm::new("Open channel", vec!["Collateral: 100000".to_string()]);
        assert_eq!(
            handle_key(&mut confirm, key(KeyCode::Enter)),
            Outcome::Pending
        );
        assert!(!confirm.armed);
    }

    #[test]
    fn y_then_enter_confirms() {
        let mut confirm = Confirm::new("Open channel", vec![]);
        assert_eq!(
            handle_key(&mut confirm, key(KeyCode::Char('y'))),
            Outcome::Pending
        );
        assert!(confirm.armed);
        assert_eq!(
            handle_key(&mut confirm, key(KeyCode::Enter)),
            Outcome::Confirmed
        );
    }

    #[test]
    fn any_other_key_between_y_and_enter_disarms_it() {
        let mut confirm = Confirm::new("Open channel", vec![]);
        handle_key(&mut confirm, key(KeyCode::Char('y')));
        assert!(confirm.armed);
        handle_key(&mut confirm, key(KeyCode::Char('x')));
        assert!(!confirm.armed);
        assert_eq!(
            handle_key(&mut confirm, key(KeyCode::Enter)),
            Outcome::Pending
        );
    }

    #[test]
    fn esc_cancels_whether_armed_or_not() {
        let mut confirm = Confirm::new("Open channel", vec![]);
        assert_eq!(
            handle_key(&mut confirm, key(KeyCode::Esc)),
            Outcome::Cancelled
        );

        let mut armed = Confirm::new("Open channel", vec![]);
        handle_key(&mut armed, key(KeyCode::Char('y')));
        assert_eq!(
            handle_key(&mut armed, key(KeyCode::Esc)),
            Outcome::Cancelled
        );
    }

    #[test]
    fn n_cancels() {
        let mut confirm = Confirm::new("Open channel", vec![]);
        assert_eq!(
            handle_key(&mut confirm, key(KeyCode::Char('n'))),
            Outcome::Cancelled
        );
    }

    #[test]
    fn draws_without_panicking_armed_and_unarmed() {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut confirm = Confirm::new(
            "Open channel",
            vec!["Collateral: 100000 base units".to_string()],
        );
        terminal
            .draw(|frame| draw(frame, frame.area(), &confirm))
            .unwrap();
        confirm.armed = true;
        terminal
            .draw(|frame| draw(frame, frame.area(), &confirm))
            .unwrap();
    }
}
