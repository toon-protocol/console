import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SignerIndex } from './signer-index.js';
import type { SignerRecord } from './signer.js';

function record(overrides: Partial<SignerRecord> = {}): SignerRecord {
  return {
    id: 'id-1',
    kind: 'local',
    label: 'npub1abcd…wxyz',
    pubkey: 'aa'.repeat(32),
    npub: 'npub1aaaa',
    backend: 'file',
    origin: 'generated',
    createdAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('the list of signers this machine knows', () => {
  let dir: string;
  let path: string;
  let index: SignerIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-console-signers-'));
    path = join(dir, 'signers.json');
    index = new SignerIndex(path);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is empty before anything signs in', () => {
    expect(index.list()).toEqual([]);
  });

  it('keeps what it was given, across instances', () => {
    index.put(record());
    expect(new SignerIndex(path).list()).toHaveLength(1);
  });

  it('is readable by its owner and nobody else', () => {
    index.put(record());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('updates the row for an account instead of adding a second', () => {
    index.put(record());
    const again = index.put(record({ id: 'id-2', label: 'renamed' }));
    expect(index.list()).toHaveLength(1);
    // The id is the keystore's key, so the FIRST one has to survive a rename.
    expect(again.id).toBe('id-1');
    expect(index.list()[0]?.label).toBe('renamed');
  });

  it('holds a remote signer beside a local one for the same account', () => {
    index.put(record());
    index.put(record({ id: 'id-2', kind: 'remote', bunkerRelays: ['wss://one'] }));
    expect(index.list()).toHaveLength(2);
  });

  it('remembers when a signer was last used', () => {
    index.put(record());
    index.touch('id-1', new Date('2026-09-23T10:00:00Z'));
    expect(index.find('id-1')?.lastUsedAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('forgets a row', () => {
    index.put(record());
    index.remove('id-1');
    expect(index.list()).toEqual([]);
  });

  it('starts over on a file it cannot read', () => {
    writeFileSync(path, 'not json');
    expect(index.list()).toEqual([]);
  });

  /**
   * The one rule this file has. It is read before a passphrase is asked for,
   * so everything in it is public by construction.
   */
  it('holds nothing secret', () => {
    index.put(record());
    index.put(
      record({
        id: 'id-2',
        kind: 'remote',
        bunkerRelays: ['wss://relay.example'],
        bunkerPubkey: 'bb'.repeat(32),
      })
    );
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('nsec');
    expect(onDisk).not.toContain('secret');
    expect(onDisk).not.toContain('passphrase');
  });
});
