import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activeProfileFilePath, consolePaths } from './paths.js';
import { ProfileStore, UnknownProfileError } from './profile-store.js';
import { BUILT_IN_PROFILES, DEFAULT_PROFILE_ID, isConfigured } from './profiles.js';

describe('network profiles', () => {
  it('ships devnet, a local sandbox and mainnet, and starts on devnet', () => {
    expect(BUILT_IN_PROFILES.map((profile) => profile.id)).toEqual([
      'devnet',
      'sandbox',
      'mainnet',
    ]);
    expect(DEFAULT_PROFILE_ID).toBe('devnet');
  });

  it('hard-codes no chain facts — only endpoints', () => {
    // Every chain fact is read from the connector at runtime. If a chain id, a
    // token address or a settlement address ever appears in a profile, this
    // test is the thing that should stop it.
    //
    // It used to be a substring blocklist that included the words `base` and
    // `solana`. #90 gave a profile chain RPC ENDPOINTS, whose keys have to name
    // a chain family to be keys at all, so the blocklist would have refused a
    // URL while letting `"chainId": 84532` through untouched. What is banned is
    // therefore spelled out as the three things spec §2 and §3 say come from
    // `GET /ilp`: a chain id, a token address and a settlement address.
    const serialized = JSON.stringify(BUILT_IN_PROFILES).toLowerCase();
    expect(serialized).not.toMatch(/0x[0-9a-f]{6,}/u); // an EVM address or key
    expect(serialized).not.toMatch(/\bevm:\d+/u); // a chain key
    expect(serialized).not.toMatch(/\bchainid\b/u);
    expect(serialized).not.toMatch(/\busdc\b/u); // the settlement token
    expect(serialized).not.toMatch(/\bdecimals\b/u);
    expect(serialized).not.toMatch(/\b(84532|31337)\b/u); // the two chain ids in play
  });

  it('gives a profile endpoints and nothing else', () => {
    // The positive half of the rule above: every value a profile carries is an
    // id, a label, a sentence of prose, or a URL. Nothing else gets in.
    for (const profile of BUILT_IN_PROFILES) {
      const { id, label, description, origin, gatewayDomain, ...endpoints } = profile;
      expect(typeof id).toBe('string');
      expect(typeof label).toBe('string');
      expect(typeof description).toBe('string');
      expect(origin).toBe('built-in');
      // A gateway domain is a hostname suffix rather than a URL, so it is
      // checked on its own terms.
      expect(gatewayDomain).toMatch(/^$|^[a-z0-9.:-]+$/u);
      for (const url of urlsIn(endpoints)) {
        expect(url, `${profile.id} carries a non-URL endpoint`).toMatch(
          /^(https?|wss?):\/\/[^\s]+$/u
        );
      }
    }
  });

  it('marks mainnet unconfigured rather than guessing a connector for it', () => {
    const mainnet = BUILT_IN_PROFILES.find((profile) => profile.id === 'mainnet');
    expect(mainnet && isConfigured(mainnet)).toBe(false);
    for (const id of ['devnet', 'sandbox']) {
      const profile = BUILT_IN_PROFILES.find((candidate) => candidate.id === id);
      expect(profile && isConfigured(profile)).toBe(true);
    }
  });
});

/** Every string in a nested record, flattened, with the empty ones dropped. */
function urlsIn(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(urlsIn);
}

describe('ProfileStore', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const storePath = () =>
    activeProfileFilePath(consolePaths({ HOME: home } as NodeJS.ProcessEnv));

  it('defaults to devnet with nothing on disk', () => {
    expect(new ProfileStore(storePath()).active().id).toBe('devnet');
  });

  it('remembers a switch across restarts', () => {
    const path = storePath();
    new ProfileStore(path).setActive('sandbox');
    expect(new ProfileStore(path).active().id).toBe('sandbox');
  });

  it('refuses a profile it does not have', () => {
    expect(() => new ProfileStore(storePath()).setActive('nope')).toThrow(UnknownProfileError);
  });

  it('falls back to the default rather than refusing to start on a bad file', () => {
    const path = storePath();
    new ProfileStore(path).setActive('mainnet');
    // A file from a future version, or a half-written one.
    const store = new ProfileStore(
      path,
      BUILT_IN_PROFILES.filter((p) => p.id !== 'mainnet')
    );
    expect(store.active().id).toBe('devnet');
  });
});
