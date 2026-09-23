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
import {
  PaidRelayWriter,
  RelayWriteError,
  relayWriteDestination,
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
