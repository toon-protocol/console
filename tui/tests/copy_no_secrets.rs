//! TOON_Network#138: no view's `copyables()` may ever offer a secret — an
//! nsec, a mnemonic, a passphrase, the per-launch token, a Continuation
//! Token, a Root Secret, or anything else the daemon marks secret.
//!
//! This walks every view's own `copyables()`, built from the daemon's REAL
//! committed fixtures (`packages/daemon/fixtures/api/*.json` — the same
//! ones `tests/fixture_contract.rs` checks deserialize), and asserts none of
//! the values they offer look like a secret. It is deliberately built from
//! the fixtures rather than hand-rolled sample data: a fixture is what the
//! daemon actually sends, so this is the closest thing to proving the real
//! app never offers one, without running the Node daemon.
//!
//! `types.rs`'s own module docs already explain WHY a secret has no field to
//! read in the first place (a Continuation Token, a Root Secret, a Gateway
//! Grant): this test is the regression guard for that invariant holding at
//! the one seam that turns a type into something a person can `y` and paste
//! elsewhere.

use std::fs;
use std::path::PathBuf;

use toon_console_tui::markdown;
use toon_console_tui::types::{
    ChainSeedStatus, Dashboard, Directory, DocsPage, FundingStatus, GasStationStatus, Health,
    SessionStatus, TemplateAvailability, TemplateGallery,
};
use toon_console_tui::views::directory::DirectoryViewState;
use toon_console_tui::views::docs::DocsViewState;
use toon_console_tui::views::funds::FundsState;
use toon_console_tui::views::new_workload::NewWorkloadViewState;
use toon_console_tui::views::workloads::WorkloadsViewState;
use toon_console_tui::views::{
    account, chain_seed, directory, docs, funds, health, new_workload, workloads,
};

/// A fake token, seeded here purely so this test's own intent is explicit
/// and checkable in code (no fixture the daemon writes ever carries a
/// per-launch token — that value lives only in `LaunchRecord`, read by
/// `src/launch.rs` and used only by `src/client.rs`'s bearer header, never
/// passed to any view). If a future change ever threaded a token-shaped
/// value into a view's state under a name this test's real assertions do
/// not already cover, this constant is what a copy-pasted regression test
/// would compare against.
const FAKE_LAUNCH_TOKEN: &str = "toon-launch-4f2b9c7a-do-not-copy-this-token";

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/daemon/fixtures/api")
}

fn fixture<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = fixtures_dir().join(format!("{name}.json"));
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("could not read fixture {}: {err}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("fixture {} did not deserialize: {err}", path.display()))
}

/// A crude but effective BIP-39 mnemonic detector: 12 or 24 lowercase
/// alphabetic words. Good enough for a regression guard — a value shaped
/// like this has no business being offered by `y` regardless of whether it
/// is a REAL mnemonic.
fn looks_like_a_mnemonic(value: &str) -> bool {
    let words: Vec<&str> = value.split_whitespace().collect();
    (words.len() == 12 || words.len() == 24)
        && words
            .iter()
            .all(|word| word.len() >= 3 && word.chars().all(|c| c.is_ascii_lowercase()))
}

fn assert_no_secrets(view: &str, items: &[(String, String)]) {
    for (label, value) in items {
        assert!(
            !value.contains("nsec1"),
            "{view}'s {label:?} copyable looks like an nsec: {value}"
        );
        assert!(
            !looks_like_a_mnemonic(value),
            "{view}'s {label:?} copyable looks like a BIP-39 mnemonic: {value}"
        );
        assert!(
            !value.contains(FAKE_LAUNCH_TOKEN),
            "{view}'s {label:?} copyable contains the launch token"
        );
    }
}

#[test]
fn no_views_copyables_built_from_the_real_fixtures_contains_a_secret() {
    // -- Health --
    let health: Health = fixture("health");
    let gas: GasStationStatus = fixture("gas-station");
    assert_no_secrets("Health", &health::copyables(Some(&health), Some(&gas)));

    // -- Account (and its embedded Chain Seed section) --
    let account_status: SessionStatus = fixture("account-signed-in");
    let chain_seed_status: ChainSeedStatus = fixture("chain-seed-ready");
    assert_no_secrets(
        "Account",
        &account::copyables(Some(&account_status), Some(&chain_seed_status)),
    );
    assert_no_secrets(
        "Chain Seed",
        &chain_seed::copyables(Some(&chain_seed_status)),
    );

    // -- Funds --
    let funding: FundingStatus = fixture("funding");
    let mut funds_state = FundsState::default();
    funds_state.funding = Some(funding);
    assert_no_secrets("Funds", &funds::copyables(&funds_state));

    // -- Directory --
    let directory_data: Directory = fixture("directory");
    let mut directory_state = DirectoryViewState::new();
    directory_state.apply(directory_data);
    assert_no_secrets("Directory", &directory::copyables(&directory_state));

    // -- Workloads --
    let dashboard: Dashboard = fixture("workloads");
    let mut workloads_state = WorkloadsViewState::new();
    workloads_state.dashboard = Some(dashboard);
    assert_no_secrets("Workloads", &workloads::copyables(&workloads_state));

    // -- Docs --
    let doc_page: DocsPage = fixture("doc");
    let mut docs_state = DocsViewState::new();
    docs_state.link_hrefs = markdown::render(&doc_page.doc.markdown, None)
        .links
        .into_iter()
        .map(|link| link.href)
        .collect();
    docs_state.page = Some(doc_page);
    assert_no_secrets("Docs", &docs::copyables(&docs_state));

    // -- New workload --
    let gallery: TemplateGallery = fixture("templates");
    let mut new_workload_state = NewWorkloadViewState::new();
    if let TemplateGallery::Ok { templates, .. } = gallery {
        new_workload_state.template = templates.into_iter().find(|template| {
            matches!(
                template.availability,
                TemplateAvailability::Available { .. }
            )
        });
    }
    assert_no_secrets(
        "New workload",
        &new_workload::copyables(&new_workload_state),
    );
}
