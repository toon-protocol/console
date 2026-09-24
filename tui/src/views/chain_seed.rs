//! The Chain Seed section of the Account view (TOON_Network#142, ADR 0020).
//!
//! A terminal mirror of `packages/ui/src/app/chain-seed-view.tsx`
//! (`ChainSeedCard`) and `packages/ui/src/hooks/use-chain-seed.ts`: what
//! state an account's Chain Seed is in — none, minted or imported and held
//! on this disk alone, published, or a record this signer cannot open — and
//! the actions the web UI offers from each one: acknowledge the custody
//! warning, mint, import a mnemonic (masked), publish, and refresh.
//!
//! This module draws its own block and owns its own [`Target`] list and
//! [`ChainSeedViewState`], but it is not a view of its own — `views::account`
//! renders it inside the Account view's signed-in section (the same
//! stacking `console-app.tsx` uses for `AccountCard` then `ChainSeedCard`)
//! and folds [`Target`] into its own cursor via `Target::ChainSeed`, so
//! `j`/`k` and `Enter` work the same way across both sections. See
//! `views::account`'s module doc comment for how that wiring works.
//!
//! **Publishing is a paid relay write (#120, #121)**, so `Target::Publish`
//! does not fire [`crate::app::Command::PublishChainSeed`] directly — it
//! opens a [`Confirm`] (via [`activate`]), and only typing `yes` then
//! `Enter` into that modal produces the command — the same shared confirm
//! widget TOON_Network#143's Workloads view built (this view originally had
//! its own minimal `y`-then-`Enter` modal; ported onto the shared one once
//! it landed). See `widgets::confirm` and `views::account::handle_key`'s
//! check at its top.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::types::{ChainAddress, ChainSeedState, ChainSeedStatus, RelayWriteTargets, SeedOrigin};
use crate::widgets::confirm::Confirm;
use crate::widgets::input::TextField;

/// One focusable thing in the Chain Seed section, in the order it is drawn.
/// Built fresh from the current `ChainSeedStatus` by [`targets`] — never
/// stored — the same discipline `views::account::Target` follows and for
/// the same reason: what is focusable can only be what is actually on
/// screen this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// The custody warning's "I understand — continue" button.
    Acknowledge,
    Mint,
    /// Opens or closes the import form — a state change, not a command.
    ToggleImport,
    /// The masked mnemonic field. `views::account` puts this view's own
    /// `editing` flag into play for it, the same as every other text field
    /// on the Account view — see that module's doc comment.
    Mnemonic,
    ImportSubmit,
    /// Opens the confirm modal; typing `yes` then `Enter` into it is what
    /// actually fires [`Command::PublishChainSeed`].
    Publish,
    /// "Read from relays again" — shown only where the web UI shows it, on
    /// the `Ready` state.
    Refresh,
}

/// This section's own state: the import form's open/closed flag, the
/// mnemonic field (masked, zeroizing — see `widgets::input`), and the
/// publish confirm modal. Holds no cursor of its own — `views::account`'s
/// cursor walks [`Target::ChainSeed`] alongside its own targets.
pub struct ChainSeedViewState {
    pub show_import: bool,
    pub mnemonic: TextField,
    /// `None` when closed. The carried `()` is a placeholder action: unlike
    /// Funds' or Workloads' confirms, there is only ever one thing to
    /// confirm here (publish), so nothing needs to travel with it — the
    /// confirmed outcome itself is what tells `handle_key` to fire
    /// `Command::PublishChainSeed`.
    pub confirm: Option<Confirm<()>>,
}

impl ChainSeedViewState {
    pub fn new() -> Self {
        Self {
            show_import: false,
            mnemonic: TextField::new("12 or 24 BIP-39 words", true),
            confirm: None,
        }
    }
}

impl Default for ChainSeedViewState {
    fn default() -> Self {
        Self::new()
    }
}

/// The targets this state offers, mirroring exactly which buttons
/// `chain-seed-view.tsx` renders for each `ChainSeedStatus.state` — a state
/// this view has no button for (`SignedOut`, `Unreadable`) gets none.
pub fn targets(status: Option<&ChainSeedStatus>, show_import: bool) -> Vec<Target> {
    let Some(status) = status else {
        return Vec::new();
    };
    let mut out = Vec::new();
    match status.state {
        ChainSeedState::SignedOut | ChainSeedState::Unreadable => {}
        ChainSeedState::Unknown | ChainSeedState::Absent => {
            if status.warning.acknowledged_at.is_none() {
                out.push(Target::Acknowledge);
            } else {
                out.push(Target::Mint);
                out.push(Target::ToggleImport);
                if show_import {
                    out.push(Target::Mnemonic);
                    out.push(Target::ImportSubmit);
                }
            }
        }
        ChainSeedState::NotYetRecoverable => {
            out.push(Target::Publish);
        }
        ChainSeedState::Ready => {
            out.push(Target::Refresh);
        }
    }
    out
}

/// What this section offers `y` (TOON_Network#138): each chain's derived
/// address, and the published record's id once there is one — never the
/// mnemonic, never anything held-but-unpublished (`status.held` carries no
/// address of its own to offer, and the warning/held text is prose, not a
/// value worth copying). `views::account::copyables` appends this to its own
/// list, the same way this section's `Target`s fold into that view's cursor.
pub fn copyables(status: Option<&ChainSeedStatus>) -> Vec<(String, String)> {
    let Some(status) = status else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(addresses) = &status.addresses {
        out.push((
            "Chain Seed EVM address".to_string(),
            addresses.evm.address.clone(),
        ));
        out.push((
            "Chain Seed Solana address".to_string(),
            addresses.solana.address.clone(),
        ));
    }
    if let Some(record) = &status.record {
        out.push(("Chain Seed record id".to_string(), record.event_id.clone()));
    }
    out
}

/// Whether the daemon has yet to look for this account's seed on its relays:
/// `unknown` means nobody has asked, so neither "none yet" nor a published
/// record can be told apart. The runtime asks once per signed-in pubkey (a
/// free relay read, `POST /api/chain-seed/refresh`) — without it a fresh
/// sign-in sat on "reading…" until something else happened to look.
/// `read_for` is the pubkey that first read was already asked for.
pub fn first_read_needed(status: &ChainSeedStatus, read_for: Option<&str>) -> bool {
    status.state == ChainSeedState::Unknown
        && status.pubkey.is_some()
        && status.pubkey.as_deref() != read_for
}

/// Turns an `Enter` on `target` into a state change or a [`Command`], the
/// same contract `views::account::activate` follows. `Target::Mnemonic` is
/// handled by the caller (`views::account`) before this is reached — see the
/// module doc comment — but is matched here too so this function stays
/// total and safe to call on its own (its unit tests do exactly that).
pub fn activate(
    state: &mut ChainSeedViewState,
    status: Option<&ChainSeedStatus>,
    target: Target,
) -> Command {
    match target {
        Target::Acknowledge => Command::AcknowledgeChainSeedWarning,
        Target::Mint => Command::MintChainSeed,
        Target::ToggleImport => {
            state.show_import = !state.show_import;
            Command::None
        }
        Target::Mnemonic => Command::None,
        Target::ImportSubmit => {
            if state.mnemonic.is_empty() {
                return Command::None;
            }
            state.show_import = false;
            Command::ImportChainSeed(state.mnemonic.take())
        }
        Target::Publish => {
            state.confirm = Some(Confirm::new(
                "Publish the Chain Seed",
                confirm_body(status),
                (),
            ));
            Command::None
        }
        Target::Refresh => Command::RefreshChainSeed,
    }
}

/// The confirm modal's body: the daemon's own cost figure when it has quoted
/// one, and why not when it has not — never a price this crate computed.
fn confirm_body(status: Option<&ChainSeedStatus>) -> Vec<String> {
    let mut lines = vec![
        "This is a paid relay write (TOON_Network#120), paid from this account's own \
         channel. It cannot be undone."
            .to_string(),
    ];
    match status.map(|status| &status.writes) {
        Some(writes) if writes.ready => lines.push(cost_line(writes)),
        Some(writes) => {
            lines.push(writes.blocked_by.clone().unwrap_or_else(|| {
                "This network cannot pay for a relay write right now.".to_string()
            }))
        }
        None => lines.push("Reading what this write would cost…".to_string()),
    }
    lines
}

/// "One packet: 1 base units…" / "3 packets, one per relay: 12 base units…"
/// — the daemon's own `totalPrice`/`price`, never a figure computed here
/// (mirrors `PerRelayCost` and the publish button's caption in
/// `chain-seed-view.tsx`).
fn cost_line(writes: &RelayWriteTargets) -> String {
    let packets = if writes.relays.len() == 1 {
        "One packet".to_string()
    } else {
        format!("{} packets, one per relay", writes.relays.len())
    };
    let amount = writes
        .total_price
        .as_deref()
        .or(writes.price.as_deref())
        .unwrap_or("an unknown amount of");
    format!("{packets}: {amount} base units of the settlement token in total.")
}

/// How tall this section needs to be, roughly — the same fixed-height
/// discipline `views::account::draw` already uses for its other rows
/// (`profiles_height`, `saved_height`): generous enough for every state's
/// content to fit inside a normal terminal, not a measurement of the exact
/// text this frame holds.
pub fn height(status: Option<&ChainSeedStatus>) -> u16 {
    match status.map(|status| status.state) {
        None | Some(ChainSeedState::SignedOut) => 3,
        Some(ChainSeedState::Unreadable) => 7,
        Some(ChainSeedState::Unknown) | Some(ChainSeedState::Absent) => 16,
        Some(ChainSeedState::NotYetRecoverable) => 20,
        Some(ChainSeedState::Ready) => 13,
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

pub fn draw(
    frame: &mut Frame,
    area: Rect,
    state: &ChainSeedViewState,
    status: Option<&ChainSeedStatus>,
    focused: impl Fn(Target) -> bool,
) {
    let title = format!(" Chain Seed{} ", badge(status));
    let block = Block::default().title(title).borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let Some(status) = status else {
        frame.render_widget(
            Paragraph::new("Reading…").style(Style::default().fg(Color::DarkGray)),
            inner,
        );
        return;
    };

    match status.state {
        ChainSeedState::SignedOut => {}
        ChainSeedState::Unknown | ChainSeedState::Absent => {
            if status.warning.acknowledged_at.is_none() {
                draw_warning(frame, inner, status, focused);
            } else {
                draw_mint_import(frame, inner, state, focused);
            }
        }
        ChainSeedState::NotYetRecoverable => draw_held(frame, inner, status, focused),
        ChainSeedState::Ready => draw_ready(frame, inner, status, focused),
        ChainSeedState::Unreadable => draw_unreadable(frame, inner, status),
    }
    // The confirm modal itself is NOT drawn here: `views::account::draw`
    // layers it over the whole Account view (better centred than this
    // section's own, often short, row) after calling this function — see
    // that module's doc comment and `renders_the_confirm_modal_over_the_held_state`
    // there.
}

/// " — reading…" / " — none yet" / … — the state badge, mirroring
/// `StateBadge` in `chain-seed-view.tsx`. Folded into the block's own title
/// rather than a separate widget: this section has one block, and ratatui
/// has no notion of a badge inside a border's own title line beyond text.
fn badge(status: Option<&ChainSeedStatus>) -> String {
    let Some(status) = status else {
        return String::new();
    };
    let text = match status.state {
        ChainSeedState::SignedOut => return String::new(),
        ChainSeedState::Unknown => "reading…",
        ChainSeedState::Absent => "none yet",
        ChainSeedState::NotYetRecoverable => "not yet recoverable",
        ChainSeedState::Unreadable => "not readable",
        ChainSeedState::Ready => match status.origin {
            Some(SeedOrigin::Imported) => "imported",
            _ => "minted",
        },
    };
    format!(" — {text}")
}

fn button_line(label: &str, focused: bool) -> Line<'static> {
    let style = if focused {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().add_modifier(Modifier::BOLD)
    };
    Line::from(Span::styled(format!(" {label} "), style))
}

fn warning_lines(text: &str) -> Vec<Line<'static>> {
    vec![
        Line::styled(
            "Before this account has any money in it",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
        Line::raw(text.to_string()),
    ]
}

fn draw_warning(
    frame: &mut Frame,
    area: Rect,
    status: &ChainSeedStatus,
    focused: impl Fn(Target) -> bool,
) {
    let mut lines = warning_lines(&status.warning.text);
    lines.push(Line::raw(""));
    lines.push(button_line(
        "I understand — continue",
        focused(Target::Acknowledge),
    ));
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn draw_mint_import(
    frame: &mut Frame,
    area: Rect,
    state: &ChainSeedViewState,
    focused: impl Fn(Target) -> bool,
) {
    let mut lines = vec![
        Line::raw(
            "This account has no Chain Seed yet. Mint a new one, or import a phrase you \
             already use.",
        ),
        Line::raw(""),
        button_line("Mint a Chain Seed", focused(Target::Mint)),
        button_line("Import a mnemonic", focused(Target::ToggleImport)),
    ];
    if state.show_import {
        lines.push(Line::raw(""));
        lines.push(state.mnemonic.line(focused(Target::Mnemonic)));
        lines.push(Line::styled(
            "Sealed to this account and held on this machine until you publish it; never \
             shown again.",
            Style::default().fg(Color::DarkGray),
        ));
        lines.push(button_line(
            "Import as the Chain Seed",
            focused(Target::ImportSubmit),
        ));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn address_lines(evm: &ChainAddress, solana: &ChainAddress) -> Vec<Line<'static>> {
    vec![
        Line::from(vec![
            Span::styled(
                "EVM (Base): ",
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(evm.address.clone()),
            Span::styled(
                format!("  ({})", evm.path),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(vec![
            Span::styled(
                "Solana: ",
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(solana.address.clone()),
            Span::styled(
                format!("  ({})", solana.path),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
    ]
}

fn draw_held(
    frame: &mut Frame,
    area: Rect,
    status: &ChainSeedStatus,
    focused: impl Fn(Target) -> bool,
) {
    let Some(held) = &status.held else {
        frame.render_widget(
            Paragraph::new("Held, but this build has nothing to show for it."),
            area,
        );
        return;
    };
    let mut lines = vec![Line::styled(
        "This Chain Seed is NOT YET RECOVERABLE",
        Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
    )];
    lines.push(Line::raw(held.text.clone()));
    for (index, step) in held.steps.iter().enumerate() {
        lines.push(Line::raw(format!("{}. {step}", index + 1)));
    }
    if let Some(last) = &held.last_attempt {
        lines.push(Line::styled(
            format!("The last attempt to publish it: {last}"),
            Style::default().fg(Color::DarkGray),
        ));
    }
    if let Some(addresses) = &status.addresses {
        lines.push(Line::raw(""));
        lines.extend(address_lines(&addresses.evm, &addresses.solana));
    }
    lines.push(Line::raw(""));
    lines.push(button_line("Publish", focused(Target::Publish)));
    lines.push(if status.writes.ready {
        Line::raw(cost_line(&status.writes))
    } else {
        Line::styled(
            status.writes.blocked_by.clone().unwrap_or_else(|| {
                "This network cannot pay for a relay write right now.".to_string()
            }),
            Style::default().fg(Color::DarkGray),
        )
    });
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn draw_ready(
    frame: &mut Frame,
    area: Rect,
    status: &ChainSeedStatus,
    focused: impl Fn(Target) -> bool,
) {
    let mut lines = Vec::new();
    if let Some(addresses) = &status.addresses {
        lines.extend(address_lines(&addresses.evm, &addresses.solana));
    }
    if let Some(record) = &status.record {
        lines.push(Line::raw(""));
        let where_from = match record.source {
            crate::types::RecordSource::Cache => {
                "Read from this machine's cache; no relay answered.".to_string()
            }
            crate::types::RecordSource::Relays => {
                format!("Read from {}.", record.relays.join(", "))
            }
        };
        lines.push(Line::styled(
            format!(
                "{where_from} Published {}.",
                short_date(&record.published_at)
            ),
            Style::default().fg(Color::DarkGray),
        ));
    }
    lines.push(Line::raw(""));
    lines.push(button_line(
        "Read from relays again",
        focused(Target::Refresh),
    ));
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

fn short_date(iso: &str) -> &str {
    iso.get(0..10).unwrap_or(iso)
}

fn draw_unreadable(frame: &mut Frame, area: Rect, status: &ChainSeedStatus) {
    let mut lines = vec![Line::raw(
        "This account has a Chain Seed record, but the signer in use did not open it.",
    )];
    if let Some(reason) = &status.reason {
        lines.push(Line::styled(
            reason.clone(),
            Style::default().fg(Color::Red),
        ));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        ChainAddresses, ChainSeedRelayList, ChainSeedRelayListState, ChainSeedWarning,
        HeldSeedView, RecordSource, RelayWriteTarget, SeedRecordView,
    };
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::fs;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn address(address: &str, path: &str) -> ChainAddress {
        ChainAddress {
            address: address.to_string(),
            path: path.to_string(),
        }
    }

    fn addresses() -> ChainAddresses {
        ChainAddresses {
            evm: address(
                "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
                "m/44'/60'/0'/0/0",
            ),
            solana: address(
                "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
                "m/44'/501'/0'/0'",
            ),
        }
    }

    fn empty_relay_list() -> ChainSeedRelayList {
        ChainSeedRelayList {
            state: ChainSeedRelayListState::None,
            read: vec![],
            write: vec![],
            published_at: None,
        }
    }

    fn ready_writes() -> RelayWriteTargets {
        RelayWriteTargets {
            relays: vec!["wss://relay.toon.test".to_string()],
            plan: vec![RelayWriteTarget {
                url: "wss://relay.toon.test".to_string(),
                ready: true,
                destination: Some("g.toon.relay".to_string()),
                pay_at: Some("https://connector.test/ilp".to_string()),
                price: Some("1".to_string()),
                chain: Some("evm:31337".to_string()),
                channel_id: Some("0xchannel".to_string()),
                code: None,
                reason: None,
            }],
            destination: Some("g.toon.relay".to_string()),
            pay_at: Some("https://connector.test/ilp".to_string()),
            price: Some("1".to_string()),
            total_price: Some("1".to_string()),
            ready: true,
            blocked_by: None,
        }
    }

    fn blocked_writes() -> RelayWriteTargets {
        RelayWriteTargets {
            relays: vec!["wss://relay.toon.test".to_string()],
            plan: vec![RelayWriteTarget {
                url: "wss://relay.toon.test".to_string(),
                ready: false,
                destination: None,
                pay_at: None,
                price: None,
                chain: None,
                channel_id: None,
                code: Some("no_channel".to_string()),
                reason: Some("This account holds no payment channel.".to_string()),
            }],
            destination: None,
            pay_at: None,
            price: None,
            total_price: None,
            ready: false,
            blocked_by: Some("This account holds no payment channel.".to_string()),
        }
    }

    fn warning(acknowledged: bool) -> ChainSeedWarning {
        ChainSeedWarning {
            text: "Whoever holds this account's Nostr key holds its funds.".to_string(),
            acknowledged_at: acknowledged.then(|| "2026-09-24T00:00:00.000Z".to_string()),
        }
    }

    fn base(state: ChainSeedState, acknowledged: bool) -> ChainSeedStatus {
        ChainSeedStatus {
            state,
            pubkey: Some(
                "e1c1195c6cb14c75a21c93445cd07025665133ea6bcc19ab55b03758f6272a68".to_string(),
            ),
            addresses: None,
            origin: None,
            record: None,
            held: None,
            relay_list: empty_relay_list(),
            writes: ready_writes(),
            warning: warning(acknowledged),
            superseded_seeds: 0,
            last_publish: None,
            reason: None,
            checked_at: "2026-09-24T12:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn an_unknown_seed_is_read_once_per_account() {
        let mut status = unknown_status();
        status.pubkey = Some("aa".to_string());
        assert!(first_read_needed(&status, None));
        assert!(!first_read_needed(&status, Some("aa")));
        assert!(first_read_needed(&status, Some("bb")));
        assert!(!first_read_needed(&absent_unacknowledged_status(), None));
        assert!(!first_read_needed(&ready_status(), None));
    }

    fn unknown_status() -> ChainSeedStatus {
        let mut status = base(ChainSeedState::Unknown, false);
        status.writes = RelayWriteTargets {
            relays: vec![],
            plan: vec![],
            destination: None,
            pay_at: None,
            price: None,
            total_price: None,
            ready: false,
            blocked_by: Some("Nothing has asked yet.".to_string()),
        };
        status
    }

    fn absent_unacknowledged_status() -> ChainSeedStatus {
        base(ChainSeedState::Absent, false)
    }

    fn absent_acknowledged_status() -> ChainSeedStatus {
        base(ChainSeedState::Absent, true)
    }

    fn held_status() -> ChainSeedStatus {
        let mut status = base(ChainSeedState::NotYetRecoverable, true);
        status.addresses = Some(addresses());
        status.origin = Some(SeedOrigin::Minted);
        status.held = Some(HeldSeedView {
            since: "2026-09-24T00:00:00.000Z".to_string(),
            origin: "minted".to_string(),
            text: "This Chain Seed is NOT YET RECOVERABLE. It is sealed on this machine and \
                   on nothing else."
                .to_string(),
            steps: vec![
                "Send the chain's own coin to the payer address below.".to_string(),
                "Fund that address with the settlement token.".to_string(),
                "Open a payment channel with this network's connector.".to_string(),
                "Publish the Chain Seed record.".to_string(),
            ],
            last_attempt: None,
        });
        status
    }

    fn held_blocked_status() -> ChainSeedStatus {
        let mut status = held_status();
        status.writes = blocked_writes();
        status
    }

    fn ready_status() -> ChainSeedStatus {
        let mut status = base(ChainSeedState::Ready, true);
        status.addresses = Some(addresses());
        status.origin = Some(SeedOrigin::Minted);
        status.record = Some(SeedRecordView {
            event_id: "b10802ff3450ff64ca2560758ffd5ebb191339db21ec769efd7dc788f0fa2988"
                .to_string(),
            published_at: "2026-09-24T12:01:14.000Z".to_string(),
            source: RecordSource::Relays,
            relays: vec!["wss://relay.toon.test".to_string()],
        });
        status
    }

    fn unreadable_status() -> ChainSeedStatus {
        let mut status = base(ChainSeedState::Unreadable, false);
        status.reason =
            Some("This account's key does not open that record: invalid MAC".to_string());
        status
    }

    // -- copyables (TOON_Network#138) ----------------------------------------

    #[test]
    fn copyables_is_empty_with_no_status() {
        assert_eq!(copyables(None), Vec::<(String, String)>::new());
    }

    #[test]
    fn copyables_offers_both_addresses_and_the_record_id_once_ready() {
        let status = ready_status();
        let items = copyables(Some(&status));
        assert_eq!(
            items,
            vec![
                (
                    "Chain Seed EVM address".to_string(),
                    status.addresses.as_ref().unwrap().evm.address.clone()
                ),
                (
                    "Chain Seed Solana address".to_string(),
                    status.addresses.as_ref().unwrap().solana.address.clone()
                ),
                (
                    "Chain Seed record id".to_string(),
                    status.record.as_ref().unwrap().event_id.clone()
                ),
            ]
        );
    }

    #[test]
    fn copyables_offers_nothing_before_a_seed_exists() {
        assert_eq!(copyables(Some(&unknown_status())), Vec::new());
    }

    // -- key handling: pure state, no rendering ------------------------------

    #[test]
    fn unknown_and_absent_offer_only_acknowledge_before_the_warning_is_read() {
        assert_eq!(
            targets(Some(&unknown_status()), false),
            vec![Target::Acknowledge]
        );
        assert_eq!(
            targets(Some(&absent_unacknowledged_status()), false),
            vec![Target::Acknowledge]
        );
    }

    #[test]
    fn absent_and_acknowledged_offers_mint_and_the_import_toggle() {
        assert_eq!(
            targets(Some(&absent_acknowledged_status()), false),
            vec![Target::Mint, Target::ToggleImport]
        );
    }

    #[test]
    fn opening_import_adds_the_mnemonic_field_and_submit() {
        assert_eq!(
            targets(Some(&absent_acknowledged_status()), true),
            vec![
                Target::Mint,
                Target::ToggleImport,
                Target::Mnemonic,
                Target::ImportSubmit
            ]
        );
    }

    #[test]
    fn not_yet_recoverable_offers_only_publish() {
        assert_eq!(targets(Some(&held_status()), false), vec![Target::Publish]);
    }

    #[test]
    fn ready_offers_only_refresh() {
        assert_eq!(targets(Some(&ready_status()), false), vec![Target::Refresh]);
    }

    #[test]
    fn unreadable_and_signed_out_and_missing_offer_nothing() {
        assert_eq!(targets(Some(&unreadable_status()), false), Vec::new());
        assert_eq!(
            targets(Some(&base(ChainSeedState::SignedOut, false)), false),
            Vec::new()
        );
        assert_eq!(targets(None, false), Vec::new());
    }

    #[test]
    fn acknowledge_fires_the_command_directly_no_confirmation_needed() {
        let mut state = ChainSeedViewState::new();
        let status = absent_unacknowledged_status();
        assert_eq!(
            activate(&mut state, Some(&status), Target::Acknowledge),
            Command::AcknowledgeChainSeedWarning
        );
    }

    #[test]
    fn mint_fires_the_command_directly_no_confirmation_needed() {
        let mut state = ChainSeedViewState::new();
        let status = absent_acknowledged_status();
        assert_eq!(
            activate(&mut state, Some(&status), Target::Mint),
            Command::MintChainSeed
        );
    }

    #[test]
    fn toggle_import_opens_and_closes_the_form_without_a_command() {
        let mut state = ChainSeedViewState::new();
        assert!(!state.show_import);
        let command = activate(&mut state, None, Target::ToggleImport);
        assert_eq!(command, Command::None);
        assert!(state.show_import);
        activate(&mut state, None, Target::ToggleImport);
        assert!(!state.show_import);
    }

    #[test]
    fn import_submit_is_a_no_op_with_a_blank_mnemonic() {
        let mut state = ChainSeedViewState::new();
        assert_eq!(
            activate(&mut state, None, Target::ImportSubmit),
            Command::None
        );
    }

    #[test]
    fn import_submit_takes_the_typed_words_clears_the_field_and_closes_the_form() {
        let mut state = ChainSeedViewState::new();
        state.show_import = true;
        for c in "abandon abandon about".chars() {
            state.mnemonic.handle_key(key(KeyCode::Char(c)));
        }
        let command = activate(&mut state, None, Target::ImportSubmit);
        assert_eq!(
            command,
            Command::ImportChainSeed("abandon abandon about".to_string())
        );
        assert_eq!(state.mnemonic.value(), "", "the typed words do not linger");
        assert!(!state.show_import, "a submitted import closes its own form");
    }

    #[test]
    fn publish_opens_the_confirm_modal_instead_of_firing_the_command() {
        let mut state = ChainSeedViewState::new();
        let status = held_status();
        let command = activate(&mut state, Some(&status), Target::Publish);
        assert_eq!(
            command,
            Command::None,
            "Publish must not fire a command directly — see the confirm modal"
        );
        assert!(state.confirm.is_some());
    }

    #[test]
    fn the_confirm_modal_shows_the_cost_the_daemon_reported() {
        let mut state = ChainSeedViewState::new();
        let status = held_status();
        activate(&mut state, Some(&status), Target::Publish);
        // The modal's own render is exercised below; here the point is only
        // that `confirm_body` reaches into `writes` rather than inventing a
        // number — a regression here would show up as "an unknown amount of"
        // in the modal even though the fixture quotes "1".
        assert!(confirm_body(Some(&status))
            .iter()
            .any(|line| line.contains('1')));
    }

    #[test]
    fn the_confirm_modal_explains_why_when_the_write_cannot_be_paid_for() {
        let status = held_blocked_status();
        assert!(confirm_body(Some(&status))
            .iter()
            .any(|line| line.contains("no payment channel")));
    }

    #[test]
    fn refresh_fires_the_command_directly_no_confirmation_needed() {
        let mut state = ChainSeedViewState::new();
        assert_eq!(
            activate(&mut state, Some(&ready_status()), Target::Refresh),
            Command::RefreshChainSeed
        );
        assert!(
            state.confirm.is_none(),
            "reading again is free — it must never open a confirmation"
        );
    }

    #[test]
    fn one_keypress_alone_can_never_publish_end_to_end() {
        // The same "one keypress cannot pass" rule `widgets::confirm` tests
        // on its own, exercised through this view's real path: opening the
        // modal via `activate`, then a single `Enter` — the fat-finger case
        // a person actually hits.
        let mut state = ChainSeedViewState::new();
        activate(&mut state, Some(&held_status()), Target::Publish);
        assert!(state.confirm.is_some());
        let outcome = state
            .confirm
            .as_mut()
            .unwrap()
            .handle_key(key(KeyCode::Enter));
        assert_eq!(outcome, crate::widgets::confirm::ConfirmOutcome::Pending);
        assert!(
            state.confirm.is_some(),
            "an Enter with nothing typed must not confirm or close the modal"
        );
    }

    // -- rendering ------------------------------------------------------------

    fn render(draw_fn: impl FnOnce(&mut Frame)) -> String {
        let backend = TestBackend::new(90, 28);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw_fn(frame)).unwrap();
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

    macro_rules! snapshot_state {
        ($name:ident, $status:expr) => {
            #[test]
            fn $name() {
                let state = ChainSeedViewState::new();
                let status = $status;
                let output = render(|frame| {
                    draw(frame, frame.area(), &state, Some(&status), |_| false);
                });
                insta::assert_snapshot!(output);
            }
        };
    }

    #[test]
    fn renders_before_any_status_has_arrived() {
        let state = ChainSeedViewState::new();
        let output = render(|frame| {
            draw(frame, frame.area(), &state, None, |_| false);
        });
        insta::assert_snapshot!(output);
    }

    #[test]
    fn renders_nothing_extra_for_a_signed_out_status() {
        // Mirrors `ChainSeedCard`'s own `if (!status || status.state ===
        // 'signed_out') return null;` — in practice unreachable through
        // `views::account` (the section only draws once the Account view
        // knows it is signed in), but this module's own `draw` must still
        // do the right, boring thing if it ever is reached this way.
        let state = ChainSeedViewState::new();
        let status = base(ChainSeedState::SignedOut, false);
        let output = render(|frame| {
            draw(frame, frame.area(), &state, Some(&status), |_| false);
        });
        assert!(
            output.contains("Chain Seed ") && !output.contains("—"),
            "the block title carries no state badge when signed out"
        );
    }

    snapshot_state!(renders_the_unknown_state, unknown_status());
    snapshot_state!(
        renders_the_absent_unacknowledged_state,
        absent_unacknowledged_status()
    );
    snapshot_state!(
        renders_the_absent_acknowledged_state,
        absent_acknowledged_status()
    );
    snapshot_state!(renders_the_not_yet_recoverable_state, held_status());
    snapshot_state!(
        renders_the_not_yet_recoverable_blocked_state,
        held_blocked_status()
    );
    snapshot_state!(renders_the_ready_state, ready_status());
    snapshot_state!(renders_the_unreadable_state, unreadable_status());

    #[test]
    fn renders_the_import_form_open() {
        let mut state = ChainSeedViewState::new();
        state.show_import = true;
        for c in "abandon abandon about".chars() {
            state.mnemonic.handle_key(key(KeyCode::Char(c)));
        }
        let status = absent_acknowledged_status();
        let output = render(|frame| {
            draw(frame, frame.area(), &state, Some(&status), |_| false);
        });
        insta::assert_snapshot!(output);
        assert!(
            !output.contains("abandon"),
            "a masked mnemonic must never appear in the rendered frame"
        );
    }

    // The confirm modal's own render (over a whole account view, not just
    // this section) is `views::account::tests::renders_the_confirm_modal_over_the_held_state`
    // — this module draws the section's content only; see the note on
    // `draw` above.

    fn real_fixture(name: &str) -> String {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        fs::read_to_string(&path).unwrap_or_else(|err| panic!("could not read {path}: {err}"))
    }

    /// Every real, volatile fixture `api-chain-seed.test.ts` writes must
    /// still render without panicking — see `views::account`'s and
    /// `views::health`'s tests for why this is separate from the
    /// deterministic snapshots above.
    #[test]
    fn renders_every_real_chain_seed_fixture_without_panicking() {
        let state = ChainSeedViewState::new();
        for name in [
            "chain-seed-signed-out",
            "chain-seed-unknown",
            "chain-seed-absent",
            "chain-seed-absent-acknowledged",
            "chain-seed-not-yet-recoverable",
            "chain-seed-not-yet-recoverable-blocked",
            "chain-seed-ready",
            "chain-seed-unreadable",
        ] {
            let text = real_fixture(name);
            let status: ChainSeedStatus = serde_json::from_str(&text)
                .unwrap_or_else(|err| panic!("fixture {name} did not deserialize: {err}"));
            render(|frame| {
                draw(frame, frame.area(), &state, Some(&status), |_| false);
            });
        }
    }
}
