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
use crate::widgets::copy_picker;

/// Where things landed on screen this frame, for `app::handle_mouse` to test
/// a click against next event (ADR 0028: "mouse clicks select tabs and
/// rows") — the App has no business knowing its own screen coordinates, only
/// `ui` draws, so only `ui` can say.
#[derive(Default)]
pub struct Hits {
    /// Each sidebar row's `y`, paired with the [`View`] it selects.
    pub sidebar: Vec<(u16, View)>,
    /// The current view's own main list, if it has one — each visible row's
    /// `y`, paired with its index into that view's own (already filtered)
    /// item list, the same index `j`/`k` would land the selection on.
    pub rows: Vec<(u16, usize)>,
}

pub fn draw(frame: &mut Frame, app: &App) -> Hits {
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

    let sidebar = draw_sidebar(frame, body[0], app.view);
    let rows = draw_content(frame, body[1], app);
    draw_footer(frame, outer[2], app);

    if let Some(picker) = &app.copy_picker {
        copy_picker::draw(frame, area, picker);
    }

    if app.help_open {
        draw_help(frame, area);
    }

    Hits { sidebar, rows }
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
    // TOON_Network#147: the total channel balance, shown on every view (not
    // only Funds) — a small additive read of `app.funds.funding`, which is
    // fetched eagerly on connect for exactly this reason.
    let channels = crate::format::total_channel_balance(app.funds.funding.as_ref());

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
        Span::raw(format!("channels: {channels}")),
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

/// Draws the current view and returns its main list's row hits, if it has
/// one — empty for Health and Funds (no list `handle_mouse` selects a row
/// of today) and for the daemon-down screen.
fn draw_content(frame: &mut Frame, area: Rect, app: &App) -> Vec<(u16, usize)> {
    match (app.view, &app.daemon_status) {
        (_, DaemonStatus::Down(message)) => {
            draw_down(frame, area, message);
            Vec::new()
        }
        (View::Health, _) => {
            match &app.health {
                Some(health) => views::health::draw(frame, area, health),
                None => draw_loading(frame, area, "Health"),
            }
            Vec::new()
        }
        (View::Workloads, _) => {
            let gateway_domain = app
                .health
                .as_ref()
                .map(|h| h.profile.gateway_domain.as_str());
            views::workloads::draw(frame, area, &app.workloads, gateway_domain)
        }
        (View::Directory, _) => views::directory::draw(
            frame,
            area,
            &app.directory,
            app.now_ms,
            app.loading_directory,
        ),
        (View::Docs, _) => views::docs::draw(frame, area, &app.docs),
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
            None => {
                draw_loading(frame, area, "Account");
                Vec::new()
            }
        },
        // Funds (TOON_Network#147) draws its own loading/not-yet/ready
        // states from `app.funds` — unlike Health there is no separate
        // `draw_loading` arm here, since the view's own first line already
        // says "Reading your funds…".
        (View::Funds, _) => {
            views::funds::draw(frame, area, &app.funds);
            Vec::new()
        }
        // New workload (TOON_Network#146) draws its own per-stage
        // loading/empty states from `app.new_workload`, the same as Funds.
        // Every one of the seven sidebar views now has a dedicated arm —
        // ADR 0028's placeholder (`views::placeholder::draw`) is what an
        // unbuilt one showed, and there is not one left.
        (View::New, _) => views::new_workload::draw(frame, area, &app.new_workload, app.now_ms),
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
    let mut spans = Vec::new();
    // TOON_Network#138: the last copy/paste outcome, ahead of the hints —
    // shown regardless of which view is current, so it is never lost the
    // moment a view-specific hint would otherwise crowd it out.
    if let Some(status) = &app.clipboard_status {
        spans.push(Span::styled(
            format!(" {status} "),
            Style::default().fg(Color::Green),
        ));
    }
    spans.push(Span::raw(" Tab/h/l switch  1-7 jump  y copy "));
    if app.view == View::Health {
        spans.push(Span::raw(" r refresh "));
    }
    if app.view == View::Workloads {
        spans.push(Span::raw(
            " j/k select  / filter  e extend  x terminate  a auto-extend  r rotate  g gateway  R refresh ",
        ));
    }
    if app.view == View::Directory {
        spans.push(Span::raw(
            " j/k move  Enter detail  i/a/g/d/n/H filter  r refresh ",
        ));
    }
    if app.view == View::Docs {
        spans.push(if app.docs.page.is_some() {
            Span::raw(" j/k scroll  n/N link  o open  r refresh  Backspace back ")
        } else {
            Span::raw(" j/k select  Enter open  r refresh ")
        });
    }
    if app.view == View::Account {
        spans.push(Span::raw(
            " j/k move  Enter edit/act  Ctrl+V paste  Esc stop editing  r refresh ",
        ));
        if app.account_view.chain_seed.confirm.is_some() {
            spans.push(Span::raw(" type yes, Enter to publish  Esc cancel "));
        }
    }
    if app.view == View::Funds {
        spans.push(Span::raw(
            " j/k chain  o open  f faucet  g quote  b buy  r refresh ",
        ));
    }
    if app.view == View::New {
        spans.push(Span::raw(match app.new_workload.stage {
            views::new_workload::Stage::Gallery => " j/k select  / filter  Enter open  r refresh ",
            views::new_workload::Stage::Form => {
                " j/k move  Enter edit/preview  Ctrl+V paste  Esc stop editing  Backspace back "
            }
            views::new_workload::Stage::Listing => " j/k move  Enter choose  Backspace back ",
            views::new_workload::Stage::Standbys => {
                " j/k move  Enter add  d remove last  n continue  Backspace back "
            }
            views::new_workload::Stage::Preflight => {
                " L toggle local-only  s spawn (asks for confirmation)  Backspace back "
            }
        }));
        if app.new_workload.confirm.is_some() {
            spans.push(Span::raw(" type yes, Enter to spawn  Esc cancel "));
        }
    }
    if app.copy_picker.is_some() {
        spans.push(Span::raw(" j/k move  Enter copy  Esc close "));
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
    "r          refresh Health, the open Docs page/list, Account, or Funds",
    "R          refresh Workloads",
    "y          copy what's on screen — straight away with one thing to",
    "           copy, or j/k/Enter/Esc over a small picker with more than one",
    "Ctrl+V     paste the system clipboard into the field being typed into",
    "paste      pasting into a field (a terminal's own paste, not typed",
    "           keys) lands there too, whole, minus any \\r/\\n",
    "j / k      Docs: select a page, or scroll an open one",
    "Enter      Docs: open the selected page",
    "n / N      Docs: focus the next / previous link",
    "o          Docs: open the focused link (xdg-open)",
    "Backspace  Docs: back to the reading list",
    "j / k      Account: move between fields and buttons",
    "Enter      Account: edit a field, or act on a button",
    "Esc        Account: stop typing (while editing a field)",
    "y, Enter   Account: confirm a Chain Seed publish (two keys, on purpose)",
    "n          Account: add a network profile under a new id",
    "e          Account: edit the network profile under the cursor",
    "D          Account: reset or remove it (asks for confirmation)",
    "mouse      click a sidebar row to select it, or a list row to select IT",
    "?          toggle this help",
    "q / Esc    quit",
    "-- Funds --",
    "j / k      select a chain",
    "o          open a payment channel (asks for confirmation)",
    "f          ask the faucet",
    "g          get a gas quote",
    "b          buy the shown gas quote (asks for confirmation)",
    "-- Workloads --",
    "j / k      select a workload",
    "/          filter the list",
    "e          extend (asks for confirmation)",
    "x          terminate (asks for confirmation)",
    "a          set/clear the auto-extend budget (asks for confirmation)",
    "r          rotate the Continuation Token (asks for confirmation)",
    "g          hand over to / withdraw from a gateway (asks for confirmation)",
    "-- New workload --",
    "j / k      Gallery: select a Template; Form/Listing/Standbys: move",
    "/          Gallery: filter the list",
    "Enter      Gallery: open; Form: edit a field or preview; Listing/Standbys: choose",
    "Esc        Form: stop typing (while editing a field)",
    "Backspace  go back one stage",
    "d          Standbys: remove the last Warm Standby added",
    "n          Standbys: continue to the preflight",
    "L          Preflight: toggle local-only and re-price",
    "s, yes     Preflight: spawn (asks for confirmation)",
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
        let mut hits = Hits::default();
        terminal
            .draw(|frame| {
                hits = draw(frame, &app);
            })
            .unwrap();
        let hits = hits.sidebar;
        assert_eq!(hits.len(), View::ALL.len());
        for (offset, (_, view)) in hits.iter().enumerate() {
            assert_eq!(*view, View::ALL[offset]);
        }
    }
}
