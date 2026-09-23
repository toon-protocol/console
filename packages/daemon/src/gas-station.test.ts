import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { base58 } from '@scure/base';
import { parseSolanaWireTransaction } from '@toon-protocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakeAccount,
  fakePaidWriter,
  fakeRelayNetwork,
  fakeRelayServer,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import { channelStoreFor } from './channel-store.js';
import type { ConnectorHealth } from './connector-health.js';
import type { FundingStore } from './funding.js';
import {
  EVM_SETTLEMENT,
  SOLANA_SETTLEMENT,
  fakeChainPort,
  fundingStoreFor,
  healthWith,
} from './funding.testkit.js';
import {
  GasJobError,
  GasStationStore,
  byDoorPreference,
  checkGasJob,
  type GasJobOutcome,
  type GasJobPacket,
  type GasJobPort,
  type GasStationError,
} from './gas-station.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';

/**
 * Buying the next chain's gas, against a gas station that does as it is told.
 *
 * Every case worth holding still here is one a live gas station will not
 * produce on request: a door that refuses the phase it was not opened for, a
 * float that has run out, a quote that expired between the screen and the
 * button, a chain nothing will sell gas for. They are also every case in which
 * MONEY MOVED AND NOTHING CAME BACK, which is the failure #119 names, so each
 * one is asserted on what it cost as much as on what it said.
 */

const RELAY = 'wss://own.relay.test';
const STATION = 'http://gas.test:3220/ilp';
const HUB = SANDBOX.connectorUrl;
/** The station's own fee payer: a real 32-byte address, so drafts compile. */
const FEE_PAYER = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => at + 1));
const BLOCKHASH = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => 255 - at));

const PROFILE: NetworkProfile = { ...SANDBOX, relayUrl: RELAY, gasConnectorUrl: STATION };

/** The station's connector: it terminates a quote door and an execute door. */
function stationHealth(
  addresses: readonly string[] = ['g.toon.gas', 'g.toon.gas.quote'],
  prices: readonly string[] = ['1000', '1000']
): ConnectorHealth {
  return {
    state: 'ok',
    endpoint: STATION,
    selfEndpoint: STATION,
    ilpAddresses: [...addresses],
    settlements: [EVM_SETTLEMENT, SOLANA_SETTLEMENT],
    routes: addresses.map((prefix, at) => ({ prefix, price: prices[at] ?? '1000' })),
    peerCarriages: ['btp'],
    edgeSealKey: '0x04deadbeef',
    supportedVersions: [1],
  };
}

interface FakeStation extends GasJobPort {
  readonly sent: GasJobPacket[];
  /** What each door answers, keyed `<destination>|<phase>`. */
  readonly answers: Map<string, GasJobOutcome>;
}

function fakeStation(): FakeStation {
  const sent: GasJobPacket[] = [];
  const answers = new Map<string, GasJobOutcome>();
  return {
    sent,
    answers,
    async send(packet) {
      sent.push(packet);
      const phase = packet.params['phase'] ?? '';
      return (
        answers.get(`${packet.destination}|${phase}`) ?? {
          kind: 'refused',
          code: 'F00',
          message: `${packet.destination} does not take a ${phase}`,
          cost: '1000',
        }
      );
    },
  };
}

function quoteReceipt(overrides: Record<string, unknown> = {}): GasJobOutcome {
  return {
    kind: 'receipt',
    cost: '1000',
    receipt: {
      job: 'gas-station',
      phase: 'quote',
      status: 'ok',
      network: 'devnet',
      quoteId: 'q-1',
      feePayer: FEE_PAYER,
      maxLamports: '12020000',
      recentBlockhash: BLOCKHASH,
      expiresAt: Date.parse('2026-09-23T12:01:00.000Z'),
      ...overrides,
    } as never,
  };
}

/**
 * The refusal a call threw — and the assertion that it threw at all.
 *
 * A bare `.catch(e => e as GasStationError)` widens the awaited type to
 * include the success it was never going to produce, so an assertion below it
 * reads as if the call might have worked. This one fails loudly when the call
 * succeeded, which for a module that moves money is the difference worth
 * drawing.
 */
async function threw<T>(work: Promise<T>): Promise<GasStationError> {
  let value: T;
  try {
    value = await work;
  } catch (error) {
    return error as GasStationError;
  }
  throw new Error(`expected a refusal and got ${JSON.stringify(value)}`);
}

describe('buying the next chain’s gas', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let funding: FundingStore;
  let station: FakeStation;
  let health: ConnectorHealth;
  let stationAt: ConnectorHealth;
  let now: Date;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-gas-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    relay = fakeRelayServer(RELAY);
    account = fakeAccount();
    seed = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(relay),
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });
    seed.acknowledgeWarning();
    await seed.mint();
    // The hub forwards both of the station's doors, as devnet's and the
    // sandbox's both do: the station terminates them, this connector carries
    // them, and the price the caller pays is this one's.
    health = {
      ...healthWith([EVM_SETTLEMENT, SOLANA_SETTLEMENT], HUB),
      routes: [
        { prefix: 'g.toon.gas', price: '1001' },
        { prefix: 'g.toon.gas.quote', price: '1001' },
      ],
    } as ConnectorHealth;
    stationAt = stationHealth();
    station = fakeStation();
    now = new Date('2026-09-23T12:00:00.000Z');
    funding = fundingStoreFor({
      chainSeed: seed,
      paths,
      chains: fakeChainPort(),
      profile: PROFILE,
      health,
      now: () => now,
    });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function store(overrides: { lamports?: bigint } = {}): GasStationStore {
    return new GasStationStore({
      profile: () => PROFILE,
      funding: () => funding.status(),
      readHealth: async () => health,
      readHealthAt: async () => stationAt,
      chainSeed: seed,
      paths,
      port: station,
      now: () => now,
      ...(overrides.lamports === undefined ? {} : { lamports: overrides.lamports }),
    });
  }

  /** A channel with one connector on one chain, as an open would have left it. */
  function channelWith(connector: string, chain: string, deposit = 1_000_000n): void {
    const channels = channelStoreFor(paths, PROFILE.id);
    const channelId = `0xchannel-${chain}-${connector}`;
    channels.store.saveBinding?.(`${connector}|${chain}|network`, {
      channelId,
      context: { chainType: 'evm', chainId: 0, tokenNetworkAddress: 'network' },
      depositTotal: deposit,
      openedAt: '2026-09-22T00:00:00.000Z',
    });
    channels.store.save(channelId, { nonce: 0, cumulativeAmount: 0n });
  }

  describe('what it will say before anything is bought', () => {
    it('says the first channel has no route through this, and does not soften it', async () => {
      const status = await store().status();
      expect(status.state).toBe('ready');
      // No channel anywhere: the sentence is present, and every chain is
      // reported as the thing buying gas cannot fix.
      expect(status.firstChannel).toMatch(/FIRST channel on the FIRST chain/u);
      expect(status.firstChannel).toMatch(/from outside/u);
      for (const chain of status.chains) {
        expect(chain.verdict).not.toBe('buyable');
      }
      expect(status.chains.find((c) => c.chain === 'solana')?.verdict).toBe('no_channel');
    });

    it('offers to buy for a blocked chain once another chain has a channel', async () => {
      channelWith(HUB, 'evm:31337');
      const status = await store().status();
      expect(status.firstChannel).toBeUndefined();

      const solana = status.chains.find((chain) => chain.chain === 'solana');
      expect(solana?.verdict).toBe('buyable');
      // The claim that pays is signed on the OTHER chain, which is the whole
      // trick: a claim costs no gas on any chain.
      expect(solana?.payer?.chain).toBe('evm:31337');
      expect(solana?.payer?.payAt).toBe(HUB);
      expect(solana?.payer?.via).toBe('forwarded');
      // And it lands at this account's own address, not at some pool.
      expect(solana?.recipient).toBe(seed.status().addresses?.solana.address);
      // The price is the PAYING connector's, repeated (#82) — the hub's 1001
      // and not the station's own 1000, because the hub is what will bill it.
      expect(solana?.price).toBe('1001');
    });

    it('will not pretend a gas station sells EVM gas, and says why', async () => {
      channelWith(HUB, 'solana');
      const status = await store().status();
      const evm = status.chains.find((chain) => chain.chain === 'evm:31337');
      expect(evm?.verdict).toBe('unsupported');
      expect(evm?.reason).toMatch(/kind:5098/u);
      expect(evm?.reason).toMatch(/value` cap is zero/u);
      expect(evm?.reason).toMatch(/would be a faucet/u);
    });

    it('says nothing is blocked on a chain that can already pay', async () => {
      const funded = fakeChainPort();
      funded.state.wallets.set('solana', {
        native: { amount: '5000000', symbol: 'SOL', decimals: 9 },
      });
      funding = fundingStoreFor({
        chainSeed: seed,
        paths,
        chains: funded,
        profile: PROFILE,
        health,
        now: () => now,
      });
      channelWith(HUB, 'evm:31337');
      const status = await store().status();
      expect(status.chains.find((chain) => chain.chain === 'solana')?.verdict).toBe(
        'not_blocked'
      );
    });

    it('reports a profile that names no gas station as having none, not as broken', async () => {
      const bare = new GasStationStore({
        profile: () => ({ ...PROFILE, gasConnectorUrl: '' }),
        funding: () => funding.status(),
        readHealth: async () => health,
        readHealthAt: async () => stationAt,
        chainSeed: seed,
        paths,
        port: station,
        now: () => now,
      });
      const status = await bare.status();
      expect(status.state).toBe('no_station');
      expect(status.reason).toMatch(/names no gas station/u);
    });

    it('says a channel with too little left in it cannot buy a packet', async () => {
      channelWith(HUB, 'evm:31337', 10n);
      const status = await store().status();
      const solana = status.chains.find((chain) => chain.chain === 'solana');
      expect(solana?.verdict).toBe('unaffordable');
      expect(solana?.reason).toMatch(/has 10 left/u);
    });

    it('reports a station whose connector did not answer, and sends nothing', async () => {
      channelWith(HUB, 'evm:31337');
      stationAt = { state: 'unreachable', endpoint: STATION, reason: 'connection refused' };
      const status = await store().status();
      expect(status.station?.reachable).toBe(false);
      expect(status.chains.find((chain) => chain.chain === 'solana')?.verdict).toBe(
        'station_unreachable'
      );
      expect(station.sent).toHaveLength(0);
    });
  });

  describe('the quote, which is shown before anything is paid for', () => {
    beforeEach(() => {
      channelWith(HUB, 'evm:31337');
    });

    it('learns the fee payer, prices the real draft, and reports both packets', async () => {
      station.answers.set('g.toon.gas.quote|quote', quoteReceipt());
      const quote = await store({ lamports: 10_000_000n }).quote({ chain: 'solana' });

      // Two packets: one to learn the station's own fee payer (nothing
      // publishes it), one carrying the draft so the gate runs and
      // `maxLamports` is priced from a simulation.
      expect(station.sent).toHaveLength(2);
      expect(station.sent[0]?.params['transaction']).toBeUndefined();
      expect(station.sent[1]?.params['transaction']).toBeDefined();
      expect(quote.attempts).toHaveLength(2);
      expect(quote.attempts.every((attempt) => attempt.cost === '1000')).toBe(true);

      // The draft names the station's fee payer as account 0 and this
      // account's own address as the destination.
      const draft = parseSolanaWireTransaction(station.sent[1]?.params['transaction'] ?? '');
      expect(draft.staticAccounts[0]).toBe(FEE_PAYER);
      expect(draft.staticAccounts[1]).toBe(seed.status().addresses?.solana.address);

      expect(quote.quoteId).toBe('q-1');
      expect(quote.feePayer).toBe(FEE_PAYER);
      expect(quote.lamports).toBe('10000000');
      expect(quote.maxLamports).toBe('12020000');
      expect(quote.recentBlockhash).toBe(BLOCKHASH);
      // The route's price, verbatim from the connector that quoted it.
      expect(quote.price).toBe('1001');
    });

    it('seals past the hop, because the hub forwards the door it did not open', async () => {
      station.answers.set('g.toon.gas.quote|quote', quoteReceipt());
      await store().quote({ chain: 'solana' });
      // The key is the STATION connector's own, read from its own document —
      // no hop may name it on the station's behalf (#121, spec §13.1).
      expect(station.sent[0]?.sealTo).toBe('0x04deadbeef');
      expect(station.sent[0]?.payAt).toBe(HUB);
    });

    it('tries the quote door first, and remembers a door that refused the phase', async () => {
      station.answers.set('g.toon.gas.quote|quote', quoteReceipt());
      await store().quote({ chain: 'solana' });
      // Deepest first: a phase-scoped door is a child of the general one.
      expect(station.sent[0]?.destination).toBe('g.toon.gas.quote');

      const shop = store();
      station.answers.clear();
      station.answers.set('g.toon.gas|quote', quoteReceipt());
      await shop.quote({ chain: 'solana' });
      // The first attempt hit the narrow door and was refused F00; the second
      // went to the general one. Both were BILLED, and both are reported.
      const first = await shop.quote({ chain: 'solana' });
      expect(first.attempts.map((attempt) => attempt.destination)).toEqual(['g.toon.gas']);
    });

    it('carries the cost of a refusal out with the error, because it was billed', async () => {
      // Every door refuses. Nothing was bought, and it still cost two packets.
      await expect(store().quote({ chain: 'solana' })).rejects.toMatchObject({
        name: 'GasStationError',
      });
      const error = await threw(store().quote({ chain: 'solana' }));
      expect(error.message).toMatch(/still billed 2000 base units/u);
      expect(error.attempts.map((attempt) => attempt.cost)).toEqual(['1000', '1000']);
    });

    it('reports a station that declined to quote in the station’s own words', async () => {
      station.answers.set('g.toon.gas.quote|quote', {
        kind: 'receipt',
        cost: '1000',
        receipt: {
          job: 'gas-station',
          phase: 'quote',
          status: 'failed',
          network: 'devnet',
          reason: 'float_exhausted',
          detail: 'the fee payer holds 0 lamports',
        },
      });
      const error = await threw(store().quote({ chain: 'solana' }));
      // A station that declines has ANSWERED — it applied its rules. So the
      // code is its own vocabulary, and the packet was billed.
      expect(error.code).toBe('float_exhausted');
      expect(error.message).toMatch(/holds 0 lamports/u);
      expect(error.attempts.at(-1)?.cost).toBe('1000');
    });

    it('refuses to quote a chain no gas station will sell for, free', async () => {
      const error = await threw(store().quote({ chain: 'evm:31337' }));
      expect(error.code).toBe('unsupported');
      expect(error.message).toMatch(/Nothing was sent and nothing was billed/u);
      expect(station.sent).toHaveLength(0);
    });
  });

  describe('the purchase', () => {
    beforeEach(() => {
      channelWith(HUB, 'evm:31337');
      station.answers.set('g.toon.gas.quote|quote', quoteReceipt());
      station.answers.set('g.toon.gas|execute', {
        kind: 'receipt',
        cost: '1000',
        receipt: {
          job: 'gas-station',
          phase: 'execute',
          status: 'ok',
          network: 'devnet',
          quoteId: 'q-1',
          idempotencyKey: 'k',
          signature: '5sig',
          slot: '42',
          feeLamportsActual: '5000',
        },
      });
    });

    it('pays for the quote it showed, and lands the lamports at this account’s address', async () => {
      const shop = store({ lamports: 10_000_000n });
      const quote = await shop.quote({ chain: 'solana' });
      const bought = await shop.buy({ chain: 'solana', quoteId: quote.quoteId });

      expect(bought.state).toBe('delivered');
      expect(bought.signature).toBe('5sig');
      expect(bought.lamports).toBe('10000000');
      expect(bought.recipient).toBe(seed.status().addresses?.solana.address);
      // Quote and execute, summed. Never a price times a packet count.
      expect(bought.cost).toBe('3000');

      const executed = station.sent.at(-1);
      expect(executed?.params['phase']).toBe('execute');
      expect(executed?.params['quoteId']).toBe('q-1');
      expect(executed?.params['idempotencyKey']).toBeDefined();
      // Built against the quote's own blockhash, or the station refuses it.
      const sent = parseSolanaWireTransaction(executed?.params['transaction'] ?? '');
      expect(sent.recentBlockhash).toBe(BLOCKHASH);
      // The one signature slot is left empty: it is the station's to fill,
      // and this console holds no key it belongs to.
      expect(sent.unsigned).toEqual([FEE_PAYER]);
    });

    it('refuses a quote it never showed, free', async () => {
      const error = await threw(store().buy({ chain: 'solana', quoteId: 'invented' }));
      expect(error.code).toBe('unknown_quote');
      expect(error.message).toMatch(/Nothing was sent and nothing was billed/u);
      expect(station.sent).toHaveLength(0);
    });

    it('refuses an expired quote here rather than paying to be told', async () => {
      const shop = store();
      const quote = await shop.quote({ chain: 'solana' });
      const before = station.sent.length;
      now = new Date('2026-09-23T12:05:00.000Z');
      const error = await threw(shop.buy({ chain: 'solana', quoteId: quote.quoteId }));
      expect(error.code).toBe('quote_expired');
      expect(error.message).toMatch(/nothing was billed for this attempt/u);
      expect(station.sent).toHaveLength(before);
    });

    it('reports a station that declined to spend, with what the refusal cost', async () => {
      station.answers.set('g.toon.gas|execute', {
        kind: 'receipt',
        cost: '1000',
        receipt: {
          job: 'gas-station',
          phase: 'execute',
          status: 'failed',
          network: 'devnet',
          reason: 'delta_cap_exceeded',
          detail: 'the fee payer would be debited more than the quote allowed',
        },
      });
      const shop = store();
      const quote = await shop.quote({ chain: 'solana' });
      const bought = await shop.buy({ chain: 'solana', quoteId: quote.quoteId });

      // Not an error: the station was asked a question and answered it.
      expect(bought.state).toBe('refused');
      expect(bought.reason).toBe('delta_cap_exceeded');
      expect(bought.detail).toMatch(/more than the quote allowed/u);
      expect(bought.cost).toBe('3000');
      expect(bought.signature).toBeUndefined();
    });

    it('will not call a packet whose fate nobody reported done or undone', async () => {
      station.answers.set('g.toon.gas|execute', {
        kind: 'unknown',
        message: 'the socket died mid-send',
      });
      const shop = store();
      const quote = await shop.quote({ chain: 'solana' });
      const error = await threw(shop.buy({ chain: 'solana', quoteId: quote.quoteId }));
      expect(error.code).toBe('job_unconfirmed');
      expect(error.message).toMatch(/genuinely unknown/u);
      expect(error.status).toBe(504);
    });
  });

  describe('the guard that runs before a packet leaves', () => {
    it('refuses an execute missing what the station requires', () => {
      expect(() => checkGasJob('execute', { phase: 'execute' })).toThrow(GasJobError);
      expect(() => checkGasJob('execute', { phase: 'execute', transaction: 'x' })).toThrow(
        /quoteId, idempotencyKey/u
      );
      expect(() =>
        checkGasJob('execute', {
          phase: 'execute',
          transaction: 'x',
          quoteId: 'q',
          idempotencyKey: 'k',
        })
      ).not.toThrow();
    });

    it('refuses a job whose phase tag does not say what it is', () => {
      expect(() => checkGasJob('quote', { phase: 'execute' })).toThrow(/phase-scoped door/u);
    });

    it('says the refusal would have been billed at the door’s full price', () => {
      expect(() => checkGasJob('quote', {})).toThrow(/ADR 0003/u);
    });
  });

  describe('which door is tried first', () => {
    it('puts the deepest door first and breaks ties the same way every run', () => {
      const doors = [
        { destination: 'g.toon.gas', price: '1000' },
        { destination: 'g.toon.relay.gas', price: '1000' },
        { destination: 'g.toon.gas.quote', price: '1000' },
      ];
      // A quote wants the NARROW door — an operator opens `<addr>.quote`
      // beside `<addr>` — so the deepest address goes first.
      expect(
        [...doors].sort(byDoorPreference('quote')).map((door) => door.destination)
      ).toEqual(['g.toon.gas.quote', 'g.toon.relay.gas', 'g.toon.gas']);
      // An execute wants the GENERAL one, which is the door priced at what a
      // job can cost the station's float. So the order reverses.
      expect(
        [...doors].sort(byDoorPreference('execute')).map((door) => door.destination)
      ).toEqual(['g.toon.gas', 'g.toon.gas.quote', 'g.toon.relay.gas']);
      // At equal depth the cheaper door wins, so a quote never pays an
      // execute's price to find out it was the wrong door.
      expect(
        [
          { destination: 'g.a.b.c', price: '5000' },
          { destination: 'g.a.b.d', price: '10' },
        ]
          .sort(byDoorPreference('quote'))
          .map((door) => door.destination)
      ).toEqual(['g.a.b.d', 'g.a.b.c']);
    });
  });
});
