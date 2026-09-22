import { channelStoreFor } from './channel-store.js';
import type { ConnectorHealth } from './connector-health.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { UnknownProfileError, type ProfileStore } from './profile-store.js';
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
 * Three routes in this ticket, and no more: health, the profile list, and the
 * switch. Sign-in (#88), funds (#89) and workloads (#90 onward) add their own.
 */

export interface ApiDeps {
  readonly profiles: ProfileStore;
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

  if (path.startsWith('/api/')) {
    return problem(404, 'unknown_route', `No route ${method} ${path}.`);
  }

  return problem(404, 'not_found', `No route ${method} ${path}.`);
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
      uptimeSeconds: Math.max(0, Math.round((now.getTime() - deps.startedAt.getTime()) / 1000)),
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
