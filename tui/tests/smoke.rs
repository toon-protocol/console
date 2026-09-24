//! The TUI smoke (TOON_Network#149): one workload's whole life, driven
//! through the TUI's own API client against a real daemon.
//!
//! ```text
//! cargo test --features smoke
//! ```
//!
//! Every call below is a function in `toon_console_tui::api` — the same one
//! `main.rs` runs when the matching `app::Command` arrives — decoded into the
//! same `types.rs` structs the views draw from, and the spawn bodies are built
//! by `views::new_workload`'s own builders (`spawn_request_from_expansion`,
//! `template_spawn_request`). What this proves is the TUI's half of the conversation,
//! not a second client that happens to spell the same URLs.
//!
//! ## What it drives
//!
//! Six steps: `signin`, `spawn` (from a Template), `extend`, `rotate`,
//! `gateway` (handover, then withdraw) and `terminate`. Each one re-reads what
//! the daemon now says — the account, the dashboard card, the rotation, the
//! gateway view — and asserts that, not merely a 2xx.
//!
//! Between `signin` and `spawn` it does what a spawn needs first, as the stages
//! `smoke:console` names the same way: `chain-seed`, `directory`, `funds`,
//! `publish-seed` and `template`. Those go through the TUI's client too, except
//! the three things that are not the console's to do at all — minting this
//! run's keys, moving test money into the payer address, and publishing the
//! Template — which `smoke:console` also does outside the daemon. They are the
//! one shared copy in `packages/daemon/src/main-smoke-tui.ts` (run from
//! `dist/`, so `npm run build -w @toon-protocol/console-daemon` first).
//!
//! ## Three outcomes
//!
//! A step **passes** when the daemon's re-read state held, **fails** when it
//! did not, and is **skipped** when the network cannot carry it. The one skip
//! today is the gateway, decided by `smoke-console.ts`'s own `planConditional`
//! (through that helper), so both smokes skip it for the same reason: no
//! Workload Gateway connector in the profile, or one that publishes no
//! handover route. A skip is printed as its own word and listed at the end
//! under NOT PROVED; it is never counted as a pass.
//!
//! ## Whose daemon
//!
//! A fresh one, started with its own `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME` and
//! `XDG_DATA_HOME` and `TOON_CONSOLE_KEYSTORE=file` (the repository README's
//! “The TUI smoke” has the recipe). The smoke reads that daemon's launch record the way the TUI does,
//! and refuses to go on when `XDG_RUNTIME_DIR` is the login session's own, when
//! an account is already signed in, or when the keystore is not the file — a
//! smoke that signs in, switches networks and spends must never do it to the
//! console somebody is using.
//!
//! Behind the `smoke` feature, with `harness = false` so the report prints
//! whether it passes or not: plain `cargo test` and CI never build it.

use std::process::{ExitCode, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use toon_console_tui::api;
use toon_console_tui::client::{ClientError, DaemonClient};
use toon_console_tui::launch::launch_file_path;
use toon_console_tui::types::{
    ChainFundingView, ChainSeedState, Directory, DirectoryFilters, ExpandTemplateRequest,
    KeystoreBackend, LeaseLife, ListingView, LocalSignerMode, LocalSignerRequest, ProviderView,
    SignerKind, TemplateAvailability, TemplateGallery, WorkloadCard, WorkloadStatus,
};
use toon_console_tui::views::new_workload::{spawn_request_from_expansion, template_spawn_request};

/// The profile a run switches a fresh daemon to. `TOON_TUI_SMOKE_PROFILE`
/// overrides it (`devnet`, say), exactly as `--profile` does for
/// `smoke:console`.
const DEFAULT_PROFILE: &str = "sandbox";
/// `smoke:console`'s default image — an HTTP echo server; `TOON_TUI_SMOKE_IMAGE`
/// overrides it.
const DEFAULT_IMAGE: &str = "traefik/whoami:v1.10.2";
/// How long a channel open, and a fresh container, are given.
const OPEN_TIMEOUT: Duration = Duration::from_secs(180);
const RUNNING_TIMEOUT: Duration = Duration::from_secs(180);
const POLL: Duration = Duration::from_secs(3);

/// The stages, in order. The six the ticket names are marked `true`; the rest
/// are what a spawn needs first, named as `smoke:console` names them.
const STAGES: &[(&str, bool, &str)] = &[
    ("daemon", false, "a fresh daemon, on its own directories"),
    ("signin", true, "sign in with a local key"),
    ("chain-seed", false, "seal a Chain Seed to the account"),
    ("directory", false, "read the Provider Directory"),
    ("funds", false, "fund the payer and open a channel"),
    ("publish-seed", false, "publish the sealed seed"),
    ("template", false, "a Template on the relay, in the gallery"),
    ("spawn", true, "spawn from the Template"),
    ("extend", true, "buy one more Lease Interval"),
    ("rotate", true, "replace the lease's Continuation Token"),
    (
        "gateway",
        true,
        "hand the workload to a Workload Gateway, and take it back",
    ),
    ("terminate", true, "end the lease"),
];

/* -------------------------------------------------------------------------- */
/* The three outcomes                                                         */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Passed,
    Skipped,
    Failed,
}

/// Why a stage did not pass.
enum Stop {
    /// This network cannot carry it. The reason is the network's own answer.
    Skip(String),
    /// An assertion did not hold.
    Fail(String),
}

impl From<ClientError> for Stop {
    fn from(error: ClientError) -> Self {
        Stop::Fail(error.to_string())
    }
}

type Outcome<T> = Result<T, Stop>;

fn must(condition: bool, message: impl Into<String>) -> Outcome<()> {
    if condition {
        Ok(())
    } else {
        Err(Stop::Fail(message.into()))
    }
}

struct StageResult {
    name: &'static str,
    state: State,
    detail: String,
    ms: u128,
}

/// The running report. `record` is the only way a stage ends, so none can
/// finish without saying which of the three things happened to it.
#[derive(Default)]
struct Run {
    stages: Vec<StageResult>,
    spent: u128,
}

impl Run {
    fn record<T>(
        &mut self,
        name: &'static str,
        began: Instant,
        facts: Vec<String>,
        outcome: Outcome<T>,
    ) -> Option<T> {
        let (state, detail, value) = match outcome {
            Ok(value) => (
                State::Passed,
                facts
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "nothing was asserted".to_string()),
                Some(value),
            ),
            Err(Stop::Skip(why)) => (State::Skipped, why, None),
            Err(Stop::Fail(why)) => (State::Failed, why, None),
        };
        let mark = match state {
            State::Passed => "ok  ",
            State::Skipped => "skip",
            State::Failed => "FAIL",
        };
        let ms = began.elapsed().as_millis();
        println!("  {mark}  {name:<13}{:>7}  {detail}", format!("{ms}ms"));
        if state != State::Skipped {
            for fact in facts.iter().take(facts.len().saturating_sub(1)) {
                println!("         · {fact}");
            }
        }
        self.stages.push(StageResult {
            name,
            state,
            detail,
            ms,
        });
        value
    }

    fn spend(&mut self, cost: Option<&str>) {
        if let Some(units) = cost.and_then(|cost| cost.parse::<u128>().ok()) {
            self.spent += units;
        }
    }

    fn count(&self, state: State) -> usize {
        self.stages
            .iter()
            .filter(|stage| stage.state == state)
            .count()
    }

    /// The ending: the tally, what was spent, and — always — what this run did
    /// NOT prove, skipped and unreached kept apart.
    fn summarize(&self, profile: &str, elapsed: Duration) -> bool {
        let failed = self.count(State::Failed);
        let reached: Vec<&str> = self.stages.iter().map(|stage| stage.name).collect();
        let missed: Vec<&str> = STAGES
            .iter()
            .map(|(name, _, _)| *name)
            .filter(|name| !reached.contains(name))
            .collect();
        let green = failed == 0 && missed.is_empty();
        let required = |state: State| {
            self.stages
                .iter()
                .filter(|stage| {
                    stage.state == state
                        && STAGES
                            .iter()
                            .any(|(name, six, _)| *six && *name == stage.name)
                })
                .count()
        };

        println!();
        println!(
            "{} — {} proved, {} skipped, {} failed, in {}s on “{profile}”.",
            if green { "GREEN" } else { "RED" },
            self.count(State::Passed),
            self.count(State::Skipped),
            failed,
            elapsed.as_secs(),
        );
        println!(
            "The six TUI steps: {} proved, {} skipped, {} failed, {} not reached.",
            required(State::Passed),
            required(State::Skipped),
            required(State::Failed),
            missed
                .iter()
                .filter(|name| STAGES.iter().any(|(each, six, _)| *six && each == *name))
                .count(),
        );
        println!();
        println!(
            "Spent {} base units, as each answer reported it — status re-reads included. A \
             refused paid request is billed like an accepted one (ADR 0003), and one refused \
             before it answered is not in this figure.",
            self.spent
        );
        println!();

        let skipped: Vec<&StageResult> = self
            .stages
            .iter()
            .filter(|stage| stage.state == State::Skipped)
            .collect();
        if !skipped.is_empty() {
            println!("NOT PROVED on this network ({}):", skipped.len());
            for stage in &skipped {
                println!("  {} — {}", stage.name, title(stage.name));
                println!("      {}", stage.detail);
            }
        }
        if !missed.is_empty() {
            if !skipped.is_empty() {
                println!();
            }
            println!(
                "NOT REACHED ({}): the run stopped before these, so they are neither proved nor \
                 disproved — {}.",
                missed.len(),
                missed.join(", ")
            );
        }
        if skipped.is_empty() && missed.is_empty() {
            println!("Nothing was skipped: every stage this smoke knows ran here.");
        }
        let failures: Vec<&StageResult> = self
            .stages
            .iter()
            .filter(|stage| stage.state == State::Failed)
            .collect();
        if !failures.is_empty() {
            println!();
            println!("FAILED ({}):", failures.len());
            for stage in failures {
                println!("  {} — {} ({}ms)", stage.name, stage.detail, stage.ms);
            }
        }
        green
    }
}

fn title(name: &str) -> &'static str {
    STAGES
        .iter()
        .find(|(each, _, _)| *each == name)
        .map(|(_, _, title)| *title)
        .unwrap_or("")
}

/* -------------------------------------------------------------------------- */
/* The helper: what is not the console's to do                                */
/* -------------------------------------------------------------------------- */

/// This run's own keys, from `main-smoke-tui.js keys`. Never printed: the
/// type has no `Debug`, on purpose.
#[derive(Deserialize)]
struct Keys {
    nsec: String,
    pubkey: String,
    npub: String,
    mnemonic: String,
    passphrase: String,
    #[serde(rename = "sshPublicKey")]
    ssh_public_key: String,
    addresses: SeedAddresses,
}

#[derive(Deserialize)]
struct SeedAddresses {
    evm: String,
    solana: String,
}

#[derive(Deserialize)]
struct Published {
    address: String,
    digest: String,
    cost: String,
    facts: Vec<String>,
}

#[derive(Deserialize)]
struct Verdict {
    run: bool,
    reason: String,
}

#[derive(Deserialize)]
struct Plan {
    gateway: Verdict,
}

/// `node packages/daemon/dist/main-smoke-tui.js <command>`, one JSON object in
/// and one out. It inherits this process's environment — which is the
/// daemon's own `XDG_*` — so the Template is paid from the daemon's channel.
async fn helper<T: for<'de> Deserialize<'de>>(command: &str, input: Value) -> Outcome<T> {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/daemon/dist/main-smoke-tui.js");
    if !script.exists() {
        return Err(Stop::Fail(format!(
            "{} is not built — run `npm ci && npm run build -w @toon-protocol/console-daemon` at \
             the repository root first",
            script.display()
        )));
    }
    let mut child = tokio::process::Command::new("node")
        .arg(&script)
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| Stop::Fail(format!("could not run node: {err}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.to_string().as_bytes())
            .await
            .map_err(|err| Stop::Fail(format!("could not talk to the helper: {err}")))?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|err| Stop::Fail(format!("the helper did not finish: {err}")))?;
    if !output.status.success() {
        return Err(Stop::Fail(format!(
            "main-smoke-tui {command} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|err| Stop::Fail(format!("main-smoke-tui {command} answered oddly: {err}")))
}

/* -------------------------------------------------------------------------- */
/* Small reads                                                                */
/* -------------------------------------------------------------------------- */

fn short(text: &str) -> String {
    text.chars().take(16).collect::<String>() + "…"
}

/// Base units every status read below was billed, as the card reported it.
/// A `status` is free at a provider's own connector and billed by a hop that
/// carries it — on the sandbox, the hub — so re-reading is not free, and the
/// ending counts it.
static STATUS_SPENT: AtomicU64 = AtomicU64::new(0);

/// The dashboard card for `id`, re-read from its provider (`?refresh=1`, as
/// `R` and the 30-second poll ask for it).
async fn card(client: &DaemonClient, id: &str) -> Outcome<WorkloadCard> {
    let board = api::workloads(client, true).await?;
    for each in &board.cards {
        let cost = match &each.status {
            WorkloadStatus::Read { cost, .. }
            | WorkloadStatus::Silent { cost, .. }
            | WorkloadStatus::Refused { cost, .. } => cost.as_deref(),
            WorkloadStatus::Unread { .. } => None,
        };
        if let Some(units) = cost.and_then(|cost| cost.parse::<u64>().ok()) {
            STATUS_SPENT.fetch_add(units, Ordering::Relaxed);
        }
    }
    board
        .cards
        .into_iter()
        .find(|card| card.workload_id == id)
        .ok_or_else(|| {
            Stop::Fail(format!(
                "the dashboard no longer carries workload {}",
                short(id)
            ))
        })
}

fn phase(card: &WorkloadCard) -> String {
    match &card.status {
        WorkloadStatus::Read { life, .. } => match life {
            LeaseLife::Provisioning => "provisioning".to_string(),
            LeaseLife::Reserved => "reserved".to_string(),
            LeaseLife::Running => "running".to_string(),
            LeaseLife::Stopped => "stopped".to_string(),
            LeaseLife::Ended { ending, .. } => format!("ended ({ending})"),
        },
        WorkloadStatus::Silent { reason, .. } => format!("silent: {reason}"),
        WorkloadStatus::Refused { code, message, .. } => format!("refused {code}: {message}"),
        WorkloadStatus::Unread { reason } => format!("unread: {reason}"),
    }
}

fn expires_at(card: &WorkloadCard) -> Option<i64> {
    match &card.status {
        WorkloadStatus::Read { expires_at, .. } => *expires_at,
        _ => None,
    }
}

/// Unix seconds as an ISO-8601 UTC timestamp, the way `smoke:console` prints
/// an expiry — Howard Hinnant's `civil_from_days`, so no date crate is pulled
/// in for one report line.
fn iso(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

async fn chain_at(client: &DaemonClient, chain: &str) -> Outcome<ChainFundingView> {
    let funding = api::funding(client, true).await?;
    funding
        .chains
        .into_iter()
        .find(|each| each.chain == chain)
        .ok_or_else(|| Stop::Fail(format!("the connector stopped settling on {chain} mid-run")))
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

struct Target {
    provider: ProviderView,
    listing: ListingView,
}

#[tokio::main]
async fn main() -> ExitCode {
    let profile = std::env::var("TOON_TUI_SMOKE_PROFILE").unwrap_or(DEFAULT_PROFILE.to_string());
    let image = std::env::var("TOON_TUI_SMOKE_IMAGE").unwrap_or(DEFAULT_IMAGE.to_string());
    let launch = launch_file_path();
    println!("toon-console-tui smoke on “{profile}”");
    println!("  launch record: {}", launch.display());
    println!("  image:         {image}");
    println!();

    let began = Instant::now();
    let mut run = Run::default();
    let mut workload: Option<String> = None;
    let mut client: Option<Arc<DaemonClient>> = None;

    drive(&mut run, &mut client, &mut workload, &profile, &image).await;

    // Whatever happened above, a lease this run bought is not left running:
    // `terminate` is free and final. `workload` is `None` on every path that
    // already ended it.
    if let (Some(client), Some(id)) = (&client, &workload) {
        match api::terminate(client, id).await {
            Ok(result) => println!(
                "  ..    teardown       ended {}: {}",
                short(id),
                result
                    .ended
                    .unwrap_or_else(|| "no ending reported".to_string())
            ),
            Err(error) => println!("  ..    teardown       COULD NOT END {id}: {error}"),
        }
    }

    run.spent += u128::from(STATUS_SPENT.load(Ordering::Relaxed));
    if run.summarize(&profile, began.elapsed()) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

async fn drive(
    run: &mut Run,
    slot: &mut Option<Arc<DaemonClient>>,
    workload: &mut Option<String>,
    profile: &str,
    image: &str,
) {
    // -- daemon ---------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = daemon(profile, &mut facts).await;
    let Some((client, keys)) = run.record("daemon", t, facts, outcome) else {
        return;
    };
    *slot = Some(client.clone());

    // -- signin ---------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = signin(&client, &keys, &mut facts).await;
    if run.record("signin", t, facts, outcome).is_none() {
        return;
    }

    // -- chain-seed -----------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = chain_seed(&client, &keys, &mut facts).await;
    if run.record("chain-seed", t, facts, outcome).is_none() {
        return;
    }

    // -- directory ------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = directory(&client, &mut facts).await;
    let Some(target) = run.record("directory", t, facts, outcome) else {
        return;
    };

    // -- funds ----------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = funds(&client, &target, &mut facts).await;
    if run.record("funds", t, facts, outcome).is_none() {
        return;
    }

    // -- publish-seed ---------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = publish_seed(&client, &mut facts).await;
    let Some(cost) = run.record("publish-seed", t, facts, outcome) else {
        return;
    };
    run.spend(cost.as_deref());

    // -- template -------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let outcome = template(&client, &keys, &target, profile, image, &mut facts).await;
    let Some(published) = run.record("template", t, facts, outcome) else {
        return;
    };
    run.spend(Some(&published.cost));

    // -- spawn ----------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let mut cost = None;
    let outcome = spawn(
        &client, &keys, &target, &published, workload, &mut cost, &mut facts,
    )
    .await;
    run.spend(cost.as_deref());
    let Some(id) = run.record("spawn", t, facts, outcome) else {
        return;
    };

    // -- extend ---------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let mut cost = None;
    let outcome = extend(&client, &id, &mut cost, &mut facts).await;
    run.spend(cost.as_deref());
    run.record("extend", t, facts, outcome);

    // -- rotate ---------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let mut costs = Vec::new();
    let outcome = rotate(&client, &id, &mut costs, &mut facts).await;
    for cost in &costs {
        run.spend(cost.as_deref());
    }
    run.record("rotate", t, facts, outcome);

    // -- gateway --------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let mut costs = Vec::new();
    let outcome = gateway(&client, &id, profile, &mut costs, &mut facts).await;
    for cost in &costs {
        run.spend(cost.as_deref());
    }
    run.record("gateway", t, facts, outcome);

    // -- terminate ------------------------------------------------------------
    let t = Instant::now();
    let mut facts = Vec::new();
    let mut cost = None;
    let outcome = terminate(&client, &id, workload, &mut cost, &mut facts).await;
    run.spend(cost.as_deref());
    run.record("terminate", t, facts, outcome);
}

/* -------------------------------------------------------------------------- */
/* The stages                                                                 */
/* -------------------------------------------------------------------------- */

/// Reach the daemon through its launch record, as the TUI does, and make sure
/// it is a fresh one of this run's own before anything is signed or spent.
async fn daemon(profile: &str, facts: &mut Vec<String>) -> Outcome<(Arc<DaemonClient>, Keys)> {
    match std::env::var("XDG_RUNTIME_DIR") {
        Ok(dir) if !dir.is_empty() && !dir.starts_with("/run/user/") => {}
        Ok(dir) => {
            return Err(Stop::Fail(format!(
                "XDG_RUNTIME_DIR is {dir:?}, the login session's own: this smoke signs in, \
                 switches networks and spends, so it only drives a daemon started with \
                 directories of its own (README.md, “The TUI smoke”)"
            )))
        }
        Err(_) => {
            return Err(Stop::Fail(
                "XDG_RUNTIME_DIR is not set: point it, XDG_CONFIG_HOME and XDG_DATA_HOME at the \
                 directories this smoke's daemon was started with (README.md, “The TUI smoke”)"
                    .to_string(),
            ))
        }
    }

    let client = DaemonClient::connect(launch_file_path())
        .await
        .map_err(|err| Stop::Fail(format!("no daemon to drive: {err}")))?;
    let url = client.base_url().await;
    let health = api::health(&client).await?;

    let session = api::account(&client).await?;
    must(
        !session.signed_in,
        "an account is already signed in on this daemon — the smoke signs in an account of its \
         own, and only on a daemon nobody is using",
    )?;
    must(
        session.keystore.backend == KeystoreBackend::File,
        format!(
            "the keystore is {:?} at {} — start the daemon with TOON_CONSOLE_KEYSTORE=file, so \
             no key of this run's reaches a session keyring",
            session.keystore.backend, session.keystore.location
        ),
    )?;

    let profiles = api::profiles(&client).await?;
    let switched = if profiles.active_id == profile {
        String::new()
    } else {
        let now = api::switch_profile(&client, profile.to_string()).await?;
        must(
            now.active_id == profile,
            format!("the daemon would not switch to the “{profile}” profile"),
        )?;
        format!(" (switched from {})", profiles.active_id)
    };
    // Re-read: the switch is the daemon's state, not the answer's.
    let now = api::profiles(&client).await?;
    must(
        now.active_id == profile,
        format!(
            "the daemon reads “{}” back as its profile, not “{profile}”",
            now.active_id
        ),
    )?;

    let keys: Keys = helper("keys", json!({})).await?;
    facts.push(format!(
        "{} (daemon {}), profile {profile}{switched}, nobody signed in, keystore in a file at {}",
        url, health.daemon.version, session.keystore.location
    ));
    Ok((client, keys))
}

/// Step 1: `Command::AddLocalSigner` with `mode: nsec`, as the Account view's
/// "Import an nsec" form sends it.
async fn signin(client: &DaemonClient, keys: &Keys, facts: &mut Vec<String>) -> Outcome<()> {
    let request = LocalSignerRequest {
        mode: LocalSignerMode::Nsec,
        nsec: Some(keys.nsec.clone()),
        mnemonic: None,
        label: Some("tui-smoke".to_string()),
        passphrase: Some(keys.passphrase.clone()),
    };
    let answer = api::add_local_signer(client, &request).await?;
    must(
        answer.signed_in,
        "the sign-in answer says nobody is signed in",
    )?;

    // The daemon's state, read again the way `Command::RefreshAccount` reads it.
    let session = api::account(client).await?;
    let account = session
        .account
        .as_ref()
        .ok_or_else(|| Stop::Fail("GET /api/account names no account".to_string()))?;
    must(
        session.signed_in && account.pubkey == keys.pubkey,
        format!(
            "the daemon reads back {} as signed in, not this run's key",
            account.npub
        ),
    )?;
    must(
        account.signer_kind == SignerKind::Local,
        "the signer is not the local keystore",
    )?;
    let saved = session
        .signers
        .iter()
        .find(|signer| signer.id == account.signer_id)
        .ok_or_else(|| Stop::Fail("the signer in use is not among the saved ones".to_string()))?;
    must(
        saved.backend == KeystoreBackend::File,
        "the key was saved somewhere other than the file keystore",
    )?;
    // ADR 0020: nothing that went in comes back out.
    let raw: Value = client.get("/api/account").await?;
    must(
        !raw.to_string().contains(&keys.nsec),
        "the account answer carries the nsec — a key must never leave the daemon",
    )?;
    facts.push(format!(
        "{} is signed in from the file keystore, read back from GET /api/account, and no key \
         came back",
        keys.npub
    ));
    Ok(())
}

async fn chain_seed(client: &DaemonClient, keys: &Keys, facts: &mut Vec<String>) -> Outcome<()> {
    api::acknowledge_chain_seed_warning(client).await?;
    api::import_chain_seed(client, keys.mnemonic.clone()).await?;
    let seed = api::chain_seed(client).await?;
    let addresses = seed.addresses.as_ref().ok_or_else(|| {
        Stop::Fail(format!(
            "the imported seed has no addresses; it is {:?}",
            seed.state
        ))
    })?;
    must(
        addresses
            .evm
            .address
            .eq_ignore_ascii_case(&keys.addresses.evm),
        "the console derived a different EVM payer address from this seed",
    )?;
    must(
        addresses.solana.address == keys.addresses.solana,
        "the console derived a different Solana payer address from this seed",
    )?;
    facts.push(format!(
        "sealed to the account ({:?}); its payer addresses are the seed's own",
        seed.state
    ));
    Ok(())
}

/// The cheapest live clearnet tier with no capabilities — `smoke:console`'s
/// `chooseProvider`, with no flags.
async fn directory(client: &DaemonClient, facts: &mut Vec<String>) -> Outcome<Target> {
    let Directory::Ok { providers, .. } =
        api::directory(client, &DirectoryFilters::default()).await?
    else {
        return Err(Stop::Fail(
            "this profile has no Provider Directory".to_string(),
        ));
    };
    must(
        !providers.is_empty(),
        "the Provider Directory on this relay is empty",
    )?;
    let usable: Vec<&ProviderView> = providers
        .iter()
        .filter(|provider| !provider.profile.hidden && !provider.listings.is_empty())
        .collect();
    let live: Vec<&ProviderView> = usable
        .iter()
        .copied()
        .filter(|provider| provider.liveness.state == "live")
        .collect();
    let pool = if live.is_empty() { usable } else { live };
    let mut best: Option<(&ProviderView, &ListingView)> = None;
    for provider in pool {
        for listing in &provider.listings {
            if !listing.capabilities.is_empty() {
                continue;
            }
            if best.is_none_or(|(_, held)| listing.price < held.price) {
                best = Some((provider, listing));
            }
        }
    }
    let (provider, listing) =
        best.ok_or_else(|| Stop::Fail("no provider publishes a plain Listing".to_string()))?;
    facts.push(format!(
        "{} provider(s); buying {} v{} ({}s at {}) from {}",
        providers.len(),
        listing.name,
        listing.version,
        listing.lease_interval_seconds,
        listing.price,
        short(&provider.pubkey)
    ));
    Ok(Target {
        provider: provider.clone(),
        listing: listing.clone(),
    })
}

/// Pick the chain, fund the payer, and open a channel through
/// `Command::OpenChannel`.
///
/// Which chain is read from the network: the first one the profile's
/// connector settles on in the same TOKEN the chosen provider's own Profile
/// settles in (§4.1) — so no hop between them has to convert the payment, and
/// a conversion that rounds to nothing is refused at full price (ADR 0003).
/// On the sandbox that is `solana`, the chain `smoke:console` is told with
/// `--chain solana`: the hub's EVM token is not the providers'. The token
/// decides it, not the chain name. `TOON_TUI_SMOKE_CHAIN` overrides it, as
/// `--chain` does for `smoke:console`.
async fn funds(client: &DaemonClient, target: &Target, facts: &mut Vec<String>) -> Outcome<()> {
    let health = api::health(client).await?;
    if let toon_console_tui::types::ConnectorHealth::Ok { routes, .. } = &health.connector {
        let ilp = &target.provider.profile.ilp_address;
        must(
            routes
                .iter()
                .any(|route| route.prefix == *ilp || route.prefix.starts_with(&format!("{ilp}."))),
            format!(
                "the profile's connector carries no route to the provider's prefix {ilp}, so a \
                 lease is bought at the provider's own connector — and the TUI's Funds view opens \
                 channels with the profile's connector only"
            ),
        )?;
    }

    let funding = api::funding(client, true).await?;
    must(
        funding.state == "ready",
        format!(
            "funding is “{}”: {}",
            funding.state,
            funding.reason.clone().unwrap_or_default()
        ),
    )?;
    let chosen = match std::env::var("TOON_TUI_SMOKE_CHAIN") {
        Ok(chain) => funding.chains.iter().find(|each| each.chain == chain),
        Err(_) => funding.chains.iter().find(|each| {
            target.provider.profile.settlement.iter().any(|term| {
                term.chain == each.chain && term.token.eq_ignore_ascii_case(&each.token.address)
            })
        }),
    }
    .cloned()
    .ok_or_else(|| {
        Stop::Fail(format!(
            "the connector settles on {} and the provider on {}: no chain and token in common",
            funding
                .chains
                .iter()
                .map(|each| format!("{} ({})", each.chain, each.token.address))
                .collect::<Vec<_>>()
                .join(", "),
            target
                .provider
                .profile
                .settlement
                .iter()
                .map(|term| format!("{} ({})", term.chain, term.token))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;

    if chosen.channel.phase == "open" {
        facts.push(format!(
            "a channel on {} is already open; nothing was funded",
            chosen.chain
        ));
        return Ok(());
    }

    let deposit = chosen.suggested_deposit.clone().ok_or_else(|| {
        Stop::Fail(format!(
            "the connector suggested no collateral for {}",
            chosen.chain
        ))
    })?;
    #[derive(Deserialize)]
    struct Funded {
        lines: Vec<String>,
    }
    let chain_view = json!({
        "chain": chosen.chain,
        "kind": chosen.kind,
        "token": { "address": chosen.token.address, "decimals": chosen.token.decimals },
        "deposit": { "address": chosen.deposit.address },
        "rpc": { "url": chosen.rpc.url },
        "balances": {
            "state": chosen.balances.state,
            "native": chosen.balances.native.as_ref().map(|amount| json!({ "amount": amount.amount })),
            "token": chosen.balances.token.as_ref().map(|amount| json!({ "amount": amount.amount })),
        },
    });
    let funded: Funded = helper(
        "fund",
        json!({ "chain": chain_view, "deposit": deposit.clone() }),
    )
    .await?;
    facts.extend(funded.lines);

    let ready = chain_at(client, &chosen.chain).await?;
    must(
        ready.can_open,
        format!(
            "the console still will not open on {}: {}",
            chosen.chain,
            ready
                .blocked_by
                .unwrap_or_else(|| "no reason given".to_string())
        ),
    )?;

    api::open_channel(client, chosen.chain.clone(), Some(deposit.clone()), None).await?;
    let deadline = Instant::now() + OPEN_TIMEOUT;
    let channel = loop {
        let now = chain_at(client, &chosen.chain).await?;
        if now.channel.phase != "opening" {
            break now.channel;
        }
        must(
            Instant::now() < deadline,
            format!(
                "the channel on {} was still opening after {}s",
                chosen.chain,
                OPEN_TIMEOUT.as_secs()
            ),
        )?;
        tokio::time::sleep(POLL).await;
    };
    must(
        channel.phase == "open",
        format!(
            "the channel on {} is “{}”{}",
            chosen.chain,
            channel.phase,
            channel
                .reason
                .map(|why| format!(": {why}"))
                .unwrap_or_default()
        ),
    )?;
    facts.push(format!(
        "a channel with {} on {} ({} base units of collateral, channel {}), read back as open",
        chosen.counterparty,
        chosen.chain,
        channel.deposit.unwrap_or(deposit),
        short(&channel.channel_id.unwrap_or_default())
    ));
    Ok(())
}

async fn publish_seed(client: &DaemonClient, facts: &mut Vec<String>) -> Outcome<Option<String>> {
    let answer = api::publish_chain_seed(client).await?;
    let cost = answer
        .last_publish
        .as_ref()
        .and_then(|report| report.cost.clone());
    let seed = api::chain_seed(client).await?;
    must(
        seed.state == ChainSeedState::Ready,
        format!(
            "the seed is {:?} rather than recoverable after its write",
            seed.state
        ),
    )?;
    let accepted = answer
        .last_publish
        .map(|report| report.accepted)
        .unwrap_or_default();
    must(!accepted.is_empty(), "no relay accepted the sealed record")?;
    facts.push(format!(
        "the sealed record is on {}, bought for {} base units",
        accepted.join(", "),
        cost.clone().unwrap_or_else(|| "0".to_string())
    ));
    Ok(cost)
}

async fn template(
    client: &DaemonClient,
    keys: &Keys,
    target: &Target,
    profile: &str,
    image: &str,
    facts: &mut Vec<String>,
) -> Outcome<Published> {
    let health = api::health(client).await?;
    // The hint is the PROVIDER's own relay (§6.2, TOON_Network#107), as
    // `smoke:console` spells it.
    let relay = target
        .provider
        .profile
        .relays
        .first()
        .cloned()
        .unwrap_or(health.profile.relay_url.clone());
    let published: Published = helper(
        "template",
        json!({
            "profile": profile,
            "image": image,
            "relay": relay,
            "arch": target.listing.arch,
            "mnemonic": keys.mnemonic,
            "nsec": keys.nsec,
            "pubkey": keys.pubkey,
        }),
    )
    .await?;
    facts.extend(published.facts.iter().cloned());

    // `Command::RefreshTemplates`, as the Gallery stage reads it.
    let TemplateGallery::Ok { templates, .. } = api::templates(client).await? else {
        return Err(Stop::Fail(
            "this profile has no Template gallery".to_string(),
        ));
    };
    let found = templates
        .iter()
        .find(|each| each.address == published.address)
        .ok_or_else(|| {
            Stop::Fail(format!(
                "the Template {} was written but the gallery does not carry it back",
                published.address
            ))
        })?;
    if let TemplateAvailability::Unavailable { reason } = &found.availability {
        return Err(Stop::Fail(format!(
            "the gallery calls the Template unavailable: {reason}"
        )));
    }
    must(
        found.image.digest == published.digest,
        "the gallery names a different image digest from the one published",
    )?;
    facts.push(format!(
        "the gallery reads {} back as available, image {}",
        found.name,
        short(&found.image.digest)
    ));
    Ok(published)
}

/// Step 2: the New workload view's own sequence — `Command::ExpandTemplate`,
/// `Command::PreflightSpawn` with the body `spawn_request_from_expansion`
/// builds, then `Command::SpawnFromTemplate` with the body
/// `template_spawn_request` builds.
async fn spawn(
    client: &DaemonClient,
    keys: &Keys,
    target: &Target,
    published: &Published,
    workload: &mut Option<String>,
    cost: &mut Option<String>,
    facts: &mut Vec<String>,
) -> Outcome<String> {
    // What the form's "Preview the spawn" sends, and keeps for the spawn.
    let settings = ExpandTemplateRequest {
        template: published.address.clone(),
        env: None,
        ssh_public_key: keys.ssh_public_key.clone(),
        volume_gb: None,
    };
    let expansion = api::expand_template(client, &settings).await?;
    must(
        expansion.spawn.image.digest == published.digest,
        "the expansion names a different image from the Template",
    )?;
    let request = spawn_request_from_expansion(
        &expansion,
        &published.address,
        &target.provider.pubkey,
        &target.listing.name,
        false,
    );

    let preflight = api::preflight_spawn(client, &request).await?;
    must(
        preflight.ok,
        format!(
            "the free preflight says the spawn would not go through: {}",
            preflight.problems.join(" ")
        ),
    )?;

    let spawned = api::spawn_from_template(
        client,
        &template_spawn_request(&settings, &target.provider.pubkey, &target.listing, false),
    )
    .await?;
    *cost = spawned.cost.clone();
    let lease = spawned.lease.ok_or_else(|| {
        Stop::Fail(format!(
            "the spawn returned no lease: {}",
            spawned.preflight.problems.join(" ")
        ))
    })?;
    // From here a lease exists, and the teardown ends it if a later stage
    // cannot.
    *workload = Some(lease.workload_id.clone());
    let id = lease.workload_id.clone();
    must(
        lease.state == "live",
        format!(
            "the vault calls the lease “{}” after the spawn",
            lease.state
        ),
    )?;
    facts.push(format!(
        "workload {} bought for {} base units",
        short(&id),
        spawned.cost.clone().unwrap_or_else(|| "0".to_string())
    ));

    // The daemon's own state: the dashboard card, read until the provider
    // reports the container running.
    let deadline = Instant::now() + RUNNING_TIMEOUT;
    let running = loop {
        let now = card(client, &id).await?;
        let provisioning = matches!(
            now.status,
            WorkloadStatus::Read {
                life: LeaseLife::Provisioning,
                ..
            }
        );
        if !provisioning {
            break now;
        }
        must(
            Instant::now() < deadline,
            format!(
                "the workload never left provisioning in {}s",
                RUNNING_TIMEOUT.as_secs()
            ),
        )?;
        tokio::time::sleep(POLL).await;
    };
    must(
        matches!(
            running.status,
            WorkloadStatus::Read {
                life: LeaseLife::Running,
                ..
            }
        ),
        format!("the card reads “{}”, not running", phase(&running)),
    )?;
    must(
        !running.lease.relays.is_empty(),
        "no relay holds the Root Secret, so the lease exists only on this disk",
    )?;
    must(
        running.lease.template.as_deref() == Some(published.address.as_str()),
        format!(
            "the vault record names {:?} as its Template, not {} — a lease spawned from a \
             Template must say so",
            running.lease.template, published.address
        ),
    )?;
    facts.push(format!(
        "the card reads running until {}, the Root Secret on {}, and the record names the \
         Template it came from",
        expires_at(&running)
            .map(iso)
            .unwrap_or_else(|| "an unknown expiry".to_string()),
        running.lease.relays.join(", ")
    ));
    Ok(id)
}

/// Step 3: `Command::ExtendWorkload` with no price ceiling.
async fn extend(
    client: &DaemonClient,
    id: &str,
    cost: &mut Option<String>,
    facts: &mut Vec<String>,
) -> Outcome<()> {
    let before = card(client, id).await?;
    let was = expires_at(&before).ok_or_else(|| {
        Stop::Fail(format!(
            "the card has no expiry to extend: {}",
            phase(&before)
        ))
    })?;
    let result = api::extend(client, id, None).await?;
    *cost = result.cost.clone();
    must(
        result.sent,
        format!("nothing was sent: {}", result.problems.join(" ")),
    )?;
    if let Some(code) = &result.provider_error {
        return Err(Stop::Fail(format!(
            "the provider refused with {code} — and billed for it (ADR 0003): {}",
            result.message.clone().unwrap_or_default()
        )));
    }
    let answered = result.expires_at.unwrap_or(0);
    must(
        answered > was,
        format!("the answer's expiry did not move: {was} → {answered}"),
    )?;

    let after = card(client, id).await?;
    let now = expires_at(&after).unwrap_or(0);
    must(
        now == answered,
        format!(
            "the provider answered a new expiry of {answered}, and a fresh status read says {now}"
        ),
    )?;
    facts.push(format!(
        "one interval for {} base units; the card re-read from the provider moved {}s, to {}",
        result.cost.clone().unwrap_or_else(|| "0".to_string()),
        now - was,
        iso(now)
    ));
    Ok(())
}

/// Step 4: `Command::RotateWorkload`.
async fn rotate(
    client: &DaemonClient,
    id: &str,
    costs: &mut Vec<Option<String>>,
    facts: &mut Vec<String>,
) -> Outcome<()> {
    let before = api::rotation(client, id).await?;
    let result = api::rotate(client, id).await?;
    costs.push(result.cost.clone());
    costs.push(result.vault_cost.clone());
    must(
        result.started,
        format!("nothing was sent: {}", result.problems.join(" ")),
    )?;
    must(
        result.rotated && result.confirmed == result.of,
        format!(
            "only {} of {} members hold the new token: {}",
            result.confirmed,
            result.of,
            result.problems.join(" ")
        ),
    )?;

    // `GET …/rotation`, as the detail pane reads it. A finished rotation is
    // none under way and a new `rotatedAt`: `confirmed` counts the members of
    // a rotation IN FLIGHT, so it reads 0 again once the old root is dropped.
    let view = api::rotation(client, id).await?;
    must(
        !view.under_way && view.rotated_at.is_some() && view.rotated_at != before.rotated_at,
        format!(
            "the rotation reads back as under way: {}, rotated at {:?} (it was {:?})",
            view.under_way, view.rotated_at, before.rotated_at
        ),
    )?;
    // A rotation is a revocation, so the lease must still answer — with the
    // NEW token, the only one the console now holds.
    let after = card(client, id).await?;
    must(
        matches!(after.status, WorkloadStatus::Read { .. }),
        format!(
            "the lease stopped answering after its token was replaced: {}",
            phase(&after)
        ),
    )?;
    facts.push(format!(
        "{}/{} member(s) took the new Continuation Token for {} + {} base units; the rotation \
         reads back finished at {}, and the lease answers the new token ({})",
        result.confirmed,
        result.of,
        result.cost.clone().unwrap_or_else(|| "0".to_string()),
        result.vault_cost.clone().unwrap_or_else(|| "0".to_string()),
        view.rotated_at.clone().unwrap_or_default(),
        phase(&after)
    ));
    Ok(())
}

/// Step 5: `Command::HandOverWorkload`, then `Command::WithdrawWorkload` so
/// nothing is left served.
async fn gateway(
    client: &DaemonClient,
    id: &str,
    profile: &str,
    costs: &mut Vec<Option<String>>,
    facts: &mut Vec<String>,
) -> Outcome<()> {
    let plan: Plan = helper("plan", json!({ "profile": profile })).await?;
    if !plan.gateway.run {
        return Err(Stop::Skip(plan.gateway.reason));
    }

    let result = api::handover(client, id).await?;
    costs.push(result.cost.clone());
    must(
        result.sent,
        format!("nothing was sent: {}", result.problems.join(" ")),
    )?;
    if let Some(code) = &result.gateway_error {
        return Err(Stop::Fail(format!(
            "the gateway refused with {code}: {}",
            result.message.clone().unwrap_or_default()
        )));
    }
    must(
        result.matches == Some(true),
        format!(
            "the gateway serves {:?} and this console derived {:?} (§12.2)",
            result.hostname, result.expected_hostname
        ),
    )?;
    let hostname = result.hostname.clone().unwrap_or_default();

    // `GET …/gateway`, as the detail pane reads it.
    let held = api::gateway(client, id).await?;
    must(
        held.held
            && held
                .handover
                .as_ref()
                .is_some_and(|note| note.hostname == hostname && note.withdrawn_at.is_none()),
        format!(
            "after the handover the gateway view reads held={} with {:?}",
            held.held,
            held.handover.as_ref().map(|note| &note.hostname)
        ),
    )?;

    let withdrawn = api::withdraw(client, id).await?;
    costs.push(withdrawn.cost.clone());
    must(
        withdrawn.sent,
        format!(
            "the withdrawal did not go out: {}",
            withdrawn.problems.join(" ")
        ),
    )?;
    let after = api::gateway(client, id).await?;
    must(
        !after.held
            || after
                .handover
                .as_ref()
                .is_some_and(|note| note.withdrawn_at.is_some()),
        "after the withdrawal the gateway view still reads the workload as served",
    )?;
    facts.push(format!(
        "handed to {hostname} for {} base units — the name this console derived itself (§12.2), \
         read back as held — then withdrawn for {}, read back as withdrawn",
        result.cost.clone().unwrap_or_else(|| "0".to_string()),
        withdrawn.cost.clone().unwrap_or_else(|| "0".to_string()),
    ));
    Ok(())
}

/// Step 6: `Command::TerminateWorkload`.
async fn terminate(
    client: &DaemonClient,
    id: &str,
    workload: &mut Option<String>,
    cost: &mut Option<String>,
    facts: &mut Vec<String>,
) -> Outcome<()> {
    let result = api::terminate(client, id).await?;
    *cost = result.cost.clone();
    must(
        result.sent,
        format!("nothing was sent: {}", result.problems.join(" ")),
    )?;
    if let Some(code) = &result.provider_error {
        return Err(Stop::Fail(format!(
            "the provider refused with {code}: {}",
            result.message.clone().unwrap_or_default()
        )));
    }
    must(
        result.ended.as_deref() == Some("termination"),
        format!(
            "the lease ended as {:?}, not a Termination (§6.6)",
            result.ended
        ),
    )?;
    *workload = None;

    let after = card(client, id).await?;
    must(
        !matches!(
            after.status,
            WorkloadStatus::Read {
                life: LeaseLife::Running | LeaseLife::Provisioning | LeaseLife::Reserved,
                ..
            }
        ),
        format!(
            "the card still reads “{}” — this run left a lease burning money",
            phase(&after)
        ),
    )?;
    facts.push(format!(
        "ended as a Termination for {} base units; the card re-read from the provider reads “{}”",
        result.cost.clone().unwrap_or_else(|| "0".to_string()),
        phase(&after)
    ));
    Ok(())
}
