import { describe, expect, it } from 'vitest';

import { readAccountProfile } from './account-metadata.js';
import { fakeProvider, fakeRelays, sign, type FakeProvider } from './directory.testkit.js';
import type { NostrEvent } from './nostr.js';

/**
 * The kind-0 read, against fake relays that answer the way a relay does.
 *
 * Signed, because `relay-pool` verifies before it hands anything over — and
 * that is the point of the last test here: a relay that serves SOMEBODY ELSE'S
 * kind-0 under this account's pubkey would otherwise choose the face a person
 * sees while they decide what to pay for.
 */

const account = fakeProvider('the-account');
const stranger = fakeProvider('somebody-else');

function metadata(who: FakeProvider, content: unknown, createdAt = 1_000): NostrEvent {
  return sign(who, { kind: 0, created_at: createdAt, tags: [], content: JSON.stringify(content) });
}

function relayList(who: FakeProvider, tags: string[][], createdAt = 1_000): NostrEvent {
  return sign(who, { kind: 10_002, created_at: createdAt, tags, content: '' });
}

describe('the account’s kind-0', () => {
  it('reads name and picture from the profile’s relay when there is no NIP-65', async () => {
    const { dial } = fakeRelays([
      {
        url: 'wss://devnet',
        events: [metadata(account, { name: 'ada', picture: 'https://pic/1' })],
      },
    ]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata?.name).toBe('ada');
    expect(profile.metadata?.picture).toBe('https://pic/1');
    expect(profile.relaySource).toBe('profile');
    expect(profile.relays).toEqual(['wss://devnet']);
  });

  it('follows the account’s NIP-65 list and prefers what it finds there', async () => {
    const { dial } = fakeRelays([
      {
        url: 'wss://devnet',
        events: [
          metadata(account, { name: 'stale' }, 1_000),
          relayList(account, [
            ['r', 'wss://own-read', 'read'],
            ['r', 'wss://own-both'],
            ['r', 'wss://own-write', 'write'],
          ]),
        ],
      },
      { url: 'wss://own-read', events: [metadata(account, { name: 'current' }, 2_000)] },
      { url: 'wss://own-both', events: [] },
    ]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata?.name).toBe('current');
    expect(profile.relaySource).toBe('nip65');
    // A write-only relay is not somewhere to read from.
    expect(profile.relays).toEqual(['wss://own-read', 'wss://own-both']);
  });

  it('keeps the newer copy when the account’s own relays have nothing fresher', async () => {
    const { dial } = fakeRelays([
      {
        url: 'wss://devnet',
        events: [
          metadata(account, { name: 'newest' }, 5_000),
          relayList(account, [['r', 'wss://own']]),
        ],
      },
      { url: 'wss://own', events: [metadata(account, { name: 'older' }, 1_000)] },
    ]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata?.name).toBe('newest');
  });

  it('is a signed-in account with no name when nothing answers', async () => {
    const { dial } = fakeRelays([{ url: 'wss://devnet', events: [] }]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata).toBeUndefined();
    expect(profile.relaySource).toBe('profile');
  });

  it('survives a relay that will not answer at all', async () => {
    const { dial } = fakeRelays([{ url: 'wss://devnet', events: [], broken: true }]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata).toBeUndefined();
    expect(profile.relaySource).toBe('profile');
  });

  it('does not fall over on a kind-0 that is not JSON', async () => {
    const { dial } = fakeRelays([
      {
        url: 'wss://devnet',
        events: [sign(account, { kind: 0, created_at: 1_000, tags: [], content: 'hello' })],
      },
    ]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata?.name).toBeUndefined();
    expect(profile.metadata?.publishedAt).toBeDefined();
  });

  it('truncates a name long enough to be an attack on the layout', async () => {
    const { dial } = fakeRelays([
      { url: 'wss://devnet', events: [metadata(account, { name: 'a'.repeat(5_000) })] },
    ]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata?.name).toHaveLength(512);
  });

  it('asks nothing at all when the profile names no relay', async () => {
    const profile = await readAccountProfile(account.pubkey, [], {
      dial: () => {
        throw new Error('nothing should have been dialled');
      },
    });
    expect(profile.relaySource).toBe('none');
  });

  /**
   * The read is filtered on the account's pubkey, and verified on top of that,
   * so a relay cannot put a stranger's face on this account.
   */
  it('shows no name a relay made up', async () => {
    const { dial } = fakeRelays([
      { url: 'wss://devnet', events: [metadata(stranger, { name: 'not-the-account' })] },
    ]);
    const profile = await readAccountProfile(account.pubkey, ['wss://devnet'], { dial });
    expect(profile.metadata).toBeUndefined();
  });
});
