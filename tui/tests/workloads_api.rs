//! Proves the Workloads view's API client against a stub HTTP server that
//! answers with the daemon's REAL, committed fixtures (TOON_Network#143,
//! #144; "works against a sandbox daemon" acceptance criterion) — the
//! client-and-parsing half of that criterion; the live end-to-end proof
//! against a real sandbox daemon is TOON_Network#149.
//!
//! The stub is the same hand-rolled HTTP/1.1 server `client_reread.rs` uses,
//! extended to read a request body and answer `GET`/`POST`/`DELETE`
//! differently, and to serve any fixture under
//! `packages/daemon/fixtures/api/` verbatim — proving `DaemonClient::get`/
//! `post`/`delete` decode the real shapes the daemon writes, not a shape
//! this test invented.

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;

use toon_console_tui::client::DaemonClient;
use toon_console_tui::types::{
    Dashboard, ExtendResult, GatewayView, HandoverResult, RotationResult, RotationView,
    TerminateResult, WithdrawalResult, WorkloadCard,
};

const TOKEN: &str = "test-token";

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/../packages/daemon/fixtures/api/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("could not read {path}: {err}"))
}

/// Answers every request with `body`, whatever the method or path — good
/// enough for these tests, which each talk to the stub about exactly one
/// route. Records the last request's method, path and body so a test can
/// assert on what the client actually sent.
struct Recorded {
    method: String,
    path: String,
    body: String,
}

fn spawn_stub(
    body: &'static str,
    recorded: Arc<Mutex<Option<Recorded>>>,
) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let async_listener = tokio::net::TcpListener::from_std(listener).unwrap();

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = async_listener.accept().await else {
                return;
            };
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let (method, path, request_body) = read_request(&mut stream).await;
                *recorded.lock().unwrap() = Some(Recorded {
                    method,
                    path,
                    body: request_body,
                });
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });

    (url, handle)
}

/// Reads the request line, headers (for `content-length`) and body. Good
/// enough for what `DaemonClient` itself sends — no chunked transfer, no
/// pipelining.
async fn read_request(stream: &mut tokio::net::TcpStream) -> (String, String, String) {
    let mut buf = [0u8; 8192];
    let mut text = String::new();
    let header_end = loop {
        let read = stream.read(&mut buf).await.unwrap_or(0);
        if read == 0 {
            break text.len();
        }
        text.push_str(&String::from_utf8_lossy(&buf[..read]));
        if let Some(at) = text.find("\r\n\r\n") {
            break at + 4;
        }
    };

    let content_length: usize = text
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().to_string())
        })
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut body = text[header_end..].to_string();
    while body.len() < content_length {
        let read = stream.read(&mut buf).await.unwrap_or(0);
        if read == 0 {
            break;
        }
        body.push_str(&String::from_utf8_lossy(&buf[..read]));
    }

    let request_line = text.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    (method, path, body)
}

fn write_record(path: &std::path::Path, url: &str) {
    std::fs::write(
        path,
        serde_json::json!({
            "url": url,
            "token": TOKEN,
            "launchUrl": format!("{url}/?t={TOKEN}"),
            "pid": 1,
            "startedAt": "2026-09-24T00:00:00.000Z",
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn get_workloads_decodes_the_daemons_real_dashboard_fixture() {
    let body: &'static str = Box::leak(fixture("workloads").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let dashboard: Dashboard = client.get("/api/workloads?refresh=1").await.unwrap();

    assert_eq!(dashboard.cards.len(), 1);
    assert_eq!(dashboard.cards[0].lease.listing.name, "basic");
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "GET");
    assert_eq!(sent.path, "/api/workloads?refresh=1");
}

#[tokio::test]
async fn post_extend_sends_max_price_and_decodes_the_real_extend_fixture() {
    let body: &'static str = Box::leak(fixture("workload-extend").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    #[derive(serde::Serialize)]
    struct Body {
        #[serde(rename = "maxPrice")]
        max_price: Option<String>,
    }
    let result: ExtendResult = client
        .post(
            "/api/workloads/abc/extend",
            &Body {
                max_price: Some("1000".to_string()),
            },
        )
        .await
        .unwrap();

    assert!(result.sent);
    assert_eq!(result.cost.as_deref(), Some("1000"));
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert!(sent.body.contains("\"maxPrice\":\"1000\""));
}

#[tokio::test]
async fn post_terminate_decodes_the_real_terminate_fixture_and_ended_reads_termination() {
    let body: &'static str = Box::leak(fixture("workload-terminate").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let result: TerminateResult = client
        .post("/api/workloads/abc/terminate", &serde_json::json!({}))
        .await
        .unwrap();

    assert!(result.sent);
    assert_eq!(result.ended.as_deref(), Some("termination"));
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
}

/* -------------------------------------------------------------------------- */
/* TOON_Network#144: auto-extend, rotate, gateway.                            */
/* -------------------------------------------------------------------------- */

#[tokio::test]
async fn post_auto_extend_sends_the_budget_and_confirm_and_decodes_the_real_card() {
    let body: &'static str = Box::leak(fixture("workload-auto-extend-armed").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    #[derive(serde::Serialize)]
    struct Body {
        budget: String,
        #[serde(rename = "agreedPrice")]
        agreed_price: String,
        confirm: bool,
    }
    let card: WorkloadCard = client
        .post(
            "/api/workloads/abc/auto-extend",
            &Body {
                budget: "3000".to_string(),
                agreed_price: "1000".to_string(),
                confirm: true,
            },
        )
        .await
        .unwrap();

    assert_eq!(card.auto_extend.as_ref().map(|a| a.armed), Some(true));
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert!(sent.body.contains("\"confirm\":true"));
}

#[tokio::test]
async fn delete_auto_extend_decodes_the_real_off_card() {
    let body: &'static str = Box::leak(fixture("workload-auto-extend-off").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let card: WorkloadCard = client
        .delete("/api/workloads/abc/auto-extend")
        .await
        .unwrap();

    assert_eq!(card.auto_extend.as_ref().map(|a| a.armed), Some(false));
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "DELETE");
}

#[tokio::test]
async fn get_rotation_decodes_a_partially_rotated_standby_set() {
    let body: &'static str = Box::leak(fixture("workload-rotation-partial").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let view: RotationView = client.get("/api/workloads/abc/rotation").await.unwrap();

    assert!(view.under_way);
    assert_eq!((view.confirmed, view.of), (1, 2));
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "GET");
}

#[tokio::test]
async fn post_rotate_decodes_the_real_rotate_result() {
    let body: &'static str = Box::leak(fixture("workload-rotate").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let result: RotationResult = client
        .post("/api/workloads/abc/rotate", &serde_json::json!({}))
        .await
        .unwrap();

    assert!(result.started);
    assert!(result.rotated);
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
}

#[tokio::test]
async fn get_gateway_decodes_the_real_view() {
    let body: &'static str = Box::leak(fixture("workload-gateway").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let view: GatewayView = client.get("/api/workloads/abc/gateway").await.unwrap();

    assert!(!view.held);
    assert!(view.hostname.is_some());
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "GET");
}

#[tokio::test]
async fn post_gateway_handover_decodes_the_real_result_and_the_hostname_it_served() {
    let body: &'static str = Box::leak(fixture("workload-gateway-handover").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let result: HandoverResult = client
        .post(
            "/api/workloads/abc/gateway/handover",
            &serde_json::json!({}),
        )
        .await
        .unwrap();

    assert!(result.sent);
    assert!(result.hostname.is_some());
    assert!(result.view.held);
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
}

#[tokio::test]
async fn post_gateway_withdraw_decodes_the_real_result_and_says_serving_not_reading() {
    let body: &'static str = Box::leak(fixture("workload-gateway-withdraw").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let result: WithdrawalResult = client
        .post(
            "/api/workloads/abc/gateway/withdraw",
            &serde_json::json!({}),
        )
        .await
        .unwrap();

    assert_eq!(result.withdrawn, Some(true));
    assert!(!result.view.held);
    assert!(result.message.as_deref().unwrap().contains("not reading"));
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
}
