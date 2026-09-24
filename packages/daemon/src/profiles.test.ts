import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activeProfileFilePath, consolePaths, userProfilesFilePath } from './paths.js';
import {
  ActiveProfileError,
  InvalidProfileIdError,
  ProfileStore,
  UnknownProfileError,
} from './profile-store.js';
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

describe('ProfileStore: user profiles (TOON_Network#150)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const paths = () => consolePaths({ HOME: home } as NodeJS.ProcessEnv);
  const storePath = () => activeProfileFilePath(paths());
  const userPath = () => userProfilesFilePath(paths());
  const newStore = () => new ProfileStore(storePath(), undefined, userPath());

  it('overrides one field of a built-in and falls every other field through', () => {
    const store = newStore();
    const updated = store.setEndpoints('devnet', {
      connectorUrl: 'https://my-fork.example/ilp',
    });
    expect(updated.connectorUrl).toBe('https://my-fork.example/ilp');
    expect(updated.relayUrl).toBe(BUILT_IN_PROFILES.find((p) => p.id === 'devnet')!.relayUrl);
    expect(updated.origin).toBe('user');
    expect(store.overriddenFields('devnet')).toEqual(['connectorUrl']);
  });

  it('persists an override across a restart', () => {
    newStore().setEndpoints('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    const reloaded = newStore();
    expect(reloaded.list().find((p) => p.id === 'devnet')?.connectorUrl).toBe(
      'https://my-fork.example/ilp'
    );
    expect(reloaded.overriddenFields('devnet')).toEqual(['connectorUrl']);
  });

  it('a later call REPLACES the whole override, not merges into it', () => {
    const store = newStore();
    store.setEndpoints('devnet', {
      connectorUrl: 'https://a.example/ilp',
      relayUrl: 'wss://a.example',
    });
    // Only `connectorUrl` this time — `relayUrl` must fall back to the
    // built-in, not keep the previous call's override.
    const updated = store.setEndpoints('devnet', { connectorUrl: 'https://b.example/ilp' });
    expect(updated.connectorUrl).toBe('https://b.example/ilp');
    expect(updated.relayUrl).toBe(BUILT_IN_PROFILES.find((p) => p.id === 'devnet')!.relayUrl);
    expect(store.overriddenFields('devnet')).toEqual(['connectorUrl']);
  });

  it('resetting a built-in override goes back to exactly the built-in', () => {
    const store = newStore();
    store.setEndpoints('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    const reset = store.resetOrRemove('devnet');
    expect(reset).toEqual(BUILT_IN_PROFILES.find((p) => p.id === 'devnet'));
    expect(store.overriddenFields('devnet')).toEqual([]);
    expect(store.list().find((p) => p.id === 'devnet')?.origin).toBe('built-in');
  });

  it('resetting a built-in with no override is a harmless no-op', () => {
    const store = newStore();
    expect(store.resetOrRemove('sandbox')).toEqual(
      BUILT_IN_PROFILES.find((p) => p.id === 'sandbox')
    );
  });

  it('overriding every field with an empty string is the same as a reset', () => {
    const store = newStore();
    store.setEndpoints('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    store.setEndpoints('devnet', { connectorUrl: '   ' });
    expect(store.overriddenFields('devnet')).toEqual([]);
    expect(store.list().find((p) => p.id === 'devnet')?.origin).toBe('built-in');
  });

  it('adds a profile under a new id, selectable once added', () => {
    const store = newStore();
    const added = store.setEndpoints('my-devnet', {
      label: 'My devnet fork',
      connectorUrl: 'https://my-fork.example/ilp',
    });
    expect(added.origin).toBe('user');
    expect(added.label).toBe('My devnet fork');
    expect(added.connectorUrl).toBe('https://my-fork.example/ilp');
    expect(added.relayUrl).toBe('');
    expect(store.list().map((p) => p.id)).toContain('my-devnet');
    expect(store.setActive('my-devnet').id).toBe('my-devnet');
  });

  it('lists built-ins first, in their own order, then additions in the order they were added', () => {
    const store = newStore();
    store.setEndpoints('bravo', { label: 'Bravo' });
    store.setEndpoints('alpha', { label: 'Alpha' });
    expect(store.list().map((p) => p.id)).toEqual([
      'devnet',
      'sandbox',
      'mainnet',
      'bravo',
      'alpha',
    ]);
  });

  it('refuses a new id outside the safe alphabet', () => {
    const store = newStore();
    expect(() => store.setEndpoints('../escape', { label: 'x' })).toThrow(
      InvalidProfileIdError
    );
    expect(() => store.setEndpoints('Has Spaces', { label: 'x' })).toThrow(
      InvalidProfileIdError
    );
    expect(() => store.setEndpoints('UPPER', { label: 'x' })).toThrow(InvalidProfileIdError);
  });

  it('removes a profile added under a new id', () => {
    const store = newStore();
    store.setEndpoints('my-devnet', { label: 'My devnet fork' });
    expect(store.resetOrRemove('my-devnet')).toBeUndefined();
    expect(store.list().map((p) => p.id)).not.toContain('my-devnet');
  });

  it('refuses to remove a profile that does not exist', () => {
    const store = newStore();
    expect(() => store.resetOrRemove('nope')).toThrow(UnknownProfileError);
  });

  it('refuses to remove the active profile, and explains why', () => {
    const store = newStore();
    store.setEndpoints('my-devnet', { label: 'My devnet fork' });
    store.setActive('my-devnet');
    expect(() => store.resetOrRemove('my-devnet')).toThrow(ActiveProfileError);
    // Still there — the throw did not partially apply.
    expect(store.list().map((p) => p.id)).toContain('my-devnet');
  });

  it('a built-in may be reset even while it is the active profile', () => {
    const store = newStore();
    store.setEndpoints('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    store.setActive('devnet');
    const reset = store.resetOrRemove('devnet');
    expect(reset?.origin).toBe('built-in');
    expect(store.active().id).toBe('devnet');
  });

  it('a removed user profile is no longer switchable, but switching back to a reset built-in still finds it', () => {
    const store = newStore();
    store.setEndpoints('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    store.resetOrRemove('devnet');
    expect(store.setActive('devnet').connectorUrl).toBe(
      BUILT_IN_PROFILES.find((p) => p.id === 'devnet')!.connectorUrl
    );
  });

  it('writes the user profiles file atomically at mode 0600', () => {
    newStore().setEndpoints('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    const stat = statSync(userPath());
    expect(stat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(userPath(), 'utf8')) as { profiles: unknown[] };
    expect(onDisk.profiles).toHaveLength(1);
  });

  it('a corrupt or hand-edited user profiles file falls back to no overrides rather than refusing to start', () => {
    mkdirSync(dirname(userPath()), { recursive: true });
    writeFileSync(userPath(), '{ not json');
    const store = newStore();
    expect(store.list().find((p) => p.id === 'devnet')?.origin).toBe('built-in');
  });

  it('carries no chain fact for an added profile either — endpoints only', () => {
    const store = newStore();
    const added = store.setEndpoints('my-devnet', {
      label: 'My devnet fork',
      connectorUrl: 'https://my-fork.example/ilp',
    });
    const { id, label, description, origin, gatewayDomain, ...endpoints } = added;
    expect(id).toBeTruthy();
    expect(label).toBeTruthy();
    expect(typeof description).toBe('string');
    expect(origin).toBe('user');
    expect(gatewayDomain).toBe('');
    for (const url of urlsIn(endpoints)) {
      expect(url).toMatch(/^(https?|wss?):\/\/[^\s]+$/u);
    }
  });
});
