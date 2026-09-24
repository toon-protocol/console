//! The Workloads view (TOON_Network#143): the console's home screen.
//!
//! A terminal mirror of `packages/ui/src/app/workloads-view.tsx` and
//! `workload-card.tsx`'s **Vault** section — the list of every workload this
//! account holds, and a detail pane for whichever one is selected. What is
//! NOT here, on purpose, and left to TOON_Network#144 (which reuses
//! `widgets::confirm` the same way this view does): auto-extend, rotation and
//! the gateway handover/withdraw actions (`a`, `r`, `g`). This view's own
//! actions are the three the ticket names — `e` extend, `x` terminate, `y`
//! copy access — and both spending/destructive ones go through the same
//! confirmation modal.
//!
//! **The gateway hostname is derived, not fetched.** Spec §12.2 makes it a
//! pure function of the workload id and the profile's `gatewayDomain`
//! (`format::gateway_hostname_for`, mirroring
//! `packages/daemon/src/gateway-name.ts`), so a row shows it the instant the
//! dashboard loads — no extra packet per row, and nothing here to disagree
//! with what a gateway actually serves. Checking that live is `g`'s job
//! (TOON_Network#144, spec §12.3's `probe`), not this list's.
//!
//! **Row actions act on the primary.** The web card also offers a per-member
//! `Extend` on a Standby Set's own standbys (`workload-card.tsx`'s
//! `Members`); that finer control is left to a later ticket. `e`/`x` here
//! extend or terminate the workload the way its top-level `Actions` do (no
//! `member` in the request, which the daemon reads as the primary).

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::format::{duration, gateway_hostname_for};
use crate::types::{Dashboard, LeaseAccess, LeaseLife, WorkloadCard, WorkloadStatus};
use crate::widgets::confirm::{self, Confirm, ConfirmOutcome};
use crate::widgets::list::{ListOutcome, ListState};

/// Under 24 hours, ADR 0028 / this ticket's acceptance criterion: marked with
/// the terminal's warning colour AND a symbol, so it survives any theme
/// (colour alone would not — some themes put a warning colour close to an
/// ordinary one).
const LOW_RUNWAY_SECONDS: i64 = 24 * 3600;
const WARNING_SYMBOL: &str = "\u{26a0}"; // ⚠

/// What a confirmed `e`/`x` becomes, once the person has typed `yes`. Carried
/// out by `main.rs`, which is the only place this crate calls the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkloadAction {
    Extend {
        workload_id: String,
        max_price: Option<String>,
    },
    Terminate {
        workload_id: String,
    },
}

#[derive(Default)]
pub struct WorkloadsViewState {
    pub list: ListState,
    pub dashboard: Option<Dashboard>,
    pub loading: bool,
    pub confirm: Option<Confirm<WorkloadAction>>,
    /// A message from the last `y`/`e`/`x` press or the last refresh's
    /// answer — cleared by the next keypress that changes anything, so it
    /// never lingers past the moment it stops being true.
    pub status: Option<String>,
    pub error: Option<String>,
}

impl WorkloadsViewState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Every card whose text matches the current filter, in dashboard order —
/// the same list both `handle_key` (for bounds and which row `e`/`x`/`y` act
/// on) and `draw` (for what is on screen) must agree on.
fn filtered<'a>(dashboard: &'a Dashboard, list: &ListState) -> Vec<&'a WorkloadCard> {
    dashboard
        .cards
        .iter()
        .filter(|card| {
            let haystack = format!(
                "{} {} {}",
                card.workload_id, card.lease.listing.name, card.provider.ilp_address
            );
            list.matches(&haystack)
        })
        .collect()
}

fn has_ended(card: &WorkloadCard) -> bool {
    matches!(
        card.status,
        WorkloadStatus::Read {
            life: LeaseLife::Ended { .. },
            ..
        }
    )
}

fn short_id(id: &str) -> String {
    if id.len() > 16 {
        format!("{}\u{2026}", &id[..16])
    } else {
        id.to_string()
    }
}

/// The access details of whichever member is running the workload, falling
/// back to the card's own status/lease access — mirrors `runningAccess` in
/// `workload-card.tsx`.
fn running_access(card: &WorkloadCard) -> Option<&LeaseAccess> {
    if let Some(member) = card.members.iter().find(|m| m.running_now) {
        if let WorkloadStatus::Read {
            access: Some(access),
            ..
        } = &member.status
        {
            return Some(access);
        }
    }
    if let WorkloadStatus::Read {
        access: Some(access),
        ..
    } = &card.status
    {
        return Some(access);
    }
    card.lease.access.as_ref()
}

/// What `y` copies: an SSH command when there is a port for one, else the
/// bare host — the same choice `workload-card.tsx`'s `Access` renders.
fn access_text(card: &WorkloadCard) -> Option<String> {
    let access = running_access(card)?;
    Some(match access.ssh_port {
        Some(port) => format!("ssh -p {port} tenant@{}", access.host),
        None => access.host.clone(),
    })
}

fn ending_word(ending: &str, word: &Option<String>) -> String {
    if ending == "unstated" {
        word.clone().unwrap_or_else(|| "not said".to_string())
    } else {
        ending.to_string()
    }
}

fn status_word(status: &WorkloadStatus) -> String {
    match status {
        WorkloadStatus::Read { life, .. } => match life {
            LeaseLife::Provisioning => "provisioning".to_string(),
            LeaseLife::Reserved => "reserved".to_string(),
            LeaseLife::Running => "running".to_string(),
            LeaseLife::Stopped => "self-stopped".to_string(),
            LeaseLife::Ended { ending, word } => {
                format!("ended \u{2014} {}", ending_word(ending, word))
            }
        },
        WorkloadStatus::Silent { .. } => "not answering".to_string(),
        WorkloadStatus::Refused { code, .. } => code.clone(),
        WorkloadStatus::Unread { .. } => "not asked".to_string(),
    }
}

fn status_style(status: &WorkloadStatus) -> Style {
    match status {
        WorkloadStatus::Read {
            life: LeaseLife::Running,
            ..
        } => Style::default().fg(Color::Green),
        WorkloadStatus::Read {
            life: LeaseLife::Ended { .. },
            ..
        } => Style::default().fg(Color::DarkGray),
        WorkloadStatus::Silent { .. } => Style::default().fg(Color::DarkGray),
        WorkloadStatus::Refused { .. } => Style::default().fg(Color::Red),
        _ => Style::default(),
    }
}

struct RunwayText {
    text: String,
    low: bool,
}

/// The row's runway figure — the daemon's own arithmetic (`card.runway`),
/// never recomputed here (see `types.rs`'s module doc). `low` drives the
/// warning colour AND `WARNING_SYMBOL`, together, so it survives any theme.
/// The compact form for a row's narrow column — no "runway" word (the
/// header already says so).
fn runway_text(card: &WorkloadCard) -> RunwayText {
    match card.runway.state.as_str() {
        "computed" => {
            let seconds = card.runway.seconds.unwrap_or(0);
            RunwayText {
                text: duration(seconds),
                low: seconds < LOW_RUNWAY_SECONDS,
            }
        }
        "unbounded" => RunwayText {
            text: "unbounded".to_string(),
            low: false,
        },
        _ => RunwayText {
            text: "unknown".to_string(),
            low: false,
        },
    }
}

/// The full sentence for the detail pane, where there is room for the
/// reason the daemon gave when it could not compute a figure.
fn runway_sentence(card: &WorkloadCard) -> String {
    match card.runway.state.as_str() {
        "computed" => {
            let seconds = card.runway.seconds.unwrap_or(0);
            let low = seconds < LOW_RUNWAY_SECONDS;
            format!(
                "{}{}",
                duration(seconds),
                if low {
                    format!(" {WARNING_SYMBOL} under 24 hours")
                } else {
                    String::new()
                }
            )
        }
        "unbounded" => card
            .runway
            .reason
            .clone()
            .unwrap_or_else(|| "not bounded by funds".to_string()),
        _ => card
            .runway
            .reason
            .clone()
            .unwrap_or_else(|| "not known".to_string()),
    }
}

fn standby_count(card: &WorkloadCard) -> i64 {
    if card.set.warm {
        (card.set.members - 1).max(0)
    } else {
        0
    }
}

/// Every key while this view is active, tried before the app-level keymap
/// (`app::handle_key`). `None` means this view has no opinion about the key —
/// the app-level keymap (view switching, `?`, quit, the `Workloads`-only `r`
/// refresh) gets it next. A confirm modal or an open filter, by contrast,
/// answers `Some` for literally every key: nothing leaks through either one.
pub fn handle_key(state: &mut WorkloadsViewState, key: KeyEvent) -> Option<Command> {
    if let Some(confirm) = &mut state.confirm {
        return Some(match confirm.handle_key(key) {
            ConfirmOutcome::Pending => Command::None,
            ConfirmOutcome::Cancelled => {
                state.confirm = None;
                state.status = Some("Cancelled. Nothing was sent.".to_string());
                Command::None
            }
            ConfirmOutcome::Confirmed(action) => {
                state.confirm = None;
                match action {
                    WorkloadAction::Extend {
                        workload_id,
                        max_price,
                    } => Command::ExtendWorkload {
                        workload_id,
                        max_price,
                    },
                    WorkloadAction::Terminate { workload_id } => {
                        Command::TerminateWorkload { workload_id }
                    }
                }
            }
        });
    }

    let cards = state
        .dashboard
        .as_ref()
        .map(|dashboard| filtered(dashboard, &state.list))
        .unwrap_or_default();

    match state.list.handle_key(key, cards.len()) {
        ListOutcome::Handled => return Some(Command::None),
        // Enter's own future is a fuller drill-down; the detail pane already
        // shows the selected row, so there is nothing more to open today.
        ListOutcome::Open(_) => return Some(Command::None),
        ListOutcome::Ignored => {}
    }

    match key.code {
        KeyCode::Char('e') => {
            state.status = None;
            let Some(card) = cards.get(state.list.selected) else {
                return Some(Command::None);
            };
            if has_ended(card) {
                state.status =
                    Some("This lease has ended; there is nothing to extend.".to_string());
                return Some(Command::None);
            }
            let price = card.extend.route.as_ref().and_then(|r| r.price.clone());
            let mut lines = vec![format!(
                "Extend {} by one Lease Interval ({} s).",
                short_id(&card.workload_id),
                card.lease.listing.lease_interval_s
            )];
            lines.push(match &price {
                Some(p) => format!(
                    "Costs {p} base units. A refused request is billed the same as an accepted one."
                ),
                None => {
                    "Price not known yet. A refused request is billed the same as an accepted one."
                        .to_string()
                }
            });
            if !card.extend.ok {
                for problem in &card.extend.problems {
                    lines.push(format!("Problem: {problem}"));
                }
            }
            state.confirm = Some(Confirm::new(
                "Extend",
                lines,
                WorkloadAction::Extend {
                    workload_id: card.workload_id.clone(),
                    max_price: price,
                },
            ));
            Some(Command::None)
        }
        KeyCode::Char('x') => {
            state.status = None;
            let Some(card) = cards.get(state.list.selected) else {
                return Some(Command::None);
            };
            if has_ended(card) {
                state.status = Some("This lease has already ended.".to_string());
                return Some(Command::None);
            }
            let lines = vec![
                format!(
                    "Destroys {} immediately. There is no refund.",
                    short_id(&card.workload_id)
                ),
                "Nothing brings it back, and time already paid for is not returned.".to_string(),
            ];
            state.confirm = Some(Confirm::new(
                "Terminate",
                lines,
                WorkloadAction::Terminate {
                    workload_id: card.workload_id.clone(),
                },
            ));
            Some(Command::None)
        }
        KeyCode::Char('y') => {
            let Some(card) = cards.get(state.list.selected) else {
                return Some(Command::None);
            };
            match access_text(card) {
                Some(text) => Some(Command::CopyToClipboard(text)),
                None => {
                    state.status = Some(
                        "No access details yet — a lease that is still provisioning has none."
                            .to_string(),
                    );
                    Some(Command::None)
                }
            }
        }
        _ => None,
    }
}

pub fn draw(
    frame: &mut Frame,
    area: Rect,
    state: &WorkloadsViewState,
    gateway_domain: Option<&str>,
) {
    let content = if let Some(message) = state.error.as_deref().or(state.status.as_deref()) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(3)])
            .split(area);
        draw_message(frame, chunks[0], message, state.error.is_some());
        chunks[1]
    } else {
        area
    };

    let Some(dashboard) = &state.dashboard else {
        draw_placeholder(frame, content, "Reading Workloads\u{2026}");
        return;
    };

    let cards = filtered(dashboard, &state.list);

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(content);

    draw_list(frame, cols[0], &cards, state, gateway_domain);
    draw_detail(
        frame,
        cols[1],
        cards.get(state.list.selected).copied(),
        gateway_domain,
    );

    if let Some(confirm) = &state.confirm {
        confirm::draw(frame, area, confirm);
    }
}

fn draw_message(frame: &mut Frame, area: Rect, message: &str, is_error: bool) {
    let style = if is_error {
        Style::default().fg(Color::Red)
    } else {
        Style::default().fg(Color::Cyan)
    };
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(message.to_string(), style)))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

fn draw_placeholder(frame: &mut Frame, area: Rect, message: &str) {
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(message).style(Style::default().fg(Color::DarkGray)),
        inner,
    );
}

fn draw_list(
    frame: &mut Frame,
    area: Rect,
    cards: &[&WorkloadCard],
    state: &WorkloadsViewState,
    gateway_domain: Option<&str>,
) {
    let title = format!(
        " Workloads{}",
        state.list.title_suffix(
            cards.len(),
            state.dashboard.as_ref().map_or(0, |d| d.cards.len())
        )
    );
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    if cards.is_empty() {
        let message = if state.list.filter.is_empty() {
            "No workloads yet."
        } else {
            "No workload matches this filter."
        };
        frame.render_widget(
            Paragraph::new(message).style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return;
    }

    let mut lines = Vec::with_capacity(cards.len() + 1);
    lines.push(header_line());
    for (index, card) in cards.iter().enumerate() {
        let selected = index == state.list.selected;
        lines.push(row_line(card, selected, gateway_domain));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}

/// Cuts `text` to at most `max` characters, `…`-suffixed when it had to.
/// Used only for a ROW's cramped columns — the detail pane always shows the
/// text in full.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!(
            "{}\u{2026}",
            text.chars().take(max.saturating_sub(1)).collect::<String>()
        )
    }
}

/// The column widths `row_line` and [`header_line`] both pad to, so the
/// header's labels line up over the values underneath them.
const COL_ID: usize = 13;
const COL_LISTING: usize = 10;
const COL_STATUS: usize = 11;
const COL_RUNWAY: usize = 11;
const COL_STANDBY: usize = 4;

/// The one line at the top of the list explaining what each cramped column
/// is — `wlrjf3qat…` on its own means nothing, but under `ID` it does.
fn header_line() -> Line<'static> {
    let style = Style::default()
        .fg(Color::DarkGray)
        .add_modifier(Modifier::BOLD);
    Line::from(Span::styled(
        format!(
            "  {:<COL_ID$} {:<COL_LISTING$} {:<COL_STATUS$} {:<COL_RUNWAY$} {:<COL_STANDBY$} GW",
            "ID", "LISTING", "STATUS", "RUNWAY", "SB"
        ),
        style,
    ))
}

fn row_line(card: &WorkloadCard, selected: bool, gateway_domain: Option<&str>) -> Line<'static> {
    let base = if selected {
        Style::default().add_modifier(Modifier::REVERSED)
    } else {
        Style::default()
    };

    let runway = runway_text(card);
    let runway_style = if runway.low {
        base.fg(Color::Yellow).add_modifier(Modifier::BOLD)
    } else {
        base.fg(Color::DarkGray)
    };
    // Compact enough for a narrow column: the symbol is what a warning colour
    // alone cannot promise (ADR 0028: some themes put "warning" close to
    // "ordinary"), and it survives even a no-colour terminal.
    let runway_cell = format!(
        "{}{}",
        truncate(
            &runway.text,
            if runway.low {
                COL_RUNWAY - 2
            } else {
                COL_RUNWAY
            }
        ),
        if runway.low {
            format!(" {WARNING_SYMBOL}")
        } else {
            String::new()
        }
    );

    let standbys = standby_count(card);
    let standby_cell = if standbys > 0 {
        format!("+{standbys}")
    } else {
        String::new()
    };

    // The full 50-plus character label belongs in the detail pane (see
    // `draw_detail`) — a row only has room to say whether one exists.
    let has_gateway = gateway_domain
        .map(|domain| gateway_hostname_for(&card.workload_id, domain).is_some())
        .unwrap_or(false);
    let gateway_cell = if has_gateway { "\u{2713}" } else { "\u{2014}" };

    Line::from(vec![
        Span::styled(format!("{} ", if selected { ">" } else { " " }), base),
        Span::styled(
            format!(
                "{:<COL_ID$} ",
                truncate(&short_id(&card.workload_id), COL_ID)
            ),
            base.add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "{:<COL_LISTING$} ",
                truncate(
                    &format!(
                        "{} v{}",
                        card.lease.listing.name, card.lease.listing.version
                    ),
                    COL_LISTING
                )
            ),
            base,
        ),
        Span::styled(
            format!(
                "{:<COL_STATUS$} ",
                truncate(&status_word(&card.status), COL_STATUS)
            ),
            status_style(&card.status),
        ),
        Span::styled(format!("{runway_cell:<COL_RUNWAY$} "), runway_style),
        Span::styled(
            format!("{standby_cell:<COL_STANDBY$} "),
            base.fg(Color::Cyan),
        ),
        Span::styled(gateway_cell, base.fg(Color::DarkGray)),
    ])
}

fn draw_detail(
    frame: &mut Frame,
    area: Rect,
    card: Option<&WorkloadCard>,
    gateway_domain: Option<&str>,
) {
    let block = Block::default().title(" Detail ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(card) = card else {
        frame.render_widget(
            Paragraph::new("Select a workload to see its leases and access details.")
                .style(Style::default().fg(Color::DarkGray))
                .wrap(Wrap { trim: false }),
            inner,
        );
        return;
    };

    let mut lines = vec![
        Line::from(Span::styled(
            card.workload_id.clone(),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(vec![
            label("Listing "),
            Span::raw(format!(
                "{} v{}",
                card.lease.listing.name, card.lease.listing.version
            )),
            Span::raw("  "),
            label("Provider "),
            Span::raw(card.provider.ilp_address.clone()),
        ]),
    ];

    let runway = runway_text(card);
    let runway_style = if runway.low {
        Style::default()
            .fg(Color::Yellow)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    lines.push(Line::from(vec![
        label("Runway "),
        Span::styled(runway_sentence(card), runway_style),
    ]));

    if let Some(domain) = gateway_domain {
        if let Some(hostname) = gateway_hostname_for(&card.workload_id, domain) {
            lines.push(Line::from(vec![label("Gateway "), Span::raw(hostname)]));
        }
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(label("Leases (primary first)")));
    if card.members.is_empty() {
        lines.push(Line::from(Span::styled(
            "This account holds no lease record for this workload.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        for member in &card.members {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("  {:<11}", member.role),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("{:<16}", status_word(&member.status)),
                    status_style(&member.status),
                ),
                Span::styled(
                    format!(" {} v{}", member.listing.name, member.listing.version),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::raw(if member.running_now {
                    "  running now"
                } else {
                    ""
                }),
            ]));
        }
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(label("Access")));
    match running_access(card) {
        Some(access) => {
            lines.push(Line::from(vec![
                label("  Host "),
                Span::raw(access.host.clone()),
            ]));
            if let Some(port) = access.ssh_port {
                lines.push(Line::from(vec![
                    label("  SSH  "),
                    Span::raw(format!("ssh -p {port} tenant@{}", access.host)),
                ]));
            }
        }
        None => lines.push(Line::from(Span::styled(
            "  No access details yet.",
            Style::default().fg(Color::DarkGray),
        ))),
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(label("Most recent takeover")));
    match &card.set.takeover {
        Some(takeover) => {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::raw(short_id(&takeover.winner)),
                Span::raw(" runs this workload now"),
                Span::raw(match &takeover.from {
                    Some(from) => format!(", taken over from {}", short_id(from)),
                    None => String::new(),
                }),
                Span::raw("."),
            ]));
            let when = takeover
                .announced_at
                .clone()
                .unwrap_or_else(|| takeover.first_seen_at.clone());
            lines.push(Line::from(Span::styled(
                format!(
                    "  {} {when}{}",
                    if takeover.announced_at.is_some() {
                        "Announced"
                    } else {
                        "First seen"
                    },
                    match takeover.rounds {
                        Some(rounds) if rounds > 1 =>
                            format!(" \u{2014} changed hands {rounds} times"),
                        _ => String::new(),
                    }
                ),
                Style::default().fg(Color::DarkGray),
            )));
        }
        None => lines.push(Line::from(Span::styled(
            "  No Takeover has happened for this workload.",
            Style::default().fg(Color::DarkGray),
        ))),
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn label(text: &str) -> Span<'static> {
    Span::styled(
        text.to_string(),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        CardExtend, LeaseImage, LeaseView, ListingRef, OpRouteView, StandbySetView, TakeoverReport,
        WorkloadCardProvider, WorkloadMemberProvider, WorkloadMemberView,
    };
    use crossterm::event::KeyModifiers;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn listing(name: &str) -> ListingRef {
        ListingRef {
            name: name.to_string(),
            version: 1,
            lease_interval_s: 3600,
            price: 1000.0,
        }
    }

    fn card(workload_id: &str, phase: LeaseLife) -> WorkloadCard {
        WorkloadCard {
            workload_id: workload_id.to_string(),
            lease: LeaseView {
                workload_id: workload_id.to_string(),
                state: "live".to_string(),
                listing: listing("basic"),
                profile_id: "sandbox".to_string(),
                image: LeaseImage {
                    reference: Some("traefik/whoami".to_string()),
                    digest: "sha256:aa".to_string(),
                },
                local_only: false,
                access: Some(LeaseAccess {
                    host: "203.0.113.7".to_string(),
                    ssh_port: Some(40000),
                    ports: vec![],
                }),
                relays: vec!["wss://own.relay.test".to_string()],
            },
            provider: WorkloadCardProvider {
                ilp_address: "g.toon.provider".to_string(),
                hidden: false,
                liveness: Some("live".to_string()),
            },
            status: WorkloadStatus::Read {
                life: phase,
                access: Some(LeaseAccess {
                    host: "203.0.113.7".to_string(),
                    ssh_port: Some(40000),
                    ports: vec![],
                }),
            },
            runway: runway_computed(259_200), // 3 days: clearly "healthy"
            extend: CardExtend {
                ok: true,
                problems: vec![],
                route: Some(OpRouteView {
                    route: "g.toon.provider.basic.v1.extend".to_string(),
                    pay_at: "https://provider.example/ilp".to_string(),
                    reason: "reason".to_string(),
                    price: Some("1000".to_string()),
                    chain: Some("evm:31337".to_string()),
                }),
            },
            members: vec![WorkloadMemberView {
                pubkey: "d".repeat(64),
                role: "standalone".to_string(),
                provider: WorkloadMemberProvider {
                    ilp_address: "g.toon.provider".to_string(),
                    hidden: false,
                    liveness: Some("live".to_string()),
                },
                listing: listing("basic"),
                status: WorkloadStatus::Read {
                    life: LeaseLife::Running,
                    access: None,
                },
                running_now: true,
            }],
            set: StandbySetView {
                members: 1,
                warm: false,
                takeover: None,
            },
        }
    }

    fn runway_computed(seconds: i64) -> crate::types::RunwayView {
        crate::types::RunwayView {
            state: "computed".to_string(),
            reason: None,
            seconds: Some(seconds),
        }
    }

    fn dashboard(cards: Vec<WorkloadCard>) -> Dashboard {
        Dashboard {
            state: "ready".to_string(),
            pubkey: Some("a".repeat(64)),
            profile_id: "sandbox".to_string(),
            cards,
            unreadable: 0,
            checked_at: "2026-09-24T00:00:00.000Z".to_string(),
        }
    }

    fn render(state: &WorkloadsViewState) -> String {
        let backend = TestBackend::new(150, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                draw(
                    frame,
                    frame.area(),
                    state,
                    Some("gw.devnet.toonprotocol.dev"),
                )
            })
            .unwrap();
        buffer_to_string(terminal.backend().buffer())
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
    fn snapshot_empty() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![]));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_healthy() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![card(
            "b2e292ee009eb3fc064aaa7a1bc70a28adc1039f495751d4caa0cb9c08fd8abd",
            LeaseLife::Running,
        )]));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_low_runway() {
        let mut state = WorkloadsViewState::new();
        let mut low = card(
            "c3e292ee009eb3fc064aaa7a1bc70a28adc1039f495751d4caa0cb9c08fd8ab1",
            LeaseLife::Running,
        );
        low.runway = runway_computed(3600); // 1h — under the 24h floor
        state.dashboard = Some(dashboard(vec![low]));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_standby() {
        let mut state = WorkloadsViewState::new();
        let mut warm = card(
            "d3e292ee009eb3fc064aaa7a1bc70a28adc1039f495751d4caa0cb9c08fd8ab2",
            LeaseLife::Running,
        );
        warm.set = StandbySetView {
            members: 3,
            warm: true,
            takeover: None,
        };
        warm.members.push(WorkloadMemberView {
            pubkey: "e".repeat(64),
            role: "standby".to_string(),
            provider: WorkloadMemberProvider {
                ilp_address: "g.toon.other".to_string(),
                hidden: false,
                liveness: Some("live".to_string()),
            },
            listing: listing("basic"),
            status: WorkloadStatus::Read {
                life: LeaseLife::Reserved,
                access: None,
            },
            running_now: false,
        });
        state.dashboard = Some(dashboard(vec![warm]));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn snapshot_just_taken_over() {
        let mut state = WorkloadsViewState::new();
        let mut taken = card(
            "e3e292ee009eb3fc064aaa7a1bc70a28adc1039f495751d4caa0cb9c08fd8ab3",
            LeaseLife::Running,
        );
        taken.set = StandbySetView {
            members: 2,
            warm: true,
            takeover: Some(TakeoverReport {
                winner: "f".repeat(64),
                from: Some("d".repeat(64)),
                announced_at: Some("2026-09-24T10:00:00.000Z".to_string()),
                first_seen_at: "2026-09-24T10:00:05.000Z".to_string(),
                rounds: Some(1),
            }),
        };
        state.dashboard = Some(dashboard(vec![taken]));
        insta::assert_snapshot!(render(&state));
    }

    #[test]
    fn renders_the_real_daemon_fixture_without_panicking() {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/workloads.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read fixture {path}: {err}"));
        let dashboard: Dashboard = serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture {path} did not deserialize: {err}"));
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard);
        render(&state);
    }

    #[test]
    fn j_and_k_move_the_selection_and_slash_filters() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![
            card("a".repeat(64).as_str(), LeaseLife::Running),
            card("b".repeat(64).as_str(), LeaseLife::Running),
        ]));

        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('j'))),
            Some(Command::None)
        );
        assert_eq!(state.list.selected, 1);
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('k'))),
            Some(Command::None)
        );
        assert_eq!(state.list.selected, 0);
    }

    #[test]
    fn digit_keys_are_not_swallowed_so_view_switching_still_works() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![]));
        assert_eq!(handle_key(&mut state, key(KeyCode::Char('3'))), None);
    }

    #[test]
    fn e_on_a_running_lease_opens_a_confirm_with_the_price_and_leaves_the_network_untouched() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![card(&"a".repeat(64), LeaseLife::Running)]));

        let command = handle_key(&mut state, key(KeyCode::Char('e')));
        assert_eq!(command, Some(Command::None));
        let confirm = state.confirm.as_ref().expect("e opens a confirmation");
        assert!(confirm.lines.iter().any(|line| line.contains("1000")));
    }

    #[test]
    fn e_pressed_twice_does_not_extend_the_opening_key_is_not_the_confirming_key() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![card(&"a".repeat(64), LeaseLife::Running)]));
        handle_key(&mut state, key(KeyCode::Char('e')));
        assert!(state.confirm.is_some());
        // A second `e` (or any key that is not `yes`+Enter or `Esc`) must not
        // complete the extension — the modal is still open afterwards.
        let outcome = handle_key(&mut state, key(KeyCode::Char('e')));
        assert_eq!(outcome, Some(Command::None));
        assert!(
            state.confirm.is_some(),
            "still open: `e` typed into the word, not confirmed"
        );
    }

    #[test]
    fn typing_yes_and_enter_confirms_extend_as_a_command() {
        let mut state = WorkloadsViewState::new();
        let workload_id = "a".repeat(64);
        state.dashboard = Some(dashboard(vec![card(&workload_id, LeaseLife::Running)]));
        handle_key(&mut state, key(KeyCode::Char('e')));
        for c in "yes".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        let command = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(
            command,
            Some(Command::ExtendWorkload {
                workload_id: workload_id.clone(),
                max_price: Some("1000".to_string()),
            })
        );
        assert!(state.confirm.is_none());
    }

    #[test]
    fn x_on_an_ended_lease_refuses_with_a_status_message_and_opens_no_confirm() {
        let mut state = WorkloadsViewState::new();
        let ended = card(
            &"a".repeat(64),
            LeaseLife::Ended {
                ending: "termination".to_string(),
                word: None,
            },
        );
        state.dashboard = Some(dashboard(vec![ended]));
        handle_key(&mut state, key(KeyCode::Char('x')));
        assert!(state.confirm.is_none());
        assert!(state.status.is_some());
    }

    #[test]
    fn x_then_yes_enter_confirms_terminate() {
        let mut state = WorkloadsViewState::new();
        let workload_id = "a".repeat(64);
        state.dashboard = Some(dashboard(vec![card(&workload_id, LeaseLife::Running)]));
        handle_key(&mut state, key(KeyCode::Char('x')));
        for c in "yes".chars() {
            handle_key(&mut state, key(KeyCode::Char(c)));
        }
        let command = handle_key(&mut state, key(KeyCode::Enter));
        assert_eq!(
            command,
            Some(Command::TerminateWorkload {
                workload_id: workload_id.clone(),
            })
        );
    }

    #[test]
    fn esc_cancels_a_confirm_without_sending_a_command() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![card(&"a".repeat(64), LeaseLife::Running)]));
        handle_key(&mut state, key(KeyCode::Char('x')));
        let command = handle_key(&mut state, key(KeyCode::Esc));
        assert_eq!(command, Some(Command::None));
        assert!(state.confirm.is_none());
    }

    #[test]
    fn y_copies_an_ssh_command_when_a_port_is_known() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![card(&"a".repeat(64), LeaseLife::Running)]));
        let command = handle_key(&mut state, key(KeyCode::Char('y')));
        assert_eq!(
            command,
            Some(Command::CopyToClipboard(
                "ssh -p 40000 tenant@203.0.113.7".to_string()
            ))
        );
    }

    #[test]
    fn y_with_no_access_yet_sets_a_status_message_and_copies_nothing() {
        let mut state = WorkloadsViewState::new();
        let mut none_yet = card(&"a".repeat(64), LeaseLife::Provisioning);
        none_yet.lease.access = None;
        none_yet.status = WorkloadStatus::Read {
            life: LeaseLife::Provisioning,
            access: None,
        };
        none_yet.members[0].status = WorkloadStatus::Read {
            life: LeaseLife::Provisioning,
            access: None,
        };
        none_yet.members[0].running_now = false;
        state.dashboard = Some(dashboard(vec![none_yet]));
        let command = handle_key(&mut state, key(KeyCode::Char('y')));
        assert_eq!(command, Some(Command::None));
        assert!(state.status.is_some());
    }

    #[test]
    fn slash_typed_digits_go_into_the_filter_not_into_view_switching() {
        let mut state = WorkloadsViewState::new();
        state.dashboard = Some(dashboard(vec![card(&"a".repeat(64), LeaseLife::Running)]));
        handle_key(&mut state, key(KeyCode::Char('/')));
        let outcome = handle_key(&mut state, key(KeyCode::Char('1')));
        assert_eq!(outcome, Some(Command::None));
        assert_eq!(state.list.filter, "1");
    }
}
