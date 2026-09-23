import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeAccount } from './chain-seed.testkit.js';
import type { PayerKeys } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { connectorHealth, giveChannel } from './lease.testkit.js';
import type { NostrEvent } from './nostr.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX } from './profiles.js';
import type { RelayEdgeReading } from './relay-edge.js';
import {
  PaidRelayWriter,
  RelayWriteError,
  relayWriteDestination,
  routePriceFor,
  type RelayPacketOutcome,
  type RelayWritePacket,
  type RelayWritePort,
} from './relay-write.js';

/**
 * The console's one writer (TOON_Network#120).
 *
 * Two properties are pinned here and nowhere else.
 *
 * **Nothing is paid for that could have been checked first.** A refused paid
 * request is still billed (ADR 0003, #115), so an event that does not verify
 * and a write with no channel behind it must both be refused before a packet
 * exists. Every test of that also asserts that the port was never called.
 *
 * **Where a write goes is read, not decided.** `relayWriteDestination` takes a
 * connector's own `GET /ilp` and nothing else, which is why there is no ILP
 * address or price anywhere in this repository.
 */

const KEYS: PayerKeys = {
  evm: { privateKey: new Uint8Array(32), address: '0xpayer' },
  solana: { secretKey: new Uint8Array(64), publicKey: 'payer' },
};

/** A port that records what it was asked to send and answers to order. */
function fakePort(
  answer?: RelayPacketOutcome | ((packet: RelayWritePacket) => RelayPacketOutcome)
) {
  const sent: RelayWritePacket[] = [];
  const port: RelayWritePort & { sent: RelayWritePacket[] } = {
    sent,
    send(packet) {
      sent.push(packet);
      const given =
        answer === undefined
          ? ({ kind: 'answered', status: 200, text: '{}', cost: '1' } as RelayPacketOutcome)
          : typeof answer === 'function'
            ? answer(packet)
            : answer;
      return Promise.resolve(given);
    },
  };
  return port;
}

const DEVNET_RELAY_CONNECTOR = () =>
  connectorHealth({
    endpoint: SANDBOX.connectorUrl,
    // Exactly what devnet's relay connector answers with.
    ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
    routes: [
      { prefix: 'g.toon.relay', price: '1' },
      { prefix: 'g.toon.relay.ephemeral', price: '0' },
      { prefix: 'g.toon.relay.gas', price: '1001' },
      { prefix: 'g.toon.relay.store', price: '1001' },
    ],
  });

describe('which route writes to a relay', () => {
  const ok = (health: ConnectorHealth) => health as Extract<ConnectorHealth, { state: 'ok' }>;

  it('takes the connector’s own address that is published at a price', () => {
    expect(relayWriteDestination(ok(DEVNET_RELAY_CONNECTOR()))).toEqual({
      destination: 'g.toon.relay',
      price: '1',
    });
  });

  it('never the free ephemeral lane', () => {
    const health = ok(
      connectorHealth({
        endpoint: SANDBOX.connectorUrl,
        ilpAddresses: ['g.toon.relay.ephemeral'],
        routes: [{ prefix: 'g.toon.relay.ephemeral', price: '0' }],
      })
    );
    expect(relayWriteDestination(health)).toBeUndefined();
  });

  it('says there is none when the connector answers for nothing it prices', () => {
    const health = ok(
      connectorHealth({
        endpoint: SANDBOX.connectorUrl,
        ilpAddresses: ['g.toon.hub'],
        // Routes it FORWARDS, which it does not terminate: a write bought on
        // one would be sealed to somebody else's connector.
        routes: [{ prefix: 'g.toon.provider.basic.v1.spawn', price: '1100' }],
      })
    );
    expect(relayWriteDestination(health)).toBeUndefined();
  });
});

describe('buying one write', () => {
  let home: string;
  let paths: ConsolePaths;
  let event: NostrEvent;

  const writerWith = (
    port: ReturnType<typeof fakePort>,
    health: () => ConnectorHealth = DEVNET_RELAY_CONNECTOR
  ) =>
    new PaidRelayWriter({
      profile: () => SANDBOX,
      readHealth: () => Promise.resolve(health()),
      // The sandbox relay serves no NIP-11 document — it predates spec §13 —
      // so the profile's own relay falls back to #120's route. Stubbed rather
      // than dialled: a unit test must not depend on a relay being up.
      edges: noDocuments(),
      payerKeys: (use) => use(KEYS),
      paths,
      port,
    });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-write-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const account = fakeAccount();
    event = (await account.sign({
      kind: 30078,
      created_at: 1_790_000_000,
      tags: [['d', 'toon-console/chain-seed']],
      content: 'sealed',
    })) as unknown as NostrEvent;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('names the route, the price and the channel before anything is written', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const targets = await writerWith(fakePort()).targets();

    expect(targets).toMatchObject({
      relays: [SANDBOX.relayUrl],
      destination: 'g.toon.relay',
      price: '1',
      chain: 'evm:31337',
      channelId: '0xchannel',
      ready: true,
    });
  });

  it('writes the event as one paid packet, and reports what it cost', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort();

    const receipt = await writerWith(port).write({ event, what: 'A record' });

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({
      destination: 'g.toon.relay',
      payAt: SANDBOX.connectorUrl,
      chainKind: 'evm',
      event,
    });
    expect(receipt.relays).toEqual([SANDBOX.relayUrl]);
    expect(receipt.cost).toBe('1');
    expect(receipt.writes[0]?.state).toBe('written');
  });

  /**
   * TOON_Network#126: `SANDBOX.connectorUrl` is `http://localhost:3200/ilp`,
   * but the sandbox connector calls ITSELF `http://127.0.0.1:3200/ilp` — the
   * same loopback machine, a different string, and `@toon-protocol/client`
   * keys a channel binding by whichever one `ToonClient` was told to dial. A
   * write must find that binding by asking the connector what it calls
   * itself, never by comparing `profile.connectorUrl` literally.
   */
  it('finds its channel by what the connector calls itself, not by the profile’s connectorUrl (#126)', async () => {
    const selfEndpoint = 'http://127.0.0.1:3200';
    // The binding lives under the connector's OWN identity — exactly what an
    // open through `funding.ts` now saves it under — never under
    // `SANDBOX.connectorUrl` itself.
    giveChannel(paths, SANDBOX.id, selfEndpoint);
    const port = fakePort();
    const health = () =>
      connectorHealth({
        endpoint: SANDBOX.connectorUrl,
        selfEndpoint,
        ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
        routes: [
          { prefix: 'g.toon.relay', price: '1' },
          { prefix: 'g.toon.relay.ephemeral', price: '0' },
        ],
      });
    const writer = writerWith(port, health);

    const targets = await writer.targets();
    expect(targets.ready).toBe(true);
    expect(targets.channelId).toBe('0xchannel');
    expect(targets.payAt).toBe(selfEndpoint);

    const receipt = await writer.write({ event, what: 'A record' });
    expect(port.sent[0]).toMatchObject({ payAt: selfEndpoint });
    expect(receipt.writes[0]?.state).toBe('written');
  });

  /**
   * The other half of #126's acceptance criteria: normalising host spellings
   * must never make two DIFFERENT connectors look like the same one. A
   * channel bound to some other address is not this connector's, whatever the
   * profile says.
   */
  it('still treats a genuinely different connector as a different one', async () => {
    giveChannel(paths, SANDBOX.id, 'http://203.0.113.9:3200');
    const port = fakePort();

    const targets = await writerWith(port).targets();

    expect(targets.ready).toBe(false);
    expect(targets.blockedBy).toContain('holds no payment channel');
    expect(port.sent).toEqual([]);
  });

  it('refuses an event that does not verify, and sends nothing', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort();
    const tampered = { ...event, content: 'something else' };

    await expect(
      writerWith(port).write({ event: tampered, what: 'A record' })
    ).rejects.toMatchObject({ code: 'invalid_event', status: 400 });
    // The point of checking first: a relay answers a bad signature with 422,
    // and a paid route bills for that answer.
    expect(port.sent).toEqual([]);
  });

  it('refuses when there is no channel, names the price, and sends nothing', async () => {
    const port = fakePort();
    const writer = writerWith(port);

    const targets = await writer.targets();
    expect(targets.ready).toBe(false);
    expect(targets.blockedBy).toContain('1 base units');
    expect(targets.blockedBy).toContain('Funds tab');

    await expect(writer.write({ event, what: 'A record' })).rejects.toMatchObject({
      code: 'no_channel',
      status: 402,
    });
    expect(port.sent).toEqual([]);
  });

  it('never opens a channel to make a write possible', async () => {
    const port = fakePort();
    await writerWith(port)
      .write({ event, what: 'A record' })
      .catch(() => undefined);
    // Opening locks collateral on chain and pays gas. A record-keeping write
    // must never do either on somebody's behalf.
    expect(port.sent).toEqual([]);
  });

  it('reports what a REFUSED packet was billed, because a refusal is billed', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort({
      kind: 'refused',
      code: 'F03',
      refusedBy: 'edge',
      message: 'insufficient claim',
      cost: '1',
    });

    const failed = await writerWith(port)
      .write({ event, what: 'A record' })
      .catch((error: unknown) => error as RelayWriteError);

    expect(failed).toBeInstanceOf(RelayWriteError);
    expect((failed as RelayWriteError).code).toBe('write_refused');
    expect((failed as RelayWriteError).message).toContain('still billed 1 base units');
    expect((failed as RelayWriteError).writes?.[0]).toMatchObject({
      state: 'refused',
      code: 'F03',
      cost: '1',
    });
  });

  it('treats the relay’s own non-200 as a refusal that was paid for', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort({
      kind: 'answered',
      status: 422,
      text: '{"error":"Invalid event signature"}',
      cost: '1',
    });

    await expect(writerWith(port).write({ event, what: 'A record' })).rejects.toMatchObject({
      code: 'write_refused',
      status: 502,
    });
  });

  it('keeps "nobody said" apart from "it was refused"', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort({ kind: 'unknown', message: 'the socket died' });

    await expect(writerWith(port).write({ event, what: 'A record' })).rejects.toMatchObject({
      code: 'write_unconfirmed',
      status: 504,
    });
  });

  it('says so when the connector sells no relay write at all', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const writer = writerWith(fakePort(), () =>
      connectorHealth({
        endpoint: SANDBOX.connectorUrl,
        ilpAddresses: ['g.toon.relay.ephemeral'],
        routes: [{ prefix: 'g.toon.relay.ephemeral', price: '0' }],
      })
    );

    await expect(writer.write({ event, what: 'A record' })).rejects.toMatchObject({
      code: 'no_write_route',
    });
  });

  it('says so when the connector cannot be reached', async () => {
    const writer = writerWith(fakePort(), () => ({
      state: 'unreachable',
      endpoint: SANDBOX.connectorUrl,
      reason: 'connect ECONNREFUSED',
    }));

    const targets = await writer.targets();
    expect(targets.ready).toBe(false);
    expect(targets.blockedBy).toContain('ECONNREFUSED');
  });
});

/* -------------------------------------------------------------------------- */
/* Writing to every relay an Account named (TOON_Network#121)                 */
/* -------------------------------------------------------------------------- */

/** An edge reader that answers from a table, and records who it was asked about. */
function edgesOf(table: Record<string, RelayEdgeReading>) {
  const asked: string[] = [];
  return {
    asked,
    read(url: string): Promise<RelayEdgeReading> {
      asked.push(url);
      const held = table[url];
      return Promise.resolve(
        held ?? {
          state: 'none',
          url,
          code: 'no_document',
          reason: `${url} answered HTTP 426 to a request for its relay information document.`,
        }
      );
    },
  };
}

/** Every relay says nothing: what the fleet looked like before spec §13. */
function noDocuments() {
  return edgesOf({});
}

/** One relay's document, in the shape `relay-edge.ts` hands one over. */
function edgeAt(
  url: string,
  edge: {
    ilpAddress: string;
    connectorUrl: string;
    sealKey?: string;
    carriage?: 'http' | 'btp';
    price?: string;
  }
): RelayEdgeReading {
  return {
    state: 'edge',
    url,
    edge: {
      ilpAddress: edge.ilpAddress,
      connectorUrl: edge.connectorUrl,
      sealKey: edge.sealKey ?? SEAL_KEY,
      ...(edge.carriage === undefined ? {} : { carriage: edge.carriage }),
      price: edge.price ?? '1',
      settlement: [{ chain: 'evm:31337', token: '0xtoken', decimals: 6 }],
    },
    info: { paymentRequired: true, restrictedWrites: true },
  };
}

const SEAL_KEY = '0x04915d29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a449433b8f9';
const OTHER_KEY = '0x04aaaa29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a449433b8f9';

/** A second relay, with a connector of its own. */
const OTHER_RELAY = 'wss://relay.elsewhere.test';
const OTHER_CONNECTOR = 'https://connector.elsewhere.test/ilp';

describe('writing to every relay an account named', () => {
  let home: string;
  let paths: ConsolePaths;
  let event: NostrEvent;

  /** The profile's connector: terminates `g.toon.relay`, forwards `g.toon`. */
  const ownConnector = (routes?: readonly { prefix: string; price: string }[]) =>
    connectorHealth({
      endpoint: SANDBOX.connectorUrl,
      ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
      routes: routes ?? [
        { prefix: 'g.toon.relay', price: '1' },
        { prefix: 'g.toon.relay.ephemeral', price: '0' },
      ],
      edgeSealKey: SEAL_KEY,
    });

  const writerWith = (options: {
    port: ReturnType<typeof fakePort>;
    edges: ReturnType<typeof edgesOf>;
    writeRelays?: readonly string[];
    health?: () => ConnectorHealth;
    healthAt?: (url: string) => ConnectorHealth;
  }) =>
    new PaidRelayWriter({
      profile: () => SANDBOX,
      readHealth: () => Promise.resolve((options.health ?? ownConnector)()),
      ...(options.healthAt === undefined
        ? {}
        : {
            readHealthAt: (url: string) =>
              Promise.resolve((options.healthAt as (u: string) => ConnectorHealth)(url)),
          }),
      writeRelays: () => options.writeRelays ?? [],
      edges: options.edges,
      payerKeys: (use) => use(KEYS),
      paths,
      port: options.port,
    });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-write-many-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const account = fakeAccount();
    event = (await account.sign({
      kind: 30078,
      created_at: 1_790_000_000,
      tags: [['d', 'toon-console/chain-seed']],
      content: 'sealed',
    })) as unknown as NostrEvent;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('reads each relay’s own document rather than assuming the profile’s route', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
        carriage: 'btp',
      }),
    });
    const port = fakePort();

    const receipt = await writerWith({ port, edges }).write({ event, what: 'A record' });

    expect(edges.asked).toEqual([SANDBOX.relayUrl]);
    expect(port.sent[0]).toMatchObject({ destination: 'g.toon.relay', carriage: 'btp' });
    expect(receipt.writes[0]).toMatchObject({ state: 'written', carriage: 'btp' });
  });

  it('writes to the profile’s relay AND every payable relay the NIP-65 list names', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    giveChannel(paths, SANDBOX.id, OTHER_CONNECTOR, 'evm:31337', '0xfar');
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
      }),
      [OTHER_RELAY]: edgeAt(OTHER_RELAY, {
        ilpAddress: 'g.far.relay',
        connectorUrl: OTHER_CONNECTOR,
        price: '7',
      }),
    });
    const port = fakePort((packet) => ({
      kind: 'answered',
      status: 200,
      text: '{}',
      cost: packet.destination === 'g.far.relay' ? '7' : '1',
    }));

    const receipt = await writerWith({
      port,
      edges,
      writeRelays: [OTHER_RELAY],
      healthAt: () =>
        connectorHealth({
          endpoint: OTHER_CONNECTOR,
          ilpAddresses: ['g.far.relay'],
          routes: [{ prefix: 'g.far.relay', price: '7' }],
          edgeSealKey: SEAL_KEY,
        }),
    }).write({ event, what: 'A record' });

    expect(receipt.relays).toEqual([SANDBOX.relayUrl, OTHER_RELAY]);
    // The cost is reported per relay AND summed — never a price times a count.
    expect(receipt.writes.map((write) => [write.url, write.cost])).toEqual([
      [SANDBOX.relayUrl, '1'],
      [OTHER_RELAY, '7'],
    ]);
    expect(receipt.cost).toBe('8');
  });

  it('pays one channel for a relay its own connector FORWARDS to, sealed to that relay’s key', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const edges = edgesOf({
      [OTHER_RELAY]: edgeAt(OTHER_RELAY, {
        ilpAddress: 'g.toon.other-relay',
        connectorUrl: OTHER_CONNECTOR,
        sealKey: OTHER_KEY,
        price: '1',
      }),
    });
    const port = fakePort();

    const receipt = await writerWith({
      port,
      edges,
      writeRelays: [OTHER_RELAY],
      // This console's connector forwards everything under `g.toon` at 5.
      health: () =>
        ownConnector([
          { prefix: 'g.toon.relay', price: '1' },
          { prefix: 'g.toon', price: '5' },
        ]),
    }).write({ event, what: 'A record' });

    const far = port.sent.find((packet) => packet.destination === 'g.toon.other-relay');
    expect(far).toMatchObject({ payAt: SANDBOX.connectorUrl, sealTo: OTHER_KEY });
    // The price is the one the connector being PAID quoted (#82), not the
    // relay's own — a forwarding hop charges its own fee.
    expect(receipt.writes.find((write) => write.url === OTHER_RELAY)?.price).toBe('5');
  });

  it('never seals past a hop that terminates the route itself', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
      }),
    });
    const port = fakePort();
    await writerWith({ port, edges }).write({ event, what: 'A record' });
    expect(port.sent[0]?.sealTo).toBeUndefined();
  });

  it('buys a write to a relay that charges nothing, with no channel at all (§13.4)', async () => {
    const free = 'wss://free.test';
    const freeConnector = 'https://connector.free.test/ilp';
    const edges = edgesOf({
      [free]: edgeAt(free, {
        ilpAddress: 'g.free.relay',
        connectorUrl: freeConnector,
        price: '0',
      }),
    });
    const port = fakePort({ kind: 'answered', status: 200, text: '{}' });
    const writer = () =>
      writerWith({
        port,
        edges,
        writeRelays: [free],
        healthAt: () =>
          connectorHealth({
            endpoint: freeConnector,
            ilpAddresses: ['g.free.relay'],
            routes: [{ prefix: 'g.free.relay', price: '0' }],
            edgeSealKey: SEAL_KEY,
          }),
      });

    // No `giveChannel` anywhere: a free relay must not need one.
    const targets = await writer().targets();
    expect(targets.plan.find((entry) => entry.url === free)).toMatchObject({
      ready: true,
      price: '0',
    });

    const receipt = await writer().write({ event, what: 'A record' });
    expect(receipt.relays).toContain(free);
    expect(port.sent.some((packet) => packet.destination === 'g.free.relay')).toBe(true);
  });

  it('is a PUBLISHED record when one relay takes it and another cannot be paid', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
      }),
      // No document at all, and not the profile's relay: nothing to guess at.
    });
    const port = fakePort();

    const receipt = await writerWith({ port, edges, writeRelays: [OTHER_RELAY] }).write({
      event,
      what: 'A record',
    });

    expect(receipt.relays).toEqual([SANDBOX.relayUrl]);
    expect(port.sent).toHaveLength(1);
    const missed = receipt.writes.find((write) => write.url === OTHER_RELAY);
    expect(missed).toMatchObject({ state: 'unpayable', code: 'no_document' });
    expect(missed?.reason).toMatch(/426/u);
    expect(missed?.cost).toBeUndefined();
  });

  it('names every reason a relay could not be paid, in its own words', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const unchannelled = 'wss://unchannelled.test';
    const wrongKey = 'wss://wrong-key.test';
    const badCarriage = 'wss://bad-carriage.test';
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
      }),
      [unchannelled]: edgeAt(unchannelled, {
        ilpAddress: 'g.far.relay',
        connectorUrl: OTHER_CONNECTOR,
        price: '3',
      }),
      [wrongKey]: edgeAt(wrongKey, {
        ilpAddress: 'g.far.relay',
        connectorUrl: OTHER_CONNECTOR,
        sealKey: OTHER_KEY,
      }),
      [badCarriage]: {
        state: 'none',
        url: badCarriage,
        code: 'carriage_unsupported',
        reason: `${badCarriage} pins its write route to the \`quic\` carriage.`,
      },
    });

    const targets = await writerWith({
      port: fakePort(),
      edges,
      writeRelays: [unchannelled, wrongKey, badCarriage],
      healthAt: () =>
        connectorHealth({
          endpoint: OTHER_CONNECTOR,
          ilpAddresses: ['g.far.relay'],
          routes: [{ prefix: 'g.far.relay', price: '3' }],
          edgeSealKey: SEAL_KEY,
        }),
    }).targets();

    expect(targets.relays).toEqual([SANDBOX.relayUrl]);
    const blocked = new Map(targets.plan.map((entry) => [entry.url, entry]));
    expect(blocked.get(unchannelled)).toMatchObject({
      ready: false,
      code: 'no_channel',
      // It still names what the write would have cost, so a person can decide.
      price: '3',
    });
    expect(blocked.get(wrongKey)).toMatchObject({ ready: false, code: 'edge_disagrees' });
    expect(blocked.get(wrongKey)?.reason).toMatch(/§13\.2/u);
    expect(blocked.get(badCarriage)).toMatchObject({
      ready: false,
      code: 'carriage_unsupported',
    });
  });

  it('refuses the whole publish when NO relay took it, and says what each one did', async () => {
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
      }),
    });

    // No channel anywhere: nothing is payable, so nothing is sent.
    const port = fakePort();
    await expect(
      writerWith({ port, edges, writeRelays: [OTHER_RELAY] }).write({
        event,
        what: 'A record',
      })
    ).rejects.toMatchObject({ name: 'RelayWriteError', status: 402 });
    expect(port.sent).toHaveLength(0);
  });

  it('refuses when every packet was refused, and totals what the refusals were billed', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    giveChannel(paths, SANDBOX.id, OTHER_CONNECTOR, 'evm:31337', '0xfar');
    const edges = edgesOf({
      [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
        ilpAddress: 'g.toon.relay',
        connectorUrl: SANDBOX.connectorUrl,
      }),
      [OTHER_RELAY]: edgeAt(OTHER_RELAY, {
        ilpAddress: 'g.far.relay',
        connectorUrl: OTHER_CONNECTOR,
      }),
    });
    const port = fakePort({
      kind: 'refused',
      code: 'F99',
      refusedBy: 'destination',
      message: 'nope',
      cost: '1',
    });

    const error = await writerWith({
      port,
      edges,
      writeRelays: [OTHER_RELAY],
      healthAt: () =>
        connectorHealth({
          endpoint: OTHER_CONNECTOR,
          ilpAddresses: ['g.far.relay'],
          routes: [{ prefix: 'g.far.relay', price: '1' }],
          edgeSealKey: SEAL_KEY,
        }),
    })
      .write({ event, what: 'A record' })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as RelayWriteError);

    expect(error).toBeInstanceOf(RelayWriteError);
    expect(error?.message).toMatch(/billed 2 base units in total/u);
    expect(error?.writes?.map((write) => write.state)).toEqual(['refused', 'refused']);
  });

  it('verifies the event once, before ANY relay is paid', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort();
    const edges = edgesOf({});
    await expect(
      writerWith({ port, edges, writeRelays: [OTHER_RELAY] }).write({
        event: { ...event, content: 'tampered' },
        what: 'A record',
      })
    ).rejects.toMatchObject({ code: 'invalid_event' });
    expect(port.sent).toHaveLength(0);
  });

  it('keeps #120’s route for the profile’s OWN relay when it serves no document', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const port = fakePort();
    const targets = await writerWith({ port, edges: noDocuments() }).targets();
    expect(targets.plan[0]).toMatchObject({
      url: SANDBOX.relayUrl,
      ready: true,
      destination: 'g.toon.relay',
      via: 'profile-connector',
    });
  });

  it('borrows the payer keys ONCE however many relays are written to', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    giveChannel(paths, SANDBOX.id, OTHER_CONNECTOR, 'evm:31337', '0xfar');
    let borrows = 0;
    const writer = new PaidRelayWriter({
      profile: () => SANDBOX,
      readHealth: () => Promise.resolve(ownConnector()),
      readHealthAt: () =>
        Promise.resolve(
          connectorHealth({
            endpoint: OTHER_CONNECTOR,
            ilpAddresses: ['g.far.relay'],
            routes: [{ prefix: 'g.far.relay', price: '1' }],
            edgeSealKey: SEAL_KEY,
          })
        ),
      writeRelays: () => [OTHER_RELAY],
      edges: edgesOf({
        [SANDBOX.relayUrl]: edgeAt(SANDBOX.relayUrl, {
          ilpAddress: 'g.toon.relay',
          connectorUrl: SANDBOX.connectorUrl,
        }),
        [OTHER_RELAY]: edgeAt(OTHER_RELAY, {
          ilpAddress: 'g.far.relay',
          connectorUrl: OTHER_CONNECTOR,
        }),
      }),
      payerKeys: (use) => {
        borrows += 1;
        return use(KEYS);
      },
      paths,
      port: fakePort(),
    });

    const receipt = await writer.write({ event, what: 'A record' });
    expect(receipt.relays).toHaveLength(2);
    expect(borrows).toBe(1);
  });

  it('asks each relay once, however many relays are named twice', async () => {
    giveChannel(paths, SANDBOX.id, SANDBOX.connectorUrl);
    const edges = edgesOf({});
    await writerWith({
      port: fakePort(),
      edges,
      // The profile's relay again, under its other spelling.
      writeRelays: [`${SANDBOX.relayUrl}/`, SANDBOX.relayUrl],
    }).targets();
    expect(edges.asked).toEqual([SANDBOX.relayUrl]);
  });
});

describe('what a connector quotes for an address', () => {
  const ok = (health: ConnectorHealth) => health as Extract<ConnectorHealth, { state: 'ok' }>;

  it('matches the LONGEST prefix that covers it, as the connector itself does', () => {
    const health = ok(
      connectorHealth({
        endpoint: SANDBOX.connectorUrl,
        routes: [
          { prefix: 'g.toon', price: '100' },
          { prefix: 'g.toon.relay', price: '1' },
        ],
      })
    );
    expect(routePriceFor(health, 'g.toon.relay')).toBe('1');
    expect(routePriceFor(health, 'g.toon.store')).toBe('100');
    expect(routePriceFor(health, 'g.other')).toBeUndefined();
  });

  it('never matches a prefix that merely shares a name fragment', () => {
    const health = ok(
      connectorHealth({
        endpoint: SANDBOX.connectorUrl,
        routes: [{ prefix: 'g.toon.relay', price: '1' }],
      })
    );
    expect(routePriceFor(health, 'g.toon.relayed')).toBeUndefined();
  });
});
