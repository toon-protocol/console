//! API types, hand-kept in step with `packages/ui/src/lib/daemon.ts`.
//!
//! ADR 0028 accepts a second copy of the API's types as the cost of Rust: the
//! daemon builds for Node and this binary does not want its runtime. What
//! keeps the two copies honest is not a shared import, it's a test —
//! `tests/fixture_contract.rs` deserializes every fixture the daemon's own API
//! tests write to `packages/daemon/fixtures/api/*.json` into the type named
//! for it below. A field renamed, added or removed on one side and not the
//! other fails that test instead of showing up as a blank card.
//!
//! Only the types the shipped views need are here. A later ticket adding a
//! view adds its own types beside these, in this same module.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DaemonInfo {
    pub name: String,
    pub version: String,
    pub node: String,
    pub pid: i64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProfileRpc {
    pub evm: Option<String>,
    pub solana: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProfileView {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    #[serde(rename = "relayUrl")]
    pub relay_url: String,
    #[serde(rename = "gatewayDomain")]
    pub gateway_domain: String,
    #[serde(rename = "gatewayConnectorUrl")]
    pub gateway_connector_url: String,
    /// The gas station's own connector (TOON_Network#119, #150) — present on
    /// every `ProfileView` the daemon has ever answered, but only worth
    /// showing (and overriding) from TOON_Network#150's network editor on.
    #[serde(rename = "gasConnectorUrl")]
    #[serde(default)]
    pub gas_connector_url: String,
    #[serde(rename = "faucetUrl")]
    #[serde(default)]
    pub faucet_url: Option<String>,
    #[serde(default)]
    pub rpc: Option<ProfileRpc>,
    pub origin: String,
    pub configured: bool,
    pub active: bool,
    /// Which endpoint fields a person has overridden (or, for a profile with
    /// no built-in, simply set) — `"connectorUrl"`, `"rpc.evm"`, etc. Empty
    /// for a built-in nobody has touched (TOON_Network#150).
    #[serde(rename = "overriddenFields")]
    #[serde(default)]
    pub overridden_fields: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SettlementView {
    pub chain: String,
    pub kind: String,
    #[serde(rename = "settlementAddress")]
    pub settlement_address: String,
    #[serde(rename = "tokenAddress")]
    pub token_address: String,
    pub decimals: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RouteView {
    pub prefix: String,
    pub price: String,
    #[serde(rename = "pricePerKib")]
    #[serde(default)]
    pub price_per_kib: Option<String>,
}

/// `ConnectorHealth` in `daemon.ts` — a discriminated union on `state`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ConnectorHealth {
    #[serde(rename = "unconfigured")]
    Unconfigured { reason: String },
    #[serde(rename = "unreachable")]
    Unreachable { endpoint: String, reason: String },
    #[serde(rename = "ok")]
    Ok {
        endpoint: String,
        #[serde(rename = "selfEndpoint")]
        self_endpoint: String,
        #[serde(rename = "ilpAddresses")]
        ilp_addresses: Vec<String>,
        settlements: Vec<SettlementView>,
        routes: Vec<RouteView>,
        #[serde(rename = "peerCarriages")]
        peer_carriages: Vec<String>,
        #[serde(rename = "edgeKeyId")]
        #[serde(default)]
        edge_key_id: Option<String>,
        #[serde(rename = "supportedVersions")]
        supported_versions: Vec<i64>,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AnonTransportView {
    /// `"unconfigured" | "ready" | "unreachable" | "misconfigured"` in
    /// `daemon.ts`. Kept as a `String` rather than an enum: the Health view
    /// only ever compares it or prints it, and an unknown fifth state must
    /// render (as itself) rather than fail to deserialize.
    pub state: String,
    #[serde(rename = "socksProxy")]
    #[serde(default)]
    pub socks_proxy: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct StorageView {
    pub data: String,
    pub config: String,
    pub runtime: String,
    pub channels: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Health {
    pub daemon: DaemonInfo,
    pub profile: ProfileView,
    pub connector: ConnectorHealth,
    #[serde(default)]
    pub anon: Option<AnonTransportView>,
    pub storage: StorageView,
    #[serde(rename = "checkedAt")]
    pub checked_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Profiles {
    #[serde(rename = "activeId")]
    pub active_id: String,
    pub profiles: Vec<ProfileView>,
}

/// `MenuView` in `daemon.ts`: what an Omarchy menu entry, or a `--view` flag,
/// asks the shell to switch to.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MenuView {
    Workloads,
    NewWorkload,
    Funds,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ThemeReading {
    pub source: String,
    pub name: String,
    pub mode: String,
    pub revision: String,
    pub css: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DesktopView {
    pub seq: i64,
    pub theme: ThemeReading,
    #[serde(default)]
    pub open: Option<MenuView>,
    #[serde(rename = "openedAt")]
    #[serde(default)]
    pub opened_at: Option<String>,
    pub at: String,
}

/// The Provider Directory (TOON_Network#91, #145), a mirror of the same
/// fields `packages/ui/src/lib/daemon.ts` keeps for it. `Directory`'s fixture
/// is written by `packages/daemon/src/directory.test.ts`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct DirectoryFilters {
    #[serde(default)]
    pub isolation: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    /// A `<vendor>-<model>` label, or `any` for "some GPU".
    #[serde(default)]
    pub gpu: Option<String>,
    /// Every one of these must be granted, not any of them.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Unset shows Hidden Providers alongside the rest.
    #[serde(default)]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SettlementTerm {
    pub chain: String,
    pub token: String,
    pub decimals: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProviderProfileView {
    #[serde(rename = "ilpAddress")]
    pub ilp_address: String,
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    #[serde(rename = "connectorSealKey")]
    pub connector_seal_key: String,
    /// The provider's own Relay Set (spec §4), verbatim.
    pub relays: Vec<String>,
    pub settlement: Vec<SettlementTerm>,
    pub isolation: String,
    pub hidden: bool,
    /// Absent for a Hidden Provider, which MUST NOT publish one (§4.1, §10).
    #[serde(default)]
    pub host: Option<String>,
    #[serde(rename = "livenessCadenceSeconds")]
    #[serde(default)]
    pub liveness_cadence_seconds: Option<i64>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ListingResources {
    #[serde(rename = "cpuMillicores")]
    pub cpu_millicores: i64,
    #[serde(rename = "memoryMb")]
    pub memory_mb: i64,
    #[serde(rename = "storageGb")]
    pub storage_gb: i64,
    /// One device of this model, when the tier sells a GPU (§4.2).
    #[serde(default)]
    pub gpu: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ListingView {
    /// The `d` tag: the provider's own name for the tier, stable across versions.
    pub name: String,
    /// `30432:<pubkey>:<name>` — what a spawn will name (§6.1).
    pub address: String,
    pub version: i64,
    pub resources: ListingResources,
    pub arch: String,
    pub isolation: String,
    pub hidden: bool,
    #[serde(rename = "leaseIntervalSeconds")]
    pub lease_interval_seconds: i64,
    /// µUSDC for one Lease Interval.
    pub price: i64,
    /// µUSDC per interval for a Warm Standby; absent means this tier sells none.
    #[serde(rename = "standbyPrice")]
    #[serde(default)]
    pub standby_price: Option<i64>,
    /// Granted by the Listing alone, verbatim from its content.
    pub capabilities: Vec<String>,
    /// Those §4.4 has not specified: shown, never read as a known one.
    #[serde(rename = "unspecifiedCapabilities")]
    pub unspecified_capabilities: Vec<String>,
    #[serde(default)]
    pub geohash: Option<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    /// How many leases of this tier the provider says could start now (§4.3).
    #[serde(default)]
    pub available: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LivenessView {
    /// `"live" | "stale" | "unknown"` — kept as a `String`, same reasoning as
    /// `AnonTransportView::state` above: this view recomputes it against the
    /// wall clock (`views::directory::liveness_now`) rather than trusting a
    /// value that ages the moment the daemon sends it, so an unrecognised
    /// fifth state must still render rather than fail to deserialize.
    pub state: String,
    #[serde(rename = "publishedAt")]
    #[serde(default)]
    pub published_at: Option<String>,
    /// The moment it stops being true, from its own `expiration` tag (§4.3).
    #[serde(rename = "expiresAt")]
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(rename = "secondsUntilExpiry")]
    #[serde(default)]
    pub seconds_until_expiry: Option<i64>,
    #[serde(rename = "cadenceSeconds")]
    #[serde(default)]
    pub cadence_seconds: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RejectedListing {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProviderView {
    pub pubkey: String,
    pub profile: ProviderProfileView,
    pub liveness: LivenessView,
    /// Current, purchasable Listings, cheapest first.
    pub listings: Vec<ListingView>,
    #[serde(rename = "relaysRead")]
    pub relays_read: Vec<String>,
    /// Older Listing versions seen and set aside, so supersession is visible.
    #[serde(rename = "supersededListings")]
    pub superseded_listings: i64,
    /// Listings dropped as unpurchasable, and why (§4.2, §4.4).
    #[serde(rename = "rejectedListings")]
    pub rejected_listings: Vec<RejectedListing>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DirectoryRelayOutcome {
    pub url: String,
    pub state: String,
    pub events: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

/// The docs (TOON_Network#102, #148), mirroring `DocsIndex`/`DocsPage` in
/// `packages/daemon/src/docs.ts` and `packages/ui/src/lib/daemon.ts`.
///
/// `source` on each summary and on the opened article is the field the Docs
/// view exists to show: `"relays"` for a published NIP-23 article, `"bundled"`
/// for the Markdown this console shipped with. `fallback`, when present, is
/// already the sentence to put above the page — see `docs.ts`'s doc comment
/// for why it is prose rather than a code the view would have to translate.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DocsAuthorView {
    pub npub: String,
    pub pubkey: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RelayOutcome {
    pub url: String,
    pub state: String,
    pub events: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DirectoryRelays {
    pub seed: Vec<String>,
    pub read: Vec<DirectoryRelayOutcome>,
}

/// `Directory` in `daemon.ts` — a discriminated union on `state`, same
/// pattern as `ConnectorHealth` above.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "state")]
pub enum Directory {
    #[serde(rename = "ok")]
    Ok {
        relays: DirectoryRelays,
        filters: DirectoryFilters,
        providers: Vec<ProviderView>,
        /// Listings found whose Provider Profile was on no relay read (§4.2).
        #[serde(rename = "listingsWithoutProfile")]
        listings_without_profile: i64,
        /// Events a relay served that were not their author's.
        #[serde(rename = "rejectedEvents")]
        rejected_events: i64,
        #[serde(rename = "readAt")]
        read_at: String,
    },
    #[serde(rename = "unconfigured")]
    Unconfigured { reason: String },
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DocSummary {
    pub d: String,
    pub title: String,
    pub summary: String,
    pub order: i64,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// `"relays" | "bundled"`.
    pub source: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(rename = "updatedAt")]
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// `doc` on `DocsPage` — NOT `DocSummary` plus `markdown`, on purpose.
///
/// This is a straight mirror of `DocArticle` in `packages/daemon/src/
/// docs-article.ts`, the type `DocsStore#page` actually returns for `doc`
/// (`docs.ts`'s own `DocArticle extends DocSummary` is what the ROUTE'S
/// TYPE claims; the object it hands back is the lower-level one, which has
/// no `order` and an `updatedAt` that is a Unix seconds count, not the ISO
/// string `DocSummary.updatedAt` is elsewhere in this same response). The
/// fixture contract catches either side drifting from what ships.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DocArticle {
    pub d: String,
    pub title: String,
    pub summary: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub markdown: String,
    /// `"relays" | "bundled"`.
    pub source: String,
    #[serde(rename = "eventId")]
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(rename = "updatedAt")]
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub pubkey: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DocsIndex {
    #[serde(default)]
    pub author: Option<DocsAuthorView>,
    pub relays: Vec<String>,
    #[serde(default)]
    pub read: Vec<RelayOutcome>,
    #[serde(default)]
    pub fallback: Option<String>,
    pub docs: Vec<DocSummary>,
    #[serde(rename = "readAt")]
    pub read_at: String,
}

/// Who is signed in (TOON_Network#141), a mirror of `SessionStatus` and its
/// neighbours in `daemon.ts`. `AccountSession.status()` in the daemon is the
/// one place these are produced.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignerKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeystoreBackend {
    Libsecret,
    File,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignerOrigin {
    Generated,
    Nsec,
    Nip06,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SignerRecord {
    pub id: String,
    pub kind: SignerKind,
    pub label: String,
    pub pubkey: String,
    pub npub: String,
    pub backend: KeystoreBackend,
    #[serde(default)]
    pub origin: Option<SignerOrigin>,
    #[serde(rename = "bunkerRelays")]
    #[serde(default)]
    pub bunker_relays: Option<Vec<String>>,
    #[serde(rename = "bunkerPubkey")]
    #[serde(default)]
    pub bunker_pubkey: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastUsedAt")]
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
pub struct AccountMetadata {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "displayName")]
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
    #[serde(default)]
    pub nip05: Option<String>,
    #[serde(rename = "publishedAt")]
    #[serde(default)]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RelaySource {
    Nip65,
    Profile,
    None,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AccountProfile {
    #[serde(default)]
    pub metadata: Option<AccountMetadata>,
    pub relays: Vec<String>,
    #[serde(rename = "relaySource")]
    pub relay_source: RelaySource,
    #[serde(rename = "readAt")]
    pub read_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct DocsPage {
    #[serde(flatten)]
    pub index: DocsIndex,
    pub doc: DocArticle,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileState {
    Loading,
    Ready,
    None,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AccountView {
    pub pubkey: String,
    pub npub: String,
    #[serde(rename = "signerId")]
    pub signer_id: String,
    #[serde(rename = "signerKind")]
    pub signer_kind: SignerKind,
    #[serde(rename = "signerLabel")]
    pub signer_label: String,
    #[serde(rename = "signedInAt")]
    pub signed_in_at: String,
    #[serde(rename = "profileState")]
    pub profile_state: ProfileState,
    #[serde(default)]
    pub profile: Option<AccountProfile>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InvitationState {
    Waiting,
    Failed,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Invitation {
    pub uri: String,
    pub state: InvitationState,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct KeystoreInfo {
    pub backend: KeystoreBackend,
    pub location: String,
    #[serde(rename = "needsPassphrase")]
    pub needs_passphrase: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SessionStatus {
    #[serde(rename = "signedIn")]
    pub signed_in: bool,
    #[serde(default)]
    pub account: Option<AccountView>,
    pub signers: Vec<SignerRecord>,
    pub keystore: KeystoreInfo,
    #[serde(default)]
    pub invitation: Option<Invitation>,
}

/// The daemon's `POST /api/account/signers/local` body. `mode` picks which
/// of `nsec`/`mnemonic` (if either) it reads; the daemon ignores fields that
/// do not apply to the chosen mode, the same as `daemon.ts`'s
/// `LocalSignerRequest`.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LocalSignerMode {
    #[default]
    Generate,
    Nsec,
    Nip06,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct LocalSignerRequest {
    pub mode: LocalSignerMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mnemonic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct BunkerSignerRequest {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct SignInRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct ProfileSwitchRequest {
    pub id: String,
}

/// `PUT /api/profiles/<id>`'s body (TOON_Network#150) — every field the
/// whole override for this call (a field left out falls through to the
/// built-in, or stays unset for an added profile), mirroring
/// `profile-store.ts`'s `ProfileEndpointsInput`. `views::network` builds one
/// of these from whichever of its `TextField`s are non-empty.
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq)]
pub struct ProfileEndpointsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "connectorUrl")]
    pub connector_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "relayUrl")]
    pub relay_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gatewayDomain")]
    pub gateway_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gatewayConnectorUrl")]
    pub gateway_connector_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "gasConnectorUrl")]
    pub gas_connector_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "faucetUrl")]
    pub faucet_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc: Option<ProfileRpcRequest>,
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq)]
pub struct ProfileRpcRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana: Option<String>,
}

/// A `PUT /api/profiles/<id>` 400 or 409 — `problem()` in `api.ts`'s own
/// shape. `errors` is per-field (`"connectorUrl"`, `"rpc.evm"`, ...) and
/// absent (default: empty) on a 409 "this is the active profile" refusal,
/// which is about the id, not a field.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ProfileEndpointsError {
    pub error: String,
    pub message: String,
    #[serde(default)]
    pub errors: std::collections::HashMap<String, String>,
}

/* -------------------------------------------------------------------------- */
/* Funds: deposits, gas, balances and payment channels (TOON_Network#90,147). */
/* -------------------------------------------------------------------------- */
//
// Mirrors the "Funding" section of `packages/ui/src/lib/daemon.ts` field for
// field. A closed-vocabulary discriminator that this module only ever
// compares or prints (`FundingStatus::state`, `ChannelView::phase`,
// `GasBuyChain::verdict`, ...) is kept as a `String`, matching
// `AnonTransportView::state` above — an unknown value must still render as
// itself rather than fail the whole view to deserialize.

/// Shared between Funds (a deposit address) and Chain Seed (an EVM/Solana
/// address derived from it, TOON_Network#142) — same shape either way: an
/// address plus the BIP-44 path it was derived at.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChainAddress {
    pub address: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Amount {
    /// Base units, as a decimal string. Big enough to need one.
    pub amount: String,
    #[serde(default)]
    pub decimals: Option<i64>,
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct BalanceView {
    /// `"unknown" | "read"`. `unknown` carries no figures at all — never a
    /// zero standing in for a chain that could not be read.
    pub state: String,
    #[serde(default)]
    pub native: Option<Amount>,
    #[serde(default)]
    pub token: Option<Amount>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "readAt")]
    #[serde(default)]
    pub read_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasView {
    /// `"unknown" | "none" | "present"` — neither "you are fine" nor "you
    /// are stuck" is the same as not knowing.
    pub verdict: String,
    #[serde(default)]
    pub symbol: Option<String>,
    pub headline: String,
    pub detail: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(rename = "faucetGivesGas")]
    pub faucet_gives_gas: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChannelView {
    /// `"none" | "opening" | "open" | "closing" | "settled" | "failed"`.
    /// `opening` is neither open nor failed: a transaction is in flight.
    pub phase: String,
    #[serde(rename = "channelId")]
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub deposit: Option<String>,
    #[serde(default)]
    pub spent: Option<String>,
    #[serde(default)]
    pub available: Option<String>,
    #[serde(default)]
    pub nonce: Option<i64>,
    #[serde(rename = "openedAt")]
    #[serde(default)]
    pub opened_at: Option<String>,
    #[serde(rename = "startedAt")]
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(rename = "txHash")]
    #[serde(default)]
    pub tx_hash: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "outOfGas")]
    #[serde(default)]
    pub out_of_gas: Option<bool>,
    #[serde(rename = "watermarkUncertain")]
    #[serde(default)]
    pub watermark_uncertain: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TokenRef {
    pub address: String,
    pub decimals: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RpcRef {
    pub url: String,
    /// `"profile" | "client-default"`.
    pub source: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChainFundingView {
    /// `evm:84532`, or `solana` — the connector's own word for it.
    pub chain: String,
    /// `"evm" | "solana"`.
    pub kind: String,
    pub counterparty: String,
    pub token: TokenRef,
    pub deposit: ChainAddress,
    pub rpc: RpcRef,
    pub balances: BalanceView,
    pub gas: GasView,
    pub channel: ChannelView,
    #[serde(rename = "canOpen")]
    pub can_open: bool,
    #[serde(rename = "blockedBy")]
    #[serde(default)]
    pub blocked_by: Option<String>,
    #[serde(rename = "suggestedDeposit")]
    #[serde(default)]
    pub suggested_deposit: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct QuoteView {
    pub route: String,
    pub price: String,
    #[serde(rename = "pricePerKib")]
    #[serde(default)]
    pub price_per_kib: Option<String>,
    pub packets: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FaucetDrip {
    pub asset: String,
    pub amount: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FaucetChainView {
    /// `"evm" | "solana"`.
    pub kind: String,
    pub name: String,
    pub ready: bool,
    #[serde(default)]
    pub route: Option<String>,
    pub drips: Vec<FaucetDrip>,
    #[serde(rename = "cooldownHours")]
    #[serde(default)]
    pub cooldown_hours: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LastDrip {
    pub chain: String,
    pub at: String,
    /// `"delivered" | "refused"`.
    pub state: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FaucetView {
    pub url: String,
    /// `"unknown" | "ready" | "unreachable"`.
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub chains: Vec<FaucetChainView>,
    #[serde(rename = "givesGas")]
    pub gives_gas: bool,
    #[serde(rename = "lastDrip")]
    #[serde(default)]
    pub last_drip: Option<LastDrip>,
}

/// A Chain Seed that exists on one disk and nowhere else (#120) — the same
/// shape `FundingStatus.held_seed` and `ChainSeedStatus.held` (TOON_Network
/// #142) both carry, per `daemon.ts`'s one `HeldSeedView` interface.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct HeldSeedView {
    pub since: String,
    /// `"minted" | "imported"`.
    pub origin: String,
    pub text: String,
    pub steps: Vec<String>,
    #[serde(rename = "lastAttempt")]
    #[serde(default)]
    pub last_attempt: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FundingProfileRef {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CustodyView {
    pub text: String,
    #[serde(rename = "acknowledgedAt")]
    #[serde(default)]
    pub acknowledged_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FundingStatus {
    /// `"signed_out" | "unconfigured" | "connector_unreachable" | "no_seed"
    /// | "ready"`.
    pub state: String,
    pub profile: FundingProfileRef,
    #[serde(default)]
    pub pubkey: Option<String>,
    pub custody: CustodyView,
    #[serde(rename = "supersededSeeds")]
    pub superseded_seeds: i64,
    #[serde(rename = "heldSeed")]
    #[serde(default)]
    pub held_seed: Option<HeldSeedView>,
    #[serde(default)]
    pub chains: Vec<ChainFundingView>,
    #[serde(default)]
    pub quote: Option<QuoteView>,
    #[serde(default)]
    pub faucet: Option<FaucetView>,
    #[serde(rename = "channelStorePath")]
    #[serde(default)]
    pub channel_store_path: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "checkedAt")]
    pub checked_at: String,
}

/* -------------------------------------------------------------------------- */
/* Buying the next chain's gas at a gas station (TOON_Network#119, #147).     */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasPayer {
    /// The chain whose channel signs the claim. Never the chain being bought
    /// for.
    pub chain: String,
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[serde(default)]
    pub available: Option<String>,
    #[serde(rename = "payAt")]
    pub pay_at: String,
    /// `"station-connector" | "forwarded"`.
    pub via: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasBuyChain {
    pub chain: String,
    /// `"evm" | "solana"`.
    pub kind: String,
    /// Where bought gas would land: this account's own address on that
    /// chain.
    pub recipient: String,
    /// `"buyable" | "not_blocked" | "unsupported" | "no_station" |
    /// "station_unreachable" | "no_route" | "no_channel" | "unaffordable"`.
    pub verdict: String,
    pub reason: String,
    #[serde(default)]
    pub payer: Option<GasPayer>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub price: Option<String>,
    #[serde(default)]
    pub lamports: Option<String>,
    /// A connector to open a channel WITH, passed as `connector` to
    /// `openChannel`, when that is what stands between this account and a
    /// door the gas station publishes.
    #[serde(rename = "openChannelWith")]
    #[serde(default)]
    pub open_channel_with: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasStationView {
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    #[serde(rename = "selfEndpoint")]
    #[serde(default)]
    pub self_endpoint: Option<String>,
    pub doors: Vec<String>,
    pub reachable: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasStationStatus {
    /// `"signed_out" | "unconfigured" | "no_station" | "ready"`.
    pub state: String,
    #[serde(default)]
    pub station: Option<GasStationView>,
    #[serde(default)]
    pub chains: Vec<GasBuyChain>,
    /// Present exactly when this account holds no channel anywhere.
    #[serde(rename = "firstChannel")]
    #[serde(default)]
    pub first_channel: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "checkedAt")]
    pub checked_at: String,
}

/// One packet, and what it cost — refusals included, because they are
/// billed.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasAttempt {
    pub destination: String,
    /// `"quote" | "execute"`.
    pub phase: String,
    /// `"receipt" | "refused" | "unknown"`.
    pub outcome: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub cost: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasQuote {
    pub chain: String,
    #[serde(rename = "quoteId")]
    pub quote_id: String,
    #[serde(rename = "feePayer")]
    pub fee_payer: String,
    pub recipient: String,
    pub lamports: String,
    #[serde(rename = "maxLamports")]
    pub max_lamports: String,
    #[serde(rename = "recentBlockhash")]
    pub recent_blockhash: String,
    /// ms epoch: quote TTL and blockhash validity, merged into one deadline.
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    pub destination: String,
    #[serde(rename = "payAt")]
    pub pay_at: String,
    pub price: String,
    #[serde(default)]
    pub cost: Option<String>,
    pub attempts: Vec<GasAttempt>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GasPurchase {
    pub chain: String,
    /// `"delivered" | "refused" | "unknown"`.
    pub state: String,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub slot: Option<String>,
    #[serde(default)]
    pub lamports: Option<String>,
    pub recipient: String,
    /// The station's own closed vocabulary. Branch on this, never on
    /// `detail`.
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    pub attempts: Vec<GasAttempt>,
    #[serde(default)]
    pub cost: Option<String>,
    pub at: String,
}

/* -------------------------------------------------------------------------- */
/* Workloads (TOON_Network#143), mirroring the dashboard types in             */
/* `packages/ui/src/lib/daemon.ts` (TOON_Network#93, #97).                    */
/*                                                                            */
/* Deliberately partial: a field the shipped views never read (the fine       */
/* points of a rotation or a Standby Set spawn form, say) is simply left off  */
/* these structs. `serde` ignores a JSON field with no matching Rust field —  */
/* it does not fail — so the real daemon fixture still deserializes; a later  */
/* ticket that needs one of those fields adds it here rather than starting a  */
/* second copy of the type.                                                  */
/* -------------------------------------------------------------------------- */

/// `LeaseAccess` in `daemon.ts`. Field names are already `snake_case` on the
/// wire (unlike the rest of this API), so no `rename` is needed here.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LeaseAccess {
    pub host: String,
    #[serde(default)]
    pub ssh_port: Option<i64>,
    #[serde(default)]
    pub ports: Vec<ForwardedPort>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ForwardedPort {
    pub container_port: i64,
    pub host_port: i64,
}

/// `OpRouteView` in `daemon.ts`: where an extend or a terminate would be
/// paid, and what it costs — the figure a confirmation modal shows.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct OpRouteView {
    pub route: String,
    #[serde(rename = "payAt")]
    pub pay_at: String,
    pub reason: String,
    #[serde(default)]
    pub price: Option<String>,
    #[serde(default)]
    pub chain: Option<String>,
}

/// `LeaseView['listing']` in `daemon.ts`, reused for both a lease's own
/// listing and a member's.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ListingRef {
    pub name: String,
    pub version: i64,
    #[serde(default)]
    pub lease_interval_s: i64,
    #[serde(default)]
    pub price: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LeaseImage {
    #[serde(default)]
    pub reference: Option<String>,
    pub digest: String,
}

/// `LeaseView` in `daemon.ts`, the fields the Workloads view shows.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct LeaseView {
    #[serde(rename = "workloadId")]
    pub workload_id: String,
    pub state: String,
    pub listing: ListingRef,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    pub image: LeaseImage,
    #[serde(rename = "localOnly")]
    pub local_only: bool,
    #[serde(default)]
    pub access: Option<LeaseAccess>,
    #[serde(default)]
    pub relays: Vec<String>,
    /// The Template this lease was spawned from (`30436:<pubkey>:<d>`), when
    /// it was — the vault record carries it, so a recovered lease still says
    /// where it came from.
    #[serde(default)]
    pub template: Option<String>,
}

/// `LeaseLife` in `daemon.ts`: a tagged union on `phase`, with the three
/// endings (§6.7) kept apart inside `Ended` rather than collapsed to "over".
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "phase")]
pub enum LeaseLife {
    #[serde(rename = "provisioning")]
    Provisioning,
    #[serde(rename = "reserved")]
    Reserved,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "ended")]
    Ended {
        ending: String,
        #[serde(default)]
        word: Option<String>,
    },
}

/// `WorkloadStatus` in `daemon.ts`: a tagged union on `kind`. Four kinds, not
/// three collapsed into "error" — `Silent` says nothing about the lease,
/// `Refused` is a definite answer, `Unread` is this console's own failure to
/// ask.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum WorkloadStatus {
    #[serde(rename = "read")]
    Read {
        life: LeaseLife,
        #[serde(default)]
        access: Option<LeaseAccess>,
        /// Unix seconds: the end of the interval the provider says is paid
        /// (§6.4). What an extension moves, and what the smoke re-reads to
        /// prove it did (TOON_Network#149).
        #[serde(rename = "expiresAt", default)]
        expires_at: Option<i64>,
        /// What this read cost, base units — `status` is free at a provider's
        /// own connector and billed by a hop that carries it (spec §5).
        #[serde(default)]
        cost: Option<String>,
    },
    #[serde(rename = "silent")]
    Silent {
        reason: String,
        #[serde(default)]
        cost: Option<String>,
    },
    #[serde(rename = "refused")]
    Refused {
        code: String,
        message: String,
        #[serde(default)]
        cost: Option<String>,
    },
    #[serde(rename = "unread")]
    Unread { reason: String },
}

/// `RunwayView` in `daemon.ts`. Only the fields the Workloads row and detail
/// pane show — the figure is the daemon's own arithmetic, never recomputed
/// here (see the module doc above).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RunwayView {
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// The whole SET's figure in seconds, bounded by the member that runs
    /// out first (§7) — `None` when `state` is not `"computed"`.
    #[serde(default)]
    pub seconds: Option<i64>,
}

/// `TakeoverReport` in `daemon.ts` (§7.1, ADR 0010).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TakeoverReport {
    pub winner: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(rename = "announcedAt")]
    #[serde(default)]
    pub announced_at: Option<String>,
    #[serde(rename = "firstSeenAt")]
    pub first_seen_at: String,
    #[serde(default)]
    pub rounds: Option<i64>,
}

/// `StandbySetView` in `daemon.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct StandbySetView {
    pub members: i64,
    pub warm: bool,
    /// What one round of extensions for every member costs, base units — the
    /// figure a budget arms against (TOON_Network#144), not the primary's own
    /// price: a budget armed against one member would let the reservations
    /// lapse, and a lapsed reservation has stopped protecting anything (§7).
    #[serde(rename = "pricePerInterval")]
    #[serde(default)]
    pub price_per_interval: Option<String>,
    #[serde(default)]
    pub takeover: Option<TakeoverReport>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct WorkloadMemberProvider {
    #[serde(rename = "ilpAddress")]
    pub ilp_address: String,
    pub hidden: bool,
    #[serde(default)]
    pub liveness: Option<String>,
}

/// `WorkloadMemberView` in `daemon.ts`: one lease of a Standby Set, primary
/// or standby (§7).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct WorkloadMemberView {
    pub pubkey: String,
    pub role: String,
    pub provider: WorkloadMemberProvider,
    pub listing: ListingRef,
    pub status: WorkloadStatus,
    #[serde(rename = "runningNow")]
    pub running_now: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct WorkloadCardProvider {
    #[serde(rename = "ilpAddress")]
    pub ilp_address: String,
    pub hidden: bool,
    #[serde(default)]
    pub liveness: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct CardExtend {
    pub ok: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub route: Option<OpRouteView>,
}

/// `AutoExtendView['lastRun']` in `daemon.ts` (TOON_Network#144).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AutoExtendLastRun {
    pub at: String,
    /// `"extended" | "waited" | "stopped"` in `daemon.ts`. Kept as a `String`
    /// (this module's own convention for a kind that is only ever shown, not
    /// matched on — see `AnonTransportView.state`).
    pub outcome: String,
    pub reason: String,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(default)]
    pub members: Option<Vec<String>>,
}

/// `AutoExtendView` in `daemon.ts` (TOON_Network#144, spec §6.4): a standing
/// instruction to keep extending a workload while nobody is watching, inside
/// a budget the tenant set. Present on a `WorkloadCard` once `a` has armed
/// one, whether or not it is currently `armed` — "off" is a remembered state,
/// not an absence (`workload-auto-extend-off.json`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AutoExtendView {
    pub armed: bool,
    pub budget: String,
    pub spent: String,
    pub remaining: String,
    pub extensions: i64,
    #[serde(rename = "agreedPrice")]
    pub agreed_price: String,
    #[serde(rename = "leadSeconds")]
    pub lead_seconds: i64,
    #[serde(rename = "armedAt")]
    pub armed_at: String,
    #[serde(rename = "lastRun")]
    #[serde(default)]
    pub last_run: Option<AutoExtendLastRun>,
    #[serde(rename = "stoppedBecause")]
    #[serde(default)]
    pub stopped_because: Option<String>,
}

/// `WorkloadCard` in `daemon.ts` (TOON_Network#93): one row of the dashboard.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct WorkloadCard {
    #[serde(rename = "workloadId")]
    pub workload_id: String,
    pub lease: LeaseView,
    pub provider: WorkloadCardProvider,
    pub status: WorkloadStatus,
    pub runway: RunwayView,
    pub extend: CardExtend,
    /** Every member of the Standby Set, primary first (§7). Never empty. */
    #[serde(default)]
    pub members: Vec<WorkloadMemberView>,
    pub set: StandbySetView,
    #[serde(rename = "autoExtend")]
    #[serde(default)]
    pub auto_extend: Option<AutoExtendView>,
}

/// `Dashboard` in `daemon.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Dashboard {
    pub state: String,
    #[serde(default)]
    pub pubkey: Option<String>,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    pub cards: Vec<WorkloadCard>,
    pub unreadable: i64,
    #[serde(rename = "checkedAt")]
    pub checked_at: String,
}

/// `ExtendResult` in `daemon.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ExtendResult {
    /// `false` means nothing was sent and nothing was paid.
    pub sent: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub route: Option<OpRouteView>,
    #[serde(default)]
    pub cost: Option<String>,
    /// Unix seconds: the new end of the paid interval, as the provider
    /// answered it.
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<i64>,
    #[serde(rename = "providerError")]
    #[serde(default)]
    pub provider_error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    pub card: WorkloadCard,
}

/// `TerminateResult` in `daemon.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TerminateResult {
    pub sent: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(default)]
    pub ended: Option<String>,
    #[serde(rename = "providerError")]
    #[serde(default)]
    pub provider_error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    pub card: WorkloadCard,
}

/* -------------------------------------------------------------------------- */
/* Rotation (TOON_Network#144, spec §6.8, ADR 0018)                          */
/*                                                                            */
/* Note the fields that are NOT here and never will be: a Root Secret, a     */
/* Continuation Token, or anything derived from either. Rotation has TWO     */
/* secrets in flight — the one this lease holds and the one it is moving to  */
/* — and this surface has no field for one.                                  */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RotationMemberView {
    pub pubkey: String,
    pub index: i64,
    pub role: String,
    /// True once this member holds a token of the new Root Secret.
    pub confirmed: bool,
    pub ok: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub route: Option<OpRouteView>,
    /// Left out: this member's own spawn was refused, so it holds no lease.
    #[serde(default)]
    pub skipped: Option<bool>,
}

/// `RotationView` in `daemon.ts`: how far a rotation has got. A partially
/// rotated Standby Set (`underWay: true`, `confirmed < of`) is a state (§6.8,
/// ADR 0018), not an error, and the detail pane shows it as one.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RotationView {
    #[serde(rename = "workloadId")]
    pub workload_id: String,
    #[serde(rename = "underWay")]
    pub under_way: bool,
    pub ok: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    pub members: Vec<RotationMemberView>,
    pub confirmed: i64,
    pub of: i64,
    #[serde(rename = "startedAt")]
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(rename = "rotatedAt")]
    #[serde(default)]
    pub rotated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RotationMemberResult {
    pub pubkey: String,
    pub index: i64,
    pub role: String,
    pub sent: bool,
    pub rotated: bool,
    /// The answer was lost and a free `status` with the new token settled it.
    #[serde(default)]
    pub recovered: Option<bool>,
    #[serde(default)]
    pub already: Option<bool>,
    /// Worth asking again with nothing changed — `unavailable`, or silence.
    #[serde(default)]
    pub retryable: Option<bool>,
    #[serde(default)]
    pub route: Option<OpRouteView>,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(rename = "providerError")]
    #[serde(default)]
    pub provider_error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub problems: Option<Vec<String>>,
}

/// `RotationResult` in `daemon.ts`: what one `POST …/rotate` did.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RotationResult {
    #[serde(rename = "workloadId")]
    pub workload_id: String,
    /// False when the new Root Secret could not be recorded: nothing was sent.
    pub started: bool,
    /// True only when EVERY member confirmed.
    pub rotated: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    pub members: Vec<RotationMemberResult>,
    pub confirmed: i64,
    pub of: i64,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(rename = "vaultCost")]
    #[serde(default)]
    pub vault_cost: Option<String>,
    #[serde(rename = "vaultBehind")]
    #[serde(default)]
    pub vault_behind: Option<String>,
    pub view: RotationView,
}

/* -------------------------------------------------------------------------- */
/* The hostname (TOON_Network#144, spec §12)                                 */
/*                                                                            */
/* Note the field that is NOT here and never will be: the Gateway Grant. It  */
/* reads one lease's `status` until the moment it names, so it is a secret   */
/* exactly as the Continuation Token it derives from is. Nothing on this     */
/* surface has a field for one.                                              */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GatewayEdgeView {
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    #[serde(rename = "ilpAddress")]
    pub ilp_address: String,
    pub route: String,
    #[serde(default)]
    pub price: Option<String>,
    pub domain: String,
}

/// What this console handed to a Workload Gateway (`GatewayHandoverNote` in
/// `daemon.ts`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GatewayHandoverNote {
    pub hostname: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(rename = "httpPort")]
    pub http_port: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "standbySet")]
    #[serde(default)]
    pub standby_set: Vec<String>,
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    pub route: String,
    pub at: String,
    #[serde(rename = "withdrawnAt")]
    #[serde(default)]
    pub withdrawn_at: Option<String>,
}

/// `GatewayView` in `daemon.ts`: the hostname, and whether it is currently
/// held.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct GatewayView {
    #[serde(rename = "workloadId")]
    pub workload_id: String,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub gateway: Option<GatewayEdgeView>,
    #[serde(default)]
    pub handover: Option<GatewayHandoverNote>,
    pub held: bool,
    #[serde(default)]
    pub expired: Option<bool>,
    #[serde(default)]
    pub problems: Vec<String>,
    pub ok: bool,
    #[serde(default)]
    pub ports: Vec<i64>,
    #[serde(rename = "httpPort")]
    #[serde(default)]
    pub http_port: Option<i64>,
}

/// `HandoverResult` in `daemon.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct HandoverResult {
    pub sent: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub route: Option<OpRouteView>,
    #[serde(default)]
    pub cost: Option<String>,
    /// What the gateway answered.
    #[serde(default)]
    pub hostname: Option<String>,
    /// What the daemon derived for itself from the workload id (§12.2).
    #[serde(rename = "expectedHostname")]
    #[serde(default)]
    pub expected_hostname: Option<String>,
    #[serde(default)]
    pub matches: Option<bool>,
    #[serde(rename = "expiresAt")]
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(rename = "gatewayError")]
    #[serde(default)]
    pub gateway_error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    pub view: GatewayView,
}

/// `WithdrawalResult` in `daemon.ts`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct WithdrawalResult {
    pub sent: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub route: Option<OpRouteView>,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub withdrawn: Option<bool>,
    #[serde(rename = "gatewayError")]
    #[serde(default)]
    pub gateway_error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    pub view: GatewayView,
}

/* -------------------------------------------------------------------------- */
/* Templates and the spawn/preflight flow (TOON_Network#146).                 */
/* -------------------------------------------------------------------------- */
//
// A mirror of `packages/ui/src/app/templates-view.tsx`, `hooks/use-templates.ts`
// and the "Templates" and "Leases" sections of `packages/ui/src/lib/daemon.ts`.
// A Template GRANTS NO CAPABILITY (ADR 0004) — nothing here has a field for
// one, on purpose. `GET /api/templates` answers [`TemplateGallery`];
// `POST /api/templates/expand` answers [`ExpandedTemplate`], the §6.2 spawn
// content a Template expands to, spending nothing; `POST /api/leases/preflight`
// and `POST /api/leases/spawn` (or their `standby-set` siblings) take that
// content plus a chosen Listing and answer [`PreflightView`]/[`SpawnResult`]
// (or [`StandbySetPreflightView`]/[`StandbySetResult`]).

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplatePort {
    #[serde(rename = "containerPort")]
    pub container_port: i64,
    pub protocol: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplateResources {
    #[serde(rename = "cpuMillicores")]
    pub cpu_millicores: i64,
    #[serde(rename = "memoryMb")]
    pub memory_mb: i64,
    #[serde(rename = "storageGb")]
    pub storage_gb: i64,
    #[serde(default)]
    pub gpu: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplateImageRegistryEntry {
    pub address: String,
    #[serde(default)]
    pub relay: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplateImage {
    pub digest: String,
    #[serde(rename = "registryEntry", default)]
    pub registry_entry: Option<TemplateImageRegistryEntry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PublisherView {
    pub pubkey: String,
    pub npub: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
    #[serde(default)]
    pub nip05: Option<String>,
}

/// Only the fields `views::new_workload`'s `WhatItRuns` equivalent shows —
/// `canonicalName` and how many blobs. `blobs` is kept as raw JSON: its own
/// shape (§8.1's `ImageBlob`, a discriminated union on a toon-store or an OCI
/// source) is never read here, only counted.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplateImageEntry {
    pub address: String,
    #[serde(rename = "canonicalName")]
    pub canonical_name: String,
    #[serde(default)]
    pub blobs: Vec<serde_json::Value>,
}

/// `TemplateAvailability` in `daemon.ts`: a Template whose image cannot be
/// resolved gets no form — shown with the reason instead (see
/// `views::new_workload`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "state")]
pub enum TemplateAvailability {
    #[serde(rename = "available")]
    Available {
        /// What was checked — records, not bytes (shown, so it cannot
        /// overclaim).
        checked: String,
        #[serde(default)]
        entry: Option<TemplateImageEntry>,
        /// Not shown anywhere today; kept only so a fixture with one still
        /// deserializes.
        #[serde(rename = "blobRecord", default)]
        blob_record: Option<serde_json::Value>,
    },
    #[serde(rename = "unavailable")]
    Unavailable { reason: String },
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplateView {
    pub name: String,
    /// `30436:<publisher pubkey>:<name>` — what `POST /api/templates/expand`
    /// names.
    pub address: String,
    pub publisher: PublisherView,
    pub version: i64,
    pub image: TemplateImage,
    #[serde(default)]
    pub ports: Vec<TemplatePort>,
    #[serde(rename = "dataPath", default)]
    pub data_path: Option<String>,
    #[serde(rename = "envFixed", default)]
    pub env_fixed: std::collections::BTreeMap<String, String>,
    /// Every name a tenant may set, fixed ones included (`envFixed`'s keys
    /// are filtered out where this is used — see `SpawnForm` in
    /// `templates-view.tsx`, mirrored by `views::new_workload::settable_env`).
    #[serde(rename = "envTenant", default)]
    pub env_tenant: Vec<String>,
    #[serde(rename = "minResources", default)]
    pub min_resources: Option<TemplateResources>,
    pub availability: TemplateAvailability,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RejectedTemplateEntry {
    pub address: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TemplateRelays {
    pub seed: Vec<String>,
    pub read: Vec<RelayOutcome>,
}

/// `TemplateGallery` in `daemon.ts` — a discriminated union on `state`, same
/// pattern as [`Directory`].
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "state")]
pub enum TemplateGallery {
    #[serde(rename = "ok")]
    Ok {
        relays: TemplateRelays,
        templates: Vec<TemplateView>,
        #[serde(default)]
        rejected: Vec<RejectedTemplateEntry>,
        #[serde(rename = "rejectedEvents")]
        rejected_events: i64,
        #[serde(rename = "readAt")]
        read_at: String,
    },
    #[serde(rename = "unconfigured")]
    Unconfigured { reason: String },
}

/// `POST /api/templates/expand`'s body — `{ template, ...TemplateSettings }`
/// in `daemon.ts`. Only the fields `views::new_workload`'s form collects;
/// `workloadId` and `standbySet` are the Standby Set's own naming and are
/// never sent from this form (the primary/standby-set spawn routes below
/// carry that instead).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct ExpandTemplateRequest {
    pub template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(rename = "sshPublicKey")]
    pub ssh_public_key: String,
    #[serde(rename = "volumeGb", skip_serializing_if = "Option::is_none")]
    pub volume_gb: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SpawnContentImageRegistryEntry {
    pub address: String,
    #[serde(default)]
    pub relay: Option<String>,
}

/// `SpawnContent['image']` in `daemon.ts` — the wire's own spelling
/// (snake_case, §6.2), never rewritten here.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SpawnContentImage {
    pub digest: String,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub registry_entry: Option<SpawnContentImageRegistryEntry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SpawnContentPort {
    pub container_port: i64,
    pub protocol: String,
}

/// `SpawnContent` in `daemon.ts` (spec §6.2's content, verbatim wire
/// spelling).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SpawnContent {
    pub workload_id: String,
    pub image: SpawnContentImage,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub ports: Vec<SpawnContentPort>,
    #[serde(default)]
    pub volume_gb: Option<i64>,
    pub ssh_public_key: String,
    #[serde(default)]
    pub entrypoint: Option<Vec<String>>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub standby_set: Option<Vec<String>>,
    #[serde(default)]
    pub template: Option<String>,
}

/// `ExpandedTemplate` in `daemon.ts` — what `POST /api/templates/expand`
/// answers. Spends nothing: the daemon re-reads the Template and decides
/// what is settable, so this is the same content a manual spawn of the
/// expanded image would carry (`views::new_workload` builds
/// [`SpawnRequestBody`] straight from `spawn`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ExpandedTemplate {
    pub template: String,
    pub spawn: SpawnContent,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct SpawnImageRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    pub digest: String,
    #[serde(rename = "registryEntry", skip_serializing_if = "Option::is_none")]
    pub registry_entry: Option<RegistryEntryRequest>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct RegistryEntryRequest {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct SpawnPortRequest {
    #[serde(rename = "containerPort")]
    pub container_port: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

/// `SpawnRequestBody` in `daemon.ts` — what `POST /api/leases/preflight` and
/// `POST /api/leases/spawn` take. `views::new_workload` builds this from an
/// [`ExpandedTemplate`]'s `spawn` (the image, env, ports, volume and SSH key
/// a Template expanded to) and the [`crate::views::directory::ListingPicker`]
/// selection (`provider`, `listing`) — never typed by hand, the way the
/// generic Workloads spawn form's fields are.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct SpawnRequestBody {
    pub provider: String,
    pub listing: String,
    pub image: SpawnImageRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<Vec<SpawnPortRequest>>,
    #[serde(rename = "sshPublicKey")]
    pub ssh_public_key: String,
    #[serde(rename = "volumeGb", skip_serializing_if = "Option::is_none")]
    pub volume_gb: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// The Template this spawn came from (`address`). `POST /api/leases/*`
    /// does not read it — a lease spawned from a Template is bought through
    /// `POST /api/templates/spawn` ([`TemplateSpawnRequestBody`]), which is
    /// what makes the vault record name its Template (TOON_Network#149).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(rename = "localOnly", skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain: Option<String>,
}

/// `POST /api/templates/spawn`'s body: `{ template, ...TemplateSettings }` —
/// the same settings `POST /api/templates/expand` took ([`ExpandTemplateRequest`])
/// — plus the Listing to buy on. The daemon expands the Template again from
/// these settings and buys the lease with the Template's address on its
/// record, so the Lease Vault (and a machine that recovers it) can say where a
/// workload came from. `POST /api/leases/spawn` has no such field and drops
/// it, which is why New workload spawns through this route (TOON_Network#149).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct TemplateSpawnRequestBody {
    pub template: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(rename = "sshPublicKey")]
    pub ssh_public_key: String,
    #[serde(rename = "volumeGb", skip_serializing_if = "Option::is_none")]
    pub volume_gb: Option<i64>,
    /// The Listing's author: the provider to buy from.
    pub provider: String,
    /// The Listing's `d` name.
    pub listing: String,
    /// The Listing version the spawn is bought at (§4.2, ADR 0009).
    #[serde(rename = "listingVersion")]
    pub listing_version: i64,
    #[serde(rename = "localOnly", skip_serializing_if = "Option::is_none")]
    pub local_only: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct StandbyMemberRequest {
    pub provider: String,
    pub listing: String,
    #[serde(rename = "listingVersion", skip_serializing_if = "Option::is_none")]
    pub listing_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain: Option<String>,
}

/// `StandbySetRequestBody` in `daemon.ts` — `SpawnRequestBody` plus
/// `standbys`, flattened onto the same JSON object on the wire (the TS side
/// spells this as `extends`).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Default)]
pub struct StandbySetRequestBody {
    #[serde(flatten)]
    pub base: SpawnRequestBody,
    /// A Warm Standby per member. Non-empty: the API refuses an empty one —
    /// a lease with no standby is an ordinary spawn (spec §7).
    pub standbys: Vec<StandbyMemberRequest>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PreflightProviderView {
    pub pubkey: String,
    #[serde(rename = "ilpAddress")]
    pub ilp_address: String,
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    pub hidden: bool,
    pub liveness: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PreflightListingView {
    pub name: String,
    pub version: i64,
    #[serde(rename = "leaseIntervalSeconds")]
    pub lease_interval_seconds: i64,
    /// µUSDC for one Lease Interval, as the Listing priced it.
    pub price: i64,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PreflightPayment {
    #[serde(rename = "connectorUrl")]
    pub connector_url: String,
    pub via: String,
    pub reason: String,
    #[serde(default)]
    pub chain: Option<String>,
    #[serde(rename = "channelId", default)]
    pub channel_id: Option<String>,
    #[serde(rename = "routePrice", default)]
    pub route_price: Option<String>,
    #[serde(rename = "overAnon", default)]
    pub over_anon: Option<bool>,
    #[serde(rename = "rpcOverAnon", default)]
    pub rpc_over_anon: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PreflightVault {
    #[serde(rename = "localOnly")]
    pub local_only: bool,
    pub writes: RelayWriteTargets,
}

/// `PreflightView` in `daemon.ts` (`packages/daemon/src/lease.ts`'s own type
/// of the same name) — what a spawn WOULD do, and everything wrong with it,
/// before anything is paid.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PreflightView {
    pub ok: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(default)]
    pub provider: Option<PreflightProviderView>,
    #[serde(default)]
    pub listing: Option<PreflightListingView>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub payment: Option<PreflightPayment>,
    pub vault: PreflightVault,
}

/// `SpawnResult` in `daemon.ts`. No field here could carry a Root Secret —
/// `LeaseView` has none — matching `api-leases.test.ts`'s own rule.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SpawnResult {
    #[serde(default)]
    pub lease: Option<LeaseView>,
    pub preflight: PreflightView,
    #[serde(default)]
    pub answer: Option<serde_json::Value>,
    /// What the packet cost, in base units of the settlement token.
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(rename = "retractionFailed", default)]
    pub retraction_failed: Option<String>,
    #[serde(rename = "confirmationFailed", default)]
    pub confirmation_failed: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MemberPlanView {
    pub pubkey: String,
    pub index: i64,
    pub role: String,
    pub view: PreflightView,
}

/// `StandbySetPreflightView` in `daemon.ts` (spec §7): one workload id,
/// priced at every member — the primary AND each Warm Standby, since a set
/// spends at every one of them.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct StandbySetPreflightView {
    pub ok: bool,
    #[serde(default)]
    pub problems: Vec<String>,
    #[serde(rename = "workloadId", default)]
    pub workload_id: Option<String>,
    pub members: Vec<MemberPlanView>,
    #[serde(default)]
    pub cost: Option<String>,
    pub vault: PreflightVault,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MemberSpawnResult {
    pub pubkey: String,
    pub index: i64,
    pub role: String,
    #[serde(default)]
    pub route: Option<String>,
    pub sent: bool,
    pub ok: bool,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub access: Option<LeaseAccess>,
    #[serde(rename = "providerError", default)]
    pub provider_error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

/// `StandbySetResult` in `daemon.ts` — every member reported separately,
/// including one that refused and was billed anyway (ADR 0003).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct StandbySetResult {
    #[serde(default)]
    pub lease: Option<LeaseView>,
    pub preflight: StandbySetPreflightView,
    pub members: Vec<MemberSpawnResult>,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(rename = "confirmationFailed", default)]
    pub confirmation_failed: Option<String>,
}

/// The Chain Seed (TOON_Network#142, ADR 0020), a mirror of `daemon.ts`'s
/// `ChainSeedStatus` and its neighbours.
///
/// There is no field anywhere in this group a mnemonic could be reached
/// through — the daemon never returns one, and this hand-kept mirror does
/// not invent a place for it.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChainSeedState {
    SignedOut,
    /// Not looked for yet — distinct from `Absent`, which has looked and
    /// found nothing (ADR 0020).
    Unknown,
    Absent,
    NotYetRecoverable,
    Ready,
    Unreadable,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SeedOrigin {
    Minted,
    Imported,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChainAddresses {
    pub evm: ChainAddress,
    pub solana: ChainAddress,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecordSource {
    Cache,
    Relays,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SeedRecordView {
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    pub source: RecordSource,
    pub relays: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChainSeedRelayListState {
    Unknown,
    None,
    Present,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChainSeedRelayList {
    pub state: ChainSeedRelayListState,
    pub read: Vec<String>,
    pub write: Vec<String>,
    #[serde(rename = "publishedAt")]
    #[serde(default)]
    pub published_at: Option<String>,
}

/// One relay a write would go to, or the reason it would not
/// (TOON_Network#120, #121).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RelayWriteTarget {
    pub url: String,
    pub ready: bool,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(rename = "payAt")]
    #[serde(default)]
    pub pay_at: Option<String>,
    #[serde(default)]
    pub price: Option<String>,
    #[serde(default)]
    pub chain: Option<String>,
    #[serde(rename = "channelId")]
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    /// Set exactly when `ready` is false.
    #[serde(default)]
    pub reason: Option<String>,
}

/// Where a paid write goes, what it costs, and what stops it. Every figure
/// here is one the daemon's connector quoted, never one computed in this
/// crate.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RelayWriteTargets {
    pub relays: Vec<String>,
    /// Every relay considered, payable or not, with the reason either way.
    pub plan: Vec<RelayWriteTarget>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(rename = "payAt")]
    #[serde(default)]
    pub pay_at: Option<String>,
    /// Base units per write at the first payable relay, verbatim.
    #[serde(default)]
    pub price: Option<String>,
    /// Every payable relay's price summed: what one record costs to
    /// publish, in total — the figure shown next to the confirmation.
    #[serde(rename = "totalPrice")]
    #[serde(default)]
    pub total_price: Option<String>,
    pub ready: bool,
    #[serde(rename = "blockedBy")]
    #[serde(default)]
    pub blocked_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RelayWriteOutcome {
    pub url: String,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub cost: Option<String>,
    /// `"written" | "refused" | "unknown" | "unpayable"` — kept as a
    /// `String` the same way `AnonTransportView::state` is: an unknown fifth
    /// state must render as itself rather than fail to deserialize.
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PublishReport {
    pub at: String,
    /// `"chain-seed" | "relay-list"`.
    pub what: String,
    pub relays: Vec<RelayWriteOutcome>,
    pub accepted: Vec<String>,
    /// What this write cost, in base units of the settlement token.
    #[serde(default)]
    pub cost: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChainSeedWarning {
    pub text: String,
    #[serde(rename = "acknowledgedAt")]
    #[serde(default)]
    pub acknowledged_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ChainSeedStatus {
    pub state: ChainSeedState,
    #[serde(default)]
    pub pubkey: Option<String>,
    #[serde(default)]
    pub addresses: Option<ChainAddresses>,
    #[serde(default)]
    pub origin: Option<SeedOrigin>,
    /// The PUBLISHED record. Absent while a seed is only held (#120).
    #[serde(default)]
    pub record: Option<SeedRecordView>,
    /// Set exactly when `state` is `NotYetRecoverable`.
    #[serde(default)]
    pub held: Option<HeldSeedView>,
    #[serde(rename = "relayList")]
    pub relay_list: ChainSeedRelayList,
    pub writes: RelayWriteTargets,
    pub warning: ChainSeedWarning,
    #[serde(rename = "supersededSeeds")]
    pub superseded_seeds: i64,
    #[serde(rename = "lastPublish")]
    #[serde(default)]
    pub last_publish: Option<PublishReport>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "checkedAt")]
    pub checked_at: String,
}

/// `POST /api/chain-seed/import`'s body.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct ImportChainSeedRequest {
    pub mnemonic: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_deserializes_from_the_shape_the_daemon_sends() {
        let json = serde_json::json!({
            "daemon": {"name": "@toon-protocol/console-daemon", "version": "0.1.0", "node": "v22.0.0", "pid": 1, "startedAt": "2026-09-24T00:00:00.000Z", "uptimeSeconds": 5},
            "profile": {
                "id": "devnet", "label": "Devnet", "description": "d", "connectorUrl": "https://c", "relayUrl": "wss://r",
                "gatewayDomain": "g", "gatewayConnectorUrl": "https://g", "rpc": {}, "origin": "built-in", "configured": true, "active": true
            },
            "connector": {"state": "ok", "endpoint": "https://c", "selfEndpoint": "https://c", "ilpAddresses": ["g.toon"], "settlements": [], "routes": [], "peerCarriages": [], "supportedVersions": [1]},
            "storage": {"data": "/d", "config": "/c", "runtime": "/r", "channels": "/ch"},
            "checkedAt": "2026-09-24T00:00:01.000Z"
        });
        let health: Health = serde_json::from_value(json).unwrap();
        assert_eq!(health.profile.id, "devnet");
        assert!(matches!(health.connector, ConnectorHealth::Ok { .. }));
        assert!(health.anon.is_none());
    }

    #[test]
    fn connector_health_unconfigured_and_unreachable_both_parse() {
        let unconfigured: ConnectorHealth = serde_json::from_value(
            serde_json::json!({"state": "unconfigured", "reason": "no url"}),
        )
        .unwrap();
        assert!(matches!(unconfigured, ConnectorHealth::Unconfigured { .. }));

        let unreachable: ConnectorHealth = serde_json::from_value(
            serde_json::json!({"state": "unreachable", "endpoint": "https://x", "reason": "timed out"}),
        )
        .unwrap();
        assert!(matches!(unreachable, ConnectorHealth::Unreachable { .. }));
    }

    #[test]
    fn directory_ok_and_unconfigured_both_parse() {
        let ok: Directory = serde_json::from_value(serde_json::json!({
            "state": "ok",
            "relays": {"seed": ["wss://seed"], "read": [{"url": "wss://seed", "state": "read", "events": 1}]},
            "filters": {},
            "providers": [{
                "pubkey": "abc",
                "profile": {
                    "ilpAddress": "g.test", "connectorUrl": "https://c", "connectorSealKey": "0x04",
                    "relays": [], "settlement": [], "isolation": "shared-kernel", "hidden": false,
                    "publishedAt": "2026-09-22T00:00:00.000Z", "eventId": "e1"
                },
                "liveness": {"state": "live", "expiresAt": "2026-09-22T12:02:00.000Z", "secondsUntilExpiry": 120, "cadenceSeconds": 60},
                "listings": [{
                    "name": "basic", "address": "30432:abc:basic", "version": 1,
                    "resources": {"cpuMillicores": 1000, "memoryMb": 1024, "storageGb": 10},
                    "arch": "amd64", "isolation": "shared-kernel", "hidden": false,
                    "leaseIntervalSeconds": 3600, "price": 1000,
                    "capabilities": [], "unspecifiedCapabilities": [],
                    "publishedAt": "2026-09-22T00:00:00.000Z", "eventId": "e2"
                }],
                "relaysRead": ["wss://seed"], "supersededListings": 0, "rejectedListings": []
            }],
            "listingsWithoutProfile": 0, "rejectedEvents": 0, "readAt": "2026-09-22T12:00:00.000Z"
        }))
        .unwrap();
        match ok {
            Directory::Ok { providers, .. } => {
                assert_eq!(providers.len(), 1);
                assert_eq!(providers[0].listings[0].price, 1000);
            }
            Directory::Unconfigured { .. } => panic!("expected Ok"),
        }

        let unconfigured: Directory = serde_json::from_value(
            serde_json::json!({"state": "unconfigured", "reason": "no relay"}),
        )
        .unwrap();
        assert!(matches!(unconfigured, Directory::Unconfigured { .. }));
    }

    #[test]
    fn docs_index_deserializes_with_no_npub_configured() {
        let json = serde_json::json!({
            "relays": [],
            "read": [],
            "fallback": "These are the pages that shipped with this console.",
            "docs": [
                {"d": "concepts", "title": "Concepts", "summary": "The words.", "order": 1,
                 "publishedAt": "2026-09-23", "tags": ["toon-network"], "source": "bundled"}
            ],
            "readAt": "2026-09-24T00:00:00.000Z"
        });
        let index: DocsIndex = serde_json::from_value(json).unwrap();
        assert!(index.author.is_none());
        assert_eq!(index.docs[0].source, "bundled");
        assert_eq!(
            index.fallback.as_deref(),
            Some("These are the pages that shipped with this console.")
        );
    }

    #[test]
    fn docs_page_flattens_the_index_alongside_the_opened_article() {
        let json = serde_json::json!({
            "author": {"npub": "npub1x", "pubkey": "a".repeat(64)},
            "relays": ["wss://relay.test"],
            "read": [{"url": "wss://relay.test", "state": "read", "events": 1}],
            "docs": [],
            "readAt": "2026-09-24T00:00:00.000Z",
            "doc": {
                "d": "concepts", "title": "Concepts", "summary": "The words.",
                "publishedAt": "2026-09-23", "tags": [], "source": "relays",
                "address": "30023:a:concepts", "updatedAt": 1_790_000_000,
                "markdown": "# Concepts\n\nBody."
            }
        });
        let page: DocsPage = serde_json::from_value(json).unwrap();
        assert_eq!(page.index.author.as_ref().unwrap().npub, "npub1x");
        assert_eq!(page.doc.d, "concepts");
        assert_eq!(page.doc.updated_at, Some(1_790_000_000));
        assert_eq!(page.doc.markdown, "# Concepts\n\nBody.");
        assert_eq!(page.index.read[0].state, "read");
    }

    fn sample_chain_funding_json() -> serde_json::Value {
        serde_json::json!({
            "chain": "evm:84532",
            "kind": "evm",
            "counterparty": "https://connector.example",
            "token": {"address": "0xusdc", "decimals": 6},
            "deposit": {"address": "0xdead", "path": "m/44'/60'/0'/0/0"},
            "rpc": {"url": "https://rpc.example", "source": "profile"},
            "balances": {"state": "read", "native": {"amount": "0", "symbol": "ETH", "decimals": 18}, "token": {"amount": "5000000", "symbol": "USDC", "decimals": 6}},
            "gas": {"verdict": "none", "symbol": "ETH", "headline": "No ETH", "detail": "detail", "faucetGivesGas": false},
            "channel": {"phase": "none", "reason": "no channel yet"},
            "canOpen": false,
            "blockedBy": "No ETH to pay for a transaction",
            "suggestedDeposit": "1000000"
        })
    }

    #[test]
    fn chain_funding_view_deserializes_from_the_shape_the_daemon_sends() {
        let chain: ChainFundingView = serde_json::from_value(sample_chain_funding_json()).unwrap();
        assert_eq!(chain.chain, "evm:84532");
        assert_eq!(chain.token.decimals, 6);
        assert_eq!(chain.deposit.address, "0xdead");
        assert!(!chain.can_open);
        assert_eq!(
            chain.blocked_by.as_deref(),
            Some("No ETH to pay for a transaction")
        );
    }

    #[test]
    fn funding_status_deserializes_ready_with_chains() {
        let json = serde_json::json!({
            "state": "ready",
            "profile": {"id": "devnet", "label": "Devnet"},
            "pubkey": "abc123",
            "custody": {"text": "Custody text"},
            "supersededSeeds": 0,
            "chains": [sample_chain_funding_json()],
            "channelStorePath": "/home/tester/channels.json",
            "checkedAt": "2026-09-24T00:00:01.000Z"
        });
        let status: FundingStatus = serde_json::from_value(json).unwrap();
        assert_eq!(status.state, "ready");
        assert_eq!(status.chains.len(), 1);
        assert_eq!(status.chains[0].chain, "evm:84532");
        assert!(status.held_seed.is_none());
    }

    #[test]
    fn funding_status_deserializes_signed_out_with_no_chains() {
        let json = serde_json::json!({
            "state": "signed_out",
            "profile": {"id": "devnet", "label": "Devnet"},
            "custody": {"text": "Custody text"},
            "supersededSeeds": 0,
            "reason": "Sign in first",
            "checkedAt": "2026-09-24T00:00:01.000Z"
        });
        let status: FundingStatus = serde_json::from_value(json).unwrap();
        assert_eq!(status.state, "signed_out");
        assert!(status.chains.is_empty());
        assert_eq!(status.reason.as_deref(), Some("Sign in first"));
    }

    #[test]
    fn gas_station_status_deserializes_buyable_chains() {
        let json = serde_json::json!({
            "state": "ready",
            "station": {"connectorUrl": "https://gas.example", "doors": ["quote", "execute"], "reachable": true},
            "chains": [{
                "chain": "solana",
                "kind": "solana",
                "recipient": "sol-address",
                "verdict": "buyable",
                "reason": "Buy Solana gas through this channel",
                "payer": {"chain": "evm:84532", "channelId": "0xchannel", "payAt": "https://gas.example", "via": "station-connector"},
                "price": "1100"
            }],
            "firstChannel": "Open your first channel to unlock the gas station.",
            "checkedAt": "2026-09-24T00:00:01.000Z"
        });
        let status: GasStationStatus = serde_json::from_value(json).unwrap();
        assert_eq!(status.chains[0].verdict, "buyable");
        assert_eq!(status.chains[0].payer.as_ref().unwrap().chain, "evm:84532");
        assert_eq!(
            status.first_channel.as_deref(),
            Some("Open your first channel to unlock the gas station.")
        );
    }

    #[test]
    fn gas_quote_and_purchase_deserialize() {
        let quote_json = serde_json::json!({
            "chain": "solana",
            "quoteId": "q-7",
            "feePayer": "fee-payer",
            "recipient": "sol-address",
            "lamports": "10000000",
            "maxLamports": "12020000",
            "recentBlockhash": "hash",
            "expiresAt": 1_758_700_000_000i64,
            "destination": "g.toon.gastation",
            "payAt": "https://gas.example",
            "price": "1100",
            "attempts": [{"destination": "g.toon.gastation", "phase": "quote", "outcome": "receipt", "cost": "1100"}]
        });
        let quote: GasQuote = serde_json::from_value(quote_json).unwrap();
        assert_eq!(quote.quote_id, "q-7");
        assert_eq!(quote.attempts.len(), 1);

        let purchase_json = serde_json::json!({
            "chain": "solana",
            "state": "delivered",
            "signature": "5sig",
            "recipient": "sol-address",
            "attempts": [],
            "cost": "3300",
            "at": "2026-09-24T00:00:02.000Z"
        });
        let purchase: GasPurchase = serde_json::from_value(purchase_json).unwrap();
        assert_eq!(purchase.state, "delivered");
        assert_eq!(purchase.signature.as_deref(), Some("5sig"));
    }

    /// TOON_Network#146: what the New workload view actually posts. Checked
    /// here at the wire level too, alongside the committed
    /// `leases-standby-set-preflight`/`leases-standby-set-spawn` fixtures
    /// (`tui/tests/fixture_contract.rs`, `tests/workloads_api.rs`) — this is
    /// what proves the flattened `extends SpawnRequestBody` shape
    /// `daemon.ts`'s `StandbySetRequestBody` describes.
    #[test]
    fn spawn_request_body_serializes_to_the_shape_the_daemon_reads() {
        let request = SpawnRequestBody {
            provider: "d".repeat(64),
            listing: "basic".to_string(),
            image: SpawnImageRequest {
                reference: Some("traefik/whoami".to_string()),
                digest: "sha256:aa".to_string(),
                registry_entry: None,
            },
            env: Some(std::collections::BTreeMap::from([(
                "SITE_TITLE".to_string(),
                "hello".to_string(),
            )])),
            ports: Some(vec![SpawnPortRequest {
                container_port: 8080,
                protocol: Some("tcp".to_string()),
            }]),
            ssh_public_key: "ssh-ed25519 AAAA".to_string(),
            volume_gb: Some(5),
            entrypoint: None,
            args: None,
            template: Some("30436:aa:static-site".to_string()),
            local_only: Some(true),
            chain: None,
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["provider"], "d".repeat(64));
        assert_eq!(value["listing"], "basic");
        assert_eq!(value["image"]["digest"], "sha256:aa");
        assert_eq!(value["sshPublicKey"], "ssh-ed25519 AAAA");
        assert_eq!(value["volumeGb"], 5);
        assert_eq!(value["localOnly"], true);
        assert_eq!(value["ports"][0]["containerPort"], 8080);
        // Fields left `None` are OMITTED, not sent as `null` — the same
        // "only what changed" shape `readSpawnRequest` expects (`api.ts`).
        assert!(value.get("chain").is_none());
        assert!(value.get("entrypoint").is_none());
        assert!(value.get("args").is_none());
    }

    #[test]
    fn standby_set_request_body_flattens_the_primary_and_carries_standbys() {
        let base = SpawnRequestBody {
            provider: "d".repeat(64),
            listing: "basic".to_string(),
            image: SpawnImageRequest {
                reference: None,
                digest: "sha256:aa".to_string(),
                registry_entry: None,
            },
            env: None,
            ports: None,
            ssh_public_key: "ssh-ed25519 AAAA".to_string(),
            volume_gb: None,
            entrypoint: None,
            args: None,
            template: Some("30436:aa:static-site".to_string()),
            local_only: None,
            chain: None,
        };
        let request = StandbySetRequestBody {
            base,
            standbys: vec![StandbyMemberRequest {
                provider: "e".repeat(64),
                listing: "basic".to_string(),
                listing_version: None,
                chain: None,
            }],
        };
        let value = serde_json::to_value(&request).unwrap();
        // Flattened: `provider`/`listing`/... sit beside `standbys` on the
        // SAME object, not nested under a `base` key — `daemon.ts`'s own
        // `extends SpawnRequestBody`, mirrored.
        assert_eq!(value["provider"], "d".repeat(64));
        assert_eq!(value["listing"], "basic");
        assert!(value.get("base").is_none());
        assert_eq!(value["standbys"][0]["provider"], "e".repeat(64));
        assert_eq!(value["standbys"][0]["listing"], "basic");
    }
}
