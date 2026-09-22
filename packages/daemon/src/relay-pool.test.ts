import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import {
  eventMatchesFilter,
  fakeProvider,
  fakeRelays,
  listingEvent,
  profileEvent,
} from './directory.testkit.js';
import { K_LISTING, K_PROFILE, LABEL } from './directory.js';
import type { NostrEvent } from './nostr.js';
import { isPersisted, publishToRelays, queryRelays } from './relay-pool.js';

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
 * A relay that takes writes, on a real socket, and answers the way NIP-01
 * says: `["OK", <id>, <bool>, <message>]`. The refusal is as interesting as
 * the acceptance — a TOON relay prices its writes, and the console's whole
 * Chain Seed story turns on hearing that clearly (TOON_Network#89).
 */
function startWritableRelay(
  options: { ok?: boolean; message?: string; silent?: boolean } = {}
) {
  const received: NostrEvent[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const [verb, payload] = JSON.parse(String(raw)) as [string, NostrEvent];
      if (verb !== 'EVENT') return;
      received.push(payload);
      if (options.silent === true) return;
      socket.send(
        JSON.stringify(['OK', payload.id, options.ok ?? true, options.message ?? ''])
      );
    });
  });
  const url = new Promise<string>((done) =>
    server.on('listening', () =>
      done(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  );
  return { server, url, received };
}

describe('publishing to relays', () => {
  const running: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map((server) => new Promise((done) => server.close(done)))
    );
  });

  it('sends the event and reports the relay that accepted it', async () => {
    const relay = startWritableRelay();
    running.push(relay.server);

    const result = await publishToRelays({ event: profile, relays: [await relay.url] });

    expect(relay.received.map((event) => event.id)).toEqual([profile.id]);
    expect(result.relays[0]?.state).toBe('accepted');
    expect(result.accepted).toHaveLength(1);
  });

  it('keeps a refusal’s own words, and its NIP-01 prefix', async () => {
    const relay = startWritableRelay({
      ok: false,
      message: 'restricted: writes require ILP payment',
    });
    running.push(relay.server);

    const result = await publishToRelays({ event: profile, relays: [await relay.url] });

    expect(result.accepted).toEqual([]);
    expect(result.relays[0]).toMatchObject({
      state: 'rejected',
      reason: 'restricted: writes require ILP payment',
      code: 'restricted',
    });
  });

  it('counts a `duplicate:` refusal as persisted, because it is', async () => {
    const relay = startWritableRelay({ ok: false, message: 'duplicate: have this event' });
    running.push(relay.server);

    const result = await publishToRelays({ event: profile, relays: [await relay.url] });

    expect(result.accepted).toEqual([await relay.url]);
    expect(isPersisted(result.relays[0]!)).toBe(true);
  });

  it('does not call silence an acceptance', async () => {
    const relay = startWritableRelay({ silent: true });
    running.push(relay.server);

    const result = await publishToRelays({
      event: profile,
      relays: [await relay.url],
      timeoutMs: 250,
    });

    expect(result.relays[0]?.state).toBe('timeout');
    expect(result.accepted).toEqual([]);
  });

  it('reports a relay that was not there, one outcome per relay', async () => {
    const relay = startWritableRelay();
    running.push(relay.server);

    const result = await publishToRelays({
      event: profile,
      relays: [await relay.url, 'ws://127.0.0.1:1'],
      timeoutMs: 2_000,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.relays.find((one) => one.url === 'ws://127.0.0.1:1')?.state).toBe('failed');
  });
});
