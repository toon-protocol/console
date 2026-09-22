import { KeyMaterialError } from './account-key.js';
import { SessionError, type AccountSession } from './account-session.js';
import { channelStoreFor } from './channel-store.js';
import type { ConnectorHealth } from './connector-health.js';
import {
  KeystoreUnavailableError,
  PassphraseRequiredError,
  WrongPassphraseError,
} from './keystore.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { UnknownProfileError, type ProfileStore } from './profile-store.js';
import { RemoteSignerError } from './remote-signer.js';
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
 * Health, the network profile list and the switch came with the skeleton
 * (#87). `/api/account/*` is sign-in (#88): the Account, its Signer and the
 * local keystore. Funds (#89) and workloads (#90 onward) add their own.
 *
 * Every route here is already behind the per-launch token — `server.ts` checks
 * it before anything in this file runs — and that matters more now than it did
 * with three read-only routes, because these ones import keys.
 *
 * The rule the account routes are written to: **no request body is ever echoed
 * back**. An nsec, a mnemonic, a passphrase and a bunker secret all arrive here
 * and none of them appears in an answer, not even inside an error message.
 * `api-account.test.ts` is the test that says so.
 */

export interface ApiDeps {
  readonly profiles: ProfileStore;
  readonly session: AccountSession;
  readonly readHealth: (
    profile: NetworkProfile,
    options?: { forceRefresh?: boolean }
  ) => Promise<ConnectorHealth>;
  readonly version: DaemonVersion;
  readonly startedAt: Date;
  readonly paths: ConsolePaths;
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

  if (path === '/api/account' && method === 'GET') {
    return { status: 200, body: deps.session.status() };
  }

  if (path.startsWith('/api/account/')) {
    try {
      return await handleAccount(deps.session, method, path, request.body);
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

function readProfileId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function problem(status: number, code: string, message: string): ApiResponse {
  return { status, body: { error: code, message } };
}
