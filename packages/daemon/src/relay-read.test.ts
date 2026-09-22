import { describe, expect, it } from 'vitest';

import {
  queryRelays,
  type NostrEvent,
  type RelaySocket,
  type SocketFactory,
} from './relay-read.js';

/**
 * A relay in fifty lines: it opens, answers one REQ from a script, and closes.
 * Driving the real thing would need a websocket server in the test tree; this
 * drives every branch the reader has, including the two that matter most — a
 * relay that never opens and one that answers garbage.
 */
interface Script {
  events?: NostrEvent[];
  eose?: boolean;
  garbage?: boolean;
  neverOpens?: boolean;
}

function fakeRelays(scripts: Record<string, Script>): {
  factory: SocketFactory;
  sent: string[];
} {
  const sent: string[] = [];
  const factory: SocketFactory = (url) => {
    const script = scripts[url];
    if (!script) throw new Error(`no script for ${url}`);
    let subscription = '';
    const socket: RelaySocket = {
      send: (data) => {
        sent.push(data);
        const frame = JSON.parse(data) as string[];
        if (frame[0] === 'REQ' && frame[1]) subscription = frame[1];
      },
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      if (script.neverOpens) return;
      socket.onopen?.();
      if (script.garbage) socket.onmessage?.({ data: 'not json' });
      for (const event of script.events ?? []) {
        socket.onmessage?.({ data: JSON.stringify(['EVENT', subscription, event]) });
      }
      if (script.eose !== false) {
        socket.onmessage?.({ data: JSON.stringify(['EOSE', subscription]) });
      }
    });
    return socket;
  };
  return { factory, sent };
}

function event(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'id',
    pubkey: 'aa'.repeat(32),
    created_at: 1_000,
    kind: 0,
    tags: [],
    content: '{}',
    sig: 'ff'.repeat(64),
    ...overrides,
  };
}

describe('reading events off relays', () => {
  it('sends a REQ and stops at EOSE', async () => {
    const { factory, sent } = fakeRelays({ 'wss://one': { events: [event({})] } });
    const found = await queryRelays(['wss://one'], { kinds: [0] }, { socketFactory: factory });
    expect(found).toHaveLength(1);
    expect(sent[0]).toContain('"REQ"');
    expect(sent.at(-1)).toContain('"CLOSE"');
  });

  it('keeps the newest of two relays’ answers', async () => {
    const { factory } = fakeRelays({
      'wss://stale': { events: [event({ id: 'old', created_at: 1_000 })] },
      'wss://fresh': { events: [event({ id: 'new', created_at: 2_000 })] },
    });
    const found = await queryRelays(
      ['wss://stale', 'wss://fresh'],
      { kinds: [0] },
      { socketFactory: factory }
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('new');
  });

  it('keeps one answer per kind', async () => {
    const { factory } = fakeRelays({
      'wss://one': { events: [event({ kind: 0 }), event({ kind: 10_002, id: 'relays' })] },
    });
    const found = await queryRelays(
      ['wss://one'],
      { kinds: [0, 10_002] },
      { socketFactory: factory }
    );
    expect(found.map((found) => found.kind).sort()).toEqual([0, 10_002]);
  });

  it('gives up on a relay that never opens, and keeps the others', async () => {
    const { factory } = fakeRelays({
      'wss://dead': { neverOpens: true },
      'wss://live': { events: [event({ id: 'live' })] },
    });
    const found = await queryRelays(
      ['wss://dead', 'wss://live'],
      { kinds: [0] },
      { socketFactory: factory, timeoutMs: 50 }
    );
    expect(found.map((found) => found.id)).toEqual(['live']);
  });

  it('ignores a frame it cannot parse', async () => {
    const { factory } = fakeRelays({ 'wss://one': { garbage: true, events: [event({})] } });
    const found = await queryRelays(['wss://one'], { kinds: [0] }, { socketFactory: factory });
    expect(found).toHaveLength(1);
  });

  it('answers nothing when a socket cannot even be made', async () => {
    const factory: SocketFactory = () => {
      throw new Error('no network');
    };
    expect(
      await queryRelays(['wss://one'], { kinds: [0] }, { socketFactory: factory })
    ).toEqual([]);
  });
});
