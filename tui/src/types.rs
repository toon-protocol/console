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
    },
    #[serde(rename = "silent")]
    Silent { reason: String },
    #[serde(rename = "refused")]
    Refused { code: String, message: String },
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
