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
use toon_console_tui::markdown;
use toon_console_tui::types::{DocsIndex, DocsPage, Health};
use toon_console_tui::ui;

/// How long to wait between attempts to find the daemon while it is down —
/// the TUI's answer to the launcher script's `wait_for_launch_file` poll.
const RECONNECT_MS: u64 = 1_000;

enum RuntimeEvent {
    Connected(Arc<DaemonClient>),
    ConnectFailed(String),
    HealthLoaded(Box<Result<Health, String>>),
    SwitchView(View),
    /// `GET /api/docs`, on connect and again on `Command::RefreshDocs` while
    /// no article is open.
    DocsIndexLoaded(Box<Result<DocsIndex, String>>),
    /// `GET /api/docs/<d>`, on `Command::OpenDoc` and again on
    /// `Command::RefreshDocs` while one is.
    DocsPageLoaded(Box<Result<DocsPage, String>>),
    /// `xdg-open` did not open `Command::OpenDocsLink`'s href.
    DocsLinkOpenFailed(String),
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
                        spawn_docs_index_fetch(connected.clone(), tx.clone(), false);
                        app.loading_docs = true;
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

#[cfg(test)]
mod tests {
    // `main.rs` is wiring; its seams (the keymap, the client, the launch
    // reader, a view's render) are unit-tested in their own modules under
    // `src/`, reachable without a terminal. Nothing here needs its own test.
}
