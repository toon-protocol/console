//! Proves the Workloads view's API client against a stub HTTP server that
//! answers with the daemon's REAL, committed fixtures (TOON_Network#143,
//! #144; "works against a sandbox daemon" acceptance criterion) — the
//! client-and-parsing half of that criterion; the live end-to-end proof
//! against a real sandbox daemon is TOON_Network#149.
//!
//! Also covers every `src/api.rs` function that used to be a `client.get`/
//! `post` call made straight from a `main.rs` `spawn_*`, in the same style:
//! Funds' gas station, faucet drip and gas quote/buy, and a Standby Set's own
//! preflight/spawn pair (TOON_Network#138's code review — "routes must go
//! through `api.rs`").
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

use toon_console_tui::api;
use toon_console_tui::client::DaemonClient;
use toon_console_tui::types::{
    Dashboard, ExtendResult, GasPurchase, GasQuote, GasStationStatus, GatewayView, HandoverResult,
    RotationResult, RotationView, StandbyMemberRequest, StandbySetPreflightView,
    StandbySetRequestBody, StandbySetResult, TemplateSpawnRequestBody, TerminateResult,
    WithdrawalResult, WorkloadCard,
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

/* -------------------------------------------------------------------------- */
/* TOON_Network#149: a Template spawn goes where the Template is recorded.     */
/* -------------------------------------------------------------------------- */

/// `POST /api/leases/spawn` has no `template` field, so a lease bought there
/// from a Template left a vault record that did not name it — the TUI smoke
/// found this against a live daemon. `api::spawn_from_template` must post to
/// the Template route, with the Template's address and the Listing version the
/// daemon buys at, and decode the same `SpawnResult` the lease route answers.
#[tokio::test]
async fn spawn_from_template_posts_to_the_template_route_and_names_the_template() {
    let body: &'static str = Box::leak(fixture("leases-spawn").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let request = TemplateSpawnRequestBody {
        template: format!("30436:{}:static-site", "a".repeat(64)),
        env: None,
        ssh_public_key: "ssh-ed25519 AAAA test".to_string(),
        volume_gb: None,
        provider: "b".repeat(64),
        listing: "basic".to_string(),
        listing_version: 3,
        local_only: None,
    };
    let result = api::spawn_from_template(&client, &request).await.unwrap();

    assert!(result.lease.is_some());
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.path, "/api/templates/spawn");
    let sent: serde_json::Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!(sent["template"], request.template.as_str());
    assert_eq!(sent["listingVersion"], 3);
    assert_eq!(sent["listing"], "basic");
    assert_eq!(sent["sshPublicKey"], "ssh-ed25519 AAAA test");
}

/* -------------------------------------------------------------------------- */
/* Funds (TOON_Network#147): gas station, faucet drip, gas quote and buy —    */
/* moved into `src/api.rs` off `main.rs`'s own `client.get`/`post` calls.     */
/* -------------------------------------------------------------------------- */

#[tokio::test]
async fn gas_station_gets_and_decodes_the_real_fixture() {
    let body: &'static str = Box::leak(fixture("gas-station").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let status: GasStationStatus = api::gas_station(&client).await.unwrap();

    assert_eq!(status.state, "ready");
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "GET");
    assert_eq!(sent.path, "/api/funding/gas");
}

#[tokio::test]
async fn drip_posts_the_chain_and_decodes_the_real_funding_fixture() {
    let body: &'static str = Box::leak(fixture("funding").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let status = api::drip(&client, "solana".to_string()).await.unwrap();

    assert_eq!(status.state, "ready");
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.path, "/api/funding/faucet");
    assert!(sent.body.contains("\"chain\":\"solana\""));
}

#[tokio::test]
async fn quote_gas_posts_the_chain_and_decodes_the_real_quote_fixture() {
    let body: &'static str = Box::leak(fixture("gas-quote").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let quote: GasQuote = api::quote_gas(&client, "solana".to_string()).await.unwrap();

    assert_eq!(quote.quote_id, "q-7");
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.path, "/api/funding/gas/quote");
    assert!(sent.body.contains("\"chain\":\"solana\""));
}

#[tokio::test]
async fn buy_gas_posts_the_chain_and_quote_id_and_decodes_the_real_purchase_fixture() {
    let body: &'static str = Box::leak(fixture("gas-purchase").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let purchase: GasPurchase = api::buy_gas(&client, "solana".to_string(), "q-7".to_string())
        .await
        .unwrap();

    assert_eq!(purchase.state, "delivered");
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.path, "/api/funding/gas/buy");
    assert!(sent.body.contains("\"chain\":\"solana\""));
    assert!(sent.body.contains("\"quoteId\":\"q-7\""));
}

/* -------------------------------------------------------------------------- */
/* A Standby Set's own routes (spec §7) — also moved off `main.rs`.          */
/* -------------------------------------------------------------------------- */

fn standby_set_request() -> StandbySetRequestBody {
    use toon_console_tui::types::{SpawnImageRequest, SpawnRequestBody};

    StandbySetRequestBody {
        base: SpawnRequestBody {
            provider: "d".repeat(64),
            listing: "basic".to_string(),
            image: SpawnImageRequest {
                reference: Some("traefik/whoami".to_string()),
                digest: "sha256:aa".to_string(),
                registry_entry: None,
            },
            env: None,
            ports: None,
            ssh_public_key: "ssh-ed25519 AAAA".to_string(),
            volume_gb: None,
            entrypoint: None,
            args: None,
            template: None,
            local_only: None,
            chain: None,
        },
        standbys: vec![StandbyMemberRequest {
            provider: "e".repeat(64),
            listing: "basic".to_string(),
            listing_version: None,
            chain: None,
        }],
    }
}

#[tokio::test]
async fn preflight_standby_set_posts_to_the_preflight_route_and_decodes_the_real_fixture() {
    let body: &'static str = Box::leak(fixture("leases-standby-set-preflight").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let view: StandbySetPreflightView = api::preflight_standby_set(&client, &standby_set_request())
        .await
        .unwrap();

    assert!(view.ok);
    assert_eq!(view.members.len(), 2);
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.path, "/api/leases/standby-set/preflight");
    assert!(sent.body.contains("\"standbys\""));
}

#[tokio::test]
async fn spawn_standby_set_posts_to_the_spawn_route_and_decodes_the_real_fixture() {
    let body: &'static str = Box::leak(fixture("leases-standby-set-spawn").into_boxed_str());
    let recorded = Arc::new(Mutex::new(None));
    let (url, _server) = spawn_stub(body, recorded.clone());
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("launch.json");
    write_record(&path, &url);
    let client = DaemonClient::connect(path).await.unwrap();

    let result: StandbySetResult = api::spawn_standby_set(&client, &standby_set_request())
        .await
        .unwrap();

    assert_eq!(result.members.len(), 2);
    assert!(result.lease.is_some());
    let sent = recorded.lock().unwrap().take().unwrap();
    assert_eq!(sent.method, "POST");
    assert_eq!(sent.path, "/api/leases/standby-set");
}
