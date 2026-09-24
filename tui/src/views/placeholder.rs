//! What an unbuilt view shows.
//!
//! Every one of the seven sidebar views is selectable from the moment the
//! shell exists — a view a later ticket has not built yet is still a
//! destination, not a dead key. This is what it shows until then.

use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

pub fn draw(frame: &mut Frame, area: Rect, view_title: &str) {
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::raw(""),
        Line::from(Span::styled(
            format!("{view_title} is not built yet."),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "A later ticket adds this view to the same shell.",
            Style::default().fg(Color::DarkGray),
        )),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: false }),
        inner,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn renders_without_panicking() {
        let backend = TestBackend::new(40, 10);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), "Workloads"))
            .unwrap();
    }
}
