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

use toon_console_tui::app::{handle_key, handle_mouse, App, Command, DaemonStatus, View};
use toon_console_tui::client::DaemonClient;
use toon_console_tui::clipboard;
use toon_console_tui::desktop;
use toon_console_tui::launch::{launch_file_path, LaunchError};
use toon_console_tui::types::{
    Dashboard, ExtendResult, GatewayView, HandoverResult, Health, RotationResult, RotationView,
    TerminateResult, WithdrawalResult, WorkloadCard,
};
use toon_console_tui::ui;
use toon_console_tui::views::workloads as workloads_view;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

/// The web UI's own cadence for the dashboard (`POLL_MS` in
/// `packages/ui/src/hooks/use-workloads.ts`) — TOON_Network#143's
/// acceptance criterion is "refreshing at its cadence", so this is that
/// number, not a TUI-only guess.
const WORKLOADS_POLL_MS: u64 = 30_000;

enum RuntimeEvent {
    Connected(Arc<DaemonClient>),
    ConnectFailed(String),
    HealthLoaded(Box<Result<Health, String>>),
    SwitchView(View),
    WorkloadsLoaded(Box<Result<Dashboard, String>>),
    WorkloadExtended(Box<Result<ExtendResult, String>>),
    WorkloadTerminated(Box<Result<TerminateResult, String>>),
    // TOON_Network#144: auto-extend, rotate, gateway.
    AutoExtendArmed(Box<Result<WorkloadCard, String>>),
    AutoExtendDisarmed(Box<Result<WorkloadCard, String>>),
    WorkloadRotated(Box<Result<RotationResult, String>>),
    WorkloadHandedOver(Box<Result<HandoverResult, String>>),
    WorkloadWithdrawn(Box<Result<WithdrawalResult, String>>),
    /// `GET …/rotation` and `GET …/gateway`, read lazily for whichever
    /// workload is selected — see `views::workloads`'s module doc.
    RotationLoaded(Box<Result<RotationView, String>>),
    GatewayLoaded(Box<Result<GatewayView, String>>),
    ClipboardDone(clipboard::ClipboardOutcome),
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
                            Command::CopyToClipboard(text) => {
                                spawn_clipboard_copy(text, tx.clone());
                            }
                            Command::None => {}
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
                        spawn_workloads_fetch(connected.clone(), tx.clone(), true);
                        app.workloads.loading = true;
                        spawn_workloads_poll(connected.clone(), tx.clone());
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
                    RuntimeEvent::ClipboardDone(outcome) => {
                        app.workloads.status = Some(match outcome {
                            clipboard::ClipboardOutcome::Copied => {
                                "Copied to the clipboard.".to_string()
                            }
                            clipboard::ClipboardOutcome::Unavailable(message) => message,
                            clipboard::ClipboardOutcome::Failed(message) => {
                                format!("Could not copy: {message}")
                            }
                        });
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

/// `GET /api/workloads`, matching the web UI's cadence
/// (TOON_Network#143 — `packages/ui/src/hooks/use-workloads.ts`'s
/// `POLL_MS`): read once on connect and again every
/// [`WORKLOADS_POLL_MS`] via [`spawn_workloads_poll`], plus whenever `r` asks
/// for one. `refresh` asks the daemon to read every provider (free at the
/// provider, but still a packet — `?refresh=1`, same as the web hook).
fn spawn_workloads_fetch(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    refresh: bool,
) {
    tokio::spawn(async move {
        let path = if refresh {
            "/api/workloads?refresh=1"
        } else {
            "/api/workloads"
        };
        let result = client
            .get::<Dashboard>(path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::WorkloadsLoaded(Box::new(result)));
    });
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
    tokio::spawn(async move {
        #[derive(serde::Serialize)]
        struct Body {
            #[serde(rename = "maxPrice", skip_serializing_if = "Option::is_none")]
            max_price: Option<String>,
        }
        let path = format!("/api/workloads/{}/extend", urlencode(&workload_id));
        let result = client
            .post::<ExtendResult, _>(&path, &Body { max_price })
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::WorkloadExtended(Box::new(result)));
    });
}

/// Ends the workload now. Free, immediate and irreversible (spec §6.6): also
/// only ever reached after a typed `yes`.
fn spawn_terminate(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    tokio::spawn(async move {
        let path = format!("/api/workloads/{}/terminate", urlencode(&workload_id));
        let result = client
            .post::<TerminateResult, _>(&path, &serde_json::json!({}))
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::WorkloadTerminated(Box::new(result)));
    });
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
    tokio::spawn(async move {
        #[derive(serde::Serialize)]
        struct Body {
            budget: String,
            #[serde(rename = "agreedPrice")]
            agreed_price: String,
            confirm: bool,
        }
        let path = format!("/api/workloads/{}/auto-extend", urlencode(&workload_id));
        let result = client
            .post::<WorkloadCard, _>(
                &path,
                &Body {
                    budget,
                    agreed_price,
                    confirm: true,
                },
            )
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::AutoExtendArmed(Box::new(result)));
    });
}

/// Turns extension off. The budget is still shown afterwards, remembered,
/// with `armed: false`.
fn spawn_disarm_auto_extend(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    tokio::spawn(async move {
        let path = format!("/api/workloads/{}/auto-extend", urlencode(&workload_id));
        let result = client
            .delete::<WorkloadCard>(&path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::AutoExtendDisarmed(Box::new(result)));
    });
}

/// Replaces this lease's Continuation Token at every member of its Standby
/// Set (spec §6.8, ADR 0018), or finishes a rotation left part-way through.
/// Free at the providers; only ever reached after a typed `yes`.
fn spawn_rotate(client: Arc<DaemonClient>, tx: UnboundedSender<RuntimeEvent>, workload_id: String) {
    tokio::spawn(async move {
        let path = format!("/api/workloads/{}/rotate", urlencode(&workload_id));
        let result = client
            .post::<RotationResult, _>(&path, &serde_json::json!({}))
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::WorkloadRotated(Box::new(result)));
    });
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
    tokio::spawn(async move {
        let path = format!(
            "/api/workloads/{}/gateway/handover",
            urlencode(&workload_id)
        );
        let result = client
            .post::<HandoverResult, _>(&path, &serde_json::json!({}))
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::WorkloadHandedOver(Box::new(result)));
    });
}

/// Stops the gateway serving this workload — ends serving, not reading
/// (spec §12.7).
fn spawn_withdraw(
    client: Arc<DaemonClient>,
    tx: UnboundedSender<RuntimeEvent>,
    workload_id: String,
) {
    tokio::spawn(async move {
        let path = format!(
            "/api/workloads/{}/gateway/withdraw",
            urlencode(&workload_id)
        );
        let result = client
            .post::<WithdrawalResult, _>(&path, &serde_json::json!({}))
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::WorkloadWithdrawn(Box::new(result)));
    });
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
    tokio::spawn(async move {
        let path = format!("/api/workloads/{}/rotation", urlencode(&rotation_id));
        let result = rotation_client
            .get::<RotationView>(&path)
            .await
            .map_err(|err| err.to_string());
        let _ = rotation_tx.send(RuntimeEvent::RotationLoaded(Box::new(result)));
    });
    tokio::spawn(async move {
        let path = format!("/api/workloads/{}/gateway", urlencode(&workload_id));
        let result = client
            .get::<GatewayView>(&path)
            .await
            .map_err(|err| err.to_string());
        let _ = tx.send(RuntimeEvent::GatewayLoaded(Box::new(result)));
    });
}

/// `wl-copy` is a fast local subprocess, but it is still a blocking spawn —
/// `spawn_blocking` keeps it off the event loop's own task so a slow or
/// hung clipboard tool cannot stall keypresses or redraws.
fn spawn_clipboard_copy(text: String, tx: UnboundedSender<RuntimeEvent>) {
    tokio::spawn(async move {
        let outcome = tokio::task::spawn_blocking(move || clipboard::copy(&text))
            .await
            .unwrap_or_else(|err| clipboard::ClipboardOutcome::Failed(err.to_string()));
        let _ = tx.send(RuntimeEvent::ClipboardDone(outcome));
    });
}

/// A workload id is 64 lowercase hex characters (never `/`, `?`, `&`, ...),
/// so this only ever needs to be a defensive no-op — but it is the same
/// belt-and-suspenders the web client applies with `encodeURIComponent`
/// before building the same route.
fn urlencode(workload_id: &str) -> String {
    workload_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Puts one card's fresh answer back into the dashboard without disturbing
/// the others — mirrors `replace` in `packages/ui/src/hooks/use-workloads.ts`.
fn replace_card(dashboard: &mut Option<Dashboard>, card: toon_console_tui::types::WorkloadCard) {
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

#[cfg(test)]
mod tests {
    // `main.rs` is wiring; its seams (the keymap, the client, the launch
    // reader, a view's render) are unit-tested in their own modules under
    // `src/`, reachable without a terminal. Nothing here needs its own test.
}
