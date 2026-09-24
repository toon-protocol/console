import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  type ChainRpcEndpoints,
  type NetworkProfile,
} from './profiles.js';
import { ENDPOINT_FIELD_NAMES, isValidProfileId } from './profile-validation.js';

/**
 * Which profile is active, remembered across restarts, and what a person has
 * changed about their profiles (TOON_Network#150).
 *
 * Two files, and two different reasons not to copy a whole `NetworkProfile`
 * to disk:
 *
 * - The ACTIVE id is one string in one small file. A built-in's endpoints may
 *   be corrected in a later release, and a copy written to disk at first
 *   launch would pin a person to the old ones forever. An unreadable or
 *   unknown file falls back to the default rather than refusing to start — a
 *   console that will not open is worse than one that opens on devnet.
 * - The USER PROFILES file holds only the fields a person actually touched —
 *   never a copy of a whole built-in. That is what makes "a release corrects
 *   devnet's relay" still reach a person who long ago overrode devnet's
 *   `connectorUrl` alone: the field they never touched was never copied out
 *   of `profiles.ts` in the first place, so it keeps tracking the built-in.
 *   A `PUT` REPLACES this store's whole record for one id in one call — the
 *   fields present in that call are the whole override, the fields absent
 *   from it fall through to the built-in (or, for a profile with no built-in,
 *   are simply unconfigured, the same honest shape `MAINNET` already has).
 *
 * Both files are optional: neither existing is "first launch," not an error.
 */

/** One id's worth of what a person has changed — every endpoint field
 * optional (only the ones actually overridden are present), plus a label and
 * a description for an id this build has no built-in for. */
export interface UserProfileEntry {
  readonly id: string;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly connectorUrl?: string | undefined;
  readonly relayUrl?: string | undefined;
  readonly gatewayDomain?: string | undefined;
  readonly gatewayConnectorUrl?: string | undefined;
  readonly gasConnectorUrl?: string | undefined;
  readonly faucetUrl?: string | undefined;
  readonly rpc?: ChainRpcEndpoints | undefined;
}

/** What `ProfileStore.setEndpoints` takes — the same shape a validated
 * `PUT /api/profiles/<id>` body carries, plus the label/description a new id
 * needs. Every field is the WHOLE override for this call: a field left out
 * is not merged with what was there before, it falls through to the
 * built-in (or is cleared, for a profile with none) — see the module doc
 * comment. */
export interface ProfileEndpointsInput {
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly connectorUrl?: string | undefined;
  readonly relayUrl?: string | undefined;
  readonly gatewayDomain?: string | undefined;
  readonly gatewayConnectorUrl?: string | undefined;
  readonly gasConnectorUrl?: string | undefined;
  readonly faucetUrl?: string | undefined;
  readonly rpc?:
    | {
        readonly evm?: string | undefined;
        readonly solana?: string | undefined;
      }
    | undefined;
}

export class ProfileStore {
  readonly #activePath: string;
  readonly #userProfilesPath: string;
  readonly #builtIns: readonly NetworkProfile[];
  readonly #userEntries = new Map<string, UserProfileEntry>();
  #activeId: string;

  /**
   * `userProfilesPath` defaults to `profiles.json` beside `activePath` —
   * exactly where `paths.userProfilesFilePath` puts it, since both live in
   * the config directory. The default exists so every call site that only
   * cares about the active profile (most of this package's tests) does not
   * have to know this file exists at all.
   */
  constructor(
    activePath: string,
    profiles: readonly NetworkProfile[] = BUILT_IN_PROFILES,
    userProfilesPath: string = join(dirname(activePath), 'profiles.json')
  ) {
    this.#activePath = activePath;
    this.#userProfilesPath = userProfilesPath;
    this.#builtIns = profiles;
    this.#readUserProfiles();
    this.#activeId = this.#readActive();
  }

  /** Every profile this console knows about: every built-in, each carrying
   * whichever of its own fields a person has overridden, followed by every
   * profile a person has added outright. */
  list(): readonly NetworkProfile[] {
    const out: NetworkProfile[] = this.#builtIns.map((base) => {
      const entry = this.#userEntries.get(base.id);
      return entry ? withOverride(base, entry) : base;
    });
    for (const [id, entry] of this.#userEntries) {
      if (this.#builtIns.some((base) => base.id === id)) continue;
      out.push(fromUserEntry(entry));
    }
    return out;
  }

  active(): NetworkProfile {
    const chosen = this.list().find((profile) => profile.id === this.#activeId);
    if (chosen) return chosen;
    // The remembered id names nothing this build has — a profile removed
    // between releases, a profile a person removed, or a hand-edited file.
    // Fall back INSIDE the list, so what is reported active is always
    // something that can be switched to.
    const fallback =
      this.list().find((profile) => profile.id === DEFAULT_PROFILE_ID) ?? this.list()[0];
    if (!fallback) throw new Error('a ProfileStore was built with no profiles');
    return fallback;
  }

  /** @throws {UnknownProfileError} when nothing is named `id`. */
  setActive(id: string): NetworkProfile {
    const profile = this.list().find((candidate) => candidate.id === id);
    if (!profile) throw new UnknownProfileError(id);
    this.#activeId = profile.id;
    this.#writeActive(profile.id);
    return profile;
  }

  /** The names of the endpoint fields this id currently carries an override
   * for (`ENDPOINT_FIELD_NAMES`' own spelling, `"rpc.evm"` included) — empty
   * for a built-in nobody has touched. Used by the API view so a client can
   * tell "reads like devnet because it IS devnet" from "reads like devnet
   * because every field happens to still match." */
  overriddenFields(id: string): readonly string[] {
    const entry = this.#userEntries.get(id);
    if (!entry) return [];
    return ENDPOINT_FIELD_NAMES.filter((field) => fieldOf(entry, field) !== undefined);
  }

  /**
   * Replaces the whole stored override (or addition) for `id` with `input`
   * and persists it. The caller (the API route) has already validated every
   * URL in `input` — this method's only own check is `id` itself, since an
   * id this store has never seen becomes a directory name elsewhere
   * (`paths.profileDataDir`) and a request body is not a safe source for
   * one.
   *
   * @throws {InvalidProfileIdError} for a new id outside the safe alphabet.
   */
  setEndpoints(id: string, input: ProfileEndpointsInput): NetworkProfile {
    const builtIn = this.#builtIns.find((base) => base.id === id);
    if (!builtIn && !isValidProfileId(id)) {
      throw new InvalidProfileIdError(id);
    }
    const existing = this.#userEntries.get(id);

    const entry: UserProfileEntry = { id };
    const withField = <K extends keyof ProfileEndpointsInput>(key: K): string | undefined => {
      const value = input[key];
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    };

    const mutable = entry as {
      -readonly [K in keyof UserProfileEntry]: UserProfileEntry[K];
    };
    mutable.connectorUrl = withField('connectorUrl');
    mutable.relayUrl = withField('relayUrl');
    mutable.gatewayDomain = withField('gatewayDomain');
    mutable.gatewayConnectorUrl = withField('gatewayConnectorUrl');
    mutable.gasConnectorUrl = withField('gasConnectorUrl');
    mutable.faucetUrl = withField('faucetUrl');
    const evm =
      typeof input.rpc?.evm === 'string' && input.rpc.evm.trim()
        ? input.rpc.evm.trim()
        : undefined;
    const solana =
      typeof input.rpc?.solana === 'string' && input.rpc.solana.trim()
        ? input.rpc.solana.trim()
        : undefined;
    if (evm !== undefined || solana !== undefined) {
      mutable.rpc = {
        ...(evm !== undefined ? { evm } : {}),
        ...(solana !== undefined ? { solana } : {}),
      };
    }

    // Endpoints only — a built-in's own label and description are never
    // overridable (`profiles.test.ts`'s rule), only a profile with no
    // built-in needs its own.
    if (!builtIn) {
      const label =
        typeof input.label === 'string' && input.label.trim() ? input.label.trim() : undefined;
      const description =
        typeof input.description === 'string' ? input.description.trim() : undefined;
      mutable.label = label ?? existing?.label ?? id;
      mutable.description = description ?? existing?.description ?? '';
    }

    const hasEndpoint = ENDPOINT_FIELD_NAMES.some(
      (field) => fieldOf(entry, field) !== undefined
    );
    if (builtIn && !hasEndpoint) {
      // Every field this call set was blank: there is nothing left to
      // override, so this is the same as a reset rather than an override
      // with nothing in it.
      this.#userEntries.delete(id);
    } else {
      this.#userEntries.set(id, entry);
    }
    this.#writeUserProfiles();

    const result = this.list().find((profile) => profile.id === id);
    if (!result) throw new Error(`setEndpoints produced no profile for ${JSON.stringify(id)}`);
    return result;
  }

  /**
   * `DELETE /api/profiles/<id>`'s two behaviours in one method: for a
   * built-in, drops whatever override it carries and answers the built-in
   * itself — always allowed, even while it is active, since nothing is
   * removed from the list. For a profile with no built-in, removes it
   * outright and answers `undefined` — refused while it is active, since
   * that WOULD remove the thing currently in use.
   *
   * @throws {UnknownProfileError} for an id this store has never added.
   * @throws {ActiveProfileError} removing (not resetting) the active profile.
   */
  resetOrRemove(id: string): NetworkProfile | undefined {
    const builtIn = this.#builtIns.find((base) => base.id === id);
    if (builtIn) {
      this.#userEntries.delete(id);
      this.#writeUserProfiles();
      return builtIn;
    }
    if (!this.#userEntries.has(id)) throw new UnknownProfileError(id);
    if (id === this.#activeId) throw new ActiveProfileError(id);
    this.#userEntries.delete(id);
    this.#writeUserProfiles();
    return undefined;
  }

  #readActive(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.#activePath, 'utf8')) as {
        activeId?: unknown;
      };
      if (typeof parsed.activeId === 'string') return parsed.activeId;
    } catch {
      // No file yet, or a file this version cannot read. Either way: default.
    }
    return DEFAULT_PROFILE_ID;
  }

  #writeActive(id: string): void {
    mkdirSync(dirname(this.#activePath), { recursive: true });
    writeFileSync(this.#activePath, `${JSON.stringify({ activeId: id }, null, 2)}\n`);
  }

  #readUserProfiles(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#userProfilesPath, 'utf8')) as {
        profiles?: unknown;
      };
      if (!Array.isArray(parsed.profiles)) return;
      for (const raw of parsed.profiles) {
        const entry = sanitizeEntry(raw);
        if (entry) this.#userEntries.set(entry.id, entry);
      }
    } catch {
      // No file yet, or a file this version cannot read — start with no
      // overrides, the same fallback philosophy as the active-profile file.
    }
  }

  /**
   * Atomic, mode `0600` (TOON_Network#150): a network endpoint is not a
   * secret, but the file sits beside `profile.json` in the same config
   * directory, and a half-written JSON file — the result of a write that
   * lost power partway — must never be what the next launch reads as "no
   * overrides." Writing to a temp file in the same directory and renaming it
   * over the real path is what makes the write atomic; `rename` never
   * leaves a reader seeing a partial file.
   */
  #writeUserProfiles(): void {
    mkdirSync(dirname(this.#userProfilesPath), { recursive: true });
    const body = { profiles: [...this.#userEntries.values()] };
    const tmpPath = `${this.#userProfilesPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, this.#userProfilesPath);
    try {
      chmodSync(this.#userProfilesPath, 0o600);
    } catch {
      // Best-effort on a platform (or filesystem) that does not support
      // Unix permission bits at all — the write above already succeeded.
    }
  }
}

export class UnknownProfileError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`no network profile named ${JSON.stringify(id)}`);
    this.name = 'UnknownProfileError';
    this.id = id;
  }
}

export class ActiveProfileError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `${JSON.stringify(id)} is the active profile — switch to another one before removing it.`
    );
    this.name = 'ActiveProfileError';
    this.id = id;
  }
}

export class InvalidProfileIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `${JSON.stringify(id)} is not a valid profile id — lowercase letters, digits and hyphens, starting with a letter.`
    );
    this.name = 'InvalidProfileIdError';
    this.id = id;
  }
}

function fieldOf(
  entry: UserProfileEntry,
  field: (typeof ENDPOINT_FIELD_NAMES)[number]
): string | undefined {
  switch (field) {
    case 'connectorUrl':
      return entry.connectorUrl;
    case 'relayUrl':
      return entry.relayUrl;
    case 'gatewayDomain':
      return entry.gatewayDomain;
    case 'gatewayConnectorUrl':
      return entry.gatewayConnectorUrl;
    case 'gasConnectorUrl':
      return entry.gasConnectorUrl;
    case 'faucetUrl':
      return entry.faucetUrl;
    case 'rpc.evm':
      return entry.rpc?.evm;
    case 'rpc.solana':
      return entry.rpc?.solana;
    default:
      return undefined;
  }
}

/** `exactOptionalPropertyTypes` refuses `{ evm: possiblyUndefined }` even for
 * an optional field — a key present with `undefined` is not the same as the
 * key absent — so the two callers below build `rpc` through this instead of
 * an object literal that assigns straight from a `??`. */
function mergeRpc(
  entry: ChainRpcEndpoints | undefined,
  base: ChainRpcEndpoints | undefined
): ChainRpcEndpoints {
  const evm = entry?.evm ?? base?.evm;
  const solana = entry?.solana ?? base?.solana;
  return {
    ...(evm !== undefined ? { evm } : {}),
    ...(solana !== undefined ? { solana } : {}),
  };
}

function withOverride(base: NetworkProfile, entry: UserProfileEntry): NetworkProfile {
  return {
    ...base,
    connectorUrl: entry.connectorUrl ?? base.connectorUrl,
    relayUrl: entry.relayUrl ?? base.relayUrl,
    gatewayDomain: entry.gatewayDomain ?? base.gatewayDomain,
    gatewayConnectorUrl: entry.gatewayConnectorUrl ?? base.gatewayConnectorUrl,
    gasConnectorUrl: entry.gasConnectorUrl ?? base.gasConnectorUrl,
    faucetUrl: entry.faucetUrl ?? base.faucetUrl,
    rpc: mergeRpc(entry.rpc, base.rpc),
    origin: 'user',
  };
}

function fromUserEntry(entry: UserProfileEntry): NetworkProfile {
  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    description: entry.description ?? '',
    connectorUrl: entry.connectorUrl ?? '',
    relayUrl: entry.relayUrl ?? '',
    gatewayDomain: entry.gatewayDomain ?? '',
    gatewayConnectorUrl: entry.gatewayConnectorUrl ?? '',
    gasConnectorUrl: entry.gasConnectorUrl ?? '',
    ...(entry.faucetUrl !== undefined ? { faucetUrl: entry.faucetUrl } : {}),
    rpc: mergeRpc(entry.rpc, undefined),
    origin: 'user',
  };
}

/** Turns whatever `JSON.parse` handed back for one array element into a
 * `UserProfileEntry`, or `undefined` when it is not shaped like one — a
 * hand-edited or future-version file must not crash the daemon, the same
 * tolerance `#readActive` gives a bad `profile.json`. */
function sanitizeEntry(raw: unknown): UserProfileEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const str = (key: string): string | undefined => {
    const field = value[key];
    return typeof field === 'string' ? field : undefined;
  };

  const rpcRaw = value.rpc;
  let rpc: ChainRpcEndpoints | undefined;
  if (typeof rpcRaw === 'object' && rpcRaw !== null) {
    const rpcValue = rpcRaw as Record<string, unknown>;
    const evm = typeof rpcValue.evm === 'string' ? rpcValue.evm : undefined;
    const solana = typeof rpcValue.solana === 'string' ? rpcValue.solana : undefined;
    if (evm !== undefined || solana !== undefined) {
      rpc = {
        ...(evm !== undefined ? { evm } : {}),
        ...(solana !== undefined ? { solana } : {}),
      };
    }
  }

  return {
    id,
    ...(str('label') !== undefined ? { label: str('label') } : {}),
    ...(str('description') !== undefined ? { description: str('description') } : {}),
    ...(str('connectorUrl') !== undefined ? { connectorUrl: str('connectorUrl') } : {}),
    ...(str('relayUrl') !== undefined ? { relayUrl: str('relayUrl') } : {}),
    ...(str('gatewayDomain') !== undefined ? { gatewayDomain: str('gatewayDomain') } : {}),
    ...(str('gatewayConnectorUrl') !== undefined
      ? { gatewayConnectorUrl: str('gatewayConnectorUrl') }
      : {}),
    ...(str('gasConnectorUrl') !== undefined
      ? { gasConnectorUrl: str('gasConnectorUrl') }
      : {}),
    ...(str('faucetUrl') !== undefined ? { faucetUrl: str('faucetUrl') } : {}),
    ...(rpc !== undefined ? { rpc } : {}),
  };
}
