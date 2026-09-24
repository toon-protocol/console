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

use toon_console_tui::types::{Health, Profiles, SessionStatus};

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
    // TOON_Network#141 (Account): `GET /api/account` answers the same
    // `SessionStatus` shape signed in or out, so both fixtures check the
    // same type.
    map.insert("account-signed-out", check::<SessionStatus> as Check);
    map.insert("account-signed-in", check::<SessionStatus> as Check);
    map.insert("profiles", check::<Profiles> as Check);
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
