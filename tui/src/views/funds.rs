//! The Funds view (TOON_Network#147).
//!
//! A terminal mirror of `packages/ui/src/app/funding-view.tsx` and its two
//! hooks, `use-funding.ts` and `use-gas-station.ts`: a deposit address (with
//! a scannable QR code) and a channel balance per chain the connector
//! settles on, the devnet faucet, opening a payment channel, and buying the
//! next chain's gas at a gas station (TOON_Network#119). One chain is
//! "selected" at a time (`j`/`k` moves it, mirroring the sidebar's `h`/`l`)
//! and its detail fills the right-hand panel — the web page shows every
//! chain stacked at once, which a terminal's height does not have room for.
//!
//! Two spending actions live here — opening a channel and buying gas — and
//! both go through [`crate::widgets::confirm`] before a byte reaches the
//! daemon: `o` and `b` only PROPOSE the action, and the amount is on screen
//! before typing `yes` then `Enter` sends it — the same shared confirm
//! widget TOON_Network#143's Workloads view built (this view originally had
//! its own minimal `y`-then-`Enter` modal; ported onto the shared one so
//! every spending/destructive/publish action in this console behaves the
//! same way).

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::Command;
use crate::types::{
    ChainFundingView, FaucetView, FundingStatus, GasPurchase, GasQuote, GasStationStatus,
};
use crate::widgets::confirm::{Confirm, ConfirmOutcome};

/// What is being confirmed, captured at the moment `o` or `b` proposed it so
/// that what typing `yes`+`Enter` sends is provably what was shown — nothing
/// is recomputed between the two.
#[derive(Debug, Clone, PartialEq)]
enum Action {
    OpenChannel {
        chain: String,
        deposit: Option<String>,
    },
    BuyGas {
        chain: String,
        quote_id: String,
    },
}

pub struct FundsState {
    pub funding: Option<FundingStatus>,
    pub funding_loading: bool,
    pub funding_busy: bool,
    pub funding_error: Option<String>,
    pub gas: Option<GasStationStatus>,
    pub gas_loading: bool,
    pub gas_busy: bool,
    pub gas_error: Option<String>,
    /// The quote currently on screen. Cleared the moment it is bought or a
    /// different chain is asked about — a stale quote must never be what
    /// `b` sends.
    pub gas_quote: Option<GasQuote>,
    pub gas_purchase: Option<GasPurchase>,
    pub selected: usize,
    confirm: Option<Confirm<Action>>,
    pub clipboard_message: Option<String>,
}

impl Default for FundsState {
    fn default() -> Self {
        Self {
            funding: None,
            funding_loading: true,
            funding_busy: false,
            funding_error: None,
            gas: None,
            gas_loading: true,
            gas_busy: false,
            gas_error: None,
            gas_quote: None,
            gas_purchase: None,
            selected: 0,
            confirm: None,
            clipboard_message: None,
        }
    }
}

impl FundsState {
    pub fn apply_funding(&mut self, result: Result<FundingStatus, String>) {
        self.funding_loading = false;
        self.funding_busy = false;
        match result {
            Ok(status) => {
                if !status.chains.is_empty() && self.selected >= status.chains.len() {
                    self.selected = status.chains.len() - 1;
                }
                self.funding = Some(status);
                self.funding_error = None;
            }
            Err(message) => self.funding_error = Some(message),
        }
    }

    pub fn apply_gas_station(&mut self, result: Result<GasStationStatus, String>) {
        self.gas_loading = false;
        self.gas_busy = false;
        match result {
            Ok(status) => {
                self.gas = Some(status);
                self.gas_error = None;
            }
            Err(message) => self.gas_error = Some(message),
        }
    }

    pub fn apply_gas_quote(&mut self, result: Result<GasQuote, String>) {
        self.gas_busy = false;
        match result {
            Ok(quote) => {
                self.gas_purchase = None;
                self.gas_quote = Some(quote);
                self.gas_error = None;
            }
            Err(message) => self.gas_error = Some(message),
        }
    }

    pub fn apply_gas_purchase(&mut self, result: Result<GasPurchase, String>) {
        self.gas_busy = false;
        // The quote is spent either way: a station that answered has
        // consumed it, and one that refused has consumed it too. Showing it
        // afterwards would invite a second purchase against a quote that no
        // longer exists (mirrors `use-gas-station.ts`'s `buyGas`).
        self.gas_quote = None;
        match result {
            Ok(purchase) => {
                self.gas_purchase = Some(purchase);
                self.gas_error = None;
            }
            Err(message) => self.gas_error = Some(message),
        }
    }

    fn selected_chain(&self) -> Option<&ChainFundingView> {
        self.funding
            .as_ref()
            .and_then(|funding| funding.chains.get(self.selected))
    }
}

/// Every key Funds handles for itself, once the shell has already ruled out
/// the global bindings (quit, help, view switching) and confirmed no
/// confirmation is open (`app::handle_key` calls `handle_confirm_key`
/// first). Anything not recognised here is `Command::None` — a key that does
/// nothing is safer than one that does the wrong thing.
pub fn handle_key(state: &mut FundsState, key: KeyEvent) -> Command {
    if let KeyCode::Char('r') = key.code {
        return Command::FetchFunding { refresh: true };
    }

    let Some(funding) = &state.funding else {
        return Command::None;
    };
    if funding.state != "ready" || funding.chains.is_empty() {
        return Command::None;
    }
    let chain_count = funding.chains.len();

    match key.code {
        KeyCode::Down | KeyCode::Char('j') => {
            state.selected = (state.selected + 1) % chain_count;
            Command::None
        }
        KeyCode::Up | KeyCode::Char('k') => {
            state.selected = (state.selected + chain_count - 1) % chain_count;
            Command::None
        }
        KeyCode::Char('y') => match state.selected_chain() {
            Some(chain) => Command::CopyToClipboard(chain.deposit.address.clone()),
            None => Command::None,
        },
        KeyCode::Char('o') => {
            open_channel_confirm(state);
            Command::None
        }
        KeyCode::Char('f') => match state.selected_chain() {
            Some(chain) if faucet_ready_for(funding.faucet.as_ref(), chain) => Command::Drip {
                chain: chain.chain.clone(),
            },
            _ => Command::None,
        },
        KeyCode::Char('g') => match gas_plan_for(state, funding) {
            Some(plan) if plan.verdict == "buyable" => Command::QuoteGas {
                chain: plan.chain.clone(),
            },
            _ => Command::None,
        },
        KeyCode::Char('b') => {
            buy_gas_confirm(state);
            Command::None
        }
        _ => Command::None,
    }
}

fn faucet_ready_for(faucet: Option<&FaucetView>, chain: &ChainFundingView) -> bool {
    faucet
        .map(|faucet| {
            faucet
                .chains
                .iter()
                .any(|leg| leg.kind == chain.kind && leg.ready)
        })
        .unwrap_or(false)
}

fn gas_plan_for<'a>(
    state: &'a FundsState,
    funding: &FundingStatus,
) -> Option<&'a crate::types::GasBuyChain> {
    let chain = funding.chains.get(state.selected)?;
    state
        .gas
        .as_ref()?
        .chains
        .iter()
        .find(|plan| plan.chain == chain.chain)
}

fn open_channel_confirm(state: &mut FundsState) {
    let Some(chain) = state.selected_chain() else {
        return;
    };
    if !chain.can_open {
        return;
    }
    let chain_id = chain.chain.clone();
    let deposit = chain.suggested_deposit.clone();
    let decimals = chain.token.decimals;
    let amount_line = match &deposit {
        Some(amount) => format!("Collateral: {amount} base units ({decimals} decimals)"),
        None => "Collateral: the connector's own default amount".to_string(),
    };
    let lines = vec![
        format!("Open a payment channel on {chain_id}"),
        amount_line,
        "This locks collateral on chain and pays the chain's own gas for the transaction."
            .to_string(),
    ];
    state.confirm = Some(Confirm::new(
        "Open channel",
        lines,
        Action::OpenChannel {
            chain: chain_id,
            deposit,
        },
    ));
}

fn buy_gas_confirm(state: &mut FundsState) {
    let Some(chain) = state.selected_chain() else {
        return;
    };
    let chain_id = chain.chain.clone();
    let Some(quote) = state
        .gas_quote
        .as_ref()
        .filter(|quote| quote.chain == chain_id)
    else {
        return;
    };
    let lines = vec![
        format!("Buy gas for {chain_id}"),
        format!("Pay {} base units to the gas station", quote.price),
        format!("Moves {} lamports to {}", quote.lamports, quote.recipient),
    ];
    state.confirm = Some(Confirm::new(
        "Buy gas",
        lines,
        Action::BuyGas {
            chain: chain_id,
            quote_id: quote.quote_id.clone(),
        },
    ));
}

/// Feeds a keypress to an OPEN confirmation. Returns `None` when none is
/// open, so `app::handle_key` falls through to its normal keymap — this is
/// the one function that decides whether a keypress belongs to the
/// confirmation or to the view underneath it.
pub fn handle_confirm_key(state: &mut FundsState, key: KeyEvent) -> Option<Command> {
    let pending = state.confirm.as_mut()?;
    match pending.handle_key(key) {
        ConfirmOutcome::Pending => Some(Command::None),
        ConfirmOutcome::Cancelled => {
            state.confirm = None;
            Some(Command::None)
        }
        ConfirmOutcome::Confirmed(action) => {
            state.confirm = None;
            Some(match action {
                Action::OpenChannel { chain, deposit } => Command::OpenChannel {
                    chain,
                    deposit,
                    connector: None,
                },
                Action::BuyGas { chain, quote_id } => Command::BuyGas { chain, quote_id },
            })
        }
    }
}

pub fn draw(frame: &mut Frame, area: Rect, state: &FundsState) {
    let Some(funding) = &state.funding else {
        let message = if state.funding_loading {
            "Reading your funds…"
        } else {
            "The daemon said nothing about funds."
        };
        draw_message(frame, area, message);
        return;
    };

    if funding.state != "ready" {
        draw_not_yet(frame, area, funding);
        return;
    }

    draw_ready(frame, area, state, funding);

    if let Some(pending) = &state.confirm {
        crate::widgets::confirm::draw(frame, area, pending);
    }
}

fn draw_message(frame: &mut Frame, area: Rect, message: &str) {
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    frame.render_widget(
        Paragraph::new(message).style(Style::default().fg(Color::DarkGray)),
        inner,
    );
}

fn draw_not_yet(frame: &mut Frame, area: Rect, funding: &FundingStatus) {
    let title = match funding.state.as_str() {
        "signed_out" => "Sign in first",
        "no_seed" => "This account has no Chain Seed yet",
        "unconfigured" => "This profile has no connector",
        "connector_unreachable" => "The connector did not answer",
        _ => "Funds is not ready yet",
    };
    let block = Block::default()
        .title(format!(" {title} "))
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = vec![
        Line::from(Span::styled(
            "Deposit addresses come from the account's Chain Seed, and which \
             chains they are for comes from the connector. Both are needed \
             before there is anything to show here.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
    ];
    if let Some(reason) = &funding.reason {
        lines.push(Line::from(reason.clone()));
        lines.push(Line::raw(""));
    }
    if funding.state == "connector_unreachable" {
        lines.push(Line::from(Span::styled(
            "r tries again.",
            Style::default().fg(Color::DarkGray),
        )));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_ready(frame: &mut Frame, area: Rect, state: &FundsState, funding: &FundingStatus) {
    let banner_lines = banner_lines(funding);
    let banner_height = if banner_lines.is_empty() {
        0
    } else {
        (banner_lines.len() as u16 + 2).min(area.height / 2)
    };

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(banner_height),
            Constraint::Length(3),
            Constraint::Min(6),
            Constraint::Length(3),
        ])
        .split(area);

    if banner_height > 0 {
        let block = Block::default()
            .title(" Native gas ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Yellow));
        let inner = block.inner(rows[0]);
        frame.render_widget(block, rows[0]);
        frame.render_widget(
            Paragraph::new(banner_lines).wrap(Wrap { trim: false }),
            inner,
        );
    }

    draw_chain_tabs(frame, rows[1], funding, state.selected);

    let body = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(48), Constraint::Min(24)])
        .split(rows[2]);

    match funding.chains.get(state.selected) {
        Some(chain) => {
            draw_deposit(frame, body[0], chain, funding.faucet.as_ref(), state);
            draw_chain_detail(frame, body[1], chain, state);
        }
        None => {
            draw_message(frame, rows[2], "This connector settles on no chain.");
        }
    }

    draw_footnote(frame, rows[3], funding, state);
}

fn banner_lines(funding: &FundingStatus) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    if let Some(held) = &funding.held_seed {
        lines.push(Line::from(Span::styled(
            "This account's Chain Seed is not yet recoverable.",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(held.text.clone()));
    }
    if funding.superseded_seeds > 0 {
        lines.push(Line::from(Span::styled(
            format!(
                "This account has {} other sealed Chain Seed(s). Check the Account tab before depositing.",
                funding.superseded_seeds
            ),
            Style::default().fg(Color::Red),
        )));
    }
    let stuck: Vec<&ChainFundingView> = funding
        .chains
        .iter()
        .filter(|chain| chain.gas.verdict != "present")
        .collect();
    if !stuck.is_empty() {
        lines.push(Line::from(Span::styled(
            "You need native gas to open a channel on:",
            Style::default().add_modifier(Modifier::BOLD),
        )));
        for chain in stuck {
            lines.push(Line::from(format!(
                "  {} — {}",
                chain.chain, chain.gas.headline
            )));
        }
    }
    lines
}

fn draw_chain_tabs(frame: &mut Frame, area: Rect, funding: &FundingStatus, selected: usize) {
    let block = Block::default()
        .title(" Chains (j/k to move) ")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut spans = Vec::with_capacity(funding.chains.len() * 2);
    for (index, chain) in funding.chains.iter().enumerate() {
        let style = if index == selected {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        spans.push(Span::styled(format!(" {} ", chain.chain), style));
        spans.push(Span::raw(" "));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), inner);
}

fn draw_deposit(
    frame: &mut Frame,
    area: Rect,
    chain: &ChainFundingView,
    faucet: Option<&FaucetView>,
    state: &FundsState,
) {
    let block = Block::default()
        .title(" Deposit address ")
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines: Vec<Line> = match qr::qr_lines(&chain.deposit.address) {
        Ok(qr) => qr,
        Err(_) => vec![Line::from(Span::styled(
            "(QR code unavailable for this address)",
            Style::default().fg(Color::DarkGray),
        ))],
    };
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        chain.deposit.address.clone(),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        chain.deposit.path.clone(),
        Style::default().fg(Color::DarkGray),
    )));
    lines.push(Line::from(Span::styled(
        "y copies the address",
        Style::default().fg(Color::DarkGray),
    )));
    if let Some(message) = &state.clipboard_message {
        lines.push(Line::from(Span::styled(
            message.clone(),
            Style::default().fg(Color::Green),
        )));
    }

    if let Some(faucet) = faucet {
        lines.push(Line::raw(""));
        let leg = faucet.chains.iter().find(|leg| leg.kind == chain.kind);
        let text = match leg {
            Some(leg) if leg.ready => format!(
                "Faucet drips {} here. f asks it.",
                leg.drips
                    .iter()
                    .map(|drip| format!("{} {}", drip.amount, drip.asset))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Some(_) => "Faucet is not ready for this chain right now.".to_string(),
            None => format!("This network's faucet does not cover {}.", chain.chain),
        };
        lines.push(Line::from(text));
        if let Some(last) = &faucet.last_drip {
            if last.chain == chain.chain {
                let delivered = last.state == "delivered";
                let style = if delivered {
                    Style::default()
                } else {
                    Style::default().fg(Color::Red)
                };
                lines.push(Line::from(Span::styled(
                    format!(
                        "{}: {}",
                        if delivered { "Asked" } else { "Refused" },
                        last.message
                    ),
                    style,
                )));
            }
        }
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_chain_detail(frame: &mut Frame, area: Rect, chain: &ChainFundingView, state: &FundsState) {
    let block = Block::default()
        .title(format!(" {} ", chain.chain))
        .borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = Vec::new();
    lines.push(Line::from(vec![
        label("Token "),
        Span::raw(format!(
            "{} ({} decimals)",
            chain.token.address, chain.token.decimals
        )),
    ]));
    lines.push(Line::from(vec![
        label("Counterparty "),
        Span::raw(chain.counterparty.clone()),
    ]));
    lines.push(Line::raw(""));

    lines.push(Line::from(Span::styled(
        "On chain",
        Style::default().add_modifier(Modifier::BOLD),
    )));
    if chain.balances.state == "unknown" {
        lines.push(Line::from(Span::styled(
            chain.balances.reason.clone().unwrap_or_default(),
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        let symbol = chain
            .gas
            .symbol
            .clone()
            .unwrap_or_else(|| "Native".to_string());
        lines.push(Line::from(format!(
            "{symbol} (gas): {}",
            crate::format::format_amount(chain.balances.native.as_ref())
        )));
        lines.push(Line::from(format!(
            "Settlement token: {}",
            crate::format::format_amount(chain.balances.token.as_ref())
        )));
    }
    lines.push(Line::raw(""));

    lines.push(Line::from(vec![
        Span::styled("Channel ", Style::default().add_modifier(Modifier::BOLD)),
        channel_badge(&chain.channel.phase),
    ]));
    match chain.channel.phase.as_str() {
        "none" | "failed" => {
            let mut spans = Vec::new();
            if chain.channel.phase == "failed" {
                spans.push(Span::styled(
                    "The open did not land. ",
                    Style::default().fg(Color::Red),
                ));
            }
            spans.push(Span::raw(chain.channel.reason.clone().unwrap_or_default()));
            lines.push(Line::from(spans));
        }
        _ => {
            lines.push(Line::from(format!(
                "Collateral {}  Spent {}  Available {}",
                chain
                    .channel
                    .deposit
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
                chain
                    .channel
                    .spent
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
                chain
                    .channel
                    .available
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
            )));
            if let Some(id) = &chain.channel.channel_id {
                lines.push(Line::from(Span::styled(
                    id.clone(),
                    Style::default().fg(Color::DarkGray),
                )));
            }
        }
    }
    lines.push(Line::raw(""));

    lines.push(Line::from(Span::styled(
        "Open a payment channel",
        Style::default().add_modifier(Modifier::BOLD),
    )));
    if chain.can_open {
        let amount = chain
            .suggested_deposit
            .clone()
            .unwrap_or_else(|| "the connector's default".to_string());
        lines.push(Line::from(format!(
            "o opens it, with {amount} base units of collateral"
        )));
    } else if let Some(reason) = &chain.blocked_by {
        lines.push(Line::from(Span::styled(
            reason.clone(),
            Style::default().fg(Color::DarkGray),
        )));
    }
    lines.push(Line::raw(""));

    if chain.gas.verdict != "present" {
        lines.push(Line::from(Span::styled(
            "Buy gas at a gas station",
            Style::default().add_modifier(Modifier::BOLD),
        )));
        match state
            .gas
            .as_ref()
            .and_then(|gas| gas.chains.iter().find(|plan| plan.chain == chain.chain))
        {
            Some(plan) if plan.verdict == "buyable" => {
                lines.push(Line::from(plan.reason.clone()));
                match state
                    .gas_quote
                    .as_ref()
                    .filter(|quote| quote.chain == chain.chain)
                {
                    Some(quote) => {
                        lines.push(Line::from(format!(
                            "Quote: pay {} base units, moves {} lamports to {}",
                            quote.price, quote.lamports, quote.recipient
                        )));
                        lines.push(Line::from("b buys this quote"));
                    }
                    None => {
                        lines.push(Line::from(format!(
                            "g gets a quote ({} base units)",
                            plan.price.clone().unwrap_or_default()
                        )));
                    }
                }
            }
            Some(plan) => lines.push(Line::from(Span::styled(
                plan.reason.clone(),
                Style::default().fg(Color::DarkGray),
            ))),
            None => lines.push(Line::from(Span::styled(
                "Reading the gas station…",
                Style::default().fg(Color::DarkGray),
            ))),
        }
        if let Some(purchase) = state
            .gas_purchase
            .as_ref()
            .filter(|purchase| purchase.chain == chain.chain)
        {
            let style = if purchase.state == "delivered" {
                Style::default().fg(Color::Green)
            } else {
                Style::default().fg(Color::Red)
            };
            let text = match purchase.state.as_str() {
                "delivered" => format!(
                    "Delivered: {} lamports to {} in {}",
                    purchase.lamports.clone().unwrap_or_default(),
                    purchase.recipient,
                    purchase.signature.clone().unwrap_or_default()
                ),
                "refused" => format!("Refused: {}", purchase.reason.clone().unwrap_or_default()),
                _ => "Unknown outcome — nobody reported what became of that packet. Read the balances again.".to_string(),
            };
            lines.push(Line::from(Span::styled(text, style)));
        }
    }

    if let Some(error) = &state.funding_error {
        lines.push(Line::raw(""));
        lines.push(Line::from(Span::styled(
            error.clone(),
            Style::default().fg(Color::Red),
        )));
    }
    if let Some(error) = &state.gas_error {
        lines.push(Line::from(Span::styled(
            error.clone(),
            Style::default().fg(Color::Red),
        )));
    }

    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn draw_footnote(frame: &mut Frame, area: Rect, funding: &FundingStatus, state: &FundsState) {
    let block = Block::default().borders(Borders::ALL);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let line = if state.funding_busy || state.gas_busy {
        Line::from(Span::styled("Working…", Style::default().fg(Color::Yellow)))
    } else {
        Line::from(funding.custody.text.clone())
    };
    frame.render_widget(Paragraph::new(line).wrap(Wrap { trim: false }), inner);
}

fn channel_badge(phase: &str) -> Span<'static> {
    match phase {
        // `opening` is NOT a failure and must never look like one — the
        // transaction is in flight and the only remedy is to wait.
        "opening" => Span::styled(
            " opening… ",
            Style::default().fg(Color::Black).bg(Color::Yellow),
        ),
        "open" => Span::styled(
            " channel open ",
            Style::default().fg(Color::Black).bg(Color::Green),
        ),
        "failed" => Span::styled(
            " open failed ",
            Style::default().fg(Color::White).bg(Color::Red),
        ),
        "closing" => Span::styled(
            " closing ",
            Style::default().fg(Color::Black).bg(Color::Yellow),
        ),
        "settled" => Span::styled(
            " settled ",
            Style::default().fg(Color::Black).bg(Color::White),
        ),
        _ => Span::styled(
            " no channel ",
            Style::default().fg(Color::Black).bg(Color::White),
        ),
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

/// The deposit QR code, drawn dark-on-light in half-block characters.
///
/// TOON_Network#147 is explicit: a QR code is read by a camera, so it must
/// be dark modules on a light background REGARDLESS of the terminal's own
/// Omarchy theme, and only the terminal's own named ANSI colours (never a
/// fixed RGB or indexed colour — `tests/no_colour.rs` enforces that crate
/// wide). `Color::Black` and `Color::White` are the two named colours a
/// phone camera reads as ink and paper regardless of which Omarchy theme
/// remapped them, so those are the only two colours this module ever uses.
mod qr {
    use qrcode::{Color as ModuleColor, QrCode};
    use ratatui::style::{Color, Style};
    use ratatui::text::{Line, Span};

    /// Modules either side of the code, so a phone's scanner has the quiet
    /// zone it needs to find the finder patterns — 4 is the acceptance
    /// criterion's stated minimum.
    const QUIET_ZONE: usize = 4;

    /// The dark/light module grid actually drawn, quiet zone included. This
    /// is the one source of truth both [`qr_lines`] (the terminal glyphs)
    /// and the round-trip test (a real decoder, via `rqrr`) build from, so a
    /// change to the quiet zone or the scan direction is provably still what
    /// a camera decodes — not two implementations that happen to agree
    /// today.
    pub(super) fn qr_modules(data: &str) -> Result<(usize, Vec<bool>), String> {
        let code = QrCode::new(data.as_bytes()).map_err(|err| err.to_string())?;
        let inner = code.width();
        let total = inner + QUIET_ZONE * 2;
        let mut grid = vec![false; total * total];
        for y in 0..inner {
            for x in 0..inner {
                if code[(x, y)] == ModuleColor::Dark {
                    grid[(y + QUIET_ZONE) * total + (x + QUIET_ZONE)] = true;
                }
            }
        }
        Ok((total, grid))
    }

    /// Two module rows per terminal cell, via the upper-half-block glyph
    /// (`▀`): its foreground paints the top module and its background paints
    /// the bottom one. Always `Color::Black` on `Color::Dark` and
    /// `Color::White` on light — never the app's own palette — so the code
    /// scans the same in either Omarchy theme.
    pub(super) fn qr_lines(data: &str) -> Result<Vec<Line<'static>>, String> {
        let (total, grid) = qr_modules(data)?;
        let dark = |x: usize, y: usize| grid[y * total + x];

        let mut lines = Vec::with_capacity(total.div_ceil(2));
        let mut y = 0;
        while y < total {
            let mut spans = Vec::with_capacity(total);
            for x in 0..total {
                let top = dark(x, y);
                let bottom = y + 1 < total && dark(x, y + 1);
                spans.push(Span::styled(
                    "▀",
                    Style::default()
                        .fg(if top { Color::Black } else { Color::White })
                        .bg(if bottom { Color::Black } else { Color::White }),
                ));
            }
            lines.push(Line::from(spans));
            y += 2;
        }
        Ok(lines)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_quiet_zone_is_at_least_four_modules_of_light_on_every_side() {
            let (total, grid) = qr_modules("hello").unwrap();
            let dark = |x: usize, y: usize| grid[y * total + x];
            for i in 0..total {
                for ring in 0..QUIET_ZONE {
                    assert!(
                        !dark(i, ring),
                        "top quiet zone row {ring} has a dark module"
                    );
                    assert!(
                        !dark(i, total - 1 - ring),
                        "bottom quiet zone row {ring} has a dark module"
                    );
                    assert!(
                        !dark(ring, i),
                        "left quiet zone column {ring} has a dark module"
                    );
                    assert!(
                        !dark(total - 1 - ring, i),
                        "right quiet zone column {ring} has a dark module"
                    );
                }
            }
        }

        #[test]
        fn qr_lines_pairs_every_two_module_rows_into_one_terminal_line() {
            let (total, _) = qr_modules("0x1234").unwrap();
            let lines = qr_lines("0x1234").unwrap();
            assert_eq!(lines.len(), total.div_ceil(2));
            for line in &lines {
                assert_eq!(line.spans.len(), total);
            }
        }

        #[test]
        fn qr_lines_uses_only_black_and_white_named_colours() {
            // The acceptance criterion in the crate's own words: dark-on-light
            // regardless of theme, via named ANSI colours only.
            let lines = qr_lines("a deposit address").unwrap();
            for line in &lines {
                for span in &line.spans {
                    let fg = span.style.fg.expect("every module glyph sets fg");
                    let bg = span.style.bg.expect("every module glyph sets bg");
                    assert!(matches!(fg, Color::Black | Color::White));
                    assert!(matches!(bg, Color::Black | Color::White));
                }
            }
        }

        /// Structural + a REAL third-party decoder, round-tripped: builds the
        /// exact same module grid `qr_lines` draws from (via
        /// [`qr_modules`]) into a bitmap and decodes it with `rqrr`, an
        /// independent implementation from `qrcode` — proof this is a
        /// standards-shaped code and not just a picture that happens to look
        /// like one.
        #[test]
        fn the_deposit_qr_round_trips_through_a_real_decoder() {
            let address = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
            let (total, grid) = qr_modules(address).unwrap();

            const SCALE: usize = 4;
            let mut image = image::GrayImage::new((total * SCALE) as u32, (total * SCALE) as u32);
            for y in 0..total {
                for x in 0..total {
                    let value: u8 = if grid[y * total + x] { 0 } else { 255 };
                    for dy in 0..SCALE {
                        for dx in 0..SCALE {
                            image.put_pixel(
                                (x * SCALE + dx) as u32,
                                (y * SCALE + dy) as u32,
                                image::Luma([value]),
                            );
                        }
                    }
                }
            }

            let mut prepared = rqrr::PreparedImage::prepare(image);
            let grids = prepared.detect_grids();
            assert_eq!(
                grids.len(),
                1,
                "expected exactly one QR grid to be detected"
            );
            let (_meta, content) = grids[0].decode().expect("a detected grid must decode");
            assert_eq!(content, address);
        }

        #[test]
        fn a_solana_style_base58_address_also_round_trips() {
            let address = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM6";
            let (total, grid) = qr_modules(address).unwrap();

            const SCALE: usize = 4;
            let mut image = image::GrayImage::new((total * SCALE) as u32, (total * SCALE) as u32);
            for y in 0..total {
                for x in 0..total {
                    let value: u8 = if grid[y * total + x] { 0 } else { 255 };
                    for dy in 0..SCALE {
                        for dx in 0..SCALE {
                            image.put_pixel(
                                (x * SCALE + dx) as u32,
                                (y * SCALE + dy) as u32,
                                image::Luma([value]),
                            );
                        }
                    }
                }
            }

            let mut prepared = rqrr::PreparedImage::prepare(image);
            let grids = prepared.detect_grids();
            assert_eq!(grids.len(), 1);
            let (_meta, content) = grids[0].decode().unwrap();
            assert_eq!(content, address);
        }
    }
}

#[cfg(test)]
// `FundsState` has no public constructor besides `default()` (its `confirm`
// field is private on purpose — only this module opens one), so every test
// below builds a default and then sets the one or two fields it cares
// about; clippy's struct-literal suggestion would mean repeating the
// several dozen fields that ARE the default on every single test instead.
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::types::{
        Amount, BalanceView, ChainAddress, CustodyView, FaucetChainView, FaucetDrip,
        FundingProfileRef, GasBuyChain, GasView, RpcRef, TokenRef,
    };
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    fn sample_chain(
        chain: &str,
        can_open: bool,
        gas_verdict: &str,
        phase: &str,
    ) -> ChainFundingView {
        ChainFundingView {
            chain: chain.to_string(),
            kind: if chain == "solana" { "solana" } else { "evm" }.to_string(),
            counterparty: "https://connector.example".to_string(),
            token: TokenRef {
                address: "0xusdc".to_string(),
                decimals: 6,
            },
            deposit: ChainAddress {
                address: format!("addr-{chain}"),
                path: "m/44'/60'/0'/0/0".to_string(),
            },
            rpc: RpcRef {
                url: "https://rpc.example".to_string(),
                source: "profile".to_string(),
            },
            balances: BalanceView {
                state: "read".to_string(),
                native: Some(Amount {
                    amount: "0".to_string(),
                    decimals: Some(18),
                    symbol: Some("ETH".to_string()),
                    address: None,
                }),
                token: Some(Amount {
                    amount: "5000000".to_string(),
                    decimals: Some(6),
                    symbol: Some("USDC".to_string()),
                    address: None,
                }),
                reason: None,
                read_at: None,
            },
            gas: GasView {
                verdict: gas_verdict.to_string(),
                symbol: Some("ETH".to_string()),
                headline: "No ETH".to_string(),
                detail: "detail".to_string(),
                command: None,
                faucet_gives_gas: false,
            },
            channel: crate::types::ChannelView {
                phase: phase.to_string(),
                channel_id: if phase == "open" {
                    Some("0xchannel".to_string())
                } else {
                    None
                },
                deposit: Some("1000000".to_string()),
                spent: Some("0".to_string()),
                available: Some("1000000".to_string()),
                nonce: None,
                opened_at: None,
                started_at: None,
                tx_hash: None,
                reason: Some("no channel yet".to_string()),
                out_of_gas: None,
                watermark_uncertain: None,
            },
            can_open,
            blocked_by: if can_open {
                None
            } else {
                Some("No ETH to pay for a transaction".to_string())
            },
            suggested_deposit: Some("1000000".to_string()),
        }
    }

    fn sample_funding(state: &str, chains: Vec<ChainFundingView>) -> FundingStatus {
        FundingStatus {
            state: state.to_string(),
            profile: FundingProfileRef {
                id: "devnet".to_string(),
                label: "Devnet".to_string(),
            },
            pubkey: Some("abc123".to_string()),
            custody: CustodyView {
                text: "Keys never leave this account's Signer.".to_string(),
                acknowledged_at: None,
            },
            superseded_seeds: 0,
            held_seed: None,
            chains,
            quote: None,
            faucet: Some(FaucetView {
                url: "https://faucet.devnet.example".to_string(),
                state: "ready".to_string(),
                reason: None,
                chains: vec![FaucetChainView {
                    kind: "evm".to_string(),
                    name: "Base Sepolia".to_string(),
                    ready: true,
                    route: None,
                    drips: vec![FaucetDrip {
                        asset: "USDC".to_string(),
                        amount: "10".to_string(),
                    }],
                    cooldown_hours: None,
                }],
                gives_gas: false,
                last_drip: None,
            }),
            channel_store_path: Some("/home/tester/channels.json".to_string()),
            reason: None,
            checked_at: "2026-09-24T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn r_refreshes_funding_even_with_no_data_loaded_yet() {
        let mut state = FundsState::default();
        state.funding = None;
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('r'))),
            Command::FetchFunding { refresh: true }
        );
    }

    #[test]
    fn j_and_k_move_the_selection_and_wrap() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![
                sample_chain("evm:84532", true, "present", "none"),
                sample_chain("solana", false, "none", "none"),
            ],
        ));
        assert_eq!(state.selected, 0);
        handle_key(&mut state, key(KeyCode::Char('j')));
        assert_eq!(state.selected, 1);
        handle_key(&mut state, key(KeyCode::Char('j')));
        assert_eq!(state.selected, 0, "wraps back to the first chain");
        handle_key(&mut state, key(KeyCode::Char('k')));
        assert_eq!(state.selected, 1, "wraps backward too");
    }

    #[test]
    fn y_copies_the_selected_chains_deposit_address() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        ));
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('y'))),
            Command::CopyToClipboard("addr-evm:84532".to_string())
        );
    }

    #[test]
    fn o_opens_a_confirmation_showing_the_amount_and_does_not_open_a_channel_by_itself() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        ));
        let command = handle_key(&mut state, key(KeyCode::Char('o')));
        assert_eq!(
            command,
            Command::None,
            "one keypress must not open anything"
        );
        assert!(state.confirm.is_some());
        let confirm = state.confirm.as_ref().unwrap();
        assert!(confirm.lines.iter().any(|line| line.contains("1000000")));
    }

    #[test]
    fn o_does_nothing_when_the_chain_cannot_open() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", false, "none", "none")],
        ));
        handle_key(&mut state, key(KeyCode::Char('o')));
        assert!(state.confirm.is_none());
    }

    #[test]
    fn confirming_an_open_channel_by_typing_yes_then_enter_issues_the_command_and_closes_the_modal(
    ) {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        ));
        handle_key(&mut state, key(KeyCode::Char('o')));
        assert!(state.confirm.is_some());

        // Enter alone (before typing `yes`) must not confirm — one keypress
        // can never publish/spend (`widgets::confirm`'s own invariant).
        assert_eq!(
            handle_confirm_key(&mut state, key(KeyCode::Enter)),
            Some(Command::None)
        );
        assert!(state.confirm.is_some(), "one keypress did not confirm");

        for c in "yes".chars() {
            assert_eq!(
                handle_confirm_key(&mut state, key(KeyCode::Char(c))),
                Some(Command::None)
            );
        }
        assert_eq!(
            handle_confirm_key(&mut state, key(KeyCode::Enter)),
            Some(Command::OpenChannel {
                chain: "evm:84532".to_string(),
                deposit: Some("1000000".to_string()),
                connector: None,
            })
        );
        assert!(state.confirm.is_none());
    }

    #[test]
    fn esc_cancels_the_confirmation_without_issuing_a_command() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        ));
        handle_key(&mut state, key(KeyCode::Char('o')));
        assert_eq!(
            handle_confirm_key(&mut state, key(KeyCode::Esc)),
            Some(Command::None)
        );
        assert!(state.confirm.is_none());
    }

    #[test]
    fn handle_confirm_key_returns_none_when_nothing_is_open() {
        let mut state = FundsState::default();
        assert_eq!(
            handle_confirm_key(&mut state, key(KeyCode::Char('y'))),
            None
        );
    }

    #[test]
    fn f_drips_only_when_the_faucet_is_ready_for_the_selected_chains_kind() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        ));
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('f'))),
            Command::Drip {
                chain: "evm:84532".to_string()
            }
        );

        // Solana is not in the faucet's `chains` in this fixture.
        state.funding.as_mut().unwrap().chains =
            vec![sample_chain("solana", true, "present", "none")];
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('f'))),
            Command::None
        );
    }

    #[test]
    fn g_quotes_gas_only_when_the_gas_station_says_this_chain_is_buyable() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("solana", false, "none", "none")],
        ));
        // No gas station data loaded yet: nothing to do.
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('g'))),
            Command::None
        );

        state.gas = Some(GasStationStatus {
            state: "ready".to_string(),
            station: None,
            chains: vec![GasBuyChain {
                chain: "solana".to_string(),
                kind: "solana".to_string(),
                recipient: "sol-address".to_string(),
                verdict: "buyable".to_string(),
                reason: "Buy through the EVM channel".to_string(),
                payer: None,
                destination: None,
                price: Some("1100".to_string()),
                lamports: None,
                open_channel_with: None,
            }],
            first_channel: None,
            reason: None,
            checked_at: "2026-09-24T00:00:00.000Z".to_string(),
        });
        assert_eq!(
            handle_key(&mut state, key(KeyCode::Char('g'))),
            Command::QuoteGas {
                chain: "solana".to_string()
            }
        );
    }

    #[test]
    fn b_confirms_only_against_a_quote_already_shown_for_this_chain() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("solana", false, "none", "none")],
        ));
        // No quote yet: nothing to confirm.
        handle_key(&mut state, key(KeyCode::Char('b')));
        assert!(state.confirm.is_none());

        state.gas_quote = Some(GasQuote {
            chain: "solana".to_string(),
            quote_id: "q-7".to_string(),
            fee_payer: "fee-payer".to_string(),
            recipient: "sol-address".to_string(),
            lamports: "10000000".to_string(),
            max_lamports: "12020000".to_string(),
            recent_blockhash: "hash".to_string(),
            expires_at: 1_758_700_000_000,
            destination: "g.toon.gastation".to_string(),
            pay_at: "https://gas.example".to_string(),
            price: "1100".to_string(),
            cost: None,
            attempts: vec![],
        });
        handle_key(&mut state, key(KeyCode::Char('b')));
        assert!(state.confirm.is_some());
        for c in "yes".chars() {
            assert_eq!(
                handle_confirm_key(&mut state, key(KeyCode::Char(c))),
                Some(Command::None)
            );
        }
        assert_eq!(
            handle_confirm_key(&mut state, key(KeyCode::Enter)),
            Some(Command::BuyGas {
                chain: "solana".to_string(),
                quote_id: "q-7".to_string(),
            })
        );
    }

    #[test]
    fn apply_funding_clamps_the_selection_when_the_chain_list_shrinks() {
        let mut state = FundsState::default();
        state.selected = 1;
        state.apply_funding(Ok(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        )));
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn apply_gas_purchase_clears_the_quote_whether_it_was_delivered_or_refused() {
        let mut state = FundsState::default();
        state.gas_quote = Some(GasQuote {
            chain: "solana".to_string(),
            quote_id: "q-7".to_string(),
            fee_payer: "fee-payer".to_string(),
            recipient: "sol-address".to_string(),
            lamports: "10000000".to_string(),
            max_lamports: "12020000".to_string(),
            recent_blockhash: "hash".to_string(),
            expires_at: 0,
            destination: "g.toon.gastation".to_string(),
            pay_at: "https://gas.example".to_string(),
            price: "1100".to_string(),
            cost: None,
            attempts: vec![],
        });
        state.apply_gas_purchase(Ok(GasPurchase {
            chain: "solana".to_string(),
            state: "refused".to_string(),
            signature: None,
            slot: None,
            lamports: None,
            recipient: "sol-address".to_string(),
            reason: Some("no door answered".to_string()),
            detail: None,
            attempts: vec![],
            cost: Some("1100".to_string()),
            at: "2026-09-24T00:00:02.000Z".to_string(),
        }));
        assert!(state.gas_quote.is_none());
        assert!(state.gas_purchase.is_some());
    }

    fn render(state: &FundsState) -> String {
        let backend = TestBackend::new(120, 40);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, frame.area(), state))
            .unwrap();
        let buffer = terminal.backend().buffer();
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
    fn draws_without_panicking_while_loading() {
        let state = FundsState::default();
        render(&state);
    }

    fn read_fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
        let path = format!(
            "{}/../packages/daemon/fixtures/api/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read {path}: {err}"));
        serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("fixture {path} did not deserialize: {err}"))
    }

    /// The daemon's own real, volatile answers must still render without
    /// panicking — no snapshot assertion (timestamps, addresses and paths
    /// differ on every regeneration), just proof this view survives contact
    /// with the real shape `packages/daemon` produces today, not only the
    /// tidy fixtures this file made up above. Mirrors
    /// `views::health::tests::renders_the_real_daemon_fixture_without_panicking`.
    #[test]
    fn renders_the_real_daemon_funding_fixture_without_panicking() {
        let funding: FundingStatus = read_fixture("funding");
        let mut state = FundsState::default();
        state.funding_loading = false;
        state.funding = Some(funding);
        render(&state);
    }

    #[test]
    fn renders_the_real_daemon_gas_station_fixture_without_panicking() {
        let funding: FundingStatus = read_fixture("funding");
        let gas_station: GasStationStatus = read_fixture("gas-station");
        let gas_quote: GasQuote = read_fixture("gas-quote");
        let gas_purchase: GasPurchase = read_fixture("gas-purchase");
        let mut state = FundsState::default();
        state.funding_loading = false;
        state.funding = Some(funding);
        state.gas_loading = false;
        state.gas = Some(gas_station);
        state.gas_quote = Some(gas_quote);
        state.gas_purchase = Some(gas_purchase);
        render(&state);
    }

    #[test]
    fn draws_without_panicking_when_signed_out() {
        let mut state = FundsState::default();
        state.funding_loading = false;
        state.funding = Some(sample_funding("signed_out", vec![]));
        state.funding.as_mut().unwrap().reason = Some("Sign in to see your funds.".to_string());
        let text = render(&state);
        assert!(text.contains("Sign in first"));
    }

    #[test]
    fn draws_without_panicking_when_ready_with_chains() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![
                sample_chain("evm:84532", true, "none", "none"),
                sample_chain("solana", false, "unknown", "open"),
            ],
        ));
        render(&state);
    }

    #[test]
    fn draws_without_panicking_with_a_confirmation_open() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![sample_chain("evm:84532", true, "present", "none")],
        ));
        handle_key(&mut state, key(KeyCode::Char('o')));
        assert!(state.confirm.is_some());
        render(&state);
    }

    #[test]
    fn insta_snapshot_of_the_ready_state() {
        let mut state = FundsState::default();
        state.funding = Some(sample_funding(
            "ready",
            vec![
                sample_chain("evm:84532", true, "present", "open"),
                sample_chain("solana", false, "none", "none"),
            ],
        ));
        insta::assert_snapshot!(render(&state));
    }
}
