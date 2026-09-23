import { describe, expect, it } from 'vitest';

import {
  RelayEdgeReader,
  edgeFromDocument,
  readRelayEdge,
  relayHttpUrl,
  type RelayEdgeFetch,
} from './relay-edge.js';

/**
 * Reading where a relay says its own writes are paid for (TOON_Network#121,
 * spec §13).
 *
 * Two properties are pinned here.
 *
 * **Nothing is defaulted.** A document short of one of §13.1's five normative
 * fields yields no edge at all, and every failure carries a sentence — because
 * what a caller does with a relay it could not read is REPORT it, and "no
 * edge" with no reason is not something a person can act on.
 *
 * **Silence and a pin are different things.** An absent carriage means the
 * route pins none the relay could learn of, and so does `both`; a carriage
 * naming a transport this console has none of is neither, and refuses the
 * relay rather than being read as either (§13.3).
 */

/** Devnet's own document, as the live relay served it on 2026-09-23. */
const DEVNET_DOCUMENT = {
  pubkey: 'd49438a7f15c4a670710beb409e6aad927cb9bba3db02e8477f84a2189da5a04',
  supported_nips: [1, 9, 11, 16, 40],
  software: 'https://github.com/toon-protocol/relay',
  version: '2.2.0',
  limitation: {
    payment_required: true,
    restricted_writes: true,
    max_subscriptions: 20,
    max_filters: 10,
    auth_required: false,
  },
  fees: { publication: [{ amount: 1, unit: 'uusdc' }] },
  toon: {
    ilp_address: 'g.toon.relay',
    connector_url: 'https://proxy.relay.devnet.toonprotocol.dev/ilp',
    connector_seal_key: '0x04915d29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a449433b8f9',
    carriage: 'btp',
    price: 1,
    settlement: [
      { chain: 'evm:84532', token: '0x49bee1bca5d15fb0963117923403f9498119a9ce', decimals: 6 },
      { chain: 'solana', token: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU', decimals: 6 },
    ],
  },
};

const RELAY = 'wss://relay-ws.devnet.toonprotocol.dev';

/** A fetch that answers one body, and records what it was asked. */
function fakeFetch(
  answer: { ok?: boolean; status?: number; body: string } | Error
): RelayEdgeFetch & { asked: { url: string; accept: string | undefined }[] } {
  const asked: { url: string; accept: string | undefined }[] = [];
  const fetcher = (url: string, init: { headers: Record<string, string> }) => {
    asked.push({ url, accept: init.headers['accept'] });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      text: () => Promise.resolve(answer.body),
    });
  };
  return Object.assign(fetcher as RelayEdgeFetch, { asked });
}

describe('where a relay’s document lives', () => {
  it('is the HTTP form of the relay’s own URL', () => {
    expect(relayHttpUrl('wss://relay.example')).toBe('https://relay.example/');
    expect(relayHttpUrl('ws://localhost:7100')).toBe('http://localhost:7100/');
  });

  it('keeps a path, because a relay served under one serves its document there', () => {
    expect(relayHttpUrl('wss://host.example/relay')).toBe('https://host.example/relay');
  });

  it('is nowhere for something that is not a relay URL', () => {
    expect(relayHttpUrl('https://host.example')).toBeUndefined();
    expect(relayHttpUrl('not a url')).toBeUndefined();
  });
});

describe('reading a relay’s write edge', () => {
  it('asks for the NIP-11 media type, and reads what devnet answers', async () => {
    const fetcher = fakeFetch({ body: JSON.stringify(DEVNET_DOCUMENT) });
    const reading = await readRelayEdge(RELAY, { fetch: fetcher });

    expect(fetcher.asked).toEqual([
      { url: 'https://relay-ws.devnet.toonprotocol.dev/', accept: 'application/nostr+json' },
    ]);
    expect(reading).toMatchObject({
      state: 'edge',
      url: RELAY,
      edge: {
        ilpAddress: 'g.toon.relay',
        connectorUrl: 'https://proxy.relay.devnet.toonprotocol.dev/ilp',
        carriage: 'btp',
        price: '1',
      },
    });
    if (reading.state !== 'edge') throw new Error('unreachable');
    expect(reading.edge.settlement.map((entry) => entry.chain)).toEqual([
      'evm:84532',
      'solana',
    ]);
    expect(reading.info).toMatchObject({ paymentRequired: true, restrictedWrites: true });
  });

  it('says a relay that predates §13 serves no document — `nak serve`, the sandbox’s', async () => {
    const reading = await readRelayEdge('ws://localhost:7100', {
      fetch: fakeFetch({ ok: false, status: 426, body: 'Upgrade Required' }),
    });
    expect(reading).toMatchObject({ state: 'none', code: 'no_document' });
    if (reading.state !== 'none') throw new Error('unreachable');
    expect(reading.reason).toMatch(/426/u);
    expect(reading.reason).toMatch(/Upgrade Required/u);
  });

  it('never throws when the host does not answer at all', async () => {
    const reading = await readRelayEdge(RELAY, {
      fetch: fakeFetch(new Error('ECONNREFUSED')),
    });
    expect(reading).toMatchObject({ state: 'none', code: 'no_document' });
    if (reading.state !== 'none') throw new Error('unreachable');
    expect(reading.reason).toMatch(/ECONNREFUSED/u);
  });

  it('refuses a body that is not JSON', async () => {
    const reading = await readRelayEdge(RELAY, { fetch: fakeFetch({ body: '<html>' }) });
    expect(reading).toMatchObject({ state: 'none', code: 'no_document' });
  });
});

describe('what a document says, and what it leaves out', () => {
  it('reads a relay that charges nothing as charging nothing, not as saying nothing', () => {
    const free = {
      limitation: { payment_required: false, restricted_writes: true },
      toon: { ...DEVNET_DOCUMENT.toon, price: 0, carriage: undefined },
    };
    const reading = edgeFromDocument('ws://free.test', free);
    expect(reading).toMatchObject({ state: 'edge', edge: { price: '0' } });
    if (reading.state !== 'edge') throw new Error('unreachable');
    expect(reading.edge.carriage).toBeUndefined();
    expect(reading.info.paymentRequired).toBe(false);
  });

  it('takes a document with no `toon` object as a relay that cannot say where (§13.4)', () => {
    const reading = edgeFromDocument('ws://plain.test', {
      supported_nips: [1, 11],
      limitation: { payment_required: false, restricted_writes: true },
    });
    expect(reading).toMatchObject({ state: 'none', code: 'no_edge' });
    if (reading.state !== 'none') throw new Error('unreachable');
    expect(reading.reason).toMatch(/§13\.4/u);
  });

  it.each([
    ['ilp_address', { ...DEVNET_DOCUMENT.toon, ilp_address: undefined }],
    ['connector_url', { ...DEVNET_DOCUMENT.toon, connector_url: '' }],
    ['connector_seal_key', { ...DEVNET_DOCUMENT.toon, connector_seal_key: undefined }],
    ['price', { ...DEVNET_DOCUMENT.toon, price: undefined }],
    ['settlement', { ...DEVNET_DOCUMENT.toon, settlement: [] }],
  ])('refuses an edge missing %s, because §13.1 makes all five normative', (field, toon) => {
    const reading = edgeFromDocument(RELAY, { ...DEVNET_DOCUMENT, toon });
    expect(reading).toMatchObject({ state: 'none', code: 'bad_edge' });
    if (reading.state !== 'none') throw new Error('unreachable');
    expect(reading.reason).toContain(field);
  });

  it('refuses a price that is not a whole number of base units', () => {
    for (const price of [1.5, -1, 'free', Number.NaN]) {
      const toon = { ...DEVNET_DOCUMENT.toon, price };
      expect(edgeFromDocument(RELAY, { ...DEVNET_DOCUMENT, toon })).toMatchObject({
        state: 'none',
        code: 'bad_edge',
      });
    }
  });

  it('takes a numeric string price, because a bigint-sized one is serialized that way', () => {
    const toon = { ...DEVNET_DOCUMENT.toon, price: '1100' };
    expect(edgeFromDocument(RELAY, { ...DEVNET_DOCUMENT, toon })).toMatchObject({
      state: 'edge',
      edge: { price: '1100' },
    });
  });

  it('reads `both` as silence, never as a carriage to honour (§13.3)', () => {
    const toon = { ...DEVNET_DOCUMENT.toon, carriage: 'both' };
    const reading = edgeFromDocument(RELAY, { ...DEVNET_DOCUMENT, toon });
    expect(reading).toMatchObject({ state: 'edge' });
    if (reading.state !== 'edge') throw new Error('unreachable');
    expect(reading.edge.carriage).toBeUndefined();
  });

  it('refuses a carriage this console has no transport for', () => {
    const toon = { ...DEVNET_DOCUMENT.toon, carriage: 'quic' };
    const reading = edgeFromDocument(RELAY, { ...DEVNET_DOCUMENT, toon });
    expect(reading).toMatchObject({ state: 'none', code: 'carriage_unsupported' });
    if (reading.state !== 'none') throw new Error('unreachable');
    expect(reading.reason).toMatch(/quic/u);
  });
});

describe('remembering what a relay said', () => {
  it('asks once and answers from memory until the reading is stale', async () => {
    const fetcher = fakeFetch({ body: JSON.stringify(DEVNET_DOCUMENT) });
    let now = 0;
    const reader = new RelayEdgeReader({ fetch: fetcher, okMs: 1000, now: () => now });

    await reader.read(RELAY);
    await reader.read(RELAY);
    // The same relay under its other spelling is the same relay.
    await reader.read(`${RELAY}/`);
    expect(fetcher.asked).toHaveLength(1);

    now = 1001;
    await reader.read(RELAY);
    expect(fetcher.asked).toHaveLength(2);
  });

  it('retries a relay that said nothing sooner than one that did', async () => {
    const fetcher = fakeFetch({ ok: false, status: 426, body: 'Upgrade Required' });
    let now = 0;
    const reader = new RelayEdgeReader({
      fetch: fetcher,
      okMs: 10_000,
      missMs: 100,
      now: () => now,
    });
    await reader.read(RELAY);
    now = 101;
    await reader.read(RELAY);
    expect(fetcher.asked).toHaveLength(2);
  });
});
