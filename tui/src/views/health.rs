//! The Health view.
//!
//! A terminal mirror of `packages/ui/src/app/health-view.tsx`: the daemon's
//! own identity on the left, the active profile's connector — read live from
//! its own `GET /ilp`, nothing here is a constant — on the right, and a
//! Hidden Providers card underneath when the daemon reports one (spec §10).
//! The routes list starts collapsed to a count, same as the web view's
//! `<details>` — expanding it is left to a later ticket's `Enter` handling,
//! not built here.

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::format::{format_time_of_day, format_uptime};
use crate::types::{AnonTransportView, ConnectorHealth, Health, ProfileView};

pub fn draw(frame: &mut Frame, area: Rect, health: &Health) {
    let rows = if health.anon.is_some() {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(14), Constraint::Length(9)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(0)])
            .split(area)
    };

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(rows[0]);

    draw_daemon_card(frame, cols[0], health);
    draw_connector_card(frame, cols[1], &health.connector, &health.profile);

    if let Some(anon) = &health.anon {
        draw_anon_card(frame, rows[1], anon);
    }
}

fn label(text: &str) -> Span<'static> {
    Span::styled(
        text.to_string(),
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    )
}

fn field(name: &str, value: String) -> Line<'static> {
    Line::from(vec![label(&format!("{name}: ")), Span::raw(value)])
}

fn draw_daemon_card(frame: &mut Frame, area: Rect, health: &Health) {
    let block = Block::default().title(" Daemon ").borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let d = &health.daemon;
    let lines = vec![
        Line::from(Span::styled(
            "The service this window is talking to.",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )),
        Line::raw(""),
        field("Version", format!("{} {}", d.name, d.version)),
        field("Node", d.node.clone()),
        field("Uptime", format_uptime(d.uptime_seconds)),
        field("Channel state", health.storage.channels.clone()),
        field("Checked", format_time_of_day(&health.checked_at)),
    ];
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn connector_badge(connector: &ConnectorHealth) -> Span<'static> {
    match connector {
        ConnectorHealth::Ok { .. } => Span::styled(
            " answering ",
            Style::default().fg(Color::Black).bg(Color::Green),
        ),
        ConnectorHealth::Unreachable { .. } => Span::styled(
            " unreachable ",
            Style::default().fg(Color::White).bg(Color::Red),
        ),
        ConnectorHealth::Unconfigured { .. } => Span::styled(
            " not configured ",
            Style::default().fg(Color::Black).bg(Color::Yellow),
        ),
    }
}

fn draw_connector_card(
    frame: &mut Frame,
    area: Rect,
    connector: &ConnectorHealth,
    profile: &ProfileView,
) {
    let title = Line::from(vec![
        Span::styled(" Connector ", Style::default().add_modifier(Modifier::BOLD)),
        connector_badge(connector),
    ]);
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![
        Line::from(Span::styled(
            format!("{} — read live from GET /ilp.", profile.label),
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        )),
        Line::raw(""),
    ];

    match connector {
        ConnectorHealth::Unconfigured { reason } | ConnectorHealth::Unreachable { reason, .. } => {
            lines.push(Line::from(Span::styled(
                reason.clone(),
                Style::default().fg(Color::DarkGray),
            )));
        }
        ConnectorHealth::Ok {
            endpoint,
            ilp_addresses,
            settlements,
            routes,
            ..
        } => {
            lines.push(field("Endpoint", endpoint.clone()));
            lines.push(field("ILP addresses", ilp_addresses.join(", ")));
            lines.push(Line::raw(""));
            lines.push(Line::from(label("Settlement chains")));
            if settlements.is_empty() {
                lines.push(Line::from(Span::styled(
                    "This connector settles on no chain.",
                    Style::default().fg(Color::DarkGray),
                )));
            } else {
                for settlement in settlements {
                    lines.push(Line::from(vec![
                        Span::styled(
                            settlement.chain.clone(),
                            Style::default().add_modifier(Modifier::BOLD),
                        ),
                        Span::raw(format!(
                            "  {} decimals  settles with {}  token {}",
                            settlement.decimals,
                            settlement.settlement_address,
                            settlement.token_address
                        )),
                    ]));
                }
            }
            lines.push(Line::raw(""));
            lines.push(Line::from(label(&format!("Routes ({})", routes.len()))));
        }
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn anon_badge(anon: &AnonTransportView) -> Span<'static> {
    match anon.state.as_str() {
        "ready" => Span::styled(
            " circuit available ",
            Style::default().fg(Color::Black).bg(Color::Green),
        ),
        "unconfigured" => Span::styled(" unconfigured ", Style::default().fg(Color::DarkGray)),
        _ => Span::styled(
            format!(" {} ", anon.state.replace('_', " ")),
            Style::default().fg(Color::White).bg(Color::Red),
        ),
    }
}

fn draw_anon_card(frame: &mut Frame, area: Rect, anon: &AnonTransportView) {
    let title = Line::from(vec![
        Span::styled(
            " Hidden Providers ",
            Style::default().add_modifier(Modifier::BOLD),
        ),
        anon_badge(anon),
    ]);
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![Line::from(Span::styled(
        "A Hidden Provider is reached over an Anyone Protocol circuit, or not at all.",
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    ))];
    if let Some(proxy) = &anon.socks_proxy {
        lines.push(field("SOCKS proxy", proxy.clone()));
    }
    lines.push(Line::from(Span::styled(
        anon.reason.clone(),
        Style::default().fg(Color::DarkGray),
    )));
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AnonTransportView, ConnectorHealth, DaemonInfo, ProfileRpc, ProfileView, RouteView,
        SettlementView, StorageView,
    };
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    /// A hand-built, DETERMINISTIC `Health`, for the snapshot below.
    ///
    /// Deliberately not read from `packages/daemon/fixtures/api/health.json`:
    /// that file is the daemon's REAL response, regenerated (with a fresh
    /// uptime, `checkedAt` and tempdir-based storage paths) every time
    /// `npm test` runs in `packages/daemon` — exactly what its OWN job is
    /// (`tests/fixture_contract.rs` checks it still deserializes). An insta
    /// snapshot needs the opposite: the same bytes every time. So the
    /// contract test reads the real fixture, and this one builds its own.
    fn sample_health() -> Health {
        Health {
            daemon: DaemonInfo {
                name: "@toon-protocol/console-daemon".to_string(),
                version: "0.1.0".to_string(),
                node: "v22.11.0".to_string(),
                pid: 4242,
                started_at: "2026-09-24T00:00:00.000Z".to_string(),
                uptime_seconds: 213_416,
            },
            profile: ProfileView {
                id: "devnet".to_string(),
                label: "Devnet".to_string(),
                description: "TOON Network's public test network.".to_string(),
                connector_url: "https://proxy.relay.devnet.toonprotocol.dev/ilp".to_string(),
                relay_url: "wss://relay-ws.devnet.toonprotocol.dev".to_string(),
                gateway_domain: "gw.devnet.toonprotocol.dev".to_string(),
                gateway_connector_url: "https://proxy.gateway.devnet.toonprotocol.dev/ilp"
                    .to_string(),
                faucet_url: Some("https://faucet.devnet.toonprotocol.dev".to_string()),
                rpc: Some(ProfileRpc {
                    evm: None,
                    solana: None,
                }),
                origin: "built-in".to_string(),
                configured: true,
                active: true,
            },
            connector: ConnectorHealth::Ok {
                endpoint: "https://connector.example".to_string(),
                self_endpoint: "https://connector.example".to_string(),
                ilp_addresses: vec!["g.toon.relay".to_string()],
                settlements: vec![SettlementView {
                    chain: "evm:84532".to_string(),
                    kind: "evm".to_string(),
                    settlement_address: "0x3f43".to_string(),
                    token_address: "0x49be".to_string(),
                    decimals: 6,
                }],
                routes: vec![RouteView {
                    prefix: "g.toon.relay".to_string(),
                    price: "1".to_string(),
                    price_per_kib: None,
                }],
                peer_carriages: vec![],
                edge_key_id: None,
                supported_versions: vec![1],
            },
            anon: Some(AnonTransportView {
                state: "ready".to_string(),
                socks_proxy: Some("socks5h://127.0.0.1:9050".to_string()),
                reason: "A SOCKS5h proxy answered at socks5h://127.0.0.1:9050, so a `.anyone` address can be dialled."
                    .to_string(),
            }),
            storage: StorageView {
                data: "/home/tester/.local/share/toon-console".to_string(),
                config: "/home/tester/.config/toon-console".to_string(),
                runtime: "/run/user/1000/toon-console".to_string(),
                channels: "/home/tester/.local/share/toon-console/profiles/devnet/channels/channels.json"
                    .to_string(),
            },
            checked_at: "2026-09-24T11:16:55.000Z".to_string(),
        }
    }

    fn real_daemon_fixture() -> Health {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/health.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read fixture {path}: {err}"));
        serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture {path} did not deserialize as Health: {err}"))
    }

    fn render(health: &Health) -> String {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), health))
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
    fn renders_the_sample_health() {
        insta::assert_snapshot!(render(&sample_health()));
    }

    /// The daemon's own real, volatile answer must still render without
    /// panicking — no snapshot assertion here (its uptime, timestamp and
    /// storage paths differ on every regeneration), just proof this view
    /// survives contact with the real shape `packages/daemon` produces today,
    /// not only the tidy one this file made up above.
    #[test]
    fn renders_the_real_daemon_fixture_without_panicking() {
        render(&real_daemon_fixture());
    }
}
