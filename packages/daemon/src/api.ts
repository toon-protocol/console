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
import { FundingError, type FundingStore } from './funding.js';
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
import {
  expandTemplate,
  TemplateExpansionError,
  type TemplateSettings,
  type TemplateSpawnPort,
} from './template-spawn.js';
import type { TemplateGalleryResult, TemplateView } from './templates.js';
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
 * Chain Seed (#89), `/api/funding/*` is deposits, gas, balances and payment
 * channels (#90), and `/api/templates/*` is the Template gallery and the
 * expansion a tenant does for itself (#94, spec §8.3).
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
  readonly funding: FundingStore;
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
  readonly readTemplates: (profile: NetworkProfile) => Promise<TemplateGalleryResult>;
  /**
   * The paid half of a spawn, which TOON_Network#92 owns. Absent until it is
   * wired, and `POST /api/templates/spawn` says so rather than pretending.
   */
  readonly spawnFromTemplate?: TemplateSpawnPort | undefined;
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

  if (path === '/api/templates' || path.startsWith('/api/templates/')) {
    return handleTemplates(deps, method, path, request.body);
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

  if (path === '/api/funding' || path.startsWith('/api/funding/')) {
    try {
      return await handleFunding(deps.funding, method, path, request.query, request.body);
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

  if (at('/api/chain-seed/refresh', 'POST')) {
    // Optional `relays`: extra places to LOOK, for a fresh machine whose
    // network profile names only a relay that carries no NIP-65 list. It
    // publishes nothing.
    const hinted = asRecord(body).relays;
    if (hinted === undefined) return ok(await seed.refresh());
    const relays = readRelayEntries(body);
    if ('error' in relays) return problem(400, 'invalid_request', relays.error);
    return ok(await seed.refresh({ relays: relays.value.map((entry) => entry.url) }));
  }

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

/**
 * Funding: deposits, gas, balances and payment channels (TOON_Network#90).
 *
 * `GET` is the state; each `POST` is one thing an account can decide to do
 * about it, and every one of them answers with the whole state again — so a
 * window that pressed a button and a window that merely polled see the same
 * thing, which matters most for the open, whose whole story is a state that
 * changes underneath both of them.
 *
 * `POST /api/funding/channel` **spends money**: it locks collateral on chain
 * and pays gas for the privilege. It returns as soon as the transaction is in
 * flight rather than holding the request open for a confirmation, and the
 * answer reports the channel as `opening`. A caller that waited on this route
 * would have no way to tell a slow chain from a dead daemon, which is the
 * distinction the pending state exists to draw.
 *
 * No request body here carries key material, and no answer does either: the
 * payer keys are derived inside `chain-seed.ts` for the length of one open and
 * wiped after it. `api-funding.test.ts` is the test that says so.
 */
async function handleFunding(
  funding: FundingStore,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown
): Promise<ApiResponse> {
  const at = (route: string, verb: string) => path === route && method === verb;

  if (at('/api/funding', 'GET')) {
    return ok(await funding.status({ refresh: query.get('refresh') === '1' }));
  }

  if (at('/api/funding/channel', 'POST')) {
    const chain = string(asRecord(body), 'chain');
    if (!chain) {
      return problem(
        400,
        'invalid_request',
        'Body must name the `chain` to open on, exactly as the connector published it in ' +
          '`GET /ilp` — `evm:<chain id>`, or `solana`.'
      );
    }
    try {
      return ok(
        await funding.openChannel({
          chain,
          ...optional('deposit', string(asRecord(body), 'deposit')),
        })
      );
    } catch (error) {
      if (error instanceof FundingError)
        return problem(error.status, error.code, error.message);
      throw error;
    }
  }

  if (at('/api/funding/faucet', 'POST')) {
    const chain = string(asRecord(body), 'chain');
    if (!chain) {
      return problem(
        400,
        'invalid_request',
        'Body must name the `chain` to ask the faucet for.'
      );
    }
    try {
      return ok(await funding.drip({ chain }));
    } catch (error) {
      if (error instanceof FundingError)
        return problem(error.status, error.code, error.message);
      throw error;
    }
  }

  return problem(404, 'unknown_route', `No route ${method} ${path}.`);
}

/**
 * Templates: the gallery, and expanding one (TOON_Network#94, spec §8.3).
 *
 * `GET` is free and needs no account — reading relays costs nothing and a
 * person deciding what to run should be able to look first, exactly as with
 * the Provider Directory.
 *
 * `POST /expand` is where the acceptance criterion about tenant-settable
 * settings is actually enforced. It would have been cheaper to let the window
 * assemble the spawn and post it, and it would have been wrong: the browser
 * would then be the thing that decides which of a publisher's settings are
 * fixed, and a stale tab or a scripted caller could set any of them. So the
 * daemon re-reads the Template from the relays, expands it against what the
 * publisher signed, and refuses anything else. Nothing about the Template
 * comes from the request except which one it is.
 *
 * `POST /spawn` is the seam for #92. It expands exactly as `/expand` does and
 * then hands the content to whoever buys the lease; with nobody wired it
 * answers `501` AND the expansion, so that the half that exists is visible and
 * testable before the half that pays does.
 */
async function handleTemplates(
  deps: ApiDeps,
  method: string,
  path: string,
  body: unknown
): Promise<ApiResponse> {
  if (path === '/api/templates' && method === 'GET') {
    return ok(await deps.readTemplates(deps.profiles.active()));
  }

  if (
    method === 'POST' &&
    (path === '/api/templates/expand' || path === '/api/templates/spawn')
  ) {
    const fields = asRecord(body);
    const address = string(fields, 'template');
    if (address === undefined) {
      return problem(
        400,
        'invalid_request',
        'Body must name the `template` to expand, as its `30436:<pubkey>:<name>` address.'
      );
    }

    const settings = readTemplateSettings(fields);
    if ('error' in settings) return problem(400, 'invalid_request', settings.error);

    const gallery = await deps.readTemplates(deps.profiles.active());
    if (gallery.state !== 'ok') {
      return problem(409, 'unconfigured', gallery.reason);
    }
    const template = gallery.templates.find(
      (candidate: TemplateView) => candidate.address === address
    );
    if (template === undefined) {
      return problem(
        404,
        'unknown_template',
        `No Template \`${address}\` was on the relays read. A publisher may have replaced it, ` +
          'or this network may not carry it.'
      );
    }

    let expanded;
    try {
      expanded = expandTemplate(template, settings.value);
    } catch (error) {
      if (error instanceof TemplateExpansionError) {
        return problem(error.status, error.code, error.message);
      }
      throw error;
    }

    if (path === '/api/templates/expand') return ok(expanded);

    const listing = string(fields, 'listing');
    const provider = string(fields, 'provider');
    const listingVersion = number(fields, 'listingVersion');
    if (listing === undefined || provider === undefined || listingVersion === undefined) {
      return problem(
        400,
        'invalid_request',
        'A spawn names the `listing` to buy on, its `listingVersion`, and the `provider` whose ' +
          'Listing it is (§4.2, §6.1).'
      );
    }

    if (deps.spawnFromTemplate === undefined) {
      // Not an error in the request: the expansion above is complete and
      // correct, and what is missing is the paid hop (TOON_Network#92).
      return {
        status: 501,
        body: {
          error: 'spawn_unwired',
          message:
            'This console can expand a Template but cannot yet buy a lease: the paid spawn is ' +
            'TOON_Network#92. The expansion below is what it will be handed.',
          expansion: expanded,
        },
      };
    }

    return ok(
      await deps.spawnFromTemplate({
        template: expanded.template,
        provider,
        listing,
        listingVersion,
        content: expanded.spawn,
        ...(fields.localOnly === true ? { localOnly: true } : {}),
      })
    );
  }

  return problem(404, 'unknown_route', `No route ${method} ${path}.`);
}

/** The half of a spawn a Template leaves to the tenant (§8.3). */
function readTemplateSettings(
  fields: Record<string, unknown>
): { value: TemplateSettings } | { error: string } {
  const sshPublicKey = string(fields, 'sshPublicKey');
  if (sshPublicKey === undefined) {
    return { error: 'Body must carry the tenant’s `sshPublicKey`.' };
  }

  let env: Record<string, string> | undefined;
  if (fields.env !== undefined) {
    const raw = asRecord(fields.env);
    if (typeof fields.env !== 'object' || fields.env === null || Array.isArray(fields.env)) {
      return { error: '`env` is an object of names to values.' };
    }
    env = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== 'string') return { error: `\`env.${name}\` must be a string.` };
      env[name] = value;
    }
  }

  const standby = fields.standbySet;
  let standbySet: string[] | undefined;
  if (standby !== undefined) {
    if (!Array.isArray(standby) || standby.some((member) => typeof member !== 'string')) {
      return { error: '`standbySet` is an array of provider public keys, primary first.' };
    }
    standbySet = standby as string[];
  }

  return {
    value: {
      sshPublicKey,
      ...(env === undefined ? {} : { env }),
      ...optional('volumeGb', number(fields, 'volumeGb')),
      ...optional('workloadId', string(fields, 'workloadId')),
      ...(standbySet === undefined ? {} : { standbySet }),
    },
  };
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
  if (error instanceof FundingError) return problem(error.status, error.code, error.message);
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
