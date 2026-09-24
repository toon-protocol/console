//! Every daemon call the TUI makes for an account, a Chain Seed, funds, a
//! Template or a workload — one function per route, each the exact path,
//! verb and body `main.rs` sends when the matching `app::Command` arrives.
//!
//! `main.rs` wraps each of these in a `tokio::spawn` that turns the answer
//! into a `RuntimeEvent`; `tests/smoke.rs` (TOON_Network#149) calls them
//! directly against a live daemon. Keeping the route here, once, is what makes
//! that smoke a proof of the TUI rather than of a second client that happens
//! to spell the same URLs.
//!
//! Nothing here holds state or retries: `DaemonClient` owns the token and the
//! one 401-then-reread retry.

use serde::Serialize;

use crate::client::{ClientError, DaemonClient};
use crate::types::{
    BunkerSignerRequest, ChainSeedStatus, Dashboard, Directory, DirectoryFilters,
    ExpandTemplateRequest, ExpandedTemplate, ExtendResult, FundingStatus, GasPurchase, GasQuote,
    GasStationStatus, GatewayView, HandoverResult, Health, ImportChainSeedRequest,
    LocalSignerRequest, PreflightView, ProfileEndpointsRequest, ProfileSwitchRequest, Profiles,
    RotationResult, RotationView, SessionStatus, SignInRequest, SpawnRequestBody, SpawnResult,
    StandbySetPreflightView, StandbySetRequestBody, StandbySetResult, TemplateGallery,
    TemplatePublishPreview, TemplatePublishRequestBody, TemplatePublishResult,
    TemplateSpawnRequestBody, TerminateResult, WithdrawalResult, WorkloadCard,
};
use crate::views::directory::directory_query;

type Answer<T> = Result<T, ClientError>;

// -- Health and profiles ------------------------------------------------------

/// `GET /api/health` — `Command::RefreshHealth`.
pub async fn health(client: &DaemonClient) -> Answer<Health> {
    client.get("/api/health").await
}

/// `GET /api/profiles`, read on connect.
pub async fn profiles(client: &DaemonClient) -> Answer<Profiles> {
    client.get("/api/profiles").await
}

/// `POST /api/profiles/active` — `Command::SwitchProfile`.
pub async fn switch_profile(client: &DaemonClient, id: String) -> Answer<Profiles> {
    client
        .post("/api/profiles/active", &ProfileSwitchRequest { id })
        .await
}

/// `PUT /api/profiles/<id>` (TOON_Network#150) — `Command::SaveProfile`:
/// overrides a subset of a built-in's endpoints, or adds a profile under a
/// new id. Answers the updated profile list, same as `profiles` above.
pub async fn save_profile(
    client: &DaemonClient,
    id: &str,
    body: &ProfileEndpointsRequest,
) -> Answer<Profiles> {
    client
        .put(&format!("/api/profiles/{}", encode_path_segment(id)), body)
        .await
}

/// `DELETE /api/profiles/<id>` — `Command::ResetProfile`: resets a
/// built-in's override, or removes a profile added under a new id (refused
/// by the daemon while it is active).
pub async fn reset_profile(client: &DaemonClient, id: &str) -> Answer<Profiles> {
    client
        .delete(&format!("/api/profiles/{}", encode_path_segment(id)))
        .await
}

// -- Account (TOON_Network#141) -------------------------------------------------

/// `GET /api/account` — `Command::RefreshAccount`.
pub async fn account(client: &DaemonClient) -> Answer<SessionStatus> {
    client.get("/api/account").await
}

/// `POST /api/account/signers/local` — `Command::AddLocalSigner`.
pub async fn add_local_signer(
    client: &DaemonClient,
    request: &LocalSignerRequest,
) -> Answer<SessionStatus> {
    client.post("/api/account/signers/local", request).await
}

/// `POST /api/account/signers/bunker` — `Command::AddBunkerSigner`.
pub async fn add_bunker_signer(
    client: &DaemonClient,
    request: &BunkerSignerRequest,
) -> Answer<SessionStatus> {
    client.post("/api/account/signers/bunker", request).await
}

/// `POST /api/account/signin` — `Command::SignIn`, with a saved signer.
pub async fn sign_in(client: &DaemonClient, request: &SignInRequest) -> Answer<SessionStatus> {
    client.post("/api/account/signin", request).await
}

/// `POST /api/account/signout` — `Command::SignOut`.
pub async fn sign_out(client: &DaemonClient) -> Answer<SessionStatus> {
    client.post_empty("/api/account/signout").await
}

/// `DELETE /api/account/signers/<id>` — `Command::ForgetSigner`.
pub async fn forget_signer(client: &DaemonClient, id: &str) -> Answer<SessionStatus> {
    client
        .delete(&format!("/api/account/signers/{}", encode_path_segment(id)))
        .await
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

// -- Chain Seed (TOON_Network#142) ----------------------------------------------

/// `GET /api/chain-seed`.
pub async fn chain_seed(client: &DaemonClient) -> Answer<ChainSeedStatus> {
    client.get("/api/chain-seed").await
}

/// `POST /api/chain-seed/acknowledge` — `Command::AcknowledgeChainSeedWarning`.
pub async fn acknowledge_chain_seed_warning(client: &DaemonClient) -> Answer<ChainSeedStatus> {
    client.post_empty("/api/chain-seed/acknowledge").await
}

/// `POST /api/chain-seed/mint` — `Command::MintChainSeed`. Answers
/// `not_yet_recoverable`: minting never publishes on its own (#120).
pub async fn mint_chain_seed(client: &DaemonClient) -> Answer<ChainSeedStatus> {
    client.post_empty("/api/chain-seed/mint").await
}

/// `POST /api/chain-seed/refresh` — `Command::RefreshChainSeed`. Free.
pub async fn refresh_chain_seed(client: &DaemonClient) -> Answer<ChainSeedStatus> {
    client.post_empty("/api/chain-seed/refresh").await
}

/// `POST /api/chain-seed/import` — `Command::ImportChainSeed`.
pub async fn import_chain_seed(client: &DaemonClient, mnemonic: String) -> Answer<ChainSeedStatus> {
    client
        .post(
            "/api/chain-seed/import",
            &ImportChainSeedRequest { mnemonic },
        )
        .await
}

/// `POST /api/chain-seed/publish` — `Command::PublishChainSeed`. **Spends**:
/// one paid relay write.
pub async fn publish_chain_seed(client: &DaemonClient) -> Answer<ChainSeedStatus> {
    client.post_empty("/api/chain-seed/publish").await
}

// -- Funds (TOON_Network#147) ---------------------------------------------------

/// `GET /api/funding` — `Command::FetchFunding`. `refresh` is the daemon's
/// own `?refresh=1`.
pub async fn funding(client: &DaemonClient, refresh: bool) -> Answer<FundingStatus> {
    client
        .get(if refresh {
            "/api/funding?refresh=1"
        } else {
            "/api/funding"
        })
        .await
}

/// `GET /api/funding?connector=<url>` (TOON_Network#138) — the funding read
/// scoped to a connector that is not necessarily the profile's own: what New
/// workload's Preflight stage asks for once a preflight's `payment` names a
/// connector with no bound channel yet (`views::new_workload`'s `o`, "open a
/// channel with this connector"). Answers the same `FundingStatus` shape
/// `funding` above reads for the profile's own connector — the daemon's
/// `FundingStore#status` treats a named connector exactly like the profile's
/// own (`packages/daemon/src/funding.ts`'s `#target`), so one Rust type
/// serves both.
pub async fn funding_for_connector(
    client: &DaemonClient,
    connector: &str,
) -> Answer<FundingStatus> {
    client
        .get(&format!(
            "/api/funding?connector={}",
            encode_path_segment(connector)
        ))
        .await
}

#[derive(Serialize)]
struct OpenChannelBody {
    chain: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    deposit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connector: Option<String>,
}

/// `POST /api/funding/channel` — `Command::OpenChannel`. **Spends** chain gas
/// and locks collateral.
pub async fn open_channel(
    client: &DaemonClient,
    chain: String,
    deposit: Option<String>,
    connector: Option<String>,
) -> Answer<FundingStatus> {
    client
        .post(
            "/api/funding/channel",
            &OpenChannelBody {
                chain,
                deposit,
                connector,
            },
        )
        .await
}

/// `GET /api/funding/gas` — `Command::FetchGasStation`.
pub async fn gas_station(client: &DaemonClient) -> Answer<GasStationStatus> {
    client.get("/api/funding/gas").await
}

#[derive(Serialize)]
struct ChainBody {
    chain: String,
}

/// `POST /api/funding/faucet` — `Command::Drip`. Devnet-only, and free.
pub async fn drip(client: &DaemonClient, chain: String) -> Answer<FundingStatus> {
    client
        .post("/api/funding/faucet", &ChainBody { chain })
        .await
}

/// `POST /api/funding/gas/quote` — `Command::QuoteGas`. Free: a quote spends
/// nothing on its own.
pub async fn quote_gas(client: &DaemonClient, chain: String) -> Answer<GasQuote> {
    client
        .post("/api/funding/gas/quote", &ChainBody { chain })
        .await
}

#[derive(Serialize)]
struct BuyGasBody {
    chain: String,
    #[serde(rename = "quoteId")]
    quote_id: String,
}

/// `POST /api/funding/gas/buy` — `Command::BuyGas`. **Spends**, naming the
/// exact quote a confirmation was already shown for.
pub async fn buy_gas(
    client: &DaemonClient,
    chain: String,
    quote_id: String,
) -> Answer<GasPurchase> {
    client
        .post("/api/funding/gas/buy", &BuyGasBody { chain, quote_id })
        .await
}

// -- Directory and Templates (TOON_Network#145, #146) ----------------------------

/// `GET /api/directory` with the Directory view's filters —
/// `Command::RefreshDirectory`.
pub async fn directory(client: &DaemonClient, filters: &DirectoryFilters) -> Answer<Directory> {
    client
        .get(&format!("/api/directory{}", directory_query(filters)))
        .await
}

/// `GET /api/templates` — `Command::RefreshTemplates`.
pub async fn templates(client: &DaemonClient) -> Answer<TemplateGallery> {
    client.get("/api/templates").await
}

/// `POST /api/templates/expand` — `Command::ExpandTemplate`. Free.
pub async fn expand_template(
    client: &DaemonClient,
    request: &ExpandTemplateRequest,
) -> Answer<ExpandedTemplate> {
    client.post("/api/templates/expand", request).await
}

/// `POST /api/templates/publish/preview` — `Command::PreviewTemplatePublish`
/// (TOON_Network#138). Free: it answers the two events, their addresses and
/// the writer's own quote, and sends nothing to any relay.
pub async fn preview_template_publish(
    client: &DaemonClient,
    request: &TemplatePublishRequestBody,
) -> Answer<TemplatePublishPreview> {
    client.post("/api/templates/publish/preview", request).await
}

/// `POST /api/templates/publish` — `Command::PublishTemplate`. **Spends**:
/// two paid relay writes, signed by the session's own `ConsoleSigner` and
/// paid from the account's existing relay channel — the same way
/// `publish_chain_seed` above does.
pub async fn publish_template(
    client: &DaemonClient,
    request: &TemplatePublishRequestBody,
) -> Answer<TemplatePublishResult> {
    client.post("/api/templates/publish", request).await
}

/// `POST /api/leases/preflight` — `Command::PreflightSpawn`. Free.
pub async fn preflight_spawn(
    client: &DaemonClient,
    request: &SpawnRequestBody,
) -> Answer<PreflightView> {
    client.post("/api/leases/preflight", request).await
}

/// `POST /api/templates/spawn` — `Command::SpawnFromTemplate`. **Spends**
/// one Lease Interval. The route that records the Template on the lease; see
/// [`TemplateSpawnRequestBody`].
pub async fn spawn_from_template(
    client: &DaemonClient,
    request: &TemplateSpawnRequestBody,
) -> Answer<SpawnResult> {
    client.post("/api/templates/spawn", request).await
}

/// `POST /api/leases/standby-set/preflight` — `Command::PreflightStandbySet`.
/// Free; prices every member of the set (spec §7).
pub async fn preflight_standby_set(
    client: &DaemonClient,
    request: &StandbySetRequestBody,
) -> Answer<StandbySetPreflightView> {
    client
        .post("/api/leases/standby-set/preflight", request)
        .await
}

/// `POST /api/leases/standby-set` — `Command::SpawnStandbySet`. **Spends** at
/// every member (ADR 0003).
pub async fn spawn_standby_set(
    client: &DaemonClient,
    request: &StandbySetRequestBody,
) -> Answer<StandbySetResult> {
    client.post("/api/leases/standby-set", request).await
}

// -- Workloads (TOON_Network#143, #144) -----------------------------------------

/// A workload id is 64 lowercase hex characters (never `/`, `?`, `&`, ...),
/// so this only ever needs to be a defensive no-op — but it is the same
/// belt-and-suspenders the web client applies with `encodeURIComponent`
/// before building the same route.
fn workload_path(workload_id: &str, rest: &str) -> String {
    let id: String = workload_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    format!("/api/workloads/{id}{rest}")
}

/// `GET /api/workloads` — `Command::RefreshWorkloads` and the 30-second poll.
/// `refresh` asks the daemon to read every provider (`?refresh=1`).
pub async fn workloads(client: &DaemonClient, refresh: bool) -> Answer<Dashboard> {
    client
        .get(if refresh {
            "/api/workloads?refresh=1"
        } else {
            "/api/workloads"
        })
        .await
}

#[derive(Serialize)]
struct ExtendBody {
    #[serde(rename = "maxPrice", skip_serializing_if = "Option::is_none")]
    max_price: Option<String>,
}

/// `POST …/extend` — `Command::ExtendWorkload`. **Spends** one interval.
pub async fn extend(
    client: &DaemonClient,
    workload_id: &str,
    max_price: Option<String>,
) -> Answer<ExtendResult> {
    client
        .post(
            &workload_path(workload_id, "/extend"),
            &ExtendBody { max_price },
        )
        .await
}

/// `POST …/terminate` — `Command::TerminateWorkload`. Free, and final.
pub async fn terminate(client: &DaemonClient, workload_id: &str) -> Answer<TerminateResult> {
    client
        .post(
            &workload_path(workload_id, "/terminate"),
            &serde_json::json!({}),
        )
        .await
}

#[derive(Serialize)]
struct ArmAutoExtendBody {
    budget: String,
    #[serde(rename = "agreedPrice")]
    agreed_price: String,
    confirm: bool,
}

/// `POST …/auto-extend` with `confirm: true` — `Command::ArmAutoExtend`.
/// **Spends** with nobody present, inside `budget`.
pub async fn arm_auto_extend(
    client: &DaemonClient,
    workload_id: &str,
    budget: String,
    agreed_price: String,
) -> Answer<WorkloadCard> {
    client
        .post(
            &workload_path(workload_id, "/auto-extend"),
            &ArmAutoExtendBody {
                budget,
                agreed_price,
                confirm: true,
            },
        )
        .await
}

/// `DELETE …/auto-extend` — `Command::DisarmAutoExtend`.
pub async fn disarm_auto_extend(client: &DaemonClient, workload_id: &str) -> Answer<WorkloadCard> {
    client
        .delete(&workload_path(workload_id, "/auto-extend"))
        .await
}

/// `POST …/rotate` — `Command::RotateWorkload`.
pub async fn rotate(client: &DaemonClient, workload_id: &str) -> Answer<RotationResult> {
    client
        .post(
            &workload_path(workload_id, "/rotate"),
            &serde_json::json!({}),
        )
        .await
}

/// `GET …/rotation`, read for the selected workload.
pub async fn rotation(client: &DaemonClient, workload_id: &str) -> Answer<RotationView> {
    client.get(&workload_path(workload_id, "/rotation")).await
}

/// `POST …/gateway/handover` — `Command::HandOverWorkload`. An empty body
/// asks for the daemon's own default grant length.
pub async fn handover(client: &DaemonClient, workload_id: &str) -> Answer<HandoverResult> {
    client
        .post(
            &workload_path(workload_id, "/gateway/handover"),
            &serde_json::json!({}),
        )
        .await
}

/// `POST …/gateway/withdraw` — `Command::WithdrawWorkload`.
pub async fn withdraw(client: &DaemonClient, workload_id: &str) -> Answer<WithdrawalResult> {
    client
        .post(
            &workload_path(workload_id, "/gateway/withdraw"),
            &serde_json::json!({}),
        )
        .await
}

/// `GET …/gateway`, read for the selected workload.
pub async fn gateway(client: &DaemonClient, workload_id: &str) -> Answer<GatewayView> {
    client.get(&workload_path(workload_id, "/gateway")).await
}

#[cfg(test)]
mod tests {
    use super::{encode_path_segment, workload_path};

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

    #[test]
    fn a_workload_id_cannot_smuggle_a_path_or_a_query_into_the_route() {
        assert_eq!(
            workload_path("ab/../c?d=1", "/extend"),
            "/api/workloads/abcd1/extend"
        );
    }
}
