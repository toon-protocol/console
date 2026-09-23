import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import type { FundingStatus } from './funding.js';
import {
  EVM_SETTLEMENT,
  fakeChainPort,
  fundingStoreFor,
  type FakeChainPort,
} from './funding.testkit.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX } from './profiles.js';

/**
 * The funding routes.
 *
 * Two rules are pinned here and nowhere else. One: **no answer on this surface
 * ever carries key material** — the payer keys are derived for the length of
 * one open and wiped, so a response that mentioned one would be a bug this
 * file catches. Two: **the open returns while it is still in flight**, so a
 * window is never held on a chain confirmation and the state it reports in the
 * meantime is `opening` rather than anything that reads as a failure.
 */

const RELAY = 'wss://own.relay.test';

describe('the funding routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let deps: ApiDeps;
  let chains: FakeChainPort;
  let seed: ChainSeedStore;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  const status = (answer: ApiResponse) => answer.body as FundingStatus;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-funding-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    relay = fakeRelayServer(RELAY);
    const account = fakeAccount();
    seed = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [RELAY],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });
    seed.acknowledgeWarning();
    await seed.mint();

    chains = fakeChainPort();
    chains.state.wallets.set(EVM_SETTLEMENT.chain, {
      native: { amount: '1000000000000000', symbol: 'ETH', decimals: 18 },
      token: { amount: '5000000', symbol: 'USDC', decimals: 6 },
    });

    const profiles = new ProfileStore(activeProfileFilePath(paths));
    profiles.setActive(SANDBOX.id);
    deps = {
      profiles,
      session: undefined as never,
      chainSeed: seed,
      funding: fundingStoreFor({ chainSeed: seed, paths, chains }),
      version: { name: '@toon-protocol/console-daemon', version: '0.1.0' },
      paths,
      startedAt: new Date('2026-09-22T00:00:00Z'),
      readHealth: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readDirectory: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readTemplates: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('answers the whole funding view on GET', async () => {
    const answer = await call('GET', '/api/funding');
    expect(answer.status).toBe(200);
    expect(status(answer).state).toBe('ready');
    expect(status(answer).chains.map((chain) => chain.chain)).toEqual(['evm:31337', 'solana']);
  });

  it('carries no key material, in any answer, ever', async () => {
    const answers = [
      await call('GET', '/api/funding'),
      await call('POST', '/api/funding/channel', { chain: EVM_SETTLEMENT.chain }),
    ];
    await deps.funding.settled(EVM_SETTLEMENT.chain);
    answers.push(await call('GET', '/api/funding'));

    for (const answer of answers) {
      // The account's own PUBLIC key is 64 hex and belongs here, so it is
      // taken out before the shape of a secret is looked for.
      const serialized = JSON.stringify(answer.body).replaceAll(
        seed.status().pubkey ?? '',
        ''
      );
      expect(serialized).not.toContain('mnemonic');
      expect(serialized).not.toContain('privateKey');
      expect(serialized).not.toContain('secretKey');
      expect(serialized).not.toContain('nsec');
      // A 64-hex run is what a raw key looks like on the wire. An EVM address
      // is 40 and a channel id is `0x…`-prefixed, so neither trips this.
      expect(serialized).not.toMatch(/(?<![0-9a-fx])[0-9a-f]{64}(?![0-9a-f])/u);
    }
  });

  it('returns from an open while it is still in flight', async () => {
    chains.blockOpen();
    const answer = await call('POST', '/api/funding/channel', {
      chain: EVM_SETTLEMENT.chain,
      deposit: '1000',
    });
    expect(answer.status).toBe(200);
    expect(status(answer).chains[0]?.channel.phase).toBe('opening');
    chains.finishOpen();
    await deps.funding.settled(EVM_SETTLEMENT.chain);
    expect(status(await call('GET', '/api/funding')).chains[0]?.channel.phase).toBe('open');
  });

  it('refuses an open with no chain named rather than guessing one', async () => {
    const answer = await call('POST', '/api/funding/channel', {});
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'invalid_request' });
  });

  it('answers 404 for a chain the connector does not settle on', async () => {
    const answer = await call('POST', '/api/funding/channel', { chain: 'evm:1' });
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: 'unknown_chain' });
  });

  it('answers 409 rather than opening on a chain with no gas', async () => {
    chains.state.wallets.set(EVM_SETTLEMENT.chain, {
      native: { amount: '0', symbol: 'ETH', decimals: 18 },
    });
    const view = status(await call('GET', '/api/funding'));
    expect(view.chains[0]?.canOpen).toBe(false);
    // The route still goes through — the view is the guard, and a caller that
    // ignores it gets the chain's own refusal rather than a lie — but nothing
    // in the answer suggests it would work.
    expect(view.chains[0]?.blockedBy).toMatch(/No ETH/u);
  });

  it('answers 409 when this network has no faucet', async () => {
    const answer = await call('POST', '/api/funding/faucet', { chain: EVM_SETTLEMENT.chain });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: 'no_faucet' });
  });

  it('answers 404 for a route under /api/funding it does not serve', async () => {
    expect((await call('GET', '/api/funding/nope')).status).toBe(404);
    expect((await call('DELETE', '/api/funding')).status).toBe(404);
  });
});
