//! The shell: header, sidebar, footer and the help overlay.
//!
//! `draw` is the one place a frame gets built. It lays out the four regions
//! ADR 0028 describes, asks the current `View` for its content (a shipped
//! view's `views::<name>::draw`, or `views::placeholder::draw` for the rest),
//! and hands back where the sidebar's rows landed on screen so mouse clicks
//! can be matched against them next event — the App has no business knowing
//! its own screen coordinates, only `ui` draws, so only `ui` can say.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, DaemonStatus, View};
use crate::views;

pub fn draw(frame: &mut Frame, app: &App) -> Vec<(u16, View)> {
    let area = frame.area();
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(3),
            Constraint::Length(3),
        ])
        .split(area);

    draw_header(frame, outer[0], app);

    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(16), Constraint::Min(20)])
        .split(outer[1]);

    let hits = draw_sidebar(frame, body[0], app.view);
    draw_content(frame, body[1], app);
    draw_footer(frame, outer[2], app);

    if app.help_open {
        draw_help(frame, area);
    }

    hits
}

fn status_span(status: &DaemonStatus) -> Span<'static> {
    match status {
        DaemonStatus::Connecting => {
            Span::styled("● connecting", Style::default().fg(Color::Yellow))
        }
        DaemonStatus::Connected => Span::styled("● daemon", Style::default().fg(Color::Green)),
        DaemonStatus::Down(_) => Span::styled("● daemon down", Style::default().fg(Color::Red)),
        DaemonStatus::Error(_) => Span::styled("● daemon", Style::default().fg(Color::Yellow)),
    }
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App) {
    let profile = app
        .health
        .as_ref()
        .map(|h| h.profile.label.clone())
        .unwrap_or_else(|| "…".to_string());
    let account = account_label(app);

    let line = Line::from(vec![
        Span::styled(
            " TOON Console ",
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw("── "),
        Span::raw(profile),
        Span::raw(" ── "),
        Span::raw(account),
        Span::raw(" ── "),
        status_span(&app.daemon_status),
        Span::raw(" "),
    ]);
    let block = Block::default().borders(Borders::ALL);
    frame.render_widget(Paragraph::new(line).block(block), area);
}

/// What the header shows for "who is signed in" (TOON_Network#141) — read
/// from the same `app.account` every view's Account data comes from, so the
/// header agrees with the Account view rather than keeping its own copy.
fn account_label(app: &App) -> String {
    match &app.account {
        None => "…".to_string(),
        Some(status) if !status.signed_in => "signed out".to_string(),
        Some(status) => match &status.account {
            None => "signed in".to_string(),
            Some(view) => crate::format::account_display_name(view),
        },
    }
}

/// Draws the sidebar and returns each row's screen `y` alongside the `View`
/// it selects, for mouse hit-testing.
fn draw_sidebar(frame: &mut Frame, area: Rect, current: View) -> Vec<(u16, View)> {
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut hits = Vec::with_capacity(View::ALL.len());
    let mut lines = Vec::with_capacity(View::ALL.len());
    for (offset, view) in View::ALL.iter().enumerate() {
        let row = inner.y + offset as u16;
        if row >= inner.y + inner.height {
            break;
        }
        hits.push((row, *view));
        let selected = *view == current;
        let style = if selected {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(
            format!("{} {}", view.key(), view.title()),
            style,
        )));
    }
    frame.render_widget(Paragraph::new(lines), inner);
    hits
}

fn draw_content(frame: &mut Frame, area: Rect, app: &App) {
    match (app.view, &app.daemon_status) {
        (_, DaemonStatus::Down(message)) => draw_down(frame, area, message),
        (View::Health, _) => match &app.health {
            Some(health) => views::health::draw(frame, area, health),
            None => draw_loading(frame, area, "Health"),
        },
        (View::Account, _) => match &app.account {
            Some(status) => {
                // One line, not one per concern — the same rule
                // `console-app.tsx` follows for its error banner: an
                // account error and a Chain Seed error shown separately
                // would say the same kind of thing twice.
                let error = account_and_chain_seed_error(app);
                views::account::draw(
                    frame,
                    area,
                    &app.account_view,
                    status,
                    app.profiles.as_ref(),
                    app.chain_seed.as_ref(),
                    error.as_deref(),
                )
            }
            None => draw_loading(frame, area, "Account"),
        },
        (view, _) => views::placeholder::draw(frame, area, view.title()),
    }
}

fn account_and_chain_seed_error(app: &App) -> Option<String> {
    match (&app.account_error, &app.chain_seed_error) {
        (Some(account), Some(chain_seed)) if account != chain_seed => {
            Some(format!("{account}\n{chain_seed}"))
        }
        (Some(account), _) => Some(account.clone()),
        (None, Some(chain_seed)) => Some(chain_seed.clone()),
        (None, None) => None,
    }
}

fn draw_down(frame: &mut Frame, area: Rect, message: &str) {
    let block = Block::default().title(" Daemon ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines: Vec<Line> = message
        .lines()
        .map(|line| {
            Line::from(Span::styled(
                line.to_string(),
                Style::default().fg(Color::Red),
            ))
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_loading(frame: &mut Frame, area: Rect, view_title: &str) {
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(format!("Reading {view_title}…"))
            .style(Style::default().fg(Color::DarkGray)),
        inner,
    );
}

fn draw_footer(frame: &mut Frame, area: Rect, app: &App) {
    let mut spans = vec![Span::raw(" Tab/h/l switch  1-7 jump ")];
    if app.view == View::Health {
        spans.push(Span::raw(" r refresh "));
    }
    if app.view == View::Account {
        spans.push(Span::raw(
            " j/k move  Enter edit/act  Esc stop editing  r refresh ",
        ));
        if app.account_view.chain_seed.confirm.is_open() {
            spans.push(Span::raw(" y arm, Enter to publish  Esc cancel "));
        }
    }
    spans.push(Span::raw(" ? help  q quit "));
    let block = Block::default().borders(Borders::ALL);
    frame.render_widget(Paragraph::new(Line::from(spans)).block(block), area);
}

const HELP_LINES: &[&str] = &[
    "1-7        jump to a view",
    "Tab        next view",
    "Shift+Tab  previous view",
    "h / l      previous / next view",
    "r          refresh Health, or the Account view",
    "j / k      Account: move between fields and buttons",
    "Enter      Account: edit a field, or act on a button",
    "Esc        Account: stop typing (while editing a field)",
    "y, Enter   Account: confirm a Chain Seed publish (two keys, on purpose)",
    "mouse      click a sidebar row to select it",
    "?          toggle this help",
    "q / Esc    quit",
];

fn draw_help(frame: &mut Frame, area: Rect) {
    let width = 64u16.min(area.width.saturating_sub(4)).max(10);
    let height = (HELP_LINES.len() as u16 + 2).min(area.height.saturating_sub(2));
    let popup = centered(area, width, height);
    frame.render_widget(Clear, popup);
    let block = Block::default().title(" Help ").borders(Borders::ALL);
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    let lines: Vec<Line> = HELP_LINES
        .iter()
        .map(|line| Line::from(line.to_string()))
        .collect();
    frame.render_widget(Paragraph::new(lines), inner);
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
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn draws_without_panicking_in_every_state() {
        let mut app = App::new();
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();

        // Connecting, no health yet.
        terminal
            .draw(|frame| {
                draw(frame, &app);
            })
            .unwrap();

        // Daemon down.
        app.daemon_status = DaemonStatus::Down("not running".to_string());
        terminal
            .draw(|frame| {
                draw(frame, &app);
            })
            .unwrap();

        // Help open.
        app.help_open = true;
        terminal
            .draw(|frame| {
                draw(frame, &app);
            })
            .unwrap();
    }

    #[test]
    fn sidebar_hits_list_one_row_per_view_in_order() {
        let app = App::new();
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hits = Vec::new();
        terminal
            .draw(|frame| {
                hits = draw(frame, &app);
            })
            .unwrap();
        assert_eq!(hits.len(), View::ALL.len());
        for (offset, (_, view)) in hits.iter().enumerate() {
            assert_eq!(*view, View::ALL[offset]);
        }
    }
}
