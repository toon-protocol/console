import { describe, expect, it } from 'vitest';

import { readAccountProfile } from './account-metadata.js';
import type { NostrEvent, RelaySocket, SocketFactory } from './relay-read.js';

const PUBKEY = 'aa'.repeat(32);

function event(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'id',
    pubkey: PUBKEY,
    created_at: 1_000,
    kind: 0,
    tags: [],
    content: '{}',
    sig: 'ff'.repeat(64),
    ...overrides,
  };
}

/** Each relay answers with whatever it holds, whatever the filter asks. */
function relaysHolding(holdings: Record<string, NostrEvent[]>): SocketFactory {
  return (url) => {
    const held = holdings[url] ?? [];
    let subscription = '';
    const socket: RelaySocket = {
      send: (data) => {
        const frame = JSON.parse(data) as [string, string, { kinds?: number[] }];
        if (frame[0] !== 'REQ') return;
        subscription = frame[1];
        const kinds = frame[2].kinds ?? [];
        queueMicrotask(() => {
          for (const candidate of held.filter((one) => kinds.includes(one.kind))) {
            socket.onmessage?.({ data: JSON.stringify(['EVENT', subscription, candidate]) });
          }
          socket.onmessage?.({ data: JSON.stringify(['EOSE', subscription]) });
        });
      },
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
}

describe('the account’s kind-0', () => {
  it('reads name and picture from the profile’s relay when there is no NIP-65', async () => {
    const profile = await readAccountProfile(PUBKEY, ['wss://devnet'], {
      socketFactory: relaysHolding({
        'wss://devnet': [
          event({ content: JSON.stringify({ name: 'ada', picture: 'https://pic/1' }) }),
        ],
      }),
    });
    expect(profile.metadata?.name).toBe('ada');
    expect(profile.metadata?.picture).toBe('https://pic/1');
    expect(profile.relaySource).toBe('profile');
    expect(profile.relays).toEqual(['wss://devnet']);
  });

  it('follows the account’s NIP-65 list and prefers what it finds there', async () => {
    const profile = await readAccountProfile(PUBKEY, ['wss://devnet'], {
      socketFactory: relaysHolding({
        'wss://devnet': [
          event({ created_at: 1_000, content: JSON.stringify({ name: 'stale' }) }),
          event({
            kind: 10_002,
            tags: [
              ['r', 'wss://own-read', 'read'],
              ['r', 'wss://own-both'],
              ['r', 'wss://own-write', 'write'],
            ],
          }),
        ],
        'wss://own-read': [
          event({ created_at: 2_000, content: JSON.stringify({ name: 'current' }) }),
        ],
        'wss://own-both': [],
      }),
    });
    expect(profile.metadata?.name).toBe('current');
    expect(profile.relaySource).toBe('nip65');
    // A write-only relay is not somewhere to read from.
    expect(profile.relays).toEqual(['wss://own-read', 'wss://own-both']);
  });

  it('keeps the older copy when the account’s own relays have nothing newer', async () => {
    const profile = await readAccountProfile(PUBKEY, ['wss://devnet'], {
      socketFactory: relaysHolding({
        'wss://devnet': [
          event({ created_at: 5_000, content: JSON.stringify({ name: 'newest' }) }),
          event({ kind: 10_002, tags: [['r', 'wss://own']] }),
        ],
        'wss://own': [
          event({ created_at: 1_000, content: JSON.stringify({ name: 'older' }) }),
        ],
      }),
    });
    expect(profile.metadata?.name).toBe('newest');
  });

  it('is a signed-in account with no name when nothing answers', async () => {
    const profile = await readAccountProfile(PUBKEY, ['wss://devnet'], {
      socketFactory: relaysHolding({ 'wss://devnet': [] }),
    });
    expect(profile.metadata).toBeUndefined();
    expect(profile.relaySource).toBe('profile');
  });

  it('does not fall over on a kind-0 that is not JSON', async () => {
    const profile = await readAccountProfile(PUBKEY, ['wss://devnet'], {
      socketFactory: relaysHolding({ 'wss://devnet': [event({ content: 'hello' })] }),
    });
    expect(profile.metadata?.name).toBeUndefined();
    expect(profile.metadata?.publishedAt).toBeDefined();
  });

  it('truncates a name long enough to be an attack on the layout', async () => {
    const profile = await readAccountProfile(PUBKEY, ['wss://devnet'], {
      socketFactory: relaysHolding({
        'wss://devnet': [event({ content: JSON.stringify({ name: 'a'.repeat(5_000) }) })],
      }),
    });
    expect(profile.metadata?.name).toHaveLength(512);
  });

  it('asks nothing at all when the profile names no relay', async () => {
    const profile = await readAccountProfile(PUBKEY, [], {
      socketFactory: () => {
        throw new Error('nothing should have been dialled');
      },
    });
    expect(profile.relaySource).toBe('none');
  });
});
