import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the console keeps things.
 *
 * XDG, with the usual fallbacks, and one directory per concern so that the
 * later tickets have somewhere obvious to put what they add: channel state and
 * the Lease Vault cache under the data directory, the active profile under the
 * config directory, the per-launch token under the runtime directory (which the
 * session wipes on logout — exactly the lifetime a launch token wants).
 *
 * Everything that varies per network is keyed by profile id, because devnet
 * channel state and sandbox channel state are not interchangeable and a person
 * switching profiles must never be shown one while paying on the other.
 */

const APP = 'toon-console';

/** XDG says a relative value is invalid and must be ignored, so it is. */
function xdg(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const value = env[variable];
  return value && value.startsWith('/') ? value : fallback;
}

export interface ConsolePaths {
  /** Long-lived state: channel stores, caches. */
  readonly data: string;
  /** Preferences: the active profile, user profiles. */
  readonly config: string;
  /** This login session only: the launch token, the address the daemon bound. */
  readonly runtime: string;
}

export function consolePaths(env: NodeJS.ProcessEnv = process.env): ConsolePaths {
  const home = env.HOME ?? homedir();
  const data = join(xdg(env, 'XDG_DATA_HOME', join(home, '.local', 'share')), APP);
  const config = join(xdg(env, 'XDG_CONFIG_HOME', join(home, '.config')), APP);
  const runtimeBase = env.XDG_RUNTIME_DIR?.startsWith('/') ? env.XDG_RUNTIME_DIR : data;
  return { data, config, runtime: join(runtimeBase, APP) };
}

/** Everything one network's state lives under. */
export function profileDataDir(paths: ConsolePaths, profileId: string): string {
  return join(paths.data, 'profiles', profileId);
}

/**
 * Everything ONE ACCOUNT's state lives under.
 *
 * Keyed by pubkey and not by profile, because an account's Chain Seed is the
 * same seed on every network it settles on (ADR 0020). Channel state is the
 * other way round and lives under `profileDataDir`; the two directories being
 * separate is what keeps the distinction from being forgotten.
 */
export function accountDataDir(paths: ConsolePaths, pubkey: string): string {
  return join(paths.data, 'accounts', safeKey(pubkey));
}

/** The sealed Chain Seed record's local cache (TOON_Network#89). */
export function accountChainSeedPath(paths: ConsolePaths, pubkey: string): string {
  return join(accountDataDir(paths, pubkey), 'chain-seed.json');
}

/**
 * The Lease Vault's local cache (TOON_Network#92, ADR 0021).
 *
 * Beside the Chain Seed and keyed the same way — by the ACCOUNT, not by the
 * network profile. A lease is bought on one network, but the record that holds
 * its Root Secret belongs to the account and follows it to any machine, so it
 * lives where the account's other sealed records do. Which network a lease was
 * bought on is a field inside the record, not a directory it hides under.
 */
export function accountLeaseVaultPath(paths: ConsolePaths, pubkey: string): string {
  return join(accountDataDir(paths, pubkey), 'leases.json');
}

/**
 * The last thing each of this account's providers said about its leases
 * (TOON_Network#93).
 *
 * A cache of a FREE read and nothing else: `status` costs nothing at the
 * provider (§5), so this file buys no fidelity, only patience — a dashboard
 * that opens with what it knew rather than with a row of question marks, and
 * an ending that survives a restart. It holds no secret and no token; a lost
 * or corrupt file costs one refresh.
 */
export function accountWorkloadsPath(paths: ConsolePaths, pubkey: string): string {
  return join(accountDataDir(paths, pubkey), 'workloads.json');
}

/**
 * The automatic-extension budgets this MACHINE will spend without being asked
 * (TOON_Network#93).
 *
 * Deliberately not in the Lease Vault, and deliberately not on a relay. A
 * budget is a standing instruction to spend money while nobody is watching,
 * and only the machine running the daemon can carry one out — so the machine
 * that would spend is the machine that holds the rule, and signing in
 * elsewhere arms nothing. It is still keyed by ACCOUNT, because it is that
 * account's money.
 */
export function accountAutoExtendPath(paths: ConsolePaths, pubkey: string): string {
  return join(accountDataDir(paths, pubkey), 'auto-extend.json');
}

/**
 * Which desktop notifications this account has already been sent
 * (TOON_Network#99).
 *
 * One line per event, not per observation: an Eviction announced once must not
 * be announced again after a restart, and this file is what remembers that.
 * It holds nothing but keys and timestamps, and losing it costs at most one
 * repeated toast per open event.
 */
export function accountAlertsPath(paths: ConsolePaths, pubkey: string): string {
  return join(accountDataDir(paths, pubkey), 'alerts.json');
}

/**
 * A pubkey is 64 hex characters, but it arrives from a signer rather than
 * from this process, and a value that reaches `join` decides which file is
 * written. Anything that is not the shape of a pubkey never becomes a path.
 */
function safeKey(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/iu.test(pubkey)) {
    throw new Error(
      'A pubkey is 64 hex characters; this one is not, so it names no directory.'
    );
  }
  return pubkey.toLowerCase();
}

/** The file the daemon writes so a launcher can find it. */
export function launchFilePath(paths: ConsolePaths): string {
  return join(paths.runtime, 'launch.json');
}

/** Where the active profile id is remembered between runs. */
export function activeProfileFilePath(paths: ConsolePaths): string {
  return join(paths.config, 'profile.json');
}

/**
 * Where a person's own network profiles live — a built-in overridden in
 * part, or a profile added outright (TOON_Network#150).
 *
 * Beside {@link activeProfileFilePath} and nothing like it: the active-profile
 * file is one id, small enough to rewrite whole on every switch, while this
 * one holds whatever endpoints a person has typed in, atomically, at mode
 * `0600` (`profile-store.ts` is what writes it — see that module for why the
 * built-ins themselves are never copied here).
 */
export function userProfilesFilePath(paths: ConsolePaths): string {
  return join(paths.config, 'profiles.json');
}
