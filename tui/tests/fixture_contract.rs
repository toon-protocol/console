//! The fixture contract with the daemon (ADR 0028).
//!
//! `packages/daemon/fixtures/api/*.json` are the daemon's OWN API tests'
//! real responses (`packages/daemon/src/api-fixtures.testkit.ts`,
//! `writeApiFixture`), committed so this crate can check its hand-kept types
//! against them without running the Node daemon.
//!
//! Every fixture present is deserialized into the Rust type named for it, via
//! the `REGISTRY` below. Two ways this fails on purpose:
//! - a fixture whose *name* is not in `REGISTRY` — a later ticket adding a
//!   route's fixture must add one line here too, and forgetting fails loudly
//!   rather than silently skipping the new file;
//! - a fixture whose *shape* no longer matches its Rust type — the daemon
//!   changed a field and `tui/src/types.rs` was not updated to match.
//!
//! Adding a fixture for a new route is one line in `REGISTRY`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use toon_console_tui::types::{
    ChainSeedStatus, Dashboard, Directory, DocsIndex, DocsPage, ExpandedTemplate, ExtendResult,
    FundingStatus, GasPurchase, GasQuote, GasStationStatus, GatewayView, HandoverResult, Health,
    PreflightView, ProfileEndpointsError, Profiles, RotationResult, RotationView, SessionStatus,
    SpawnResult, StandbySetPreflightView, StandbySetResult, TemplateGallery,
    TemplatePublishPreview, TemplatePublishResult, TerminateResult, WithdrawalResult, WorkloadCard,
};

type Check = fn(&str) -> Result<(), String>;

fn check<T: serde::de::DeserializeOwned>(text: &str) -> Result<(), String> {
    serde_json::from_str::<T>(text)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/// Fixture file stem (no `.json`) -> the Rust type it must deserialize into.
/// A later ticket adding `packages/daemon/fixtures/api/<route>.json` adds one
/// entry here, e.g. `("workloads", check::<WorkloadsDashboard> as Check)`.
fn registry() -> BTreeMap<&'static str, Check> {
    let mut map: BTreeMap<&'static str, Check> = BTreeMap::new();
    map.insert("health", check::<Health> as Check);
    map.insert("directory", check::<Directory> as Check);
    map.insert("docs", check::<DocsIndex> as Check);
    map.insert("doc", check::<DocsPage> as Check);
    // TOON_Network#141 (Account): `GET /api/account` answers the same
    // `SessionStatus` shape signed in or out, so both fixtures check the
    // same type.
    map.insert("account-signed-out", check::<SessionStatus> as Check);
    map.insert("account-signed-in", check::<SessionStatus> as Check);
    map.insert("profiles", check::<Profiles> as Check);
    // TOON_Network#150 (network profile editor): `PUT`/`DELETE
    // /api/profiles/<id>` answer the same `Profiles` shape as `GET
    // /api/profiles` on success, and `problem()`'s own shape (`error`,
    // `message`, an optional per-field `errors`) on a 400 or 409.
    map.insert("profiles-overridden", check::<Profiles> as Check);
    map.insert("profiles-added", check::<Profiles> as Check);
    map.insert("profiles-invalid", check::<ProfileEndpointsError> as Check);
    map.insert(
        "profiles-active-delete-refused",
        check::<ProfileEndpointsError> as Check,
    );
    // TOON_Network#142 (Chain Seed): every fixture `api-chain-seed.test.ts`
    // writes is the same `ChainSeedStatus` shape the state it names comes
    // from.
    for name in [
        "chain-seed-signed-out",
        "chain-seed-unknown",
        "chain-seed-absent",
        "chain-seed-absent-acknowledged",
        "chain-seed-not-yet-recoverable",
        "chain-seed-not-yet-recoverable-blocked",
        "chain-seed-ready",
        "chain-seed-unreadable",
    ] {
        map.insert(name, check::<ChainSeedStatus> as Check);
    }
    // Funds (TOON_Network#147): GET /api/funding, GET /api/funding/gas,
    // POST /api/funding/gas/quote and POST /api/funding/gas/buy all answer
    // with one of these four shapes.
    map.insert("funding", check::<FundingStatus> as Check);
    // TOON_Network#138 (New workload "open a channel with this connector"):
    // `GET /api/funding?connector=<url>` answers the same `FundingStatus`
    // shape, scoped to a connector that need not be the profile's own.
    map.insert("funding-connector", check::<FundingStatus> as Check);
    map.insert("gas-station", check::<GasStationStatus> as Check);
    map.insert("gas-quote", check::<GasQuote> as Check);
    map.insert("gas-purchase", check::<GasPurchase> as Check);
    // TOON_Network#143 (Workloads view).
    map.insert("workloads", check::<Dashboard> as Check);
    map.insert("workload-extend", check::<ExtendResult> as Check);
    map.insert("workload-terminate", check::<TerminateResult> as Check);
    // TOON_Network#144 (auto-extend, rotate, gateway).
    map.insert("workload-auto-extend-armed", check::<WorkloadCard> as Check);
    map.insert("workload-auto-extend-off", check::<WorkloadCard> as Check);
    map.insert("workload-rotation", check::<RotationView> as Check);
    map.insert("workload-rotation-partial", check::<RotationView> as Check);
    map.insert("workload-rotate", check::<RotationResult> as Check);
    map.insert("workload-rotate-partial", check::<RotationResult> as Check);
    map.insert("workload-rotate-finished", check::<RotationResult> as Check);
    map.insert("workload-gateway", check::<GatewayView> as Check);
    map.insert("workload-gateway-served", check::<GatewayView> as Check);
    map.insert(
        "workload-gateway-handover",
        check::<HandoverResult> as Check,
    );
    map.insert(
        "workload-gateway-withdraw",
        check::<WithdrawalResult> as Check,
    );
    // TOON_Network#146 (New workload): the Template gallery, expanding one
    // into a spawn, and the primary spawn's preflight/result, plus a Standby
    // Set's own pair (`api-leases-standby-set.test.ts`, spec §7).
    map.insert("templates", check::<TemplateGallery> as Check);
    map.insert("template-expand", check::<ExpandedTemplate> as Check);
    // TOON_Network#138 (Publish a Template): `POST /api/templates/publish`
    // and its `/preview`, both from `api-template-publish.test.ts`.
    map.insert(
        "template-publish-preview",
        check::<TemplatePublishPreview> as Check,
    );
    map.insert(
        "template-publish-preview-blocked",
        check::<TemplatePublishPreview> as Check,
    );
    map.insert("template-publish", check::<TemplatePublishResult> as Check);
    map.insert("leases-preflight", check::<PreflightView> as Check);
    // TOON_Network#138: the same route with no channel bound yet — the
    // structural shape New workload's Preflight stage detects `o` on
    // (`payment.channelId` absent).
    map.insert(
        "leases-preflight-no-channel",
        check::<PreflightView> as Check,
    );
    map.insert("leases-spawn", check::<SpawnResult> as Check);
    map.insert(
        "leases-standby-set-preflight",
        check::<StandbySetPreflightView> as Check,
    );
    map.insert(
        "leases-standby-set-spawn",
        check::<StandbySetResult> as Check,
    );
    map
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/daemon/fixtures/api")
}

#[test]
fn every_committed_fixture_deserializes_into_its_registered_type() {
    let dir = fixtures_dir();
    let entries =
        fs::read_dir(&dir).unwrap_or_else(|err| panic!("could not read {}: {err}", dir.display()));
    let registry = registry();
    let mut checked = 0;
    let mut unknown = Vec::new();

    for entry in entries {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .expect("fixture file has a UTF-8 stem")
            .to_string();
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("could not read {}: {err}", path.display()));

        match registry.get(name.as_str()) {
            Some(check) => {
                check(&text).unwrap_or_else(|err| {
                    panic!(
                        "fixture {} no longer matches its Rust type: {err}",
                        path.display()
                    )
                });
                checked += 1;
            }
            None => unknown.push(name),
        }
    }

    assert!(
        unknown.is_empty(),
        "fixture(s) with no entry in REGISTRY (add one line per fixture in \
         tui/tests/fixture_contract.rs): {unknown:?}"
    );
    assert!(
        checked > 0,
        "no fixtures found under {} — the daemon's API tests should have \
         written at least health.json",
        dir.display()
    );
}
