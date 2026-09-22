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

/** The file the daemon writes so a launcher can find it. */
export function launchFilePath(paths: ConsolePaths): string {
  return join(paths.runtime, 'launch.json');
}

/** Where the active profile id is remembered between runs. */
export function activeProfileFilePath(paths: ConsolePaths): string {
  return join(paths.config, 'profile.json');
}
