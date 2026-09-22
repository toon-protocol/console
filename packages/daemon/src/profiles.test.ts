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
    const serialized = JSON.stringify(BUILT_IN_PROFILES);
    for (const chainFact of ['84532', 'usdc', '0x', 'base', 'solana', 'evm:']) {
      expect(serialized.toLowerCase()).not.toContain(chainFact);
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
    const store = new ProfileStore(path, BUILT_IN_PROFILES.filter((p) => p.id !== 'mainnet'));
    expect(store.active().id).toBe('devnet');
  });
});
