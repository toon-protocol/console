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
/* Funds: deposits, gas, balances and payment channels (TOON_Network#90,147). */
/* -------------------------------------------------------------------------- */
//
// Mirrors the "Funding" section of `packages/ui/src/lib/daemon.ts` field for
// field. A closed-vocabulary discriminator that this module only ever
// compares or prints (`FundingStatus::state`, `ChannelView::phase`,
// `GasBuyChain::verdict`, ...) is kept as a `String`, matching
// `AnonTransportView::state` above — an unknown value must still render as
// itself rather than fail the whole view to deserialize.

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

/// A Chain Seed that exists on one disk and nowhere else (#120).
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
}
