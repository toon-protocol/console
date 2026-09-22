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

export class DaemonError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
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
    const problem = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new DaemonError(
      response.status,
      problem?.message ?? `The daemon answered ${response.status}.`
    );
  }
  return (await response.json()) as T;
}

export const daemon = {
  health: (options: { refresh?: boolean } = {}) =>
    call<Health>(`/api/health${options.refresh ? '?refresh=1' : ''}`),
  profiles: () => call<Profiles>('/api/profiles'),
  setProfile: (id: string) =>
    call<Profiles>('/api/profiles/active', { method: 'POST', body: JSON.stringify({ id }) }),
  directory: (filters: DirectoryFilters = {}) =>
    call<Directory>(`/api/directory${directoryQuery(filters)}`),
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
