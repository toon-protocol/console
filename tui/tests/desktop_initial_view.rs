//! Proves the acceptance criterion from TOON_Network#140: "with no window
//! open, [choosing a menu entry] opens the TUI on that view."
//!
//! No new code in `src/` is needed for this. `GET /api/desktop` with no
//! `since` answers at once with `desktop.current()`
//! (`packages/daemon/src/api.ts`), which already includes a still-fresh
//! `open` request the launcher posted before it ran
//! `omarchy-launch-or-focus-tui` — see `packages/daemon/src/desktop.ts`'s
//! `VIEW_REQUEST_TTL_MS`. So the very FIRST poll `desktop::run` makes
//! (`since: None`, before it ever asks for `wait=1`) already carries
//! whatever view the menu asked for while the window was closed, and
//! dispatches it through the same `SwitchView` channel a later menu press
//! uses while the window is open. This test is what proves that wiring
//! still holds; `packaging/launcher.test.mjs` proves the launcher's half
//! (posting the view before it opens the window).

use std::net::TcpListener;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::unbounded_channel;

use toon_console_tui::app::View;
use toon_console_tui::client::DaemonClient;
use toon_console_tui::desktop::run;

/// A stub daemon that answers the FIRST `/api/desktop` request — the one
/// `desktop::run` makes with no `since`, so no `wait=1` — with a fresh `open`
/// request already sitting there, exactly as if the launcher had just run
/// `POST /api/desktop/view` a moment before this process started. Every
/// request after that answers with nothing new: a `wait=1` long poll never
/// actually resolves within this test, which is fine, since the test only
/// waits for the first `SwitchView`.
fn spawn_stub_daemon() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let async_listener = tokio::net::TcpListener::from_std(listener).unwrap();

    tokio::spawn(async move {
        let mut first = true;
        loop {
            let Ok((mut stream, _)) = async_listener.accept().await else {
                return;
            };
            let is_first = first;
            first = false;
            tokio::spawn(async move {
                let _request = read_request(&mut stream).await;
                let body = desktop_view_json(is_first.then_some("workloads"));
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    url
}

fn desktop_view_json(open: Option<&str>) -> String {
    let open_fields = match open {
        Some(view) => format!(r#","open":"{view}","openedAt":"2026-09-24T00:00:00.000Z""#),
        None => String::new(),
    };
    format!(
        r#"{{"seq":1,"theme":{{"source":"default","name":"default","mode":"dark","revision":"r1","css":""}}{open_fields},"at":"2026-09-24T00:00:00.000Z"}}"#
    )
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
    let mut buf = [0u8; 4096];
    let mut text = String::new();
    loop {
        let read = stream.read(&mut buf).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        text.push_str(&String::from_utf8_lossy(&buf[..read]));
        if text.contains("\r\n\r\n") {
            break;
        }
    }
    text
}

#[tokio::test]
async fn a_view_the_menu_asked_for_before_the_window_opened_is_honoured_on_the_first_poll() {
    let url = spawn_stub_daemon();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("launch.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "url": url,
            "token": "tok",
            "launchUrl": format!("{url}/?t=tok"),
            "pid": 1,
            "startedAt": "2026-09-24T00:00:00.000Z",
        })
        .to_string(),
    )
    .unwrap();

    let client = DaemonClient::connect(path).await.unwrap();
    let (tx, mut rx) = unbounded_channel::<View>();
    tokio::spawn(run(client, tx, 5_000));

    let view = rx.recv().await.expect("desktop::run sent no SwitchView");
    assert_eq!(view, View::Workloads);
}
