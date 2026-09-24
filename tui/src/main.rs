//! Entry point: terminal setup/teardown and the event loop.
//!
//! This file is deliberately thin wiring and nothing else — every seam worth
//! a unit test (the keymap, the client, the launch-record reader, a view's
//! render) lives in `lib.rs`'s modules, where `cargo test` reaches it without
//! a real terminal. What is here: bring the terminal up, connect to the
//! daemon (retrying with an actionable message if it is not running yet),
//! fetch Health once, and run the loop that turns input and background
//! events into redraws.

use std::future::Future;
use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    EventStream, KeyEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use zeroize::Zeroizing;

use toon_console_tui::api;
use toon_console_tui::app::{
    handle_key, handle_mouse, handle_paste, now_ms, App, Command, DaemonStatus, View,
};
use toon_console_tui::client::{ClientError, DaemonClient};
use toon_console_tui::clipboard;
use toon_console_tui::desktop;
use toon_console_tui::launch::{launch_file_path, LaunchError};
use toon_console_tui::markdown;
use toon_console_tui::types::{
    BunkerSignerRequest, ChainSeedStatus, Dashboard, Directory, DirectoryFilters, DocsIndex,
    DocsPage, ExpandTemplateRequest, ExpandedTemplate, ExtendResult, ForgetResult, FundingStatus,
    GasPurchase, GasQuote, GasStationStatus, GatewayView, HandoverResult, Health, PreflightView,
    ProfileEndpointsError, ProfileEndpointsRequest, Profiles, RotationResult, RotationView,
    SessionStatus, SignInRequest, SpawnRequestBody, SpawnResult, StandbySetPreflightView,
    StandbySetRequestBody, StandbySetResult, TemplateGallery, TemplateSpawnRequestBody,
    TerminateResult, WithdrawalResult, WorkloadCard,
};
use toon_console_tui::ui;
use toon_console_tui::views::account as account_view;
use toon_console_tui::views::chain_seed;
use toon_console_tui::views::funds;
use toon_console_tui::views::new_workload;
use toon_console_tui::views::workloads as workloads_view;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

/// How often `App::now_ms` is refreshed — the one clock this crate keeps, so
/// the Directory view's Liveness countdown ages on screen with nothing
/// refetched and no new event (mirrors `useNow` in `use-directory.ts`).
const CLOCK_TICK_MS: u64 = 1_000;

/// The web UI's own cadence for the dashboard (`POLL_MS` in
/// `packages/ui/src/hooks/use-workloads.ts`) — TOON_Network#143's
/// acceptance criterion is "refreshing at its cadence", so this is that
/// number, not a TUI-only guess.
const WORKLOADS_POLL_MS: u64 = 30_000;

/// `POLL_MS` in `packages/ui/src/hooks/use-funding.ts` — checked every tick
/// against [`views::funds::FundsState::pending`], the same "poll only while
/// something is happening" gate the web hook applies, so the header's
/// channel balance keeps moving while an open is in flight without a
/// standing timer running the rest of the time.
const FUNDING_POLL_MS: u64 = 2_000;

/// `POLL_MS` in `packages/ui/src/hooks/use-account.ts` — checked every tick
/// against [`views::account::poll_needed`].
const ACCOUNT_POLL_MS: u64 = 1_500;

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
    /// `PUT /api/profiles/<id>` (TOON_Network#150) answered — the id travels
    /// alongside so a failure can be matched back to the open editor, and a
    /// success can tell whether the profile just touched was the active one
    /// (`refresh_after_profile_change`'s own gate).
    ProfileSaved(String, Result<Profiles, ProfileActionFailure>),
    /// `DELETE /api/profiles/<id>` answered.
    ProfileReset(String, Result<Profiles, ProfileActionFailure>),
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
    /// TOON_Network#138: New workload's own "open a channel with this
    /// connector" — the answer to both `Command::FetchFundingForConnector`
    /// (the `o` read) and `Command::OpenChannelForConnector` (the confirmed
    /// open), which share this one event because both hand back the same
    /// connector-scoped `FundingStatus`
    /// (`views::new_workload::apply_connector_funding` does not care which
    /// request produced it).
    ConnectorFundingLoaded(Box<Result<FundingStatus, String>>),
    GasStationLoaded(Box<Result<GasStationStatus, String>>),
    GasQuoteLoaded(Box<Result<GasQuote, String>>),
    GasPurchaseLoaded(Box<Result<GasPurchase, String>>),
    // -- Workloads (TOON_Network#143) --
    WorkloadsLoaded(Box<Result<Dashboard, String>>),
    WorkloadExtended(Box<Result<ExtendResult, String>>),
    WorkloadTerminated(Box<Result<TerminateResult, String>>),
    /// `DELETE /api/workloads/<id>` answered (TOON_Network#138): the card
    /// leaves `app.workloads.dashboard` on success (the daemon's own list no
    /// longer holds it either), whether or not the best-effort relay
    /// tombstone confirmed.
    WorkloadForgotten(Box<Result<ForgetResult, String>>),
    // -- Workloads: auto-extend, rotate, gateway (TOON_Network#144) --
    AutoExtendArmed(Box<Result<WorkloadCard, String>>),
    AutoExtendDisarmed(Box<Result<WorkloadCard, String>>),
    WorkloadRotated(Box<Result<RotationResult, String>>),
    WorkloadHandedOver(Box<Result<HandoverResult, String>>),
    WorkloadWithdrawn(Box<Result<WithdrawalResult, String>>),
    /// `GET …/rotation` and `GET …/gateway`, read lazily for whichever
    /// workload is selected — see `views::workloads`'s module doc.
    RotationLoaded(Box<Result<RotationView, String>>),
    GatewayLoaded(Box<Result<GatewayView, String>>),
    /// `Command::CopyToClipboard`'s answer — the label travels alongside the
    /// outcome (TOON_Network#138) so the footer's status line can say WHAT
    /// was copied without `main.rs` needing to remember it across the
    /// `await`.
    ClipboardDone {
        label: String,
        outcome: clipboard::ClipboardOutcome,
    },
    /// `Command::RequestClipboardPaste`'s answer (Ctrl+V, TOON_Network#138):
    /// `wl-paste --no-newline`'s stdout, or the reason it could not be read
    /// (missing, or exited non-zero).
    ClipboardPasted(Result<String, String>),
    /// The answer to `GET /api/chain-seed`, or to any Chain Seed action
    /// (acknowledge, mint, import, publish, refresh) — every one of those
    /// routes answers with the same `ChainSeedStatus` (TOON_Network#142).
    ChainSeedLoaded(Box<Result<ChainSeedStatus, String>>),
    // -- New workload (TOON_Network#146) --
    /// `GET /api/templates`, on connect, on a profile switch, and on `r`.
    TemplatesLoaded(Box<Result<TemplateGallery, String>>),
    /// `POST /api/templates/expand` — moves the wizard on to
    /// [`new_workload::Stage::Listing`] on success; stays on the Form stage,
    /// with the error beside "Preview the spawn", on failure.
    TemplateExpanded(Box<Result<ExpandedTemplate, String>>),
    SpawnPreflighted(Box<Result<PreflightView, String>>),
    StandbySetPreflighted(Box<Result<StandbySetPreflightView, String>>),
    /// `POST /api/leases/spawn` — on success, `run` switches to the
    /// Workloads view with the new lease selected (see the handler below).
    WorkloadSpawned(Box<Result<SpawnResult, String>>),
    StandbySetSpawned(Box<Result<StandbySetResult, String>>),
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
    // `EnableBracketedPaste` (TOON_Network#138) is what turns a terminal
    // paste into one `Event::Paste(String)` instead of a keystroke per
    // character — without it, pasting a bunker URI or a mnemonic would type
    // it one `KeyCode::Char` at a time, indistinguishable from someone
    // actually typing that fast.
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    // A panic must still leave the terminal usable — nobody wants a stuck
    // raw-mode shell after a bug in this crate. `restore_terminal` disables
    // bracketed paste too, so the hook covers that the same way it already
    // covers mouse capture and the alternate screen.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = restore_terminal();
        previous_hook(info);
    }));
    Terminal::new(CrosstermBackend::new(stdout))
}

fn restore_terminal() -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        io::stdout(),
        LeaveAlternateScreen,
        DisableMouseCapture,
        DisableBracketedPaste
    )?;
    Ok(())
}

async fn run(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> io::Result<()> {
    let mut app = App::new();
    let mut client: Option<Arc<DaemonClient>> = None;
    let mut hits = ui::Hits::default();
    let (tx, mut rx) = unbounded_channel::<RuntimeEvent>();

    spawn_connect_loop(tx.clone());

    let mut events = EventStream::new();
    let mut clock = tokio::time::interval(Duration::from_millis(CLOCK_TICK_MS));
    let mut funding_clock = tokio::time::interval(Duration::from_millis(FUNDING_POLL_MS));
    let mut account_clock = tokio::time::interval(Duration::from_millis(ACCOUNT_POLL_MS));

    loop {
        terminal.draw(|frame| {
            hits = ui::draw(frame, &app);
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
                                    match app.docs.page.as_ref().map(|page| page.doc.d.clone()) {
                                        Some(d) => {
                                            spawn_docs_page_fetch(client.clone(), tx.clone(), d, true)
                                        }
                                        None => spawn_docs_index_fetch(client.clone(), tx.clone(), true),
                                    }
                                    app.docs.loading = true;
                                }
                            }
                            Command::OpenDoc(d) => {
                                if let Some(client) = &client {
                                    spawn_docs_page_fetch(client.clone(), tx.clone(), d, false);
                                    app.docs.loading = true;
                                }
                            }
                            Command::OpenDocsLink(href) => {
                                spawn_open_link(href, tx.clone());
                            }
                            Command::RefreshAccount => {
                                if let Some(client) = &client {
                                    spawn_account_fetch(client.clone(), tx.clone());
                                    app.loading_account = true;
                                    // `r` on Account re-reads the Chain Seed
                                    // section below it too: it is part of the
                                    // same view.
                                    if app.chain_seed_for_pubkey.is_some() {
                                        spawn_chain_seed_fetch(client.clone(), tx.clone());
                                        app.loading_chain_seed = true;
                                    }
                                }
                            }
                            Command::AddLocalSigner(request) => {
                                if let Some(client) = &client {
                                    spawn_account_call(client.clone(), tx.clone(), move |client| async move {
                                        api::add_local_signer(&client, &request).await
                                    });
                                }
                            }
                            Command::AddBunkerSigner { uri, passphrase } => {
                                if let Some(client) = &client {
                                    let request = BunkerSignerRequest {
                                        uri,
                                        label: None,
                                        passphrase,
                                    };
                                    spawn_account_call(client.clone(), tx.clone(), move |client| async move {
                                        api::add_bunker_signer(&client, &request).await
                                    });
                                }
                            }
                            Command::SignIn { id, passphrase } => {
                                if let Some(client) = &client {
                                    let request = SignInRequest { id, passphrase };
                                    spawn_account_call(client.clone(), tx.clone(), move |client| async move {
                                        api::sign_in(&client, &request).await
                                    });
                                }
                            }
                            Command::SignOut => {
                                if let Some(client) = &client {
                                    spawn_account_call(client.clone(), tx.clone(), |client| async move {
                                        api::sign_out(&client).await
                                    });
                                }
                            }
                            Command::ForgetSigner(id) => {
                                if let Some(client) = &client {
                                    spawn_account_call(client.clone(), tx.clone(), move |client| async move {
                                        api::forget_signer(&client, &id).await
                                    });
                                }
                            }
                            Command::SwitchProfile(id) => {
                                if let Some(client) = &client {
                                    app.switching_profile = Some(id.clone());
                                    spawn_switch_profile(client.clone(), tx.clone(), id);
                                }
                            }
                            Command::SaveProfile { id, request } => {
                                if let Some(client) = &client {
                                    spawn_save_profile(client.clone(), tx.clone(), id, request);
                                }
                            }
                            Command::ResetProfile(id) => {
                                if let Some(client) = &client {
                                    spawn_reset_profile(client.clone(), tx.clone(), id);
                                }
                            }
                            Command::AcknowledgeChainSeedWarning => {
                                if let Some(client) = &client {
                                    spawn_chain_seed_call(client.clone(), tx.clone(), |client| async move {
                                        api::acknowledge_chain_seed_warning(&client).await
                                    });
                                }
                            }
                            Command::MintChainSeed => {
                                if let Some(client) = &client {
                                    spawn_chain_seed_call(client.clone(), tx.clone(), |client| async move {
                                        api::mint_chain_seed(&client).await
                                    });
                                }
                            }
                            Command::ImportChainSeed(mnemonic) => {
                                if let Some(client) = &client {
                                    spawn_chain_seed_call(client.clone(), tx.clone(), move |client| async move {
                                        api::import_chain_seed(&client, mnemonic).await
                                    });
                                }
                            }
                            // Only ever produced by the confirm modal's own
                            // typed-`yes`-then-`Enter` — see
                            // `views::chain_seed` and
                            // `views::account::handle_key`.
                            Command::PublishChainSeed => {
                                if let Some(client) = &client {
                                    spawn_chain_seed_call(client.clone(), tx.clone(), |client| async move {
                                        api::publish_chain_seed(&client).await
                                    });
                                }
                            }
                            Command::RefreshChainSeed => {
                                if let Some(client) = &client {
                                    spawn_chain_seed_call(client.clone(), tx.clone(), |client| async move {
                                        api::refresh_chain_seed(&client).await
                                    });
                                }
                            }
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
                            // -- New workload's own "open a channel with
                            // this connector" (TOON_Network#138) --
                            Command::FetchFundingForConnector(connector) => {
                                if let Some(client) = &client {
                                    spawn_connector_funding_fetch(client.clone(), tx.clone(), connector);
                                }
                            }
                            Command::OpenChannelForConnector { chain, deposit, connector } => {
                                if let Some(client) = &client {
                                    spawn_open_channel_for_connector(client.clone(), tx.clone(), chain, deposit, connector);
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
                            // -- Workloads (TOON_Network#143, #144) --
                            Command::RefreshWorkloads => {
                                if let Some(client) = &client {
                                    spawn_workloads_fetch(client.clone(), tx.clone(), true);
                                    app.workloads.loading = true;
                                }
                            }
                            Command::ExtendWorkload { workload_id, max_price } => {
                                if let Some(client) = &client {
                                    spawn_extend(client.clone(), tx.clone(), workload_id, max_price);
                                }
                            }
                            Command::TerminateWorkload { workload_id } => {
                                if let Some(client) = &client {
                                    spawn_terminate(client.clone(), tx.clone(), workload_id);
                                }
                            }
                            Command::ArmAutoExtend { workload_id, budget, agreed_price } => {
                                if let Some(client) = &client {
                                    spawn_arm_auto_extend(client.clone(), tx.clone(), workload_id, budget, agreed_price);
                                }
                            }
                            Command::DisarmAutoExtend { workload_id } => {
                                if let Some(client) = &client {
                                    spawn_disarm_auto_extend(client.clone(), tx.clone(), workload_id);
                                }
                            }
                            Command::RotateWorkload { workload_id } => {
                                if let Some(client) = &client {
                                    spawn_rotate(client.clone(), tx.clone(), workload_id);
                                }
                            }
                            Command::HandOverWorkload { workload_id } => {
                                if let Some(client) = &client {
                                    spawn_handover(client.clone(), tx.clone(), workload_id);
                                }
                            }
                            Command::WithdrawWorkload { workload_id } => {
                                if let Some(client) = &client {
                                    spawn_withdraw(client.clone(), tx.clone(), workload_id);
                                }
                            }
                            Command::ForgetWorkload { workload_id } => {
                                if let Some(client) = &client {
                                    spawn_forget(client.clone(), tx.clone(), workload_id);
                                }
                            }
                            // TOON_Network#138: the one `y` mechanism, for
                            // every view — see `app::global_key` and
                            // `widgets::copy_picker`.
                            Command::CopyToClipboard { label, value } => {
                                spawn_clipboard_copy(label, value, tx.clone());
                            }
                            // Ctrl+V while a field is focused (TOON_Network#138).
                            // No `client` involved — this never reaches the
                            // daemon.
                            Command::RequestClipboardPaste => {
                                spawn_clipboard_paste(tx.clone());
                            }
                            // -- New workload (TOON_Network#146) --
                            Command::RefreshTemplates => {
                                if let Some(client) = &client {
                                    spawn_templates_fetch(client.clone(), tx.clone());
                                    app.new_workload.loading_gallery = true;
                                }
                            }
                            Command::ExpandTemplate(request) => {
                                if let Some(client) = &client {
                                    spawn_expand_template(client.clone(), tx.clone(), request);
                                }
                            }
                            Command::PreflightSpawn(request) => {
                                if let Some(client) = &client {
                                    spawn_preflight_spawn(client.clone(), tx.clone(), request);
                                }
                            }
                            Command::PreflightStandbySet(request) => {
                                if let Some(client) = &client {
                                    spawn_preflight_standby_set(client.clone(), tx.clone(), request);
                                }
                            }
                            // Only ever produced by New workload's own
                            // typed-`yes`-then-`Enter` confirmation — see
                            // `views::new_workload::handle_key`.
                            Command::SpawnFromTemplate(request) => {
                                if let Some(client) = &client {
                                    spawn_workload_spawn(client.clone(), tx.clone(), request);
                                }
                            }
                            Command::SpawnStandbySet(request) => {
                                if let Some(client) = &client {
                                    spawn_standby_set_spawn(client.clone(), tx.clone(), request);
                                }
                            }
                            Command::None => {}
                        }
                    }
                    Event::Mouse(mouse) => {
                        handle_mouse(&mut app, mouse, &hits.sidebar, &hits.rows);
                    }
                    // TOON_Network#138: bracketed paste (`EnableBracketedPaste`
                    // in `setup_terminal`) lands here as one event rather than
                    // a keystroke per character. Wrapped in `Zeroizing` for
                    // the length of this call only, so a pasted secret (an
                    // nsec, a mnemonic) does not linger in this owned
                    // `String` once `app::handle_paste` has copied what it
                    // needs into the focused field's own zeroizing buffer.
                    Event::Paste(text) => {
                        let text = Zeroizing::new(text);
                        handle_paste(&mut app, &text);
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
                        app.docs.loading = true;
                        // The header shows the signed-in account and the
                        // active profile on every view (TOON_Network#141), so
                        // both are read once here — the same "on connect"
                        // moment Health is — not lazily when the Account view
                        // is first opened.
                        spawn_account_fetch(connected.clone(), tx.clone());
                        app.loading_account = true;
                        spawn_profiles_fetch(connected.clone(), tx.clone());
                        // The header shows the total channel balance on
                        // every view (TOON_Network#147), so Funds' own data
                        // is read eagerly on connect, the same as Health's.
                        spawn_funding_fetch(connected.clone(), tx.clone(), false);
                        app.funds.funding_loading = true;
                        app.funds.funding_busy = true;
                        spawn_gas_station_fetch(connected.clone(), tx.clone());
                        app.funds.gas_loading = true;
                        app.funds.gas_busy = true;
                        spawn_workloads_fetch(connected.clone(), tx.clone(), true);
                        app.workloads.loading = true;
                        spawn_workloads_poll(connected.clone(), tx.clone());
                        // The Template gallery (TOON_Network#146) is read
                        // eagerly too, the same as Directory and Docs: reading
                        // is free and needs no account (`use-templates.ts`).
                        spawn_templates_fetch(connected.clone(), tx.clone());
                        app.new_workload.loading_gallery = true;
                        spawn_desktop(connected.clone(), tx.clone());
                        client = Some(connected);
                    }
                    RuntimeEvent::ConnectFailed(message) => {
                        app.daemon_status = DaemonStatus::Down(message);
                    }
                    RuntimeEvent::HealthLoaded(result) => match *result {
                        Ok(health) => {
                            // TOON_Network#138: the Funds tab's own "which
                            // connector is this channel with" line reads the
                            // same profile connector the header's label
                            // does, rather than keep a second copy of it.
                            app.funds.connector_url = Some(health.profile.connector_url.clone());
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
                            // New workload's Listing picker (TOON_Network#146)
                            // shares this exact read rather than fetching its
                            // own — see `views::new_workload`'s module doc.
                            new_workload::apply_directory(&mut app.new_workload, &directory);
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
                            let pubkey = status.account.as_ref().map(|view| view.pubkey.clone());
                            app.account = Some(status);
                            app.loading_account = false;
                            app.account_error = None;
                            // The Chain Seed belongs to the Account
                            // (TOON_Network#142): signing in as somebody
                            // else — or signing out — is a different seed
                            // or none, so a change in who is signed in is
                            // the trigger to read it again, the same way
                            // `use-chain-seed.ts` keys its reload off
                            // `options.pubkey`.
                            if pubkey != app.chain_seed_for_pubkey {
                                app.chain_seed_for_pubkey = pubkey.clone();
                                if let (Some(client), Some(_)) = (&client, &pubkey) {
                                    spawn_chain_seed_fetch(client.clone(), tx.clone());
                                    app.loading_chain_seed = true;
                                } else {
                                    app.chain_seed = None;
                                }
                            }
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
                        refresh_after_profile_change(&client, &tx, &mut app);
                    }
                    RuntimeEvent::ProfileSwitchFailed(message) => {
                        app.switching_profile = None;
                        app.account_error = Some(message);
                    }
                    // TOON_Network#150: a save/reset that touched the ACTIVE
                    // profile takes effect the same way a switch does — the
                    // same re-fetch list, just gated on "was this the active
                    // id" instead of always running (a save to a profile
                    // nobody is using changes nothing currently on screen).
                    RuntimeEvent::ProfileSaved(id, Ok(profiles)) => {
                        let was_active = profiles.active_id == id;
                        app.profiles = Some(profiles);
                        app.account_view.network_editor = None;
                        if was_active {
                            refresh_after_profile_change(&client, &tx, &mut app);
                        }
                    }
                    RuntimeEvent::ProfileSaved(_, Err(failure)) => {
                        if let Some(editor) = &mut app.account_view.network_editor {
                            editor.saving = false;
                            editor.general_error = Some(failure.message);
                            editor.errors = failure.errors;
                        }
                    }
                    RuntimeEvent::ProfileReset(id, Ok(profiles)) => {
                        let was_active = profiles.active_id == id;
                        app.profiles = Some(profiles);
                        if was_active {
                            refresh_after_profile_change(&client, &tx, &mut app);
                        }
                    }
                    RuntimeEvent::ProfileReset(_, Err(failure)) => {
                        app.account_error = Some(failure.message);
                    }
                    RuntimeEvent::SwitchView(view) => {
                        app.view = view;
                    }
                    RuntimeEvent::ChainSeedLoaded(result) => match *result {
                        Ok(status) => {
                            let first_read = chain_seed::first_read_needed(
                                &status,
                                app.chain_seed_read_for.as_deref(),
                            );
                            if first_read {
                                app.chain_seed_read_for = status.pubkey.clone();
                            }
                            app.chain_seed = Some(status);
                            app.loading_chain_seed = false;
                            app.chain_seed_error = None;
                            if first_read {
                                if let Some(client) = &client {
                                    spawn_chain_seed_call(client.clone(), tx.clone(), |client| async move {
                                        api::refresh_chain_seed(&client).await
                                    });
                                    app.loading_chain_seed = true;
                                }
                            }
                        }
                        Err(message) => {
                            app.loading_chain_seed = false;
                            app.chain_seed_error = Some(message);
                        }
                    },
                    RuntimeEvent::DocsIndexLoaded(result) => match *result {
                        Ok(index) => {
                            app.docs.selected = app
                                .docs
                                .selected
                                .min(index.docs.len().saturating_sub(1));
                            app.docs.index = Some(index);
                            app.docs.loading = false;
                            app.docs.error = None;
                        }
                        Err(message) => {
                            app.docs.loading = false;
                            app.docs.error = Some(message);
                        }
                    },
                    RuntimeEvent::DocsPageLoaded(result) => match *result {
                        Ok(page) => {
                            app.docs.link_hrefs = markdown::render(&page.doc.markdown, None)
                                .links
                                .into_iter()
                                .map(|link| link.href)
                                .collect();
                            app.docs.link_index = 0;
                            app.docs.scroll = 0;
                            app.docs.page = Some(page);
                            app.docs.loading = false;
                            app.docs.open_error = None;
                        }
                        Err(message) => {
                            app.docs.loading = false;
                            app.docs.open_error = Some(message);
                        }
                    },
                    RuntimeEvent::DocsLinkOpenFailed(message) => {
                        app.docs.open_error = Some(message);
                    }
                    // -- Funds (TOON_Network#147) --
                    RuntimeEvent::FundingLoaded(result) => {
                        // A channel that has just opened is what a Chain
                        // Seed publish waits on ("no payment channel"), so
                        // the Account view re-reads it rather than keep
                        // saying so until the next sign-in.
                        if app.funds.apply_funding(*result) && app.chain_seed_for_pubkey.is_some() {
                            if let Some(client) = &client {
                                spawn_chain_seed_fetch(client.clone(), tx.clone());
                                app.loading_chain_seed = true;
                            }
                        }
                    }
                    // TOON_Network#138: New workload's own "open a channel
                    // with this connector" — the connector-scoped funding
                    // read, and the confirmed open, land here alike.
                    RuntimeEvent::ConnectorFundingLoaded(result) => {
                        let just_opened = new_workload::apply_connector_funding(
                            &mut app.new_workload,
                            *result,
                        );
                        if just_opened {
                            // TOON_Network#138: the Funds tab's own "also
                            // open with" panel is told about this connector
                            // too — the only way it learns of one that is
                            // not the profile's own, since no daemon route
                            // lists every connector this account holds a
                            // channel with (`views::funds::OtherConnector`'s
                            // own doc comment).
                            if let (Some(connector), Some(funding)) = (
                                app.new_workload.connector_funding_url.clone(),
                                app.new_workload.connector_funding.clone(),
                            ) {
                                app.funds.other_connector =
                                    Some(funds::OtherConnector { connector, funding });
                            }
                            if let Some(client) = &client {
                                match new_workload::retry_preflight(&mut app.new_workload) {
                                    Command::PreflightSpawn(body) => {
                                        spawn_preflight_spawn(client.clone(), tx.clone(), body);
                                    }
                                    Command::PreflightStandbySet(body) => {
                                        spawn_preflight_standby_set(client.clone(), tx.clone(), body);
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    RuntimeEvent::GasStationLoaded(result) => app.funds.apply_gas_station(*result),
                    RuntimeEvent::GasQuoteLoaded(result) => app.funds.apply_gas_quote(*result),
                    RuntimeEvent::GasPurchaseLoaded(result) => app.funds.apply_gas_purchase(*result),
                    // -- Workloads (TOON_Network#143) --
                    RuntimeEvent::WorkloadsLoaded(result) => {
                        app.workloads.loading = false;
                        match *result {
                            Ok(dashboard) => {
                                app.workloads.dashboard = Some(dashboard);
                                app.workloads.error = None;
                                app.workloads.list.clamp(
                                    app.workloads
                                        .dashboard
                                        .as_ref()
                                        .map_or(0, |d| d.cards.len()),
                                );
                                // TOON_Network#146: land on a workload a New
                                // workload spawn just bought, the first
                                // dashboard read that has it. One attempt per
                                // refresh, cleared either way — a lease still
                                // provisioning a moment after the spawn simply
                                // shows up selected on the NEXT poll instead.
                                if let Some(workload_id) = app.workloads.pending_select.take() {
                                    workloads_view::select_workload(
                                        &mut app.workloads,
                                        &workload_id,
                                    );
                                }
                            }
                            Err(message) => app.workloads.error = Some(message),
                        }
                    }
                    RuntimeEvent::WorkloadExtended(result) => match *result {
                        Ok(extend) => {
                            replace_card(&mut app.workloads.dashboard, extend.card.clone());
                            app.workloads.status = Some(extend_summary(&extend));
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::WorkloadTerminated(result) => match *result {
                        Ok(terminate) => {
                            replace_card(&mut app.workloads.dashboard, terminate.card.clone());
                            app.workloads.status = Some(terminate_summary(&terminate));
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::WorkloadForgotten(result) => match *result {
                        Ok(forget) => {
                            remove_card(&mut app.workloads.dashboard, &forget.workload_id);
                            app.workloads.list.clamp(
                                app.workloads
                                    .dashboard
                                    .as_ref()
                                    .map_or(0, |d| d.cards.len()),
                            );
                            app.workloads.status = Some(forget_summary(&forget));
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    // -- Workloads: auto-extend, rotate, gateway (TOON_Network#144) --
                    RuntimeEvent::AutoExtendArmed(result) => match *result {
                        Ok(card) => {
                            app.workloads.status = Some(auto_extend_summary(&card));
                            replace_card(&mut app.workloads.dashboard, card);
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::AutoExtendDisarmed(result) => match *result {
                        Ok(card) => {
                            app.workloads.status =
                                Some("Automatic extension is off.".to_string());
                            replace_card(&mut app.workloads.dashboard, card);
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::WorkloadRotated(result) => match *result {
                        Ok(rotate) => {
                            app.workloads.status = Some(rotate_summary(&rotate));
                            app.workloads.rotation = Some(rotate.view);
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::WorkloadHandedOver(result) => match *result {
                        Ok(handover) => {
                            app.workloads.status = Some(handover_summary(&handover));
                            app.workloads.gateway = Some(handover.view);
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::WorkloadWithdrawn(result) => match *result {
                        Ok(withdraw) => {
                            app.workloads.status = Some(
                                withdraw
                                    .message
                                    .clone()
                                    .unwrap_or_else(|| "Withdrawn.".to_string()),
                            );
                            app.workloads.gateway = Some(withdraw.view);
                        }
                        Err(message) => app.workloads.error = Some(message),
                    },
                    RuntimeEvent::RotationLoaded(result) => {
                        if let Ok(view) = *result {
                            app.workloads.rotation = Some(view);
                        }
                        // An error here (e.g. a build with rotation unwired)
                        // is not shown as the view's headline error: reading
                        // rotation state is a background refinement of the
                        // detail pane, not the reason Workloads failed to
                        // load. `detail_needed` will not ask again for this
                        // same selection (see `views::workloads`).
                    }
                    RuntimeEvent::GatewayLoaded(result) => {
                        if let Ok(view) = *result {
                            app.workloads.gateway = Some(view);
                        }
                    }
                    RuntimeEvent::ClipboardDone { label, outcome } => {
                        // TOON_Network#138: "a status line saying what was
                        // copied (the label, never the value when it is
                        // long)" — shown in the footer regardless of which
                        // view is current (`ui::draw_footer`), so this no
                        // longer needs to guess which view's own status
                        // field to write into.
                        app.clipboard_status = Some(match outcome {
                            clipboard::ClipboardOutcome::Copied => format!("Copied {label}."),
                            clipboard::ClipboardOutcome::Unavailable(message) => message,
                            clipboard::ClipboardOutcome::Failed(message) => {
                                format!("Could not copy: {message}")
                            }
                        });
                    }
                    RuntimeEvent::ClipboardPasted(result) => match result {
                        Ok(text) => {
                            let text = Zeroizing::new(text);
                            handle_paste(&mut app, &text);
                        }
                        Err(message) => app.clipboard_status = Some(message),
                    },
                    // -- New workload (TOON_Network#146) --
                    RuntimeEvent::TemplatesLoaded(result) => {
                        app.new_workload.loading_gallery = false;
                        match *result {
                            Ok(gallery) => {
                                app.new_workload.gallery = Some(gallery);
                                app.new_workload.gallery_error = None;
                            }
                            Err(message) => app.new_workload.gallery_error = Some(message),
                        }
                    }
                    RuntimeEvent::TemplateExpanded(result) => {
                        app.new_workload.expanding = false;
                        match *result {
                            Ok(expansion) => {
                                app.new_workload.expansion = Some(expansion);
                                app.new_workload.expand_error = None;
                                // The daemon re-read the Template and built
                                // the §6.2 content itself — only now is there
                                // anything to spawn, so only now does the
                                // wizard move on.
                                app.new_workload.stage = new_workload::Stage::Listing;
                            }
                            Err(message) => app.new_workload.expand_error = Some(message),
                        }
                    }
                    RuntimeEvent::SpawnPreflighted(result) => {
                        app.new_workload.preflight_loading = false;
                        match *result {
                            Ok(preflight) => {
                                app.new_workload.preflight = Some(preflight);
                                app.new_workload.set_preflight = None;
                                app.new_workload.preflight_error = None;
                            }
                            Err(message) => app.new_workload.preflight_error = Some(message),
                        }
                    }
                    RuntimeEvent::StandbySetPreflighted(result) => {
                        app.new_workload.preflight_loading = false;
                        match *result {
                            Ok(preflight) => {
                                app.new_workload.set_preflight = Some(preflight);
                                app.new_workload.preflight = None;
                                app.new_workload.preflight_error = None;
                            }
                            Err(message) => app.new_workload.preflight_error = Some(message),
                        }
                    }
                    RuntimeEvent::WorkloadSpawned(result) => {
                        app.new_workload.spawning = false;
                        match *result {
                            Ok(spawn) => {
                                let workload_id =
                                    spawn.lease.as_ref().map(|lease| lease.workload_id.clone());
                                new_workload::reset_wizard(
                                    &mut app.new_workload,
                                    "Spawned. Landed on the new workload in Workloads.",
                                );
                                app.view = View::Workloads;
                                app.workloads.pending_select = workload_id;
                                if let Some(client) = &client {
                                    spawn_workloads_fetch(client.clone(), tx.clone(), true);
                                    app.workloads.loading = true;
                                }
                            }
                            Err(message) => app.new_workload.spawn_error = Some(message),
                        }
                    }
                    RuntimeEvent::StandbySetSpawned(result) => {
                        app.new_workload.spawning = false;
                        match *result {
                            Ok(spawn) => {
                                let workload_id =
                                    spawn.lease.as_ref().map(|lease| lease.workload_id.clone());
                                new_workload::reset_wizard(
                                    &mut app.new_workload,
                                    "Spawned. Landed on the new workload in Workloads.",
                                );
                                app.view = View::Workloads;
                                app.workloads.pending_select = workload_id;
                                if let Some(client) = &client {
                                    spawn_workloads_fetch(client.clone(), tx.clone(), true);
                                    app.workloads.loading = true;
                                }
                            }
                            Err(message) => app.new_workload.spawn_error = Some(message),
                        }
                    }
                }
            }
            _ = clock.tick() => {
                app.now_ms = now_ms();
            }
            // TOON_Network#138's code review: the web UI's own hooks poll
            // Funds and Account too, each gated on its own "something is
            // happening" condition rather than a standing timer — see
            // `FUNDING_POLL_MS`/`ACCOUNT_POLL_MS`'s doc comments.
            _ = funding_clock.tick() => {
                if let Some(client) = &client {
                    if app.funds.pending() {
                        spawn_funding_fetch(client.clone(), tx.clone(), false);
                    }
                    if let Some(connector) = new_workload::connector_funding_poll(&app.new_workload) {
                        spawn_connector_funding_fetch(client.clone(), tx.clone(), connector);
                    }
                }
            }
            _ = account_clock.tick() => {
                if let Some(client) = &client {
                    let needed = app.account.as_ref().is_some_and(account_view::poll_needed);
                    if needed {
                        spawn_account_fetch(client.clone(), tx.clone());
                    }
                }
            }
        }

        // TOON_Network#144: keep the selected workload's rotation and
        // gateway state fresh. Checked once per loop tick rather than at
        // every place a keypress or a runtime event could change the
        // selection or the dashboard — `detail_needed` makes that cheap
        // (one comparison) and sends at most one fetch per distinct
        // selection (see `views::workloads`'s module doc).
        if app.view == View::Workloads {
            if let Some(client) = &client {
                if let Some(workload_id) = workloads_view::selected_workload_id(&app.workloads) {
                    if workloads_view::detail_needed(&app.workloads, &workload_id) {
                        app.workloads.last_detail_request = Some(workload_id.clone());
                        spawn_workload_detail(client.clone(), tx.clone(), workload_id);
                    }
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

/// Every `spawn_*` below is the same shape: run one `async` call that
/// answers `Result<T, ClientError>`, turn a failure into its `Display`
/// string (nothing downstream reads a `ClientError` — every `App` field and
/// every `RuntimeEvent` variant already carries `String`), box the result so
/// the (often much larger) `Ok` case does not bloat every other
/// `RuntimeEvent` variant, and send it. `call` is the request itself —
/// typically `move || async move { api::foo(&client, ...).await }`, with
/// whatever that call needs already captured by `move` — and `wrap` is the
/// `RuntimeEvent` variant constructor it lands in. This is what used to be
/// hand-written in each of them; TOON_Network#138's code review is what
/// asked for the one mechanism instead.
fn spawn_call<T, Fut>(
    tx: UnboundedSender<RuntimeEvent>,
    call: impl FnOnce() -> Fut + Send + 'static,
    wrap: fn(Box<Result<T, String>>) -> RuntimeEvent,
) where
    T: Send + 'static,
    Fut: Future<Output = Result<T, ClientError>> + Send + 'static,
{
    tokio::spawn(async move {
        let result = call().await.map_err(|err| err.to_string());
        let _ = tx.send(wrap(Box::new(result)));
    });
}

/// One-shot `GET /api/health`, matching the web UI's cadence: read once (on
/// connect) and again only when asked (`r`) — `use-console.ts` has no
/// auto-poll for Health, so this has none either.
fn spawn_health_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    spawn_call(
        tx,
        move || async move { api::health(&client).await },
        RuntimeEvent::HealthLoaded,
    );
}

/// `GET /api/directory`, with whichever filters are current: once on connect
/// (matching Health's cadence), and again whenever `views::directory`'s
/// keymap asks for a refresh — a filter change or `r`.
fn spawn_directory_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    filters: DirectoryFilters,
) {
    spawn_call(
        tx,
        move || async move { api::directory(&client, &filters).await },
        RuntimeEvent::DirectoryLoaded,
    );
}

// -- New workload (TOON_Network#146): the daemon calls
// `views::new_workload` needs. --

/// `GET /api/templates` — free, and needs no account (`use-templates.ts`'s
/// own doc comment): read on connect, on a profile switch, and again on `r`
/// while the Gallery stage is showing.
fn spawn_templates_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    spawn_call(
        tx,
        move || async move { api::templates(&client).await },
        RuntimeEvent::TemplatesLoaded,
    );
}

/// `POST /api/templates/expand` — free. The daemon re-reads the Template and
/// decides what is settable; what comes back is the §6.2 content a manual
/// spawn of the expanded image would carry.
fn spawn_expand_template(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    request: ExpandTemplateRequest,
) {
    spawn_call(
        tx,
        move || async move { api::expand_template(&client, &request).await },
        RuntimeEvent::TemplateExpanded,
    );
}

/// `POST /api/leases/preflight` — free; safe to call every time the
/// Standbys stage is left or `L` flips `local_only`.
fn spawn_preflight_spawn(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    request: SpawnRequestBody,
) {
    spawn_call(
        tx,
        move || async move { api::preflight_spawn(&client, &request).await },
        RuntimeEvent::SpawnPreflighted,
    );
}

/// `POST /api/leases/standby-set/preflight` — free; prices every member of
/// the set (spec §7).
fn spawn_preflight_standby_set(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    request: StandbySetRequestBody,
) {
    spawn_call(
        tx,
        move || async move { api::preflight_standby_set(&client, &request).await },
        RuntimeEvent::StandbySetPreflighted,
    );
}

/// `POST /api/templates/spawn` — **spends money** (spec §5, ADR 0003). Only
/// ever reached after `views::new_workload::handle_key` has already
/// required typing `yes` through `widgets::confirm`, the same rule every
/// other spending command in this crate follows.
fn spawn_workload_spawn(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    request: TemplateSpawnRequestBody,
) {
    spawn_call(
        tx,
        move || async move { api::spawn_from_template(&client, &request).await },
        RuntimeEvent::WorkloadSpawned,
    );
}

/// `POST /api/leases/standby-set` — **spends at every member** (ADR 0003).
/// Same confirmation gate as [`spawn_workload_spawn`].
fn spawn_standby_set_spawn(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    request: StandbySetRequestBody,
) {
    spawn_call(
        tx,
        move || async move { api::spawn_standby_set(&client, &request).await },
        RuntimeEvent::StandbySetSpawned,
    );
}

/// `GET /api/docs`, on connect and again on `r` while no article is open —
/// `refresh` is the daemon's own `?refresh=1`, the same query `docs-view.tsx`'s
/// "Re-read from relays" button sends.
fn spawn_docs_index_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    refresh: bool,
) {
    spawn_call(
        tx,
        move || async move {
            let path = if refresh {
                "/api/docs?refresh=1"
            } else {
                "/api/docs"
            };
            client.get::<DocsIndex>(path).await
        },
        RuntimeEvent::DocsIndexLoaded,
    );
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
    spawn_call(
        tx,
        move || async move {
            let path = if refresh {
                format!("/api/docs/{d}?refresh=1")
            } else {
                format!("/api/docs/{d}")
            };
            client.get::<DocsPage>(&path).await
        },
        RuntimeEvent::DocsPageLoaded,
    );
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
    spawn_call(
        tx,
        move || async move { api::account(&client).await },
        RuntimeEvent::AccountLoaded,
    );
}

fn spawn_profiles_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    spawn_call(
        tx,
        move || async move { api::profiles(&client).await },
        RuntimeEvent::ProfilesLoaded,
    );
}

/// Every account action — add a local signer, add a bunker signer, sign
/// back in with a saved one, sign out, forget a signer — answers with the
/// same `SessionStatus` `GET /api/account` does, so one wrapper turns any of
/// `api`'s account calls into an `AccountLoaded`.
fn spawn_account_call<F, Fut>(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, call: F)
where
    F: FnOnce(Arc<DaemonClient>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<SessionStatus, ClientError>> + Send + 'static,
{
    spawn_call(tx, move || call(client), RuntimeEvent::AccountLoaded);
}

fn spawn_switch_profile(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, id: String) {
    tokio::spawn(async move {
        match api::switch_profile(&client, id).await {
            Ok(profiles) => {
                let _ = tx.send(RuntimeEvent::ProfileSwitched(profiles));
            }
            Err(err) => {
                let _ = tx.send(RuntimeEvent::ProfileSwitchFailed(err.to_string()));
            }
        }
    });
}

/// TOON_Network#150's `PUT`/`DELETE /api/profiles/<id>` share this shape on
/// a refusal: a message worth showing on its own (a 409 "this is the active
/// profile", say), and — only from `PUT`'s 400 — a per-field map
/// `views::network`'s editor lines up against its own rows. Parsed from
/// `ClientError::Status`'s raw body, which is `problem()`'s own JSON in
/// `api.ts`; anything that is not that shape (an unreachable daemon, a
/// stale-token 401 that survived the retry) falls back to the error's own
/// `Display`, with no field singled out.
struct ProfileActionFailure {
    message: String,
    errors: std::collections::HashMap<String, String>,
}

fn profile_action_failure(err: &ClientError) -> ProfileActionFailure {
    if let ClientError::Status { status, body, .. } = err {
        if matches!(status, 400 | 404 | 409) {
            if let Ok(parsed) = serde_json::from_str::<ProfileEndpointsError>(body) {
                return ProfileActionFailure {
                    message: parsed.message,
                    errors: parsed.errors,
                };
            }
        }
    }
    ProfileActionFailure {
        message: err.to_string(),
        errors: std::collections::HashMap::new(),
    }
}

/// `Command::SaveProfile` — `PUT /api/profiles/<id>`. The id travels with
/// the event (not just the `Profiles` it succeeds with) so a failure can be
/// matched back to whichever id the open editor is for.
fn spawn_save_profile(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    id: String,
    request: ProfileEndpointsRequest,
) {
    tokio::spawn(async move {
        match api::save_profile(&client, &id, &request).await {
            Ok(profiles) => {
                let _ = tx.send(RuntimeEvent::ProfileSaved(id, Ok(profiles)));
            }
            Err(err) => {
                let failure = profile_action_failure(&err);
                let _ = tx.send(RuntimeEvent::ProfileSaved(id, Err(failure)));
            }
        }
    });
}

/// `Command::ResetProfile` — `DELETE /api/profiles/<id>`.
fn spawn_reset_profile(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, id: String) {
    tokio::spawn(async move {
        match api::reset_profile(&client, &id).await {
            Ok(profiles) => {
                let _ = tx.send(RuntimeEvent::ProfileReset(id, Ok(profiles)));
            }
            Err(err) => {
                let failure = profile_action_failure(&err);
                let _ = tx.send(RuntimeEvent::ProfileReset(id, Err(failure)));
            }
        }
    });
}

/// Every view with its own data, re-fetched — ADR 0028's "a switch re-reads
/// rather than patches," reused for TOON_Network#150: editing or
/// resetting/removing the ACTIVE profile takes effect the same way
/// (`RuntimeEvent::ProfileSaved`/`ProfileReset`, gated on "was this the
/// active id").
fn refresh_after_profile_change(
    client: &Option<Arc<DaemonClient>>,
    tx: &UnboundedSender<RuntimeEvent>,
    app: &mut App,
) {
    let Some(client) = client else { return };
    spawn_health_fetch(client.clone(), tx.clone());
    app.loading_health = true;
    spawn_account_fetch(client.clone(), tx.clone());
    app.loading_account = true;
    spawn_directory_fetch(client.clone(), tx.clone(), app.directory.filters.clone());
    app.loading_directory = true;
    spawn_docs_index_fetch(client.clone(), tx.clone(), false);
    app.docs.loading = true;
    spawn_funding_fetch(client.clone(), tx.clone(), false);
    app.funds.funding_loading = true;
    app.funds.funding_busy = true;
    spawn_gas_station_fetch(client.clone(), tx.clone());
    app.funds.gas_loading = true;
    app.funds.gas_busy = true;
    spawn_workloads_fetch(client.clone(), tx.clone(), true);
    app.workloads.loading = true;
    // A Template gallery is per network, like the Directory
    // (TOON_Network#146, `use-templates.ts`'s own `profileId` key).
    spawn_templates_fetch(client.clone(), tx.clone());
    app.new_workload.loading_gallery = true;
    // `writes` (what a Chain Seed publish would cost) is quoted by the
    // active profile's connector, so it re-reads here too, not only on a
    // pubkey change.
    if app.chain_seed_for_pubkey.is_some() {
        spawn_chain_seed_fetch(client.clone(), tx.clone());
        app.loading_chain_seed = true;
    }
}

/// One-shot `GET /api/chain-seed` (TOON_Network#142). Read on connect once
/// an account is known signed in, again on a pubkey change or a profile
/// switch, and again whenever an action posts a body and gets a fresh
/// `ChainSeedStatus` back (`spawn_chain_seed_call` below reuses this
/// same event).
fn spawn_chain_seed_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    spawn_call(
        tx,
        move || async move { api::chain_seed(&client).await },
        RuntimeEvent::ChainSeedLoaded,
    );
}

/// Every Chain Seed action — acknowledge, mint, import, publish, refresh —
/// answers with the same `ChainSeedStatus` `GET /api/chain-seed` does.
fn spawn_chain_seed_call<F, Fut>(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    call: F,
) where
    F: FnOnce(Arc<DaemonClient>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<ChainSeedStatus, ClientError>> + Send + 'static,
{
    spawn_call(tx, move || call(client), RuntimeEvent::ChainSeedLoaded);
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
    spawn_call(
        tx,
        move || async move { api::funding(&client, refresh).await },
        RuntimeEvent::FundingLoaded,
    );
}

fn spawn_gas_station_fetch(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    spawn_call(
        tx,
        move || async move { api::gas_station(&client).await },
        RuntimeEvent::GasStationLoaded,
    );
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
    spawn_call(
        tx,
        move || async move { api::open_channel(&client, chain, deposit, connector).await },
        RuntimeEvent::FundingLoaded,
    );
}

/// `GET /api/funding?connector=<url>` (TOON_Network#138) — New workload's
/// own `o`, and the poll while it is `opening`.
fn spawn_connector_funding_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    connector: String,
) {
    spawn_call(
        tx,
        move || async move { api::funding_for_connector(&client, &connector).await },
        RuntimeEvent::ConnectorFundingLoaded,
    );
}

/// Issued only from `Command::OpenChannelForConnector`, itself only ever
/// produced once New workload's own channel confirmation
/// (`views::new_workload::handle_key`'s `channel_confirm`) has been shown
/// and accepted — never straight from a keypress. Answers
/// `RuntimeEvent::ConnectorFundingLoaded`, the same event the GET above
/// sends: both are one connector's `FundingStatus`.
fn spawn_open_channel_for_connector(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    chain: String,
    deposit: Option<String>,
    connector: String,
) {
    spawn_call(
        tx,
        move || async move { api::open_channel(&client, chain, deposit, Some(connector)).await },
        RuntimeEvent::ConnectorFundingLoaded,
    );
}

fn spawn_drip(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, chain: String) {
    spawn_call(
        tx,
        move || async move { api::drip(&client, chain).await },
        RuntimeEvent::FundingLoaded,
    );
}

fn spawn_quote_gas(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, chain: String) {
    spawn_call(
        tx,
        move || async move { api::quote_gas(&client, chain).await },
        RuntimeEvent::GasQuoteLoaded,
    );
}

/// Issued only from `Command::BuyGas`, same rule as `spawn_open_channel`:
/// only ever after a confirmation naming this exact `quote_id` was accepted.
fn spawn_buy_gas(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    chain: String,
    quote_id: String,
) {
    spawn_call(
        tx,
        move || async move { api::buy_gas(&client, chain, quote_id).await },
        RuntimeEvent::GasPurchaseLoaded,
    );
}

// -- Workloads (TOON_Network#143, #144): the daemon calls `views::workloads`
// needs. --

/// `GET /api/workloads`, matching the web UI's cadence
/// (TOON_Network#143 — `packages/ui/src/hooks/use-workloads.ts`'s
/// `POLL_MS`): read once on connect and again every
/// [`WORKLOADS_POLL_MS`] via [`spawn_workloads_poll`], plus whenever `R` asks
/// for one. `refresh` asks the daemon to read every provider (free at the
/// provider, but still a packet — `?refresh=1`, same as the web hook).
fn spawn_workloads_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    refresh: bool,
) {
    spawn_call(
        tx,
        move || async move { api::workloads(&client, refresh).await },
        RuntimeEvent::WorkloadsLoaded,
    );
}

fn spawn_workloads_poll(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(WORKLOADS_POLL_MS)).await;
            if tx.is_closed() {
                return;
            }
            spawn_workloads_fetch(client.clone(), tx.clone(), true);
        }
    });
}

/// Buys one Lease Interval. Spends money (ADR 0003): only ever reached after
/// `views::workloads::handle_key` has already required typing `yes` through
/// `widgets::confirm`, never on a poll or a debounce.
fn spawn_extend(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
    max_price: Option<String>,
) {
    spawn_call(
        tx,
        move || async move { api::extend(&client, &workload_id, max_price).await },
        RuntimeEvent::WorkloadExtended,
    );
}

/// Ends the workload now. Free, immediate and irreversible (spec §6.6): also
/// only ever reached after a typed `yes`.
fn spawn_terminate(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    spawn_call(
        tx,
        move || async move { api::terminate(&client, &workload_id).await },
        RuntimeEvent::WorkloadTerminated,
    );
}

/// Forgets an ENDED workload (TOON_Network#138): free, and refused outright
/// by the daemon on anything still live — reached only after a typed `yes`,
/// same as the two above.
fn spawn_forget(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, workload_id: String) {
    spawn_call(
        tx,
        move || async move { api::forget(&client, &workload_id).await },
        RuntimeEvent::WorkloadForgotten,
    );
}

/// Arms a budget. Spends money with nobody present (`workload-card.tsx`'s own
/// warning): only ever reached after a typed `yes`, the same as extend and
/// terminate.
fn spawn_arm_auto_extend(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
    budget: String,
    agreed_price: String,
) {
    spawn_call(
        tx,
        move || async move { api::arm_auto_extend(&client, &workload_id, budget, agreed_price).await },
        RuntimeEvent::AutoExtendArmed,
    );
}

/// Turns extension off. The budget is still shown afterwards, remembered,
/// with `armed: false`.
fn spawn_disarm_auto_extend(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    spawn_call(
        tx,
        move || async move { api::disarm_auto_extend(&client, &workload_id).await },
        RuntimeEvent::AutoExtendDisarmed,
    );
}

/// Replaces this lease's Continuation Token at every member of its Standby
/// Set (spec §6.8, ADR 0018), or finishes a rotation left part-way through.
/// Free at the providers; only ever reached after a typed `yes`.
fn spawn_rotate(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, workload_id: String) {
    spawn_call(
        tx,
        move || async move { api::rotate(&client, &workload_id).await },
        RuntimeEvent::WorkloadRotated,
    );
}

/// Hands the workload to the Workload Gateway. An empty body asks for the
/// daemon's own default grant length (24 hours, `DEFAULT_GRANT_SECONDS` in
/// `packages/daemon/src/gateway.ts`) — the same default the web UI's own
/// form starts with, matching `HandoverRequestBody`'s all-optional fields.
fn spawn_handover(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    spawn_call(
        tx,
        move || async move { api::handover(&client, &workload_id).await },
        RuntimeEvent::WorkloadHandedOver,
    );
}

/// Stops the gateway serving this workload — ends serving, not reading
/// (spec §12.7).
fn spawn_withdraw(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    spawn_call(
        tx,
        move || async move { api::withdraw(&client, &workload_id).await },
        RuntimeEvent::WorkloadWithdrawn,
    );
}

/// Reads the selected workload's rotation and gateway state (TOON_Network#144).
/// Both are free — no lease packet for rotation, no TOON packet at all for
/// the gateway's plain `GET` — so this runs on every distinct selection
/// rather than only on request; see `views::workloads`'s module doc and
/// `detail_needed`.
fn spawn_workload_detail(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    let rotation_client = client.clone();
    let rotation_tx = tx.clone();
    let rotation_id = workload_id.clone();
    spawn_call(
        rotation_tx,
        move || async move { api::rotation(&rotation_client, &rotation_id).await },
        RuntimeEvent::RotationLoaded,
    );
    spawn_call(
        tx,
        move || async move { api::gateway(&client, &workload_id).await },
        RuntimeEvent::GatewayLoaded,
    );
}

/// `wl-copy` is a fast local subprocess, but it is still a blocking spawn —
/// `spawn_blocking` keeps it off the event loop's own task so a slow or
/// hung clipboard tool cannot stall keypresses or redraws.
fn spawn_clipboard_copy(label: String, text: String, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let outcome = tokio::task::spawn_blocking(move || clipboard::copy(&text))
            .await
            .unwrap_or_else(|err| clipboard::ClipboardOutcome::Failed(err.to_string()));
        let _ = tx.send(RuntimeEvent::ClipboardDone { label, outcome });
    });
}

/// Ctrl+V (TOON_Network#138): reads the system clipboard with `wl-paste
/// --no-newline`, run directly (no shell — nothing typed into a paste is
/// ever interpreted as shell syntax, the same rule `spawn_open_link` and
/// `clipboard::copy_with` already follow) and off the UI thread, the same
/// way a copy runs `wl-copy` off it. `--no-newline` matches `wl-copy`'s own
/// behaviour: neither adds one, so a round trip through both is exact.
fn spawn_clipboard_paste(tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let result = match tokio::process::Command::new("wl-paste")
            .arg("--no-newline")
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                Ok(String::from_utf8_lossy(&output.stdout).into_owned())
            }
            Ok(output) => Err(format!(
                "wl-paste exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err("wl-paste is not installed, so the clipboard could not be read.".to_string())
            }
            Err(err) => Err(err.to_string()),
        };
        let _ = tx.send(RuntimeEvent::ClipboardPasted(result));
    });
}

/// Puts one card's fresh answer back into the dashboard without disturbing
/// the others — mirrors `replace` in `packages/ui/src/hooks/use-workloads.ts`.
fn replace_card(dashboard: &mut Option<Dashboard>, card: WorkloadCard) {
    if let Some(dashboard) = dashboard {
        if let Some(existing) = dashboard
            .cards
            .iter_mut()
            .find(|candidate| candidate.workload_id == card.workload_id)
        {
            *existing = card;
        }
    }
}

/// Drops a workload's card from the dashboard once `DELETE /api/workloads/<id>`
/// has succeeded (TOON_Network#138): the daemon's own list no longer holds
/// it either, so there is nothing left to keep the row for.
fn remove_card(dashboard: &mut Option<Dashboard>, workload_id: &str) {
    if let Some(dashboard) = dashboard {
        dashboard
            .cards
            .retain(|candidate| candidate.workload_id != workload_id);
    }
}

fn extend_summary(result: &ExtendResult) -> String {
    if !result.sent {
        return "Nothing was sent, and nothing was paid.".to_string();
    }
    if let Some(provider_error_msg) = &result.provider_error {
        return format!("The provider refused this extension: {provider_error_msg}");
    }
    match &result.cost {
        Some(cost) => format!("Extended. Cost {cost} base units."),
        None => "Extended.".to_string(),
    }
}

fn terminate_summary(result: &TerminateResult) -> String {
    if !result.sent {
        return "Nothing was sent, and nothing was paid.".to_string();
    }
    if let Some(provider_error_msg) = &result.provider_error {
        return format!("The provider refused this termination: {provider_error_msg}");
    }
    "This lease has ended.".to_string()
}

/// `forgotten: false` here means only that a best-effort relay tombstone did
/// not confirm (TOON_Network#138) — the card is already gone from the list
/// either way, so this is a caveat, not a failure.
fn forget_summary(result: &ForgetResult) -> String {
    if result.forgotten {
        "Forgotten.".to_string()
    } else {
        format!(
            "Forgotten locally; the relay cleanup did not confirm: {}",
            result.reason.as_deref().unwrap_or("no reason given")
        )
    }
}

fn auto_extend_summary(card: &WorkloadCard) -> String {
    match &card.auto_extend {
        Some(budget) if budget.armed => format!(
            "Extending automatically. Spends up to {} base units without asking.",
            budget.budget
        ),
        Some(_) => "Automatic extension is off.".to_string(),
        None => "No budget set.".to_string(),
    }
}

fn rotate_summary(result: &RotationResult) -> String {
    if !result.started {
        return format!("Nothing was sent. {}", result.problems.join(" "))
            .trim()
            .to_string();
    }
    if result.rotated {
        "Rotated at every member. The old token is refused everywhere.".to_string()
    } else {
        format!(
            "Rotated at {} of {} member(s). The old token still works at the rest — run it again to finish.",
            result.confirmed, result.of
        )
    }
}

fn handover_summary(result: &HandoverResult) -> String {
    if let Some(gateway_error) = &result.gateway_error {
        return format!("The gateway refused this handover: {gateway_error}");
    }
    if !result.sent {
        return "Nothing was sent, and nothing was paid.".to_string();
    }
    match &result.hostname {
        Some(hostname) => format!("Served at {hostname}."),
        None => "Handed over.".to_string(),
    }
}
