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

use toon_console_tui::app::{handle_key, handle_mouse, now_ms, App, Command, DaemonStatus, View};
use toon_console_tui::client::DaemonClient;
use toon_console_tui::desktop;
use toon_console_tui::launch::{launch_file_path, LaunchError};
use toon_console_tui::markdown;
use toon_console_tui::types::{
    BunkerSignerRequest, Directory, DirectoryFilters, DocsIndex, DocsPage, FundingStatus,
    GasPurchase, GasQuote, GasStationStatus, Health, ProfileSwitchRequest, Profiles,
    SessionStatus, SignInRequest,
};
use toon_console_tui::ui;
use toon_console_tui::views::directory::directory_query;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

/// How often `App::now_ms` is refreshed — the one clock this crate keeps, so
/// the Directory view's Liveness countdown ages on screen with nothing
/// refetched and no new event (mirrors `useNow` in `use-directory.ts`).
const CLOCK_TICK_MS: u64 = 1_000;

enum RuntimeEvent {
    Connected(Arc<DaemonClient>),
    ConnectFailed(String),
    HealthLoaded(Box<Result<Health, String>>),
    DirectoryLoaded(Box<Result<Directory, String>>),
    /// The answer to `GET /api/account`, or to any account action
    /// (sign-in, sign-out, add a signer, forget one) — every one of those
    /// routes answers with the same `SessionStatus`, the daemon's whole
    /// answer to "who is signed in now" (TOON_Network#141).
    AccountLoaded(Box<Result<SessionStatus, String>>),
    ProfilesLoaded(Box<Result<Profiles, String>>),
    /// `POST /api/profiles/active` succeeded: the new list (and which one is
    /// now active) has landed, and every view with its own data needs to
    /// re-read it before anything shown is trusted.
    ProfileSwitched(Profiles),
    ProfileSwitchFailed(String),
    SwitchView(View),
    /// `GET /api/docs`, on connect and again on `Command::RefreshDocs` while
    /// no article is open.
    DocsIndexLoaded(Box<Result<DocsIndex, String>>),
    /// `GET /api/docs/<d>`, on `Command::OpenDoc` and again on
    /// `Command::RefreshDocs` while one is.
    DocsPageLoaded(Box<Result<DocsPage, String>>),
    /// `xdg-open` did not open `Command::OpenDocsLink`'s href.
    DocsLinkOpenFailed(String),
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
    let mut clock = tokio::time::interval(Duration::from_millis(CLOCK_TICK_MS));

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
                            Command::RefreshDirectory => {
                                if let Some(client) = &client {
                                    spawn_directory_fetch(
                                        client.clone(),
                                        tx.clone(),
                                        app.directory.filters.clone(),
                                    );
                                    app.loading_directory = true;
                                }
                            }
                            Command::RefreshDocs => {
                                if let Some(client) = &client {
                                    match app.docs_page.as_ref().map(|page| page.doc.d.clone()) {
                                        Some(d) => {
                                            spawn_docs_page_fetch(client.clone(), tx.clone(), d, true)
                                        }
                                        None => spawn_docs_index_fetch(client.clone(), tx.clone(), true),
                                    }
                                    app.loading_docs = true;
                                }
                            }
                            Command::OpenDoc(d) => {
                                if let Some(client) = &client {
                                    spawn_docs_page_fetch(client.clone(), tx.clone(), d, false);
                                    app.loading_docs = true;
                                }
                            }
                            Command::OpenDocsLink(href) => {
                                spawn_open_link(href, tx.clone());
                            }
                            Command::RefreshAccount => {
                                if let Some(client) = &client {
                                    spawn_account_fetch(client.clone(), tx.clone());
                                    app.loading_account = true;
                                }
                            }
                            Command::AddLocalSigner(request) => {
                                if let Some(client) = &client {
                                    spawn_account_post(
                                        client.clone(),
                                        tx.clone(),
                                        "/api/account/signers/local",
                                        request,
                                    );
                                }
                            }
                            Command::AddBunkerSigner { uri, passphrase } => {
                                if let Some(client) = &client {
                                    spawn_account_post(
                                        client.clone(),
                                        tx.clone(),
                                        "/api/account/signers/bunker",
                                        BunkerSignerRequest {
                                            uri,
                                            label: None,
                                            passphrase,
                                        },
                                    );
                                }
                            }
                            Command::SignIn { id, passphrase } => {
                                if let Some(client) = &client {
                                    spawn_account_post(
                                        client.clone(),
                                        tx.clone(),
                                        "/api/account/signin",
                                        SignInRequest { id, passphrase },
                                    );
                                }
                            }
                            Command::SignOut => {
                                if let Some(client) = &client {
                                    spawn_account_signout(client.clone(), tx.clone());
                                }
                            }
                            Command::ForgetSigner(id) => {
                                if let Some(client) = &client {
                                    spawn_forget_signer(client.clone(), tx.clone(), id);
                                }
                            }
                            Command::SwitchProfile(id) => {
                                if let Some(client) = &client {
                                    app.switching_profile = Some(id.clone());
                                    spawn_switch_profile(client.clone(), tx.clone(), id);
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
                        spawn_directory_fetch(connected.clone(), tx.clone(), DirectoryFilters::default());
                        app.loading_directory = true;
                        spawn_docs_index_fetch(connected.clone(), tx.clone(), false);
                        app.loading_docs = true;
                        // The header shows the signed-in account and the
                        // active profile on every view (TOON_Network#141), so
                        // both are read once here — the same "on connect"
                        // moment Health is — not lazily when the Account view
                        // is first opened.
                        spawn_account_fetch(connected.clone(), tx.clone());
                        app.loading_account = true;
                        spawn_profiles_fetch(connected.clone(), tx.clone());
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
                    RuntimeEvent::DirectoryLoaded(result) => match *result {
                        Ok(directory) => {
                            app.directory.apply(directory);
                            app.loading_directory = false;
                            app.daemon_status = DaemonStatus::Connected;
                        }
                        Err(message) => {
                            app.loading_directory = false;
                            app.daemon_status = DaemonStatus::Error(message);
                        }
                    },
                    RuntimeEvent::AccountLoaded(result) => match *result {
                        Ok(status) => {
                            app.account = Some(status);
                            app.loading_account = false;
                            app.account_error = None;
                        }
                        Err(message) => {
                            app.loading_account = false;
                            app.account_error = Some(message);
                        }
                    },
                    RuntimeEvent::ProfilesLoaded(result) => {
                        if let Ok(profiles) = *result {
                            app.profiles = Some(profiles);
                        }
                        // A failure here is not shown on its own: the header
                        // and the Account view's profile switcher simply keep
                        // showing nothing until the next successful read —
                        // Health's own error (if any) already says the daemon
                        // is having trouble.
                    }
                    RuntimeEvent::ProfileSwitched(profiles) => {
                        app.profiles = Some(profiles);
                        app.switching_profile = None;
                        // ADR 0028: "a switch re-reads rather than patches" —
                        // the new profile's connector and account-relay
                        // fallback are a different machine with different
                        // terms. Every view with its own data re-fetches
                        // here (the spec: every view refreshes after a
                        // switch); a later view ticket's data joins this list.
                        if let Some(client) = &client {
                            spawn_health_fetch(client.clone(), tx.clone());
                            app.loading_health = true;
                            spawn_account_fetch(client.clone(), tx.clone());
                            app.loading_account = true;
                            spawn_directory_fetch(
                                client.clone(),
                                tx.clone(),
                                app.directory.filters.clone(),
                            );
                            app.loading_directory = true;
                            spawn_docs_index_fetch(client.clone(), tx.clone(), false);
                            app.loading_docs = true;
                            spawn_funding_fetch(client.clone(), tx.clone(), false);
                            app.funds.funding_loading = true;
                            app.funds.funding_busy = true;
                            spawn_gas_station_fetch(client.clone(), tx.clone());
                            app.funds.gas_loading = true;
                            app.funds.gas_busy = true;
                        }
                    }
                    RuntimeEvent::ProfileSwitchFailed(message) => {
                        app.switching_profile = None;
                        app.account_error = Some(message);
                    }
                    RuntimeEvent::SwitchView(view) => {
                        app.view = view;
                    }
                    RuntimeEvent::DocsIndexLoaded(result) => match *result {
                        Ok(index) => {
                            app.docs_selected = app
                                .docs_selected
                                .min(index.docs.len().saturating_sub(1));
                            app.docs_index = Some(index);
                            app.loading_docs = false;
                            app.docs_error = None;
                        }
                        Err(message) => {
                            app.loading_docs = false;
                            app.docs_error = Some(message);
                        }
                    },
                    RuntimeEvent::DocsPageLoaded(result) => match *result {
                        Ok(page) => {
                            app.docs_link_hrefs = markdown::render(&page.doc.markdown, None)
                                .links
                                .into_iter()
                                .map(|link| link.href)
                                .collect();
                            app.docs_link_index = 0;
                            app.docs_scroll = 0;
                            app.docs_page = Some(page);
                            app.loading_docs = false;
                            app.docs_open_error = None;
                        }
                        Err(message) => {
                            app.loading_docs = false;
                            app.docs_open_error = Some(message);
                        }
                    },
                    RuntimeEvent::DocsLinkOpenFailed(message) => {
                        app.docs_open_error = Some(message);
                    }
                    // -- Funds (TOON_Network#147) --
                    RuntimeEvent::FundingLoaded(result) => app.funds.apply_funding(*result),
                    RuntimeEvent::GasStationLoaded(result) => app.funds.apply_gas_station(*result),
                    RuntimeEvent::GasQuoteLoaded(result) => app.funds.apply_gas_quote(*result),
                    RuntimeEvent::GasPurchaseLoaded(result) => app.funds.apply_gas_purchase(*result),
                }
            }
            _ = clock.tick() => {
                app.now_ms = now_ms();
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

/// `GET /api/directory`, with whichever filters are current: once on connect
/// (matching Health's cadence), and again whenever `views::directory`'s
/// keymap asks for a refresh — a filter change or `r`.
fn spawn_directory_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    filters: DirectoryFilters,
) {
    tokio::spawn(async move {
        let path = format!("/api/directory{}", directory_query(&filters));
        let result = client
            .get::<Directory>(&path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::DirectoryLoaded(Box::new(result)));
    });
}

/// `GET /api/docs`, on connect and again on `r` while no article is open —
/// `refresh` is the daemon's own `?refresh=1`, the same query `docs-view.tsx`'s
/// "Re-read from relays" button sends.
fn spawn_docs_index_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    refresh: bool,
) {
    tokio::spawn(async move {
        let path = if refresh {
            "/api/docs?refresh=1"
        } else {
            "/api/docs"
        };
        let result = client
            .get::<DocsIndex>(path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::DocsIndexLoaded(Box::new(result)));
    });
}

/// `GET /api/docs/<d>`, on `Enter` in the reading list and again on `r` while
/// this page is the one open. `d` is a doc's own slug (`docs-content.ts`'s
/// `SLUG` pattern: lower-case words joined by single hyphens), so unlike the
/// web client's `encodeURIComponent(d)` there is nothing here that needs
/// percent-encoding.
fn spawn_docs_page_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    d: String,
    refresh: bool,
) {
    tokio::spawn(async move {
        let path = if refresh {
            format!("/api/docs/{d}?refresh=1")
        } else {
            format!("/api/docs/{d}")
        };
        let result = client
            .get::<DocsPage>(&path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::DocsPageLoaded(Box::new(result)));
    });
}

/// `o` on a focused link. Runs `xdg-open` directly — no shell, so nothing in
/// an `href` that came off a relay-published article is ever interpreted by
/// one.
fn spawn_open_link(href: String, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        match tokio::process::Command::new("xdg-open")
            .arg(&href)
            .status()
            .await
        {
            Ok(status) if status.success() => {}
            Ok(status) => {
                let _ = tx.send(RuntimeEvent::DocsLinkOpenFailed(format!(
                    "xdg-open exited with {status} for {href}"
                )));
            }
            Err(err) => {
                let _ = tx.send(RuntimeEvent::DocsLinkOpenFailed(format!(
                    "could not run xdg-open: {err}"
                )));
            }
        }
    });
}

/// One-shot `GET /api/account` — who is signed in right now. Read on
/// connect (so the header has an answer on every view) and again on `r`
/// while the Account view is open.
fn spawn_account_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let result = client
            .get::<SessionStatus>("/api/account")
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::AccountLoaded(Box::new(result)));
    });
}

fn spawn_profiles_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let result = client
            .get::<Profiles>("/api/profiles")
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::ProfilesLoaded(Box::new(result)));
    });
}

/// Every account action that takes a body — add a local signer, add a
/// bunker signer, sign back in with a saved one — answers with the same
/// `SessionStatus` `GET /api/account` does, so one generic POST covers all
/// of them.
fn spawn_account_post<B: serde::Serialize + Send + Sync + 'static>(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    path: &'static str,
    body: B,
) {
    tokio::spawn(async move {
        let result = client
            .post::<B, SessionStatus>(path, &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::AccountLoaded(Box::new(result)));
    });
}

fn spawn_account_signout(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let result = client
            .post_empty::<SessionStatus>("/api/account/signout")
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::AccountLoaded(Box::new(result)));
    });
}

fn spawn_forget_signer(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, id: String) {
    tokio::spawn(async move {
        let path = format!("/api/account/signers/{}", encode_path_segment(&id));
        let result = client
            .delete::<SessionStatus>(&path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::AccountLoaded(Box::new(result)));
    });
}

fn spawn_switch_profile(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, id: String) {
    tokio::spawn(async move {
        let body = ProfileSwitchRequest { id };
        match client
            .post::<ProfileSwitchRequest, Profiles>("/api/profiles/active", &body)
            .await
        {
            Ok(profiles) => {
                let _ = tx.send(RuntimeEvent::ProfileSwitched(profiles));
            }
            Err(err) => {
                let _ = tx.send(RuntimeEvent::ProfileSwitchFailed(err.to_string()));
            }
        }
    });
}

/// A minimal `encodeURIComponent`-equivalent for one path segment — a
/// signer id, always a UUID from `randomUUID()` in practice, but encoded
/// properly rather than assumed safe, the way `daemon.ts`'s
/// `forgetSigner` does with the real `encodeURIComponent`.
fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// -- Funds (TOON_Network#147): the daemon calls `views::funds` needs. --

/// `GET /api/funding`, on connect (and after a profile switch) and again on
/// `r` — `refresh` is the daemon's own `?refresh=1`, matching
/// `spawn_docs_index_fetch`'s convention above.
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
            .post::<_, FundingStatus>("/api/funding/channel", &body)
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
            .post::<_, FundingStatus>("/api/funding/faucet", &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::FundingLoaded(Box::new(result)));
    });
}

fn spawn_quote_gas(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, chain: String) {
    tokio::spawn(async move {
        let body = ChainBody { chain };
        let result = client
            .post::<_, GasQuote>("/api/funding/gas/quote", &body)
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
            .post::<_, GasPurchase>("/api/funding/gas/buy", &body)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::GasPurchaseLoaded(Box::new(result)));
    });
}

#[cfg(test)]
mod tests {
    use super::encode_path_segment;

    // `main.rs` is wiring; almost every seam (the keymap, the client, the
    // launch reader, a view's render) is unit-tested in its own module under
    // `src/`, reachable without a terminal. `encode_path_segment` is the one
    // piece of real logic added directly here (TOON_Network#141's
    // forget-a-signer route), so it gets its own small test.

    #[test]
    fn a_uuid_passes_through_unchanged() {
        assert_eq!(
            encode_path_segment("9f3e2b1a-0000-4000-8000-000000000000"),
            "9f3e2b1a-0000-4000-8000-000000000000"
        );
    }

    #[test]
    fn a_character_a_path_segment_cannot_contain_is_percent_encoded() {
        assert_eq!(encode_path_segment("a/b c"), "a%2Fb%20c");
    }
}
