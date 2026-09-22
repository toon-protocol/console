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
  faucetUrl?: string;
  origin: 'built-in' | 'user';
  configured: boolean;
  active: boolean;
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
      ilpAddresses: string[];
      settlements: SettlementView[];
      routes: RouteView[];
      peerCarriages: string[];
      edgeKeyId?: string;
      supportedVersions: number[];
    };

export interface Health {
  daemon: DaemonInfo;
  profile: ProfileView;
  connector: ConnectorHealth;
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
  writeTargets: string[];
  writeTargetSource: 'nip65' | 'profile' | 'none';
}

export interface PublishOutcome {
  url: string;
  state: 'accepted' | 'rejected' | 'timeout' | 'failed';
  reason?: string;
  code?: string;
}

export interface PublishReport {
  at: string;
  what: 'chain-seed' | 'relay-list';
  relays: PublishOutcome[];
  accepted: string[];
}

export interface ChainSeedStatus {
  state: 'signed_out' | 'unknown' | 'absent' | 'ready' | 'unreadable';
  pubkey?: string;
  addresses?: ChainAddresses;
  origin?: 'minted' | 'imported';
  record?: SeedRecordView;
  relayList: RelayListView;
  warning: { text: string; acknowledgedAt?: string };
  supersededSeeds: number;
  lastPublish?: PublishReport;
  reason?: string;
  checkedAt: string;
}

export class DaemonError extends Error {
  readonly status: number;
  /** The daemon's machine-readable code, e.g. `passphrase_required`. */
  readonly code: string;
  /** Per-relay detail on a publish that persisted nothing, when there is any. */
  readonly relays?: PublishOutcome[];
  constructor(status: number, message: string, code = 'error', relays?: PublishOutcome[]) {
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
      relays?: PublishOutcome[];
    } | null;
    throw new DaemonError(
      response.status,
      problem?.message ?? `The daemon answered ${response.status}.`,
      problem?.error ?? 'error',
      problem?.relays
    );
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const daemon = {
  health: (options: { refresh?: boolean } = {}) =>
    call<Health>(`/api/health${options.refresh ? '?refresh=1' : ''}`),
  profiles: () => call<Profiles>('/api/profiles'),
  setProfile: (id: string) =>
    call<Profiles>('/api/profiles/active', { method: 'POST', body: JSON.stringify({ id }) }),
  directory: (filters: DirectoryFilters = {}) =>
    call<Directory>(`/api/directory${directoryQuery(filters)}`),

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
  mintChainSeed: () => post<ChainSeedStatus>('/api/chain-seed/mint'),
  // One way only: the words go to the daemon, and the answer is addresses.
  importChainSeed: (mnemonic: string) =>
    post<ChainSeedStatus>('/api/chain-seed/import', { mnemonic }),
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
