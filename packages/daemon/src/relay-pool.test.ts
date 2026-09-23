import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import {
  eventMatchesFilter,
  fakeProvider,
  fakeRelays,
  listingEvent,
  profileEvent,
} from './directory.testkit.js';
import { K_LISTING, K_PROFILE, LABEL } from './directory.js';
import type { NostrEvent } from './nostr.js';
import { hiddenAwareDialer, queryRelays } from './relay-pool.js';

const acme = fakeProvider('acme');
const profile = profileEvent(acme);
const basic = listingEvent(acme, { name: 'basic' });

/** A relay on loopback, so `dialWebSocket` itself is under test and not mocked. */
function startRelay(events: readonly NostrEvent[], options: { eose?: boolean } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const [verb, id, ...filters] = JSON.parse(String(raw)) as [
        string,
        string,
        ...Record<string, unknown>[],
      ];
      if (verb !== 'REQ') return;
      for (const event of events) {
        if (filters.some((filter) => eventMatchesFilter(event, filter))) {
          socket.send(JSON.stringify(['EVENT', id, event]));
        }
      }
      if (options.eose !== false) socket.send(JSON.stringify(['EOSE', id]));
    });
  });
  const url = new Promise<string>((done) =>
    server.on('listening', () =>
      done(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  );
  return { server, url };
}

describe('querying relays', () => {
  const running: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map((server) => new Promise((done) => server.close(done)))
    );
  });

  it('opens a real socket, sends one REQ and stops at EOSE', async () => {
    const relay = startRelay([profile, basic]);
    running.push(relay.server);

    const result = await queryRelays({
      relays: [await relay.url],
      filters: [{ kinds: [K_PROFILE, K_LISTING], '#L': [LABEL] }],
    });

    expect(result.relays[0]?.state).toBe('read');
    expect(result.events.map((event) => event.id).sort()).toEqual(
      [profile.id, basic.id].sort()
    );
  });

  it('gives up on a relay that never sends an EOSE, and keeps what it sent', async () => {
    const relay = startRelay([profile], { eose: false });
    running.push(relay.server);

    const result = await queryRelays({
      relays: [await relay.url],
      filters: [{ kinds: [K_PROFILE] }],
      timeoutMs: 300,
    });

    expect(result.relays[0]?.state).toBe('timeout');
    expect(result.events).toHaveLength(1);
  });

  it('reports the relay that could not be reached, rather than failing the read', async () => {
    const relay = startRelay([profile]);
    running.push(relay.server);

    const result = await queryRelays({
      relays: [await relay.url, 'ws://127.0.0.1:1'],
      filters: [{ kinds: [K_PROFILE] }],
      timeoutMs: 2_000,
    });

    expect(result.events).toHaveLength(1);
    expect(result.relays.find((r) => r.url === 'ws://127.0.0.1:1')?.state).toBe('failed');
    expect(result.relays.filter((r) => r.state === 'read')).toHaveLength(1);
  });

  it('de-duplicates the same event across relays, and counts what did not verify', async () => {
    const { dial } = fakeRelays([
      { url: 'ws://one', events: [profile, basic] },
      // The second relay also serves a Listing signed by nobody.
      {
        url: 'ws://two',
        events: [profile, { ...basic, sig: '00'.repeat(64) } as NostrEvent],
      },
    ]);

    const result = await queryRelays({
      relays: ['ws://one', 'ws://two'],
      filters: [{ kinds: [K_PROFILE, K_LISTING] }],
      dial,
    });

    expect(result.events).toHaveLength(2);
    expect(result.rejected).toBe(1);
  });
});

/**
 * A `.anyone` relay (TOON_Network#98, spec §10).
 *
 * A Hidden Provider reaches every relay through `anon`, so the Relay Set its
 * Profile publishes is `.anyone` URLs — and the console's second directory
 * pass would otherwise dial them. It must not, and "must not" is stronger than
 * "would fail": `ws` resolves the name first, and a plaintext DNS query naming
 * the hidden service is the fact the address exists to withhold.
 */
describe('dialling a hidden-service relay', () => {
  const HIDDEN = `ws://${'a'.repeat(56)}.anyone:7100`;
  const running: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map((server) => new Promise((done) => server.close(done)))
    );
  });

  it('is not dialled at all when there is no carriage', async () => {
    const result = await queryRelays({
      relays: [HIDDEN],
      filters: [{ kinds: [K_PROFILE] }],
      dial: hiddenAwareDialer(undefined),
      timeoutMs: 2_000,
    });

    expect(result.relays[0]).toMatchObject({ url: HIDDEN, state: 'failed' });
    expect(result.relays[0]?.reason).toMatch(/plaintext DNS query/u);
    expect(result.events).toHaveLength(0);
  });

  it('rides the carriage when there is one, and leaves clearnet alone', async () => {
    const relay = startRelay([profile]);
    running.push(relay.server);
    const url = await relay.url;

    let asked: string | undefined;
    const carriage = {
      socksProxy: 'socks5h://127.0.0.1:19050',
      fetch: globalThis.fetch,
      createWebSocket: (target: string) => {
        asked = target;
        // Bound to the proxy in the real one; here it is the loopback relay,
        // which is what makes "the carriage was used" observable.
        return new WebSocket(url);
      },
    };

    const overAnon = await queryRelays({
      relays: [HIDDEN],
      filters: [{ kinds: [K_PROFILE] }],
      dial: hiddenAwareDialer(carriage),
      timeoutMs: 2_000,
    });
    const clearnet = await queryRelays({
      relays: [url],
      filters: [{ kinds: [K_PROFILE] }],
      dial: hiddenAwareDialer(carriage),
      timeoutMs: 2_000,
    });

    expect(asked).toBe(HIDDEN);
    expect(overAnon.events).toHaveLength(1);
    // The clearnet read did NOT go through the carriage: a proxy beside a
    // clearnet address buys nothing and the client refuses it outright.
    expect(asked).toBe(HIDDEN);
    expect(clearnet.events).toHaveLength(1);
  });
});
