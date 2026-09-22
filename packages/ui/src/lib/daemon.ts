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

export class DaemonError extends Error {
  readonly status: number;
  /** The daemon's machine-readable code, e.g. `passphrase_required`. */
  readonly code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
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
    } | null;
    throw new DaemonError(
      response.status,
      problem?.message ?? `The daemon answered ${response.status}.`,
      problem?.error ?? 'error'
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
};
