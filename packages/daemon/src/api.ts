import { KeyMaterialError } from './account-key.js';
import { SessionError, type AccountSession } from './account-session.js';
import { ChainSeedError, type ChainSeedStore } from './chain-seed.js';
import { channelStoreFor } from './channel-store.js';
import type { ConnectorHealth } from './connector-health.js';
import {
  ANY_GPU,
  ARCHITECTURES,
  ISOLATIONS,
  type DirectoryFilters,
  type DirectoryResult,
} from './directory.js';
import {
  KeystoreUnavailableError,
  PassphraseRequiredError,
  WrongPassphraseError,
} from './keystore.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { UnknownProfileError, type ProfileStore } from './profile-store.js';
import { RelayListError, type RelayMode } from './relay-list.js';
import { RemoteSignerError } from './remote-signer.js';
import { SealingError } from './signer.js';
import type { DaemonVersion } from './version.js';

/**
 * The console's local JSON API.
 *
 * Deliberately separated from the HTTP server: everything here is a function
 * of its dependencies and a `{ method, path, body }`, so the whole surface can
 * be driven in a test without a socket, and the server below stays a matter of
 * sockets, headers and files. The seam is also where `smoke-console` will
 * attach later (TOON_Network#84's testing decisions).
 *
 * Health, the profile list and the switch came with the skeleton (#87); the
 * Provider Directory joins them here (#91); `/api/account/*` is sign-in (#88):
 * the Account, its Signer and the local keystore. `/api/chain-seed/*` is the
 * Chain Seed (#89). Channels and balances (#90 onward) add their own.
 *
 * Every route here is already behind the per-launch token — `server.ts` checks
 * it before anything in this file runs — and that matters more now than it did
 * with read-only routes, because the account ones import keys.
 *
 * The rule the account routes are written to: **no request body is ever echoed
 * back**. An nsec, a mnemonic, a passphrase and a bunker secret all arrive here
 * and none of them appears in an answer, not even inside an error message.
 * `api-account.test.ts` and `api-chain-seed.test.ts` are the tests that say so.
 */

export interface ApiDeps {
  readonly profiles: ProfileStore;
  readonly session: AccountSession;
  readonly chainSeed: ChainSeedStore;
  readonly readHealth: (
    profile: NetworkProfile,
    options?: { forceRefresh?: boolean }
  ) => Promise<ConnectorHealth>;
  readonly version: DaemonVersion;
  readonly startedAt: Date;
  readonly paths: ConsolePaths;
  readonly readDirectory: (
    profile: NetworkProfile,
    filters: DirectoryFilters
  ) => Promise<DirectoryResult>;
  readonly now?: (() => Date) | undefined;
}

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body?: unknown;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ProfileView extends NetworkProfile {
  readonly configured: boolean;
  readonly active: boolean;
}

export async function handleApi(deps: ApiDeps, request: ApiRequest): Promise<ApiResponse> {
  const { method, path } = request;

  if (path === '/api/health' && method === 'GET') {
    return { status: 200, body: await healthBody(deps, request) };
  }

  if (path === '/api/profiles' && method === 'GET') {
    return { status: 200, body: profilesBody(deps) };
  }

  if (path === '/api/profiles/active' && method === 'POST') {
    const id = readProfileId(request.body);
    if (id === undefined) {
      return problem(400, 'invalid_request', 'Body must be `{ "id": "<profile id>" }`.');
    }
    try {
      deps.profiles.setActive(id);
    } catch (error) {
      if (error instanceof UnknownProfileError) {
        return problem(404, 'unknown_profile', error.message);
      }
      throw error;
    }
    return { status: 200, body: profilesBody(deps) };
  }

  if (path === '/api/directory' && method === 'GET') {
    const filters = readFilters(request.query);
    if ('error' in filters) {
      return problem(400, 'invalid_filter', filters.error);
    }
    return {
      status: 200,
      body: await deps.readDirectory(deps.profiles.active(), filters.value),
    };
  }

  if (path === '/api/account' && method === 'GET') {
    return { status: 200, body: deps.session.status() };
  }

  if (path === '/api/account/relays' && method === 'POST') {
    const relays = readRelayEntries(request.body);
    if ('error' in relays) return problem(400, 'invalid_request', relays.error);
    try {
      return ok(await deps.chainSeed.publishRelayList(relays.value));
    } catch (error) {
      return accountProblem(error);
    }
  }

  if (path.startsWith('/api/account/')) {
    try {
      return await handleAccount(deps.session, method, path, request.body);
    } catch (error) {
      return accountProblem(error);
    }
  }

  if (path === '/api/chain-seed' || path.startsWith('/api/chain-seed/')) {
    try {
      return await handleChainSeed(deps.chainSeed, method, path, request.body);
    } catch (error) {
      return accountProblem(error);
    }
  }

  if (path.startsWith('/api/')) {
    return problem(404, 'unknown_route', `No route ${method} ${path}.`);
  }

  return problem(404, 'not_found', `No route ${method} ${path}.`);
}

/**
 * The Account routes.
 *
 * Signing in is a POST that CREATES something — a live signer — so every way
 * in is its own POST rather than one overloaded endpoint with a `mode` field
 * the server has to unpick. `/signers/local` is the local keystore's three
 * imports (which really are one operation on three sources of the same bytes),
 * `/signers/bunker` dials a `bunker://`, and `/signers/invite` offers a
 * `nostrconnect://` and waits.
 */
async function handleAccount(
  session: AccountSession,
  method: string,
  path: string,
  body: unknown
): Promise<ApiResponse> {
  const at = (route: string, verb: string) => path === route && method === verb;
  const fields = asRecord(body);

  if (at('/api/account/signers/local', 'POST')) {
    const mode = string(fields, 'mode');
    if (mode !== 'generate' && mode !== 'nsec' && mode !== 'nip06') {
      return problem(
        400,
        'invalid_request',
        'Body must name a `mode` of "generate", "nsec" or "nip06".'
      );
    }
    return ok(
      await session.addLocalSigner({
        mode,
        ...optional('nsec', string(fields, 'nsec')),
        ...optional('mnemonic', string(fields, 'mnemonic')),
        ...optional('mnemonicPassphrase', string(fields, 'mnemonicPassphrase')),
        ...optional('accountIndex', number(fields, 'accountIndex')),
        ...optional('label', string(fields, 'label')),
        ...optional('passphrase', string(fields, 'passphrase')),
      })
    );
  }

  if (at('/api/account/signers/bunker', 'POST')) {
    const uri = string(fields, 'uri');
    if (!uri) {
      return problem(400, 'invalid_request', 'Body must carry a `uri`, a `bunker://` one.');
    }
    return ok(
      await session.addBunkerSigner({
        uri,
        ...optional('label', string(fields, 'label')),
        ...optional('passphrase', string(fields, 'passphrase')),
      })
    );
  }

  if (at('/api/account/signers/invite', 'POST')) {
    return ok(
      session.invite({
        ...optional('label', string(fields, 'label')),
        ...optional('passphrase', string(fields, 'passphrase')),
      })
    );
  }

  if (at('/api/account/signers/invite', 'DELETE')) {
    return ok(session.cancelInvitation());
  }

  if (at('/api/account/signin', 'POST')) {
    const id = string(fields, 'id');
    if (!id)
      return problem(400, 'invalid_request', 'Body must name the signer `id` to sign in.');
    return ok(
      await session.resume({ id, ...optional('passphrase', string(fields, 'passphrase')) })
    );
  }

  if (at('/api/account/signout', 'POST')) {
    return ok(await session.signOut());
  }

  if (at('/api/account/profile/refresh', 'POST')) {
    return ok(await session.refreshProfile());
  }

  if (at('/api/account/sign', 'POST')) {
    const kind = number(fields, 'kind');
    if (kind === undefined) {
      return problem(400, 'invalid_request', 'Body must carry the event `kind` to sign.');
    }
    const signed = await session.sign({
      kind,
      content: string(fields, 'content') ?? '',
      tags: tags(fields),
      created_at: number(fields, 'created_at') ?? Math.floor(Date.now() / 1000),
    });
    return { status: 200, body: { event: signed } };
  }

  const forget = /^\/api\/account\/signers\/([^/]+)$/u.exec(path);
  if (forget?.[1] && method === 'DELETE') {
    return ok(await session.forget(decodeURIComponent(forget[1])));
  }

  return problem(404, 'unknown_route', `No route ${method} ${path}.`);
}

/**
 * The Chain Seed routes (TOON_Network#89, ADR 0020).
 *
 * `GET` is the state a person looks at; each `POST` is one thing an account
 * can decide to do about it. Every one of them answers with the same status
 * shape, which is built from addresses and event metadata — so there is no
 * route here, and no error path out of here, that a mnemonic could travel
 * along. `chain-seed.test.ts` and `api-chain-seed.test.ts` are the tests that
 * say so, and the rule matters more here than anywhere else in the console:
 * this is the one request body that carries a seed INTO the daemon.
 */
async function handleChainSeed(
  seed: ChainSeedStore,
  method: string,
  path: string,
  body: unknown
): Promise<ApiResponse> {
  const at = (route: string, verb: string) => path === route && method === verb;

  if (at('/api/chain-seed', 'GET')) return ok(seed.status());
  if (at('/api/chain-seed/refresh', 'POST')) return ok(await seed.refresh());
  if (at('/api/chain-seed/acknowledge', 'POST')) return ok(seed.acknowledgeWarning());
  if (at('/api/chain-seed/mint', 'POST')) return ok(await seed.mint());

  if (at('/api/chain-seed/import', 'POST')) {
    const mnemonic = string(asRecord(body), 'mnemonic');
    if (!mnemonic) {
      return problem(400, 'invalid_request', 'Body must carry the `mnemonic` to import.');
    }
    return ok(await seed.importMnemonic(mnemonic));
  }

  return problem(404, 'unknown_route', `No route ${method} ${path}.`);
}

/** `{ "relays": [{ "url": "wss://…", "mode": "read" | "write" | "both" }] }`. */
function readRelayEntries(
  body: unknown
): { value: { url: string; mode?: RelayMode }[] } | { error: string } {
  const raw = asRecord(body).relays;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Body must carry a non-empty `relays` array.' };
  }
  const value: { url: string; mode?: RelayMode }[] = [];
  for (const entry of raw) {
    const fields = typeof entry === 'string' ? { url: entry } : asRecord(entry);
    const url = string(fields, 'url');
    if (!url) return { error: 'Every relay needs a `url`.' };
    const mode = string(fields, 'mode');
    if (mode !== undefined && mode !== 'read' && mode !== 'write' && mode !== 'both') {
      return { error: '`mode` is "read", "write" or "both".' };
    }
    value.push({ url, ...(mode === undefined ? {} : { mode }) });
  }
  return { value };
}

function ok(status: unknown): ApiResponse {
  return { status: 200, body: status };
}

/**
 * Faults from the four modules underneath, each mapped to what the UI has to
 * do about it — and never to the request that caused it.
 */
function accountProblem(error: unknown): ApiResponse {
  if (error instanceof PassphraseRequiredError) return problem(401, error.code, error.message);
  if (error instanceof WrongPassphraseError) return problem(401, error.code, error.message);
  if (error instanceof KeystoreUnavailableError)
    return problem(503, error.code, error.message);
  if (error instanceof KeyMaterialError) return problem(400, error.code, error.message);
  if (error instanceof RemoteSignerError) return problem(502, error.code, error.message);
  if (error instanceof SessionError) return problem(error.status, error.code, error.message);
  if (error instanceof RelayListError) return problem(400, error.code, error.message);
  if (error instanceof SealingError) return problem(409, error.code, error.message);
  if (error instanceof ChainSeedError) {
    // The per-relay detail travels with the problem, because "it was not
    // published" is only useful alongside which relay said what. None of it
    // comes from the request body.
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.relays ? { relays: error.relays } : {}),
      },
    };
  }
  throw error;
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function string(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tags(fields: Record<string, unknown>): string[][] {
  const value = fields.tags;
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is unknown[] => Array.isArray(tag))
    .map((tag) => tag.filter((item): item is string => typeof item === 'string'));
}

/** `exactOptionalPropertyTypes` means an absent field and `undefined` differ. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

async function healthBody(deps: ApiDeps, request: ApiRequest) {
  const now = (deps.now ?? (() => new Date()))();
  const profile = deps.profiles.active();
  const refresh = request.query.get('refresh') === '1';
  const connector = await deps.readHealth(profile, { forceRefresh: refresh });
  const channels = channelStoreFor(deps.paths, profile.id);
  return {
    daemon: {
      name: deps.version.name,
      version: deps.version.version,
      node: process.version,
      pid: process.pid,
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: Math.max(
        0,
        Math.round((now.getTime() - deps.startedAt.getTime()) / 1000)
      ),
    },
    profile: toProfileView(profile, profile),
    connector,
    storage: {
      data: deps.paths.data,
      config: deps.paths.config,
      runtime: deps.paths.runtime,
      channels: channels.filePath,
    },
    checkedAt: now.toISOString(),
  };
}

function profilesBody(deps: ApiDeps) {
  const active = deps.profiles.active();
  return {
    activeId: active.id,
    profiles: deps.profiles.list().map((profile) => toProfileView(profile, active)),
  };
}

function toProfileView(profile: NetworkProfile, active: NetworkProfile): ProfileView {
  return { ...profile, configured: isConfigured(profile), active: profile.id === active.id };
}

/**
 * `GET /api/directory`'s filters, out of the query string.
 *
 * A value outside §4.4's vocabulary is refused rather than passed on. The
 * alternative is an empty directory and no way to tell a network with no
 * `arm64` provider from a typo, and the vocabulary is fixed for exactly this
 * reason: a value must mean the same thing on every provider.
 *
 * `capability` repeats, and every one of them must be granted. `hidden` is
 * three-valued: absent shows Hidden Providers alongside the rest, `true` shows
 * only them, `false` excludes them (§4.2).
 */
function readFilters(query: URLSearchParams): { value: DirectoryFilters } | { error: string } {
  const filters: {
    isolation?: string;
    arch?: string;
    gpu?: string;
    capabilities?: string[];
    hidden?: boolean;
  } = {};

  const isolation = query.get('isolation');
  if (isolation !== null && isolation !== '') {
    if (!(ISOLATIONS as readonly string[]).includes(isolation)) {
      return { error: `\`isolation\` is one of ${ISOLATIONS.join(', ')}.` };
    }
    filters.isolation = isolation;
  }

  const arch = query.get('arch');
  if (arch !== null && arch !== '') {
    if (!(ARCHITECTURES as readonly string[]).includes(arch)) {
      return { error: `\`arch\` is one of ${ARCHITECTURES.join(', ')}.` };
    }
    filters.arch = arch;
  }

  const gpu = query.get('gpu');
  if (gpu !== null && gpu !== '') {
    if (gpu !== ANY_GPU && !GPU_FILTER.test(gpu)) {
      return {
        error: `\`gpu\` is \`${ANY_GPU}\`, or a \`<vendor>-<model>\` label such as \`nvidia-rtx-4090\`.`,
      };
    }
    filters.gpu = gpu;
  }

  const capabilities = query.getAll('capability').filter((value) => value !== '');
  if (capabilities.length > 0) filters.capabilities = [...new Set(capabilities)];

  const hidden = query.get('hidden');
  if (hidden !== null && hidden !== '') {
    if (hidden !== 'true' && hidden !== 'false') {
      return { error: '`hidden` is `true`, `false`, or left out to show both.' };
    }
    filters.hidden = hidden === 'true';
  }

  return { value: filters };
}

/** §4.4's GPU label grammar, as a query may spell it. */
const GPU_FILTER = /^(nvidia|amd|intel|apple)(-[a-z0-9]+)+$/;

function readProfileId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function problem(status: number, code: string, message: string): ApiResponse {
  return { status, body: { error: code, message } };
}
