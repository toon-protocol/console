import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { BUILT_IN_PROFILES, DEFAULT_PROFILE_ID, type NetworkProfile } from './profiles.js';

/**
 * Which profile is active, remembered across restarts.
 *
 * The whole store is one id in one small file. It is deliberately not the
 * profile itself: a built-in's endpoints may be corrected in a later release,
 * and a copy written to disk at first launch would pin a person to the old
 * ones forever. An unreadable or unknown file falls back to the default rather
 * than refusing to start — a console that will not open is worse than one that
 * opens on devnet.
 */
export class ProfileStore {
  readonly #path: string;
  readonly #profiles: readonly NetworkProfile[];
  #activeId: string;

  constructor(path: string, profiles: readonly NetworkProfile[] = BUILT_IN_PROFILES) {
    this.#path = path;
    this.#profiles = profiles;
    this.#activeId = this.#read();
  }

  list(): readonly NetworkProfile[] {
    return this.#profiles;
  }

  active(): NetworkProfile {
    const chosen = this.#profiles.find((profile) => profile.id === this.#activeId);
    if (chosen) return chosen;
    // The remembered id names nothing this build has — a profile removed
    // between releases, or a hand-edited file. Fall back INSIDE the list, so
    // what is reported active is always something that can be switched to.
    const fallback =
      this.#profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID) ?? this.#profiles[0];
    if (!fallback) throw new Error('a ProfileStore was built with no profiles');
    return fallback;
  }

  /** @throws {UnknownProfileError} when nothing is named `id`. */
  setActive(id: string): NetworkProfile {
    const profile = this.#profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new UnknownProfileError(id);
    this.#activeId = profile.id;
    this.#write(profile.id);
    return profile;
  }

  #read(): string {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as { activeId?: unknown };
      if (typeof parsed.activeId === 'string') return parsed.activeId;
    } catch {
      // No file yet, or a file this version cannot read. Either way: default.
    }
    return DEFAULT_PROFILE_ID;
  }

  #write(id: string): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify({ activeId: id }, null, 2)}\n`);
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
