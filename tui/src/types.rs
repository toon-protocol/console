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
    #[serde(rename = "faucetUrl")]
    #[serde(default)]
    pub faucet_url: Option<String>,
    #[serde(default)]
    pub rpc: Option<ProfileRpc>,
    pub origin: String,
    pub configured: bool,
    pub active: bool,
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
pub struct ChainAddress {
    pub address: String,
    /// The BIP-44 path it was derived at, shown so it can be checked in any
    /// other wallet.
    pub path: String,
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

/// A seed that exists on one disk, in the console's own words
/// (TOON_Network#120).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct HeldSeedView {
    pub origin: SeedOrigin,
    /// The sentence, verbatim. This view renders it rather than writing its
    /// own — see `views::chain_seed`.
    pub text: String,
    /// What has to happen before it is recoverable, in order.
    pub steps: Vec<String>,
    /// Why the last attempt to publish it did not land, when one was made.
    #[serde(rename = "lastAttempt")]
    #[serde(default)]
    pub last_attempt: Option<String>,
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
}
