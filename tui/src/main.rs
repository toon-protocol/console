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
use toon_console_tui::desktop;
use toon_console_tui::launch::{launch_file_path, LaunchError};
use toon_console_tui::types::{
    BunkerSignerRequest, Health, ProfileSwitchRequest, Profiles, SessionStatus, SignInRequest,
};
use toon_console_tui::ui;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

enum RuntimeEvent {
    Connected(Arc<DaemonClient>),
    ConnectFailed(String),
    HealthLoaded(Box<Result<Health, String>>),
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
                        // The header shows the signed-in account and the
                        // active profile on every view (TOON_Network#141), so
                        // both are read once here — the same "on connect"
                        // moment Health is — not lazily when the Account view
                        // is first opened.
                        spawn_account_fetch(connected.clone(), tx.clone());
                        app.loading_account = true;
                        spawn_profiles_fetch(connected.clone(), tx.clone());
                        spawn_desktop(connected.clone(), tx.clone());
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
                        // here; a later view ticket's data joins this list.
                        if let Some(client) = &client {
                            spawn_health_fetch(client.clone(), tx.clone());
                            app.loading_health = true;
                            spawn_account_fetch(client.clone(), tx.clone());
                            app.loading_account = true;
                        }
                    }
                    RuntimeEvent::ProfileSwitchFailed(message) => {
                        app.switching_profile = None;
                        app.account_error = Some(message);
                    }
                    RuntimeEvent::SwitchView(view) => {
                        app.view = view;
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
