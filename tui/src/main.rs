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
use toon_console_tui::types::Health;
use toon_console_tui::ui;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

enum RuntimeEvent {
    Connected(Arc<DaemonClient>),
    ConnectFailed(String),
    HealthLoaded(Box<Result<Health, String>>),
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

#[cfg(test)]
mod tests {
    // `main.rs` is wiring; its seams (the keymap, the client, the launch
    // reader, a view's render) are unit-tested in their own modules under
    // `src/`, reachable without a terminal. Nothing here needs its own test.
}
