import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { base58 } from '@scure/base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakeAccount,
  fakePaidWriter,
  fakeRelayNetwork,
  fakeRelayServer,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import { channelStoreFor } from './channel-store.js';
import type { ConnectorHealth } from './connector-health.js';
import {
  EVM_SETTLEMENT,
  SOLANA_SETTLEMENT,
  fakeChainPort,
  fundingStoreFor,
  healthWith,
} from './funding.testkit.js';
import { GasStationStore, type GasJobOutcome, type GasJobPort } from './gas-station.js';
import { idleLeases } from './lease.testkit.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX } from './profiles.js';

/**
 * The gas routes (TOON_Network#119).
 *
 * Three rules are pinned here and nowhere else. **No answer carries key
 * material** — a gas job is paid with keys borrowed for one packet and wiped,
 * and a response that echoed one would be a bug this file catches. **A quote
 * is shown before anything is executed**, and a purchase names the quote it
 * was shown, so a stale window cannot buy at a price nobody saw. And **every
 * refusal carries what it cost**, because a paid route bills for a refusal and
 * an error that hid that would be the silent loss the ticket forbids.
 */

const RELAY = 'wss://own.relay.test';
const STATION = 'http://gas.test:3220/ilp';
const HUB = SANDBOX.connectorUrl;
const FEE_PAYER = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => at + 1));
const BLOCKHASH = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => 255 - at));

describe('the gas routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let seed: ChainSeedStore;
  let deps: ApiDeps;
  let answers: Map<string, GasJobOutcome>;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  const body = (answer: ApiResponse) => answer.body as Record<string, unknown>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-gas-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    relay = fakeRelayServer(RELAY);
    const account = fakeAccount();
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

    const profile = { ...SANDBOX, relayUrl: RELAY, gasConnectorUrl: STATION };
    const health: ConnectorHealth = {
      ...healthWith([EVM_SETTLEMENT, SOLANA_SETTLEMENT], HUB),
      routes: [{ prefix: 'g.toon.gastation', price: '1100' }],
    } as ConnectorHealth;
    const stationAt: ConnectorHealth = {
      state: 'ok',
      endpoint: STATION,
      selfEndpoint: STATION,
      ilpAddresses: ['g.toon.gastation'],
      settlements: [EVM_SETTLEMENT, SOLANA_SETTLEMENT],
      routes: [{ prefix: 'g.toon.gastation', price: '1000' }],
      peerCarriages: ['btp'],
      edgeSealKey: '0x04deadbeef',
      supportedVersions: [1],
    };

    // One channel, on the chain that is NOT blocked. That is the whole
    // premise: the claim that buys Solana gas is signed on the EVM channel.
    const channels = channelStoreFor(paths, profile.id);
    channels.store.saveBinding?.(`${HUB}|${EVM_SETTLEMENT.chain}|network`, {
      channelId: '0xchannel',
      context: { chainType: 'evm', chainId: 0, tokenNetworkAddress: 'network' },
      depositTotal: 1_000_000n,
      openedAt: '2026-09-22T00:00:00.000Z',
    });
    channels.store.save('0xchannel', { nonce: 0, cumulativeAmount: 0n });

    answers = new Map<string, GasJobOutcome>();
    const port: GasJobPort = {
      async send(packet) {
        return (
          answers.get(packet.params['phase'] ?? '') ?? {
            kind: 'refused',
            code: 'F00',
            message: 'nothing configured for this phase',
            cost: '1100',
          }
        );
      },
    };

    const funding = fundingStoreFor({
      chainSeed: seed,
      paths,
      chains: fakeChainPort(),
      profile,
      health,
    });
    const profiles = new ProfileStore(activeProfileFilePath(paths), [profile]);
    deps = {
      profiles,
      session: undefined as never,
      chainSeed: seed,
      funding,
      gasStation: new GasStationStore({
        profile: () => profile,
        funding: () => funding.status(),
        readHealth: async () => health,
        readHealthAt: async () => stationAt,
        chainSeed: seed,
        paths,
        port,
      }),
      ...idleLeases(paths),
      version: { name: '@toon-protocol/console-daemon', version: '0.1.0' },
      paths,
      startedAt: new Date('2026-09-23T00:00:00Z'),
      readHealth: () => Promise.resolve(health),
      readDirectory: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readTemplates: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function quoting(expiresAt = Date.now() + 60_000): void {
    answers.set('quote', {
      kind: 'receipt',
      cost: '1100',
      receipt: {
        job: 'gas-station',
        phase: 'quote',
        status: 'ok',
        network: 'devnet',
        quoteId: 'q-7',
        feePayer: FEE_PAYER,
        maxLamports: '12020000',
        recentBlockhash: BLOCKHASH,
        expiresAt,
      } as never,
    });
  }

  it('says on GET which chain can be bought for, from which channel, at what price', async () => {
    const answer = await call('GET', '/api/funding/gas');
    expect(answer.status).toBe(200);
    const chains = body(answer)['chains'] as Record<string, unknown>[];
    const solana = chains.find((chain) => chain['chain'] === 'solana');
    expect(solana?.['verdict']).toBe('buyable');
    expect((solana?.['payer'] as Record<string, unknown>)['chain']).toBe(EVM_SETTLEMENT.chain);
    // The price the PAYING connector quoted, repeated and never recomputed.
    expect(solana?.['price']).toBe('1100');

    // The TUI's fixture contract (TOON_Network#139, ADR 0028; console TUI
    // Funds, TOON_Network#147): the REAL response this assertion just
    // checked, committed so `tui/`'s hand-kept Rust types are checked
    // against it without running this daemon.
    writeApiFixture('gas-station', body(answer));
  });

  it('refuses a body that does not name the chain it is buying FOR', async () => {
    const answer = await call('POST', '/api/funding/gas/quote', {});
    expect(answer.status).toBe(400);
    expect(body(answer)['error']).toBe('invalid_request');
    expect(String(body(answer)['message'])).toMatch(/never the one whose channel pays/u);
  });

  it('refuses a purchase that does not name the quote it was shown', async () => {
    quoting();
    await call('POST', '/api/funding/gas/quote', { chain: 'solana' });
    const answer = await call('POST', '/api/funding/gas/buy', { chain: 'solana' });
    expect(answer.status).toBe(400);
    expect(String(body(answer)['message'])).toMatch(/quote it displayed/u);
  });

  it('shows a quote, then sells against that quote and no other', async () => {
    quoting();
    const quoted = await call('POST', '/api/funding/gas/quote', { chain: 'solana' });
    expect(quoted.status).toBe(200);
    expect(body(quoted)['quoteId']).toBe('q-7');
    expect(body(quoted)['lamports']).toBe('10000000');
    // Both packets, and what each cost.
    expect((body(quoted)['attempts'] as unknown[]).length).toBe(2);
    writeApiFixture('gas-quote', body(quoted));

    const stale = await call('POST', '/api/funding/gas/buy', {
      chain: 'solana',
      quoteId: 'q-6',
    });
    expect(stale.status).toBe(409);
    expect(body(stale)['error']).toBe('unknown_quote');
    expect(String(body(stale)['message'])).toMatch(/nothing was billed/u);

    answers.set('execute', {
      kind: 'receipt',
      cost: '1100',
      receipt: {
        job: 'gas-station',
        phase: 'execute',
        status: 'ok',
        network: 'devnet',
        quoteId: 'q-7',
        idempotencyKey: 'k',
        signature: '5sig',
        slot: '9',
        feeLamportsActual: '5000',
      } as never,
    });
    const bought = await call('POST', '/api/funding/gas/buy', {
      chain: 'solana',
      quoteId: 'q-7',
    });
    expect(bought.status).toBe(200);
    expect(body(bought)['state']).toBe('delivered');
    expect(body(bought)['signature']).toBe('5sig');
    // The gas landed at this account's own address on the blocked chain.
    expect(body(bought)['recipient']).toBe(seed.status().addresses?.solana.address);
    expect(body(bought)['cost']).toBe('3300');
    writeApiFixture('gas-purchase', body(bought));
  });

  it('carries what a refusal cost out with the refusal', async () => {
    // No door answers a quote, so both packets are refused — and billed.
    const answer = await call('POST', '/api/funding/gas/quote', { chain: 'solana' });
    expect(answer.status).toBe(502);
    expect(String(body(answer)['message'])).toMatch(/still billed 1100 base units/u);
    const attempts = body(answer)['attempts'] as Record<string, unknown>[];
    expect(attempts.map((attempt) => attempt['cost'])).toEqual(['1100']);
  });

  it('carries no key material, in any answer, ever', async () => {
    quoting();
    const seen = [
      await call('GET', '/api/funding/gas'),
      await call('POST', '/api/funding/gas/quote', { chain: 'solana' }),
      await call('POST', '/api/funding/gas/buy', { chain: 'solana', quoteId: 'q-7' }),
    ];
    for (const answer of seen) {
      const serialized = JSON.stringify(answer.body).replaceAll(
        seed.status().pubkey ?? '',
        ''
      );
      expect(serialized).not.toContain('mnemonic');
      expect(serialized).not.toContain('privateKey');
      expect(serialized).not.toContain('secretKey');
      expect(serialized).not.toContain('nsec');
      expect(serialized).not.toMatch(/(?<![0-9a-fx])[0-9a-f]{64}(?![0-9a-f])/u);
    }
  });

  it('says a build with no gas station wired cannot buy, rather than 500-ing', async () => {
    deps = { ...deps, gasStation: undefined };
    const answer = await call('GET', '/api/funding/gas');
    expect(answer.status).toBe(501);
    expect(body(answer)['error']).toBe('not_wired');
  });
});
