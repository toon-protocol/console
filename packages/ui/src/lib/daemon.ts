import { launchToken } from './launch-token';

/**
 * The daemon's API, as the UI sees it.
 *
 * These types are a hand-kept mirror of `@toon-protocol/console-daemon`'s
 * answers rather than an import: the daemon builds for Node and its package
 * root reaches for `node:fs` (ADR 0019's first reason for a local daemon at
 * all), so pulling its types into a browser bundle would pull its runtime too.
 * The `/api/health` test in the daemon package is what keeps the two honest.
 */

export interface DaemonInfo {
  name: string;
  version: string;
  node: string;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
}

export interface ProfileView {
  id: string;
  label: string;
  description: string;
  connectorUrl: string;
  relayUrl: string;
  gatewayDomain: string;
  /** The Workload Gateway's own connector, where a handover is sealed (§12.1). */
  gatewayConnectorUrl: string;
  /** The gas station's own connector (TOON_Network#119). */
  gasConnectorUrl: string;
  faucetUrl?: string;
  rpc: { evm?: string; solana?: string };
  origin: 'built-in' | 'user';
  configured: boolean;
  active: boolean;
  /** Which endpoint fields a person has overridden (or, for a profile with
   * no built-in, simply set) — `"connectorUrl"`, `"rpc.evm"`, etc. Empty for
   * a built-in nobody has touched (TOON_Network#150). */
  overriddenFields: string[];
}

/** `PUT /api/profiles/<id>`'s body (TOON_Network#150) — every endpoint field
 * the WHOLE override for this call (a field left out falls through to the
 * built-in), plus the label a brand-new id needs. Mirrors
 * `profile-store.ts`'s `ProfileEndpointsInput`. */
export interface ProfileEndpointsInput {
  label?: string;
  description?: string;
  connectorUrl?: string;
  relayUrl?: string;
  gatewayDomain?: string;
  gatewayConnectorUrl?: string;
  gasConnectorUrl?: string;
  faucetUrl?: string;
  rpc?: { evm?: string; solana?: string };
}

export interface SettlementView {
  chain: string;
  kind: 'evm' | 'solana';
  settlementAddress: string;
  tokenAddress: string;
  decimals: number;
}

export interface RouteView {
  prefix: string;
  price: string;
  pricePerKib?: string;
}

export type ConnectorHealth =
  | { state: 'unconfigured'; reason: string }
  | { state: 'unreachable'; endpoint: string; reason: string }
  | {
      state: 'ok';
      endpoint: string;
      /** What the connector calls itself — a channel is keyed by this, not `endpoint` (TOON_Network#126). */
      selfEndpoint: string;
      ilpAddresses: string[];
      settlements: SettlementView[];
      routes: RouteView[];
      peerCarriages: string[];
      edgeKeyId?: string;
      supportedVersions: number[];
    };

/**
 * The Anyone Protocol carriage (TOON_Network#98, spec §10).
 *
 * Reported here and nowhere else, because this is the one place the SOCKS
 * port itself is named: everything that rides it says "over a circuit" and
 * leaves the port alone. `unconfigured` is not a fault — a console with no
 * proxy works on every clearnet provider and refuses, out loud, on a hidden
 * one.
 */
export interface AnonTransportView {
  state: 'unconfigured' | 'ready' | 'unreachable' | 'misconfigured';
  socksProxy?: string;
  reason: string;
}

export interface Health {
  daemon: DaemonInfo;
  profile: ProfileView;
  connector: ConnectorHealth;
  anon?: AnonTransportView;
  storage: { data: string; config: string; runtime: string; channels: string };
  checkedAt: string;
}

export interface Profiles {
  activeId: string;
  profiles: ProfileView[];
}

/**
 * The Provider Directory, as the daemon assembled it (TOON_Network#91).
 *
 * A mirror of `packages/daemon/src/directory.ts`, for the same reason as
 * everything above it. Nothing here is computed in the browser except the
 * liveness countdown, which has to be: a Liveness expires on the wall clock,
 * so a page that only knew what the daemon said at read time would go on
 * claiming a provider was up minutes after it went quiet.
 */

export interface DirectoryFilters {
  isolation?: string;
  arch?: string;
  /** A `<vendor>-<model>` label, or `any` for "some GPU". */
  gpu?: string;
  /** Every one of these must be granted, not any of them. */
  capabilities?: string[];
  /** Unset shows Hidden Providers alongside the rest. */
  hidden?: boolean;
}

export interface ProviderProfileView {
  ilpAddress: string;
  connectorUrl: string;
  connectorSealKey: string;
  relays: string[];
  settlement: { chain: string; token: string; decimals: number }[];
  isolation: string;
  hidden: boolean;
  host?: string;
  livenessCadenceSeconds?: number;
  publishedAt: string;
  eventId: string;
}

export interface ListingView {
  name: string;
  address: string;
  version: number;
  resources: { cpuMillicores: number; memoryMb: number; storageGb: number; gpu?: string };
  arch: string;
  isolation: string;
  hidden: boolean;
  leaseIntervalSeconds: number;
  /** µUSDC for one Lease Interval. */
  price: number;
  standbyPrice?: number;
  capabilities: string[];
  unspecifiedCapabilities: string[];
  geohash?: string;
  publishedAt: string;
  eventId: string;
  available?: number;
}

export type LivenessState = 'live' | 'stale' | 'unknown';

export interface LivenessView {
  state: LivenessState;
  publishedAt?: string;
  expiresAt?: string;
  secondsUntilExpiry?: number;
  cadenceSeconds?: number;
}

export interface ProviderView {
  pubkey: string;
  profile: ProviderProfileView;
  liveness: LivenessView;
  listings: ListingView[];
  relaysRead: string[];
  supersededListings: number;
  rejectedListings: { name: string; reason: string }[];
}

export interface RelayOutcome {
  url: string;
  state: 'read' | 'timeout' | 'failed';
  events: number;
  reason?: string;
}

export type Directory =
  | {
      state: 'ok';
      relays: { seed: string[]; read: RelayOutcome[] };
      filters: DirectoryFilters;
      providers: ProviderView[];
      listingsWithoutProfile: number;
      rejectedEvents: number;
      readAt: string;
    }
  | { state: 'unconfigured'; reason: string };

/**
 * The Template gallery (TOON_Network#94, spec §8.3).
 *
 * The same hand-kept mirror as the directory above. Two things about this one
 * are worth saying out loud, because the window is where they could go wrong:
 *
 * A Template GRANTS NO CAPABILITY (ADR 0004), so there is no field for one
 * here and there must never be. What a lease may do comes from its Listing.
 *
 * And the window does not expand a Template. It posts which Template and what
 * the person typed, and the daemon — which re-reads the publisher's signed
 * event — decides what is settable and builds the spawn. That is why
 * `ExpandedTemplate` comes back rather than being assembled here: the
 * "tenant-settable only" rule has to be enforced somewhere a stale tab cannot
 * reach.
 */

export interface TemplatePort {
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface TemplateResources {
  cpuMillicores: number;
  memoryMb: number;
  storageGb: number;
  gpu?: string;
}

export interface ImageBlob {
  digest: string;
  size: number;
  mediaType: string;
  source:
    | { type: 'toon-store'; blobRecordTxid: string }
    | { type: 'oci'; registry: string; repository: string };
}

export interface ImageEntryView {
  address: string;
  /** `<publisher npub>/<name>:<tag>`, §8.1's canonical name for the image. */
  canonicalName: string;
  digest: string;
  mediaType: string;
  blobs: ImageBlob[];
  signer: string;
  publishedAt: string;
  eventId: string;
}

export interface BlobRecordView {
  digest: string;
  size: number;
  partSize: number;
  shape: 'inline' | 'paged';
  parts: number;
  publishedAt: string;
  eventId: string;
  signer: string;
}

export type TemplateAvailability =
  | {
      state: 'available';
      /** What was checked — records, not bytes. Shown, so it cannot overclaim. */
      checked: string;
      entry?: ImageEntryView;
      blobRecord?: BlobRecordView;
    }
  | { state: 'unavailable'; reason: string };

export interface PublisherView {
  pubkey: string;
  npub: string;
  name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
}

export interface TemplateView {
  name: string;
  address: string;
  publisher: PublisherView;
  version: number;
  image: { digest: string; registryEntry?: { address: string; relay?: string } };
  ports: TemplatePort[];
  dataPath?: string;
  envFixed: Record<string, string>;
  envTenant: string[];
  minResources?: TemplateResources;
  /** Informational, not part of §8.3's shape: see `templates.ts`'s own field. */
  sshOffered: boolean;
  availability: TemplateAvailability;
  warnings: string[];
  publishedAt: string;
  eventId: string;
}

export type TemplateGallery =
  | {
      state: 'ok';
      relays: { seed: string[]; read: RelayOutcome[] };
      templates: TemplateView[];
      rejected: { address: string; name: string; reason: string }[];
      rejectedEvents: number;
      readAt: string;
    }
  | { state: 'unconfigured'; reason: string };

/** §6.2's spawn content, in the wire's own spelling. Never rewritten here. */
export interface SpawnContent {
  workload_id: string;
  image: {
    digest: string;
    reference?: string;
    registry_entry?: { address: string; relay?: string };
  };
  env: Record<string, string>;
  ports: { container_port: number; protocol: 'tcp' | 'udp' }[];
  volume_gb?: number;
  ssh_public_key: string;
  entrypoint?: string[];
  args?: string[];
  standby_set?: string[];
  template?: string;
}

export interface ExpandedTemplate {
  template: string;
  spawn: SpawnContent;
  /** `template.sshOffered`, echoed: whether `spawn.ssh_public_key` is real. */
  sshOffered: boolean;
  warnings: string[];
}

export interface TemplateSettings {
  env?: Record<string, string>;
  sshPublicKey: string;
  volumeGb?: number;
  workloadId?: string;
  standbySet?: string[];
}

/**
 * The Account, its Signer and the local keystore (TOON_Network#88).
 *
 * Note what is NOT here and never will be: an nsec, a mnemonic, a passphrase
 * or a bunker secret. Those go one way — typed into a form, posted once, and
 * sealed by the daemon — and the answer to every account call is this shape.
 */

export interface AccountMetadata {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  publishedAt?: string;
}

export interface AccountProfile {
  metadata?: AccountMetadata;
  relays: string[];
  relaySource: 'nip65' | 'profile' | 'none';
  readAt: string;
}

export interface SignerRecord {
  id: string;
  kind: 'local' | 'remote';
  label: string;
  pubkey: string;
  npub: string;
  backend: 'libsecret' | 'file';
  origin?: 'generated' | 'nsec' | 'nip06';
  bunkerRelays?: string[];
  bunkerPubkey?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AccountView {
  pubkey: string;
  npub: string;
  signerId: string;
  signerKind: 'local' | 'remote';
  signerLabel: string;
  signedInAt: string;
  profileState: 'loading' | 'ready' | 'none';
  profile?: AccountProfile;
}

export interface Invitation {
  uri: string;
  state: 'waiting' | 'failed';
  expiresAt: string;
  error?: string;
}

export interface SessionStatus {
  signedIn: boolean;
  account?: AccountView;
  signers: SignerRecord[];
  keystore: { backend: 'libsecret' | 'file'; location: string; needsPassphrase: boolean };
  invitation?: Invitation;
}

export interface SignedEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface LocalSignerRequest {
  mode: 'generate' | 'nsec' | 'nip06';
  nsec?: string;
  mnemonic?: string;
  mnemonicPassphrase?: string;
  accountIndex?: number;
  label?: string;
  passphrase?: string;
}

/**
 * The Chain Seed (TOON_Network#89, ADR 0020).
 *
 * Note what a `ChainSeedStatus` carries: addresses, paths, relay outcomes and
 * one warning. There is no mnemonic field, and there is no route that would
 * return one — the console shows an account where its money goes, never the
 * words that unlock it. Recovery is through the account's Nostr key, which is
 * the whole point of sealing the seed to it, so a "reveal" would be a second
 * and weaker custody story sitting next to the real one.
 */

export interface ChainAddress {
  address: string;
  path: string;
}

export interface ChainAddresses {
  evm: ChainAddress;
  solana: ChainAddress;
}

export interface SeedRecordView {
  eventId: string;
  publishedAt: string;
  source: 'cache' | 'relays';
  relays: string[];
}

export interface RelayListView {
  state: 'unknown' | 'none' | 'present';
  read: string[];
  write: string[];
  publishedAt?: string;
}

/** One relay a write would go to, or the reason it would not. */
export interface RelayWriteTarget {
  url: string;
  ready: boolean;
  destination?: string;
  payAt?: string;
  price?: string;
  carriage?: 'http' | 'btp';
  chain?: string;
  channelId?: string;
  /** `document` when the relay named its own edge, else the profile's. */
  via?: 'document' | 'profile-connector';
  /** Set exactly when `ready` is false. */
  code?: string;
  reason?: string;
}

/**
 * Where a paid write goes, what it costs, and what stops it
 * (TOON_Network#120, #121).
 *
 * Every relay write the console makes is a TOON packet paid from the
 * account's own channel, so this is the shape of "can I write at all" —
 * and every figure in it is one a connector quoted, never one computed
 * here.
 *
 * A record goes to every relay in the account's NIP-65 write list the console
 * can pay, so `plan` is the whole answer and the scalars are the first payable
 * relay's. `ready` is true when ONE relay can be paid, because a record that
 * reaches one relay is published.
 */
export interface RelayWriteTargets {
  relays: string[];
  /** Every relay considered, payable or not, with the reason either way. */
  plan: RelayWriteTarget[];
  destination?: string;
  payAt?: string;
  /** Base units per write at the first payable relay, verbatim. */
  price?: string;
  /** Every payable relay's price summed: what one record costs to publish. */
  totalPrice?: string;
  chain?: string;
  channelId?: string;
  ready: boolean;
  blockedBy?: string;
}

export interface RelayWriteOutcome {
  url: string;
  destination?: string;
  payAt?: string;
  price?: string;
  carriage?: 'http' | 'btp';
  /** `unpayable` is a relay no packet was ever sent to, and never billed. */
  state: 'written' | 'refused' | 'unknown' | 'unpayable';
  reason?: string;
  code?: string;
  /** What it cost — present on a refusal too: a refusal is billed. */
  cost?: string;
}

export interface PublishReport {
  at: string;
  what: 'chain-seed' | 'relay-list';
  relays: RelayWriteOutcome[];
  accepted: string[];
  cost?: string;
  destination?: string;
  payAt?: string;
  chain?: string;
}

/** A Chain Seed that exists on one disk and nowhere else (#120). */
export interface HeldSeedView {
  since: string;
  origin: 'minted' | 'imported';
  text: string;
  steps: string[];
  lastAttempt?: string;
}

export interface ChainSeedStatus {
  state: 'signed_out' | 'unknown' | 'absent' | 'not_yet_recoverable' | 'ready' | 'unreadable';
  pubkey?: string;
  addresses?: ChainAddresses;
  origin?: 'minted' | 'imported';
  /** The PUBLISHED record. Absent while a seed is only held. */
  record?: SeedRecordView;
  /** Set exactly when `state` is `not_yet_recoverable`. */
  held?: HeldSeedView;
  relayList: RelayListView;
  writes: RelayWriteTargets;
  warning: { text: string; acknowledgedAt?: string };
  supersededSeeds: number;
  lastPublish?: PublishReport;
  reason?: string;
  checkedAt: string;
}

/**
 * Funding: deposits, gas, balances and payment channels (TOON_Network#90).
 *
 * The same hand-kept mirror as everything above, and the same rule as the
 * Chain Seed's: nothing here is a mnemonic or a key, and there is no route
 * that would answer one. What an account sees is an address, the path it came
 * from, what the chains say it holds, and what its channel is worth.
 *
 * Note the three shapes that exist so that the UI cannot round a bad answer
 * up into a good one. `BalanceView.state` is `unknown` for a chain that could
 * not be read, and carries no figures at all rather than zeroes.
 * `ChannelView.phase` has `opening`, which is neither open nor failed.
 * `GasView.verdict` has `unknown`, which is neither "you are fine" nor "you
 * are stuck".
 */

export interface Amount {
  /** Base units, as a decimal string. Big enough to need one. */
  amount: string;
  decimals?: number;
  symbol?: string;
  address?: string;
}

export interface BalanceView {
  state: 'unknown' | 'read';
  native?: Amount;
  token?: Amount;
  reason?: string;
  readAt?: string;
}

export interface GasView {
  verdict: 'unknown' | 'none' | 'present';
  symbol?: string;
  headline: string;
  detail: string;
  command?: string;
  faucetGivesGas: boolean;
}

export type ChannelPhase = 'none' | 'opening' | 'open' | 'closing' | 'settled' | 'failed';

export interface ChannelView {
  phase: ChannelPhase;
  channelId?: string;
  deposit?: string;
  spent?: string;
  available?: string;
  nonce?: number;
  openedAt?: string;
  startedAt?: string;
  txHash?: string;
  reason?: string;
  outOfGas?: boolean;
  watermarkUncertain?: boolean;
}

export interface ChainFundingView {
  /** `evm:84532`, or `solana` — the connector's own word for it. */
  chain: string;
  kind: 'evm' | 'solana';
  counterparty: string;
  token: { address: string; decimals: number };
  deposit: ChainAddress;
  rpc: { url: string; source: 'profile' | 'client-default' };
  balances: BalanceView;
  gas: GasView;
  channel: ChannelView;
  canOpen: boolean;
  blockedBy?: string;
  suggestedDeposit?: string;
}

export interface QuoteView {
  route: string;
  price: string;
  pricePerKib?: string;
  packets: number;
}

export interface FaucetChainView {
  kind: 'evm' | 'solana';
  name: string;
  ready: boolean;
  route?: string;
  drips: { asset: string; amount: string }[];
  cooldownHours?: string;
}

export interface FaucetView {
  url: string;
  state: 'unknown' | 'ready' | 'unreachable';
  reason?: string;
  chains: FaucetChainView[];
  givesGas: boolean;
  lastDrip?: {
    chain: string;
    at: string;
    state: 'delivered' | 'refused';
    message: string;
  };
}

export interface FundingStatus {
  state: 'signed_out' | 'unconfigured' | 'connector_unreachable' | 'no_seed' | 'ready';
  profile: { id: string; label: string };
  pubkey?: string;
  custody: { text: string; acknowledgedAt?: string };
  supersededSeeds: number;
  /** Set while the seed behind these addresses is not yet recoverable (#120). */
  heldSeed?: HeldSeedView;
  chains: ChainFundingView[];
  quote?: QuoteView;
  faucet?: FaucetView;
  channelStorePath?: string;
  reason?: string;
  checkedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Buying the next chain's gas (TOON_Network#119)                             */
/* -------------------------------------------------------------------------- */

export type GasBuyVerdict =
  | 'buyable'
  | 'not_blocked'
  | 'unsupported'
  | 'no_station'
  | 'station_unreachable'
  | 'no_route'
  | 'no_channel'
  | 'unaffordable';

export interface GasPayer {
  /** The chain whose channel signs the claim. Never the chain being bought for. */
  chain: string;
  channelId: string;
  available?: string;
  payAt: string;
  via: 'station-connector' | 'forwarded';
}

export interface GasBuyChain {
  chain: string;
  kind: 'evm' | 'solana';
  /** Where bought gas would land: this account's own address on that chain. */
  recipient: string;
  verdict: GasBuyVerdict;
  reason: string;
  payer?: GasPayer;
  destination?: string;
  price?: string;
  lamports?: string;
  /**
   * A connector to open a channel with, when that is what stands between this
   * account and a door the gas station publishes. Pass it as `connector` to
   * `openChannel` (#92).
   */
  openChannelWith?: string;
}

export interface GasStationView {
  connectorUrl: string;
  selfEndpoint?: string;
  doors: string[];
  reachable: boolean;
  reason?: string;
}

export interface GasStationStatus {
  state: 'signed_out' | 'unconfigured' | 'no_station' | 'ready';
  station?: GasStationView;
  chains: GasBuyChain[];
  /** Present exactly when this account holds no channel anywhere. */
  firstChannel?: string;
  reason?: string;
  checkedAt: string;
}

/** One packet, and what it cost — refusals included, because they are billed. */
export interface GasAttempt {
  destination: string;
  phase: 'quote' | 'execute';
  outcome: 'receipt' | 'refused' | 'unknown';
  code?: string;
  message?: string;
  cost?: string;
}

export interface GasQuote {
  chain: string;
  quoteId: string;
  feePayer: string;
  recipient: string;
  lamports: string;
  maxLamports: string;
  recentBlockhash: string;
  /** ms epoch: quote TTL and blockhash validity, merged into one deadline. */
  expiresAt: number;
  destination: string;
  payAt: string;
  price: string;
  cost?: string;
  attempts: GasAttempt[];
}

export interface GasPurchase {
  chain: string;
  state: 'delivered' | 'refused' | 'unknown';
  signature?: string;
  slot?: string;
  lamports?: string;
  recipient: string;
  /** The station's own closed vocabulary. Branch on this, never on `detail`. */
  reason?: string;
  detail?: string;
  attempts: GasAttempt[];
  cost?: string;
  at: string;
}

/**
 * Leases: spawning a workload and the Lease Vault (TOON_Network#92, ADR 0021).
 *
 * The same hand-kept mirror as everything above, and the sharpest version of
 * the same rule: **there is no Root Secret in any of these types.** The secret
 * is minted in the daemon, sealed to the account and published to its relays;
 * nothing sends one to this window and nothing could, because `LeaseView` has
 * no field for it. What the browser holds is a workload id, a provider, and
 * where the workload answers.
 */

export interface LeasePort {
  container_port: number;
  protocol: 'tcp' | 'udp';
}

export interface LeaseImage {
  reference?: string;
  digest: string;
  registry_entry?: { address: string; relay?: string };
}

export interface LeaseAccess {
  host: string;
  ssh_port?: number;
  ports?: { container_port: number; host_port: number }[];
}

export interface LeaseMemberView {
  pubkey: string;
  index: number;
  /** Its position in the set, which a Takeover never changes (§6.7). */
  role: 'standalone' | 'primary' | 'standby';
  provider: {
    pubkey: string;
    ilp_address: string;
    connector_url: string;
    connector_seal_key: string;
    hidden?: boolean;
  };
  listing: {
    name: string;
    version: number;
    address: string;
    lease_interval_s: number;
    price: number;
  };
  paidAt: string;
  paidChain?: string;
  state: 'spawning' | 'live' | 'failed';
  failedBecause?: string;
  answeredRole?: string;
  expiresAt?: number;
  access?: LeaseAccess;
  known: boolean;
}

export interface LeaseView {
  workloadId: string;
  state: 'spawning' | 'live' | 'retracted';
  standbySet: string[];
  /** One per name in `standbySet`, primary first (§7). Never empty. */
  members: LeaseMemberView[];
  provider: {
    pubkey: string;
    ilp_address: string;
    connector_url: string;
    connector_seal_key: string;
    hidden?: boolean;
  };
  paidAt: string;
  listing: {
    name: string;
    version: number;
    address: string;
    lease_interval_s: number;
    price: number;
  };
  profileId: string;
  image: LeaseImage;
  ports: LeasePort[];
  envKeys: string[];
  /** Whether `access.ssh_port` is worth showing: see `lease-vault.ts`'s own field. */
  sshOffered: boolean;
  createdAt: string;
  /** Marked local only: this lease's record is on this machine and nowhere else. */
  localOnly: boolean;
  role?: string;
  expiresAt?: number;
  access?: LeaseAccess;
  retractedBecause?: string;
  source: 'cache' | 'relays';
  relays: string[];
  recordId: string;
}

export interface LeaseVaultStatus {
  state: 'signed_out' | 'unknown' | 'ready';
  pubkey?: string;
  leases: LeaseView[];
  /** Where a vault record would go, what it costs, and what stops it. */
  writes: RelayWriteTargets;
  unreadable: number;
  lastPublish?: {
    at: string;
    workloadId: string;
    what: 'stage' | 'confirm' | 'retract';
    relays: RelayWriteOutcome[];
    accepted: string[];
    cost?: string;
    destination?: string;
    payAt?: string;
    chain?: string;
  };
  checkedAt: string;
}

export interface PreflightView {
  ok: boolean;
  /** Everything wrong with this spawn, before any of it costs an interval. */
  problems: string[];
  provider?: {
    pubkey: string;
    ilpAddress: string;
    connectorUrl: string;
    hidden: boolean;
    liveness: string;
  };
  listing?: {
    name: string;
    version: number;
    leaseIntervalSeconds: number;
    price: number;
    capabilities: string[];
  };
  route?: string;
  payment?: {
    connectorUrl: string;
    via: 'profile-connector' | 'provider-connector';
    reason: string;
    chain?: string;
    channelId?: string;
    routePrice?: string;
    overAnon?: boolean;
    rpcOverAnon?: boolean;
  };
  /** Where the Root Secret would be written, and what THAT write costs. */
  vault: { localOnly: boolean; writes: RelayWriteTargets };
}

export interface SpawnResult {
  lease?: LeaseView;
  preflight: PreflightView;
  answer?: unknown;
  /** What the packet cost, in base units of the settlement token. */
  cost?: string;
  retractionFailed?: string;
  confirmationFailed?: string;
}

/**
 * What the Standby Set form posts (§7).
 *
 * The primary is the ordinary spawn body; `standbys` names the rest of the
 * set, each with the tier its reservation is bought on — two providers need
 * not publish the same tier, the same version or the same `standby_price`.
 */
export interface StandbySetRequestBody extends SpawnRequestBody {
  standbys: { provider: string; listing: string; listingVersion?: number; chain?: string }[];
}

export interface MemberPlanView {
  pubkey: string;
  index: number;
  role: 'primary' | 'standby';
  view: PreflightView;
}

export interface StandbySetPreflightView {
  ok: boolean;
  problems: string[];
  workloadId?: string;
  members: MemberPlanView[];
  cost?: string;
  vault: { localOnly: boolean; writes: RelayWriteTargets };
}

export interface MemberSpawnResult {
  pubkey: string;
  index: number;
  role: 'primary' | 'standby';
  route?: string;
  sent: boolean;
  ok: boolean;
  cost?: string;
  expiresAt?: number;
  access?: LeaseAccess;
  providerError?: string;
  message?: string;
}

export interface StandbySetResult {
  lease?: LeaseView;
  preflight: StandbySetPreflightView;
  members: MemberSpawnResult[];
  cost?: string;
  confirmationFailed?: string;
}

/** What the form posts. The daemon builds the Lease Request from it (§6.2). */
export interface SpawnRequestBody {
  provider: string;
  listing: string;
  image: {
    reference?: string;
    digest: string;
    registryEntry?: { address: string; relay?: string };
  };
  env?: Record<string, string>;
  ports?: { containerPort: number; protocol?: 'tcp' | 'udp' }[];
  sshPublicKey: string;
  volumeGb?: number;
  entrypoint?: string[];
  args?: string[];
  template?: string;
  localOnly?: boolean;
  /** `evm:84532`, `solana` — as the paying connector names it. */
  chain?: string;
}

/**
 * The documentation (TOON_Network#102), as the daemon assembled it.
 *
 * A mirror of `packages/daemon/src/docs.ts`, for the same reason as every
 * other type in this file. The interesting field is `source`: a page is
 * either the NIP-23 article the relays hold or the Markdown this console
 * shipped with, and which one it is belongs above the text a person reads.
 */
export interface DocSummary {
  d: string;
  title: string;
  summary: string;
  order: number;
  publishedAt: string;
  tags: string[];
  source: 'relays' | 'bundled';
  /** `30023:<pubkey>:<d>`, on a published page. */
  address?: string;
  updatedAt?: string;
}

export interface DocArticle extends DocSummary {
  markdown: string;
}

export interface DocsIndex {
  author?: { npub: string; pubkey: string };
  relays: string[];
  read: { url: string; state: string; events: number; reason?: string }[];
  /** Why the bundled copy is showing, when it is. A sentence for a banner. */
  fallback?: string;
  docs: DocSummary[];
  readAt: string;
}

export interface DocsPage extends DocsIndex {
  doc: DocArticle;
}

/**
 * The dashboard (TOON_Network#93, spec §6.3, §6.5, §6.6, §6.7).
 *
 * The same hand-kept mirror as everything above, and two things about these
 * shapes are load-bearing in the window rather than merely descriptive.
 *
 * **`WorkloadStatus` has four kinds**, and the page must branch on all four. A
 * provider that has gone `silent` has told us nothing about the lease; one
 * that `refused` has told us something definite; `unread` is this console's
 * own failure to ask. Collapsing them into "error" is the bug this type
 * exists to prevent.
 *
 * **`LeaseLife` keeps §6.7's three endings apart.** Expiry is nobody paying,
 * Termination is the tenant, Eviction is the provider — three different things
 * that happened, and a card that said "gone" for all three would be hiding the
 * only part worth knowing.
 *
 * And what is NOT here: a Root Secret, and a Continuation Token. The token is
 * derived in the daemon for the length of one packet. Nothing sends one to
 * this window and nothing could, because none of these types has a field for
 * one.
 */

export type LeaseEnding = 'expiry' | 'termination' | 'eviction' | 'unstated';

export type LeaseLife =
  | { phase: 'provisioning' | 'reserved' | 'running' | 'stopped' }
  | { phase: 'ended'; ending: LeaseEnding; word?: string };

export type WorkloadStatus =
  | {
      kind: 'read';
      life: LeaseLife;
      role?: string;
      expiresAt?: number;
      access?: LeaseAccess;
      template?: string;
      takeover?: { winner: string };
      cost?: string;
      readAt: string;
    }
  | { kind: 'silent'; reason: string; cost?: string; readAt: string }
  | { kind: 'refused'; code: string; message: string; cost?: string; readAt: string }
  | { kind: 'unread'; reason: string; readAt: string };

export interface RunwayView {
  state: 'computed' | 'unbounded' | 'unknown';
  reason?: string;
  /** µUSDC per Lease Interval, as the Listing priced it. */
  listingPrice: number;
  leaseIntervalSeconds: number;
  /** What one extension costs where it would be paid. The connector's figure. */
  pricePerInterval?: string;
  payAt?: string;
  chain?: string;
  channelId?: string;
  available?: string;
  affordableIntervals?: number;
  paidSeconds?: number;
  paidUntil?: string;
  expirySource?: 'provider' | 'vault';
  /** The whole SET's figure, bounded by the member that runs out first (§7). */
  seconds?: number;
  until?: string;
  /** What one round of extensions for every member costs, base units. */
  setPricePerInterval?: string;
  rounds?: number;
  boundBy?: string;
  memberRunways?: {
    pubkey: string;
    index: number;
    paidSeconds?: number;
    pricePerInterval?: string;
    op?: 'extend' | 'standby.extend';
    leaseIntervalSeconds: number;
    channelKey?: string;
    available?: string;
    unknown?: string;
    ended?: boolean;
  }[];
  readAt: string;
}

export interface OpRouteView {
  route: string;
  payAt: string;
  via: 'profile-connector' | 'provider-connector';
  reason: string;
  price?: string;
  chain?: string;
  channelId?: string;
  /** This packet rides an Anyone Protocol circuit (§10). */
  overAnon?: boolean;
  /** …and so does the chain RPC behind its channel (ADR 0008). */
  rpcOverAnon?: boolean;
}

export interface AutoExtendView {
  armed: boolean;
  budget: string;
  spent: string;
  remaining: string;
  extensions: number;
  agreedPrice: string;
  leadSeconds: number;
  armedAt: string;
  lastRun?: {
    at: string;
    outcome: 'extended' | 'waited' | 'stopped';
    reason: string;
    cost?: string;
    members?: string[];
  };
  stoppedBecause?: string;
}

/**
 * A Takeover, as the dashboard reports it (§7.1, ADR 0010).
 *
 * `announcedAt` is the winner's own signed moment, from its kind-30433 claim.
 * `firstSeenAt` is when THIS CONSOLE noticed, and the card says so rather than
 * passing one off as the other.
 */
export interface TakeoverReport {
  winner: string;
  from?: string;
  rounds?: number;
  announcedAt?: string;
  firstSeenAt: string;
  seenBy: 'status' | 'claim';
  claims?: { claimant: string; index: number; primary: string; announcedAt: string }[];
}

export interface WorkloadMemberView {
  pubkey: string;
  index: number;
  role: 'standalone' | 'primary' | 'standby';
  provider: {
    ilpAddress: string;
    connectorUrl: string;
    hidden: boolean;
    liveness?: string;
    inDirectory: boolean;
  };
  listing: LeaseView['listing'];
  status: WorkloadStatus;
  extend: {
    ok: boolean;
    op: 'extend' | 'standby.extend';
    problems: string[];
    route?: OpRouteView;
  };
  /** True when this member is the one the workload is running on. */
  runningNow: boolean;
  /** A primary that stopped its OWN workload under §7.1. Not an ending. */
  selfStopped: boolean;
  vaultState: 'spawning' | 'live' | 'failed';
  failedBecause?: string;
  known: boolean;
}

export interface StandbySetView {
  members: number;
  warm: boolean;
  pricePerInterval?: string;
  reason?: string;
  runningMember?: string;
  takeover?: TakeoverReport;
  takeoverUnread?: string;
}

export interface WorkloadCard {
  workloadId: string;
  lease: LeaseView;
  provider: {
    pubkey: string;
    ilpAddress: string;
    connectorUrl: string;
    hidden: boolean;
    liveness?: string;
    inDirectory: boolean;
    /** Why a provider that calls itself hidden is not (§10, ADR 0008). */
    notHidden?: string;
  };
  status: WorkloadStatus;
  runway: RunwayView;
  extend: { ok: boolean; problems: string[]; route?: OpRouteView };
  /** Every member of the Standby Set, primary first (§7). Never empty. */
  members: WorkloadMemberView[];
  set: StandbySetView;
  autoExtend?: AutoExtendView;
  endedAs?: LeaseEnding;
}

export interface Dashboard {
  state: 'signed_out' | 'unknown' | 'ready';
  pubkey?: string;
  profileId: string;
  cards: WorkloadCard[];
  unreadable: number;
  checkedAt: string;
}

export interface ExtendResult {
  /** `false` means nothing was sent and nothing was paid. */
  sent: boolean;
  problems: string[];
  route?: OpRouteView;
  /** Which member of the Standby Set this bought an interval for (§7). */
  member: string;
  op: 'extend' | 'standby.extend';
  cost?: string;
  expiresAt?: number;
  providerError?: string;
  message?: string;
  card: WorkloadCard;
}

export interface TerminateResult {
  sent: boolean;
  problems: string[];
  route?: OpRouteView;
  cost?: string;
  ended?: LeaseEnding;
  providerError?: string;
  message?: string;
  card: WorkloadCard;
}

/* -------------------------------------------------------------------------- */
/* The hostname (TOON_Network#97, spec §12)                                   */
/* -------------------------------------------------------------------------- */

/**
 * What this console handed to a Workload Gateway.
 *
 * Note the field that is not here and never will be: the **Gateway Grant**. A
 * grant reads one lease's `status` until the moment it names, so it is a
 * secret exactly as the Continuation Token it derives from is. It is derived
 * in the daemon for the length of one sealed message. Nothing sends one to
 * this window and nothing could, because none of these types has a field for
 * one.
 */
export interface GatewayHandoverNote {
  hostname: string;
  expiresAt: number;
  httpPort: number;
  name?: string;
  standbySet: string[];
  connectorUrl: string;
  route: string;
  at: string;
  withdrawnAt?: string;
}

/** What the hostname itself answered, when the window asked for a knock. */
export type ServingView =
  | { kind: 'serving'; status: number; excerpt?: string; at: string }
  | { kind: 'no_grant'; message: string; at: string }
  | { kind: 'refused'; reason: string; status: number; message: string; at: string }
  | { kind: 'unreachable'; message: string; at: string };

export interface GatewayEdgeView {
  connectorUrl: string;
  ilpAddress: string;
  route: string;
  price?: string;
  domain: string;
}

export interface GatewayView {
  workloadId: string;
  hostname?: string;
  gateway?: GatewayEdgeView;
  handover?: GatewayHandoverNote;
  held: boolean;
  expired?: boolean;
  problems: string[];
  ok: boolean;
  ports: number[];
  httpPort?: number;
  serving?: ServingView;
  checkedAt: string;
}

export interface HandoverResult {
  sent: boolean;
  problems: string[];
  route?: OpRouteView;
  cost?: string;
  /** What the gateway answered. */
  hostname?: string;
  /** What the daemon derived for itself from the workload id (§12.2). */
  expectedHostname?: string;
  matches?: boolean;
  expiresAt?: number;
  gatewayError?: string;
  message?: string;
  view: GatewayView;
}

export interface WithdrawalResult {
  sent: boolean;
  problems: string[];
  route?: OpRouteView;
  cost?: string;
  hostname?: string;
  withdrawn?: boolean;
  gatewayError?: string;
  message?: string;
  view: GatewayView;
}

/* -------------------------------------------------------------------------- */
/* Rotation (TOON_Network#96, spec §6.8, ADR 0018)                            */
/* -------------------------------------------------------------------------- */

/**
 * What a rotation looks like from the window.
 *
 * Note, again, the fields that are not here and never will be: the lease's
 * **Root Secret**, the rotation's new one, and any Continuation Token derived
 * from either. A rotation is the one operation with TWO secrets to not carry,
 * and none of these types has a field for one.
 */
export interface RotationMemberView {
  pubkey: string;
  index: number;
  role: 'standalone' | 'primary' | 'standby';
  /** True once this member holds a token of the new Root Secret. */
  confirmed: boolean;
  ok: boolean;
  problems: string[];
  route?: OpRouteView;
  /** Left out: this member's own spawn was refused, so it holds no lease. */
  skipped?: boolean;
}

export interface RotationView {
  workloadId: string;
  /** A rotation is part-way through: some members hold the new token. */
  underWay: boolean;
  ok: boolean;
  problems: string[];
  members: RotationMemberView[];
  confirmed: number;
  of: number;
  startedAt?: string;
  rotatedAt?: string;
  vault: RelayWriteTargets;
  localOnly: boolean;
}

export interface RotationMemberResult {
  pubkey: string;
  index: number;
  role: 'standalone' | 'primary' | 'standby';
  sent: boolean;
  rotated: boolean;
  /** The answer was lost and a free `status` with the new token settled it. */
  recovered?: boolean;
  already?: boolean;
  /** Worth asking again with nothing changed — `unavailable`, or silence. */
  retryable?: boolean;
  route?: OpRouteView;
  cost?: string;
  providerError?: string;
  message?: string;
  problems?: string[];
}

export interface RotationResult {
  workloadId: string;
  /** False when the new Root Secret could not be recorded: nothing was sent. */
  started: boolean;
  /** True only when EVERY member confirmed. */
  rotated: boolean;
  problems: string[];
  members: RotationMemberResult[];
  confirmed: number;
  of: number;
  cost?: string;
  vaultCost?: string;
  vaultBehind?: string;
  view: RotationView;
}

export interface HandoverRequestBody {
  expiresAt?: number;
  expiresIn?: number;
  httpPort?: number;
  name?: string;
  chain?: string;
}

export class DaemonError extends Error {
  readonly status: number;
  /** The daemon's machine-readable code, e.g. `passphrase_required`. */
  readonly code: string;
  /** A provider's OWN refusal code, when a paid route refused (spec §5). */
  providerError?: string;
  /** Per-write detail on a paid write that did not land, when there is any. */
  readonly relays?: RelayWriteOutcome[];
  constructor(status: number, message: string, code = 'error', relays?: RelayWriteOutcome[]) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
    if (relays) this.relays = relays;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = launchToken();
  if (!token) {
    throw new DaemonError(
      401,
      'This window has no launch token. Open the console from its launcher, or from the `open:` URL the daemon printed.'
    );
  }
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
      relays?: RelayWriteOutcome[];
      providerError?: string;
    } | null;
    const failure = new DaemonError(
      response.status,
      problem?.message ?? `The daemon answered ${response.status}.`,
      problem?.error ?? 'error',
      problem?.relays
    );
    if (problem?.providerError !== undefined) failure.providerError = problem.providerError;
    throw failure;
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * The desktop around the window (TOON_Network#99).
 *
 * A mirror of `packages/daemon/src/desktop.ts`, for the same reason as every
 * other type in this file.
 */
export type MenuView = 'workloads' | 'new-workload' | 'funds';

export interface ThemeReading {
  source: 'omarchy' | 'default';
  name: string;
  mode: 'dark' | 'light';
  revision: string;
  /** A `:root { … }` rule the daemon built. Goes straight into a `<style>`. */
  css: string;
  /** Why the default theme is in use, when it is. */
  reason?: string;
  readAt: string;
}

export interface DesktopView {
  seq: number;
  theme: ThemeReading;
  open?: MenuView;
  openedAt?: string;
  at: string;
}

export const daemon = {
  health: (options: { refresh?: boolean } = {}) =>
    call<Health>(`/api/health${options.refresh ? '?refresh=1' : ''}`),
  profiles: () => call<Profiles>('/api/profiles'),

  /**
   * The desktop: this machine's theme, and whatever the Omarchy menu last
   * asked to be opened (TOON_Network#99).
   *
   * With `wait`, the daemon holds the request open until something changes or
   * about twenty-five seconds pass — so a theme switch reaches an open window
   * at once and an idle one costs nothing. `since` is the last `seq` seen, and
   * a window that is behind is answered immediately rather than waiting.
   */
  desktop: (options: { since?: number; wait?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (options.wait) query.set('wait', '1');
    if (options.since !== undefined) query.set('since', String(options.since));
    const text = query.toString();
    return call<DesktopView>(`/api/desktop${text === '' ? '' : `?${text}`}`);
  },
  setProfile: (id: string) =>
    call<Profiles>('/api/profiles/active', { method: 'POST', body: JSON.stringify({ id }) }),
  /** Overrides a subset of a built-in's endpoints, or adds a profile under a
   * new id (TOON_Network#150). Answers the updated profile list, the same
   * shape `profiles()` does. */
  updateProfile: (id: string, input: ProfileEndpointsInput) =>
    call<Profiles>(`/api/profiles/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Resets a built-in's override, or removes a profile added under a new
   * id — the daemon refuses this while that profile is the active one. */
  resetProfile: (id: string) =>
    call<Profiles>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  directory: (filters: DirectoryFilters = {}) =>
    call<Directory>(`/api/directory${directoryQuery(filters)}`),

  templates: () => call<TemplateGallery>('/api/templates'),
  /**
   * Expands a Template and spends NOTHING. The answer is the §6.2 content a
   * spawn would carry, so a person can read what they are about to buy before
   * anything is bought — and so a window can show that it really is the same
   * request a manual spawn would send.
   */
  expandTemplate: (template: string, settings: TemplateSettings) =>
    post<ExpandedTemplate>('/api/templates/expand', { template, ...settings }),

  /**
   * The docs. Free, and behind no account: a relay READ is not priced by the
   * spec, and the page explaining how to get an account is one of these.
   */
  docs: (options: { refresh?: boolean } = {}) =>
    call<DocsIndex>(`/api/docs${options.refresh ? '?refresh=1' : ''}`),
  doc: (d: string, options: { refresh?: boolean } = {}) =>
    call<DocsPage>(`/api/docs/${encodeURIComponent(d)}${options.refresh ? '?refresh=1' : ''}`),

  account: () => call<SessionStatus>('/api/account'),
  addLocalSigner: (request: LocalSignerRequest) =>
    post<SessionStatus>('/api/account/signers/local', request),
  addBunkerSigner: (request: { uri: string; label?: string; passphrase?: string }) =>
    post<SessionStatus>('/api/account/signers/bunker', request),
  invite: (request: { label?: string; passphrase?: string } = {}) =>
    post<SessionStatus>('/api/account/signers/invite', request),
  cancelInvite: () => call<SessionStatus>('/api/account/signers/invite', { method: 'DELETE' }),
  signIn: (request: { id: string; passphrase?: string }) =>
    post<SessionStatus>('/api/account/signin', request),
  signOut: () => post<SessionStatus>('/api/account/signout'),
  forgetSigner: (id: string) =>
    call<SessionStatus>(`/api/account/signers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  refreshAccountProfile: () => post<SessionStatus>('/api/account/profile/refresh'),
  sign: (template: { kind: number; content?: string; tags?: string[][] }) =>
    post<{ event: SignedEvent }>('/api/account/sign', template),
  publishRelayList: (relays: { url: string; mode?: 'read' | 'write' | 'both' }[]) =>
    post<ChainSeedStatus>('/api/account/relays', { relays }),

  chainSeed: () => call<ChainSeedStatus>('/api/chain-seed'),
  /** `relays` names extra places to LOOK. Nothing is published by a refresh. */
  refreshChainSeed: (relays?: string[]) =>
    post<ChainSeedStatus>(
      '/api/chain-seed/refresh',
      relays && relays.length > 0 ? { relays: relays.map((url) => ({ url })) } : undefined
    ),
  acknowledgeCustody: () => post<ChainSeedStatus>('/api/chain-seed/acknowledge'),
  /**
   * Mints a Chain Seed and HOLDS it. The answer says `not_yet_recoverable`:
   * the seed is on this disk and on nothing else, because publishing it is a
   * paid write and the key that pays is derived from the seed itself (#120).
   */
  mintChainSeed: () => post<ChainSeedStatus>('/api/chain-seed/mint'),
  /**
   * Publishes the held Chain Seed record. This **spends money**: one paid
   * relay write, at the price the connector quotes. It is the only thing that
   * clears "not yet recoverable".
   */
  publishChainSeed: () => post<ChainSeedStatus>('/api/chain-seed/publish'),
  // One way only: the words go to the daemon, and the answer is addresses.
  importChainSeed: (mnemonic: string) =>
    post<ChainSeedStatus>('/api/chain-seed/import', { mnemonic }),

  funding: (options: { refresh?: boolean } = {}) =>
    call<FundingStatus>(`/api/funding${options.refresh ? '?refresh=1' : ''}`),
  /**
   * Opens a channel, which **spends money**: it locks collateral on chain and
   * pays the chain's own gas for the transaction. It answers as soon as the
   * transaction is in flight, with the channel reported as `opening` — so the
   * window polls rather than waiting on a confirmation it cannot hurry.
   *
   * `deposit` is a whole number of the token's base units, as a string. It is
   * not a decimal fraction: how many decimals the token has is the connector's
   * to state, and rounding it in the browser as well is how a figure stops
   * matching.
   */
  /**
   * `connector` names which connector to open WITH. Absent is the active
   * profile's own; a spawn paid at a provider's connector needs a channel with
   * that one instead (#92).
   */
  openChannel: (request: { chain: string; deposit?: string; connector?: string }) =>
    post<FundingStatus>('/api/funding/channel', request),
  faucetDrip: (chain: string) => post<FundingStatus>('/api/funding/faucet', { chain }),

  /**
   * What could be bought, for which chain, from which channel, at what price
   * (TOON_Network#119). A read: it sends no packet and spends nothing.
   */
  gasStation: () => call<GasStationStatus>('/api/funding/gas'),
  /**
   * Buy a QUOTE. **This spends money**: a quote is a paid packet, and learning
   * the station's fee payer for the first time is a second one. What comes
   * back is the station's own figures — what it will move, its ceiling, and
   * the deadline it merged with its blockhash's validity — plus what each
   * packet cost.
   */
  quoteGas: (request: { chain: string; lamports?: string }) =>
    post<GasQuote>('/api/funding/gas/quote', request),
  /**
   * Pay the station to co-sign and broadcast. **This spends money**, and it
   * pays for the quote that was SHOWN — hence `quoteId` — so the figure on the
   * screen is provably the figure agreed to.
   */
  buyGas: (request: { chain: string; quoteId: string }) =>
    post<GasPurchase>('/api/funding/gas/buy', request),

  leases: () => call<LeaseVaultStatus>('/api/leases'),
  /** Re-read the vault from the account's relays. Free: a relay read costs nothing. */
  refreshLeases: () => post<LeaseVaultStatus>('/api/leases/refresh'),
  /** What a spawn WOULD do, with nothing spent. Safe to call on every keystroke. */
  preflightSpawn: (request: SpawnRequestBody) =>
    post<PreflightView>('/api/leases/preflight', request),
  /**
   * Buy a lease. This **spends money**: one Lease Interval at the listing's
   * price, and a refusal is billed too (spec §5, ADR 0003). The daemon
   * publishes the Root Secret to the Lease Vault before it sends anything.
   */
  spawn: (request: SpawnRequestBody) => post<SpawnResult>('/api/leases/spawn', request),

  /** What a Standby Set's spawn WOULD do, at every member, with nothing spent. */
  preflightStandbySet: (request: StandbySetRequestBody) =>
    post<StandbySetPreflightView>('/api/leases/standby-set/preflight', request),
  /**
   * Buy a primary lease AND its Warm Standbys under one workload id (§7).
   *
   * This **spends at every member**: the primary's interval at the listing's
   * price and each reservation at its tier's `standby_price`. A member that
   * refuses is billed like one that accepts (ADR 0003), so the answer reports
   * each member separately rather than one verdict for the set.
   */
  spawnStandbySet: (request: StandbySetRequestBody) =>
    post<StandbySetResult>('/api/leases/standby-set', request),

  /**
   * The dashboard (TOON_Network#93).
   *
   * `refresh` asks every provider what its lease is doing. That is free at the
   * provider (§5) and the daemon buys it where it is free, so a window may
   * poll it — but it IS a packet, so it happens on a refresh rather than on
   * every render.
   */
  workloads: (options: { refresh?: boolean } = {}) =>
    call<Dashboard>(`/api/workloads${options.refresh ? '?refresh=1' : ''}`),
  workload: (workloadId: string, options: { refresh?: boolean } = {}) =>
    call<WorkloadCard>(
      `/api/workloads/${encodeURIComponent(workloadId)}${options.refresh ? '?refresh=1' : ''}`
    ),
  /**
   * Buy one Lease Interval. This **spends money**, and a refusal is billed
   * exactly like an acceptance (ADR 0003, spec §5). The daemon checks
   * everything checkable first and answers `sent: false` — having paid nothing
   * — when any of it fails.
   */
  extendWorkload: (workloadId: string, options: { maxPrice?: string; member?: string } = {}) =>
    post<ExtendResult>(`/api/workloads/${encodeURIComponent(workloadId)}/extend`, options),
  /**
   * End ONE member's lease now. Free, immediate and irreversible: no refund.
   *
   * `member` names which of the Standby Set; without it, the primary. Ending a
   * whole set is ending each member, and the window asks about each.
   */
  terminateWorkload: (workloadId: string, options: { member?: string } = {}) =>
    post<TerminateResult>(
      `/api/workloads/${encodeURIComponent(workloadId)}/terminate`,
      options
    ),
  /**
   * Arm a budget: a standing instruction to keep extending while nobody is
   * watching. `confirm` is the whole of the consent, and `agreedPrice` is
   * checked against what the connector quotes right now — so a stale tab can
   * never arm a budget at a price that has moved.
   */
  armAutoExtend: (
    workloadId: string,
    request: { budget: string; agreedPrice: string; leadSeconds?: number }
  ) =>
    post<WorkloadCard>(`/api/workloads/${encodeURIComponent(workloadId)}/auto-extend`, {
      ...request,
      confirm: true,
    }),
  disarmAutoExtend: (workloadId: string) =>
    call<WorkloadCard>(`/api/workloads/${encodeURIComponent(workloadId)}/auto-extend`, {
      method: 'DELETE',
    }),

  /**
   * The hostname (TOON_Network#97). Reading is free and sends nothing;
   * `probe` additionally knocks on the name itself, over ordinary HTTPS,
   * reaching no provider and no relay — which is how "the hostname shown is
   * the one the gateway serves" becomes a check rather than a claim.
   */
  gateway: (workloadId: string, options: { probe?: boolean } = {}) =>
    call<GatewayView>(
      `/api/workloads/${encodeURIComponent(workloadId)}/gateway${options.probe ? '?probe=1' : ''}`
    ),
  /**
   * Hands the workload to the Workload Gateway: one Gateway Grant per member
   * of the Standby Set, sealed into one message. Free on every gateway built
   * so far, and the answer says where it was bought and what it cost.
   */
  handOverWorkload: (workloadId: string, request: HandoverRequestBody = {}) =>
    post<HandoverResult>(
      `/api/workloads/${encodeURIComponent(workloadId)}/gateway/handover`,
      request
    ),
  /**
   * Stops the gateway serving the workload. It ends the SERVING and not the
   * reading: the gateway keeps a working grant until the moment that grant was
   * derived for. Rotating the lease's token is what ends the reading.
   */
  withdrawWorkload: (workloadId: string) =>
    post<WithdrawalResult>(
      `/api/workloads/${encodeURIComponent(workloadId)}/gateway/withdraw`
    ),

  /**
   * How far a rotation has got, and what the next one would cost
   * (TOON_Network#96, spec §6.8). Free: it asks connectors what they carry and
   * sends no lease packet.
   */
  rotation: (workloadId: string) =>
    call<RotationView>(`/api/workloads/${encodeURIComponent(workloadId)}/rotation`),
  /**
   * Replace this lease's Continuation Token at every member of its Standby
   * Set, from a fresh Root Secret.
   *
   * It is free at the providers and costs one paid relay write to record the
   * new secret before anything is sent, plus one per member confirmed. Sending
   * it again FINISHES a rotation that was left part-way through — it never
   * starts a second one.
   */
  rotateWorkload: (workloadId: string) =>
    post<RotationResult>(`/api/workloads/${encodeURIComponent(workloadId)}/rotate`),
};

/** The filters, as the daemon's query string spells them. */
export function directoryQuery(filters: DirectoryFilters): string {
  const query = new URLSearchParams();
  if (filters.isolation) query.set('isolation', filters.isolation);
  if (filters.arch) query.set('arch', filters.arch);
  if (filters.gpu) query.set('gpu', filters.gpu);
  // One entry per capability: each is a further demand, not an alternative.
  for (const capability of filters.capabilities ?? []) query.append('capability', capability);
  if (filters.hidden !== undefined) query.set('hidden', String(filters.hidden));
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}
