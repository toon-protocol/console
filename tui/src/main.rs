//! Entry point: terminal setup/teardown and the event loop.
//!
//! This file is deliberately thin wiring and nothing else — every seam worth
//! a unit test (the keymap, the client, the launch-record reader, a view's
//! render) lives in `lib.rs`'s modules, where `cargo test` reaches it without
//! a real terminal. What is here: bring the terminal up, connect to the
//! daemon (retrying with an actionable message if it is not running yet),
//! fetch Health once, and run the loop that turns input and background
//! events into redraws.

use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use serde::Serialize;

use toon_console_tui::app::{handle_key, handle_mouse, App, Command, DaemonStatus, View};
use toon_console_tui::client::DaemonClient;
use toon_console_tui::desktop;
use toon_console_tui::launch::{launch_file_path, LaunchError};
use toon_console_tui::types::{FundingStatus, GasPurchase, GasQuote, GasStationStatus, Health};
use toon_console_tui::ui;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

enum RuntimeEvent {
    Connected(Arc<DaemonClient>),
    ConnectFailed(String),
    HealthLoaded(Box<Result<Health, String>>),
    SwitchView(View),
    // -- Funds (TOON_Network#147) --
    FundingLoaded(Box<Result<FundingStatus, String>>),
    GasStationLoaded(Box<Result<GasStationStatus, String>>),
    GasQuoteLoaded(Box<Result<GasQuote, String>>),
    GasPurchaseLoaded(Box<Result<GasPurchase, String>>),
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut terminal = setup_terminal()?;
    let result = run(&mut terminal).await;
    restore_terminal()?;
    if let Err(err) = &result {
        eprintln!("toon-console-tui: {err}");
    }
    result
}

fn setup_terminal() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    // A panic must still leave the terminal usable — nobody wants a stuck
    // raw-mode shell after a bug in this crate.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = restore_terminal();
        previous_hook(info);
    }));
    Terminal::new(CrosstermBackend::new(stdout))
}

fn restore_terminal() -> io::Result<()> {
    disable_raw_mode()?;
    execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;
    Ok(())
}

async fn run(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> io::Result<()> {
    let mut app = App::new();
    let mut client: Option<Arc<DaemonClient>> = None;
    let mut sidebar_hits = Vec::new();
    let (tx, mut rx) = unbounded_channel::<RuntimeEvent>();

    spawn_connect_loop(tx.clone());

    let mut events = EventStream::new();

    loop {
        terminal.draw(|frame| {
            sidebar_hits = ui::draw(frame, &app);
        })?;

        tokio::select! {
            maybe_event = events.next() => {
                let Some(event) = maybe_event else { break };
                let event = match event {
                    Ok(event) => event,
                    Err(_) => continue,
                };
                match event {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        match handle_key(&mut app, key) {
                            Command::Quit => break,
                            Command::RefreshHealth => {
                                if let Some(client) = &client {
                                    spawn_health_fetch(client.clone(), tx.clone());
                                    app.loading_health = true;
                                }
                            }
                            Command::None => {}
                            // -- Funds (TOON_Network#147) --
                            Command::FetchFunding { refresh } => {
                                if let Some(client) = &client {
                                    app.funds.funding_loading = true;
                                    app.funds.funding_busy = true;
                                    spawn_funding_fetch(client.clone(), tx.clone(), refresh);
                                }
                            }
                            Command::FetchGasStation => {
                                if let Some(client) = &client {
                                    app.funds.gas_loading = true;
                                    app.funds.gas_busy = true;
                                    spawn_gas_station_fetch(client.clone(), tx.clone());
                                }
                            }
                            Command::OpenChannel { chain, deposit, connector } => {
                                if let Some(client) = &client {
                                    app.funds.funding_busy = true;
                                    spawn_open_channel(client.clone(), tx.clone(), chain, deposit, connector);
                                }
                            }
                            Command::Drip { chain } => {
                                if let Some(client) = &client {
                                    app.funds.funding_busy = true;
                                    spawn_drip(client.clone(), tx.clone(), chain);
                                }
                            }
                            Command::QuoteGas { chain } => {
                                if let Some(client) = &client {
                                    app.funds.gas_busy = true;
                                    spawn_quote_gas(client.clone(), tx.clone(), chain);
                                }
                            }
                            Command::BuyGas { chain, quote_id } => {
                                if let Some(client) = &client {
                                    app.funds.gas_busy = true;
                                    spawn_buy_gas(client.clone(), tx.clone(), chain, quote_id);
                                }
                            }
                            Command::CopyToClipboard(text) => {
                                let result = toon_console_tui::clipboard::copy(&text);
                                app.funds.set_clipboard_result(result);
                            }
                        }
                    }
                    Event::Mouse(mouse) => {
                        handle_mouse(&mut app, mouse, &sidebar_hits);
                    }
                    _ => {}
                }
            }
            Some(runtime_event) = rx.recv() => {
                match runtime_event {
                    RuntimeEvent::Connected(connected) => {
                        app.daemon_status = DaemonStatus::Connected;
                        spawn_health_fetch(connected.clone(), tx.clone());
                        app.loading_health = true;
                        spawn_desktop(connected.clone(), tx.clone());
                        // The header shows the total channel balance on
                        // every view (TOON_Network#147), so Funds' own data
                        // is read eagerly on connect, the same as Health's.
                        spawn_funding_fetch(connected.clone(), tx.clone(), false);
                        app.funds.funding_loading = true;
                        app.funds.funding_busy = true;
                        spawn_gas_station_fetch(connected.clone(), tx.clone());
                        app.funds.gas_loading = true;
                        app.funds.gas_busy = true;
                        client = Some(connected);
                    }
                    RuntimeEvent::ConnectFailed(message) => {
                        app.daemon_status = DaemonStatus::Down(message);
                    }
                    RuntimeEvent::HealthLoaded(result) => match *result {
                        Ok(health) => {
                            app.health = Some(health);
                            app.loading_health = false;
                            app.daemon_status = DaemonStatus::Connected;
                        }
                        Err(message) => {
                            app.loading_health = false;
                            app.daemon_status = DaemonStatus::Error(message);
                        }
                    },
                    RuntimeEvent::SwitchView(view) => {
                        app.view = view;
                    }
                    // -- Funds (TOON_Network#147) --
                    RuntimeEvent::FundingLoaded(result) => app.funds.apply_funding(*result),
                    RuntimeEvent::GasStationLoaded(result) => app.funds.apply_gas_station(*result),
                    RuntimeEvent::GasQuoteLoaded(result) => app.funds.apply_gas_quote(*result),
                    RuntimeEvent::GasPurchaseLoaded(result) => app.funds.apply_gas_purchase(*result),
                }
            }
        }

        if app.should_quit {
            break;
        }
    }
    Ok(())
}

fn spawn_connect_loop(tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        loop {
            match DaemonClient::connect(launch_file_path()).await {
                Ok(client) => {
                    let _ = tx.send(RuntimeEvent::Connected(client));
                    return;
                }
                Err(LaunchError::NotRunning) => {
                    let _ = tx.send(RuntimeEvent::ConnectFailed(
                        LaunchError::NotRunning.to_string(),
                    ));
                }
                Err(other) => {
                    let _ = tx.send(RuntimeEvent::ConnectFailed(other.to_string()));
                }
            }
            tokio::time::sleep(Duration::from_millis(RECONNECT_MS)).await;
        }
    });
}

fn spawn_desktop(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    let (desktop_tx, mut desktop_rx) = unbounded_channel::<View>();
    tokio::spawn(desktop::run(client, desktop_tx, desktop::RETRY_MS));
    tokio::spawn(async move {
        while let Some(view) = desktop_rx.recv().await {
            if tx.send(RuntimeEvent::SwitchView(view)).is_err() {
                return;
            }
        }
    });
}

/// One-shot `GET /api/health`, matching the web UI's cadence: read once (on
/// connect) and again only when asked (`r`) — `use-console.ts` has no
/// auto-poll for Health, so this has none either.
fn spawn_health_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let result = client
            .get::<Health>("/api/health")
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::HealthLoaded(Box::new(result)));
    });
}

// -- Funds (TOON_Network#147): the daemon calls `views::funds` needs. --

fn spawn_funding_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    refresh: bool,
) {
    tokio::spawn(async move {
        let path = if refresh {
            "/api/funding?refresh=1"
        } else {
            "/api/funding"
        };
        let result = client
            .get::<FundingStatus>(path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::FundingLoaded(Box::new(result)));
    });
}

fn spawn_gas_station_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let result = client
            .get::<GasStationStatus>("/api/funding/gas")
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::GasStationLoaded(Box::new(result)));
    });
}

#[derive(Serialize)]
struct OpenChannelBody {
    chain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    deposit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connector: Option<String>,
}

/// Issued only from `Command::OpenChannel`, which `app::handle_key` only
/// ever produces once a confirmation has been shown and accepted
/// (`views::funds::handle_confirm_key`) — never straight from a keypress.
fn spawn_open_channel(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    chain: String,
    deposit: Option<String>,
    connector: Option<String>,
) {
    tokio::spawn(async move {
        let body = OpenChannelBody {
            chain,
            deposit,
            connector,
        };
        let result = client
            .post::<FundingStatus, _>("/api/funding/channel", &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::FundingLoaded(Box::new(result)));
    });
}

#[derive(Serialize)]
struct ChainBody {
    chain: String,
}

fn spawn_drip(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, chain: String) {
    tokio::spawn(async move {
        let body = ChainBody { chain };
        let result = client
            .post::<FundingStatus, _>("/api/funding/faucet", &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::FundingLoaded(Box::new(result)));
    });
}

fn spawn_quote_gas(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, chain: String) {
    tokio::spawn(async move {
        let body = ChainBody { chain };
        let result = client
            .post::<GasQuote, _>("/api/funding/gas/quote", &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::GasQuoteLoaded(Box::new(result)));
    });
}

#[derive(Serialize)]
struct BuyGasBody {
    chain: String,
    #[serde(rename = "quoteId")]
    quote_id: String,
}

/// Issued only from `Command::BuyGas`, same rule as `spawn_open_channel`:
/// only ever after a confirmation naming this exact `quote_id` was accepted.
fn spawn_buy_gas(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    chain: String,
    quote_id: String,
) {
    tokio::spawn(async move {
        let body = BuyGasBody { chain, quote_id };
        let result = client
            .post::<GasPurchase, _>("/api/funding/gas/buy", &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::GasPurchaseLoaded(Box::new(result)));
    });
}

#[cfg(test)]
mod tests {
    // `main.rs` is wiring; its seams (the keymap, the client, the launch
    // reader, a view's render) are unit-tested in their own modules under
    // `src/`, reachable without a terminal. Nothing here needs its own test.
}
