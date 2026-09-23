import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakePaidWriter,
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import { channelStoreFor } from './channel-store.js';
import { ChainOpenError, FundingError, tidy, type FundingStore } from './funding.js';
import {
  EVM_SETTLEMENT,
  SOLANA_SETTLEMENT,
  fakeChainPort,
  fundingStoreFor,
  healthWith,
  type FakeChainPort,
} from './funding.testkit.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { DEVNET, SANDBOX } from './profiles.js';

/**
 * Funding, against a chain that does as it is told.
 *
 * Every case here is one a real chain will not produce on request: an RPC
 * endpoint that is down, an address with no gas, an open that has not landed
 * yet, an open refused for want of gas. They are the cases the ticket is
 * judged on — "a balances view that lies is worse than one that says
 * unknown" — so they are the ones held still.
 */

const RELAY = 'wss://own.relay.test';

describe('funding', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let signedIn: FakeAccount | undefined;
  let seed: ChainSeedStore;
  let chains: FakeChainPort;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-funding-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    relay = fakeRelayServer(RELAY);
    account = fakeAccount();
    signedIn = account;
    seed = new ChainSeedStore({
      signer: () => signedIn,
      seedRelays: () => [RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(relay),
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });
    chains = fakeChainPort();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const store = (): FundingStore => fundingStoreFor({ chainSeed: seed, paths, chains });

  /**
   * A seed this account really has: minted, and then PUBLISHED with a paid
   * write, which is the ordering #120 settled. A seed that was only minted is
   * a different state — `not_yet_recoverable` — and `heldSeed` below is the
   * test of it.
   */
  const withSeed = async () => {
    seed.acknowledgeWarning();
    await seed.mint();
    await seed.publish();
  };

  /** Enough of a wallet to be allowed to open. */
  const funded = () => {
    chains.state.wallets.set(EVM_SETTLEMENT.chain, {
      native: { amount: '1000000000000000', symbol: 'ETH', decimals: 18 },
      token: { amount: '5000000', symbol: 'USDC', decimals: 6 },
    });
    chains.state.wallets.set(SOLANA_SETTLEMENT.chain, {
      native: { amount: '1000000000', symbol: 'SOL', decimals: 9 },
      token: { amount: '5000000', symbol: 'USDC', decimals: 6 },
    });
  };

  describe('before there is anything to fund', () => {
    it('says so when nobody is signed in, and shows no address', async () => {
      signedIn = undefined;
      const status = await store().status();
      expect(status.state).toBe('signed_out');
      expect(status.chains).toEqual([]);
      expect(JSON.stringify(status)).not.toContain('0x');
    });

    it('says so when the account has no Chain Seed', async () => {
      const status = await store().status();
      expect(status.state).toBe('no_seed');
      expect(status.reason).toMatch(/no Chain Seed yet/u);
      expect(status.chains).toEqual([]);
    });

    it('funds a seed that is NOT YET RECOVERABLE, and keeps saying which it is', async () => {
      // #120's ordering runs through this view: the seed is minted and held,
      // the addresses are real, and funding one of them is what pays for the
      // publication that makes it recoverable. So the view works — and says,
      // beside every address it shows, that one disk holds the seed.
      seed.acknowledgeWarning();
      await seed.mint();

      const status = await store().status();
      expect(status.state).toBe('ready');
      expect(status.chains).toHaveLength(2);
      expect(status.heldSeed?.text).toContain('NOT YET RECOVERABLE');
      expect(status.heldSeed?.steps.length).toBeGreaterThan(0);

      await seed.publish();
      expect((await store().status()).heldSeed).toBeUndefined();
    });

    it('LOOKS for a seed before saying there is none', async () => {
      // A fresh daemon has not asked the account's relays anything yet. The
      // seed is on the relay; nobody had looked. Reporting "no Chain Seed,
      // mint one" here is how an account ends up with two of them (ADR 0020).
      await withSeed();
      const cold = new ChainSeedStore({
        signer: () => signedIn,
        seedRelays: () => [RELAY],
        cache: new InMemoryChainSeedCache(),
        writer: () => fakePaidWriter(relay),
        dial: fakeRelayNetwork([relay]),
        timeoutMs: 200,
      });
      expect(cold.status().state).toBe('unknown');
      const status = await fundingStoreFor({ chainSeed: cold, paths, chains }).status();
      expect(status.state).toBe('ready');
      expect(status.chains).toHaveLength(2);
    });

    it('says UNKNOWN, not "none", when the look itself failed', async () => {
      // The look is the only thing that can turn `unknown` into `absent`. One
      // that did not happen leaves the question open, and the view says the
      // question is open — because "mint a seed" is ruinous advice to an
      // account that already has one (ADR 0020).
      const cold = {
        status: () => ({ ...seed.status(), state: 'unknown' as const }),
        refresh: () => Promise.reject(new Error('every relay refused the read')),
      } as unknown as ChainSeedStore;
      const status = await fundingStoreFor({ chainSeed: cold, paths, chains }).status();
      expect(status.state).toBe('no_seed');
      expect(status.reason).toMatch(/is unknown/u);
      expect(status.reason).not.toMatch(/has no Chain Seed yet/u);
    });

    it('shows no address when the profile names no connector', async () => {
      await withSeed();
      // Not even the addresses: which chains this network settles on is the
      // connector's to say, and an address for a chain nobody settles on is a
      // place to lose money.
      const status = await fundingStoreFor({
        chainSeed: seed,
        paths,
        chains,
        profile: { ...SANDBOX, connectorUrl: '' },
      }).status();
      expect(status.state).toBe('unconfigured');
      expect(status.chains).toEqual([]);
    });

    it('does not invent chains when the connector did not answer', async () => {
      await withSeed();
      const status = await fundingStoreFor({
        chainSeed: seed,
        paths,
        chains,
        health: { state: 'unreachable', endpoint: 'http://nope', reason: 'connect refused' },
      }).status();
      expect(status.state).toBe('connector_unreachable');
      expect(status.chains).toEqual([]);
      expect(status.reason).toContain('connect refused');
    });

    it('carries the custody sentence before any address is shown', async () => {
      const status = await store().status();
      expect(status.custody.text).toMatch(/holds this account’s Nostr key holds its funds/u);
      expect(status.custody.acknowledgedAt).toBeUndefined();
    });

    it('surfaces a superseded seed rather than swallowing it', async () => {
      await withSeed();
      const status = await store().status();
      expect(status.supersededSeeds).toBe(0);
      expect(status).toHaveProperty('supersededSeeds');
    });
  });

  describe('deposit addresses', () => {
    it('shows one per chain the connector settles on, from the Chain Seed', async () => {
      await withSeed();
      const status = await store().status();
      expect(status.state).toBe('ready');
      expect(status.chains.map((chain) => chain.chain)).toEqual(['evm:31337', 'solana']);

      const evm = status.chains[0];
      const solana = status.chains[1];
      const addresses = seed.status().addresses;
      expect(evm?.deposit.address).toBe(addresses?.evm.address);
      expect(evm?.deposit.path).toBe(addresses?.evm.path);
      expect(solana?.deposit.address).toBe(addresses?.solana.address);
      // The chain facts are the connector's, repeated.
      expect(evm?.token).toEqual({
        address: EVM_SETTLEMENT.tokenAddress,
        decimals: EVM_SETTLEMENT.decimals,
      });
      expect(evm?.counterparty).toBe(EVM_SETTLEMENT.settlementAddress);
    });

    it('never answers with anything a seed could be rebuilt from', async () => {
      await withSeed();
      const serialized = JSON.stringify(await store().status());
      // Twelve English words in a row is what a leaked mnemonic looks like.
      expect(serialized).not.toMatch(/(?:\b[a-z]{3,8}\b[ ]){11}\b[a-z]{3,8}\b/u);
      expect(serialized).not.toContain('mnemonic');
      expect(serialized).not.toContain('privateKey');
      expect(serialized).not.toContain('secretKey');
    });

    it('names the RPC endpoint it read through, and who chose it', async () => {
      await withSeed();
      const sandbox = await store().status();
      expect(sandbox.chains[0]?.rpc).toEqual({
        url: SANDBOX.rpc.evm,
        source: 'profile',
      });

      const devnet = await fundingStoreFor({
        chainSeed: seed,
        paths,
        chains,
        profile: DEVNET,
      }).status();
      // Devnet names none, so the client's own preset is used — and the view
      // says as much rather than presenting it as the profile's choice.
      expect(devnet.chains[0]?.rpc.source).toBe('client-default');
      expect(devnet.chains[0]?.rpc.url).toMatch(/^https?:\/\//u);
    });
  });

  describe('balances', () => {
    it('reports what the chain said, in the base units the chain said it in', async () => {
      await withSeed();
      funded();
      const status = await store().status();
      expect(status.chains[0]?.balances).toMatchObject({
        state: 'read',
        native: { amount: '1000000000000000', symbol: 'ETH' },
        token: { amount: '5000000', symbol: 'USDC' },
      });
    });

    it('says UNKNOWN, not zero, when the RPC endpoint does not answer', async () => {
      await withSeed();
      funded();
      chains.state.unreachable.add(SOLANA_SETTLEMENT.chain);
      const status = await store().status();
      const solana = status.chains[1];
      expect(solana?.balances.state).toBe('unknown');
      expect(solana?.balances.native).toBeUndefined();
      expect(solana?.balances.token).toBeUndefined();
      expect(solana?.balances.reason).toMatch(/did not answer/u);
      // And one dead chain does not take the other with it.
      expect(status.chains[0]?.balances.state).toBe('read');
    });

    it('keeps the chain library’s report to a sentence, and drops the echo of the call', async () => {
      // What `viem` really answers an unreachable endpoint with: a report of
      // several lines, with the request it tried and its own version in it.
      // The line that matters is the first and the `Details:`; the line that
      // echoes the call back is dropped, because a reason string is shown on
      // screen and written to a log.
      expect(
        tidy(
          [
            'HTTP request failed.',
            '',
            'URL: http://localhost:8545/',
            'Request body: {"method":"eth_getBalance","params":["0xabc","latest"]}',
            '',
            'Details: fetch failed',
            'Version: viem@2.56.8',
          ].join('\n')
        )
      ).toBe('HTTP request failed. Details: fetch failed');
      expect(tidy(undefined)).toBe('');
      expect(tidy('no route to host')).toBe('no route to host');
      expect(tidy('x'.repeat(400)).length).toBe(240);
    });

    it('refuses to offer an open on a chain it could not read', async () => {
      await withSeed();
      chains.state.unreachable.add(EVM_SETTLEMENT.chain);
      const status = await store().status();
      expect(status.chains[0]?.canOpen).toBe(false);
      expect(status.chains[0]?.gas.verdict).toBe('unknown');
      expect(status.chains[0]?.blockedBy).toMatch(/could not be read/u);
    });

    it('re-reads only when asked to', async () => {
      await withSeed();
      funded();
      const funding = store();
      await funding.status();
      chains.state.wallets.set(EVM_SETTLEMENT.chain, {
        native: { amount: '7', symbol: 'ETH', decimals: 18 },
      });
      expect((await funding.status()).chains[0]?.balances.native?.amount).toBe(
        '1000000000000000'
      );
      expect(
        (await funding.status({ refresh: true })).chains[0]?.balances.native?.amount
      ).toBe('7');
    });
  });

  describe('the gas problem', () => {
    it('says plainly that an open costs a coin nothing here can give', async () => {
      await withSeed();
      const status = await store().status();
      const gas = status.chains[0]?.gas;
      expect(gas?.verdict).toBe('none');
      expect(gas?.headline).toMatch(/costs ETH/u);
      expect(gas?.headline).toMatch(/no part of TOON Network can give you/u);
      expect(gas?.detail).toMatch(/holds no ETH/u);
    });

    it('blocks the open before the button rather than after the transaction', async () => {
      await withSeed();
      const status = await store().status();
      expect(status.chains[0]?.canOpen).toBe(false);
      expect(status.chains[0]?.blockedBy).toMatch(/No ETH at this address/u);
    });

    it('says what this network’s faucet will and will not do about it', async () => {
      await withSeed();
      const status = await fundingStoreFor({
        chainSeed: seed,
        paths,
        chains: fakeChainPort({
          faucet: {
            url: 'https://faucet.test',
            state: 'ready',
            givesGas: false,
            chains: [
              {
                kind: 'evm',
                name: 'baseSepolia',
                ready: true,
                drips: [{ asset: 'usdc', amount: '1000' }],
              },
            ],
          },
        }),
        profile: { ...SANDBOX, faucetUrl: 'https://faucet.test' },
      }).status();
      expect(status.faucet?.givesGas).toBe(false);
      expect(status.chains[0]?.gas.faucetGivesGas).toBe(false);
      expect(status.chains[0]?.gas.detail).toMatch(
        /faucet gives the settlement token and reports no ETH/u
      );
    });

    it('hands a Solana account the one command that asks the cluster itself', async () => {
      await withSeed();
      const status = await store().status();
      const solana = status.chains[1];
      expect(solana?.gas.command).toBe(
        `solana airdrop 1 ${solana?.deposit.address} --url ${SANDBOX.rpc.solana}`
      );
      expect(solana?.gas.detail).toMatch(/429/u);
    });

    it('lets an open through once there is gas', async () => {
      await withSeed();
      funded();
      const status = await store().status();
      expect(status.chains[0]?.gas.verdict).toBe('present');
      expect(status.chains[0]?.canOpen).toBe(true);
      expect(status.chains[0]?.blockedBy).toBeUndefined();
    });
  });

  describe('opening a channel', () => {
    it('reads as pending while it is in flight, and never as failed', async () => {
      await withSeed();
      funded();
      const funding = store();
      chains.blockOpen();

      const answer = await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      expect(answer.chains[0]?.channel.phase).toBe('opening');
      expect(answer.chains[0]?.channel.startedAt).toBeTruthy();
      expect(answer.chains[0]?.channel.reason).toMatch(/in flight/u);
      expect(answer.chains[0]?.canOpen).toBe(false);

      chains.finishOpen();
      await funding.settled(EVM_SETTLEMENT.chain);

      const landed = await funding.status();
      expect(landed.chains[0]?.channel.phase).toBe('open');
      expect(landed.chains[0]?.channel.channelId).toBe(`0xchannel-${EVM_SETTLEMENT.chain}`);
      expect(landed.chains[0]?.channel.deposit).toBe('100000');
      expect(landed.chains[0]?.channel.spent).toBe('0');
      expect(landed.chains[0]?.channel.available).toBe('100000');
    });

    it('stays pending when the chain says the transaction has not confirmed', async () => {
      await withSeed();
      funded();
      chains.state.opened = { channelId: '0xpending', status: 'opening', txHash: '0xabc' };
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      await funding.settled(EVM_SETTLEMENT.chain);
      const status = await funding.status();
      expect(status.chains[0]?.channel.phase).toBe('opening');
      expect(status.chains[0]?.channel.txHash).toBe('0xabc');
    });

    it('opens once, not twice, when asked twice while one is in flight', async () => {
      await withSeed();
      funded();
      const funding = store();
      chains.blockOpen();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      chains.finishOpen();
      await funding.settled(EVM_SETTLEMENT.chain);
      expect(chains.state.opens).toHaveLength(1);
    });

    it('refuses a second channel on a chain that already has one', async () => {
      await withSeed();
      funded();
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      await funding.settled(EVM_SETTLEMENT.chain);
      await funding.status();
      await expect(funding.openChannel({ chain: EVM_SETTLEMENT.chain })).rejects.toThrow(
        /already holds a channel/u
      );
    });

    it('reports an out-of-gas refusal as exactly that', async () => {
      await withSeed();
      funded();
      chains.state.openFails = new ChainOpenError('insufficient funds for gas', {
        outOfGas: true,
      });
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      await funding.settled(EVM_SETTLEMENT.chain);
      const status = await funding.status();
      expect(status.chains[0]?.channel.phase).toBe('failed');
      expect(status.chains[0]?.channel.outOfGas).toBe(true);
      expect(status.chains[0]?.channel.reason).toMatch(/insufficient funds/u);
    });

    it('sends the connector’s own settlement facts to the chain, and the console’s store', async () => {
      await withSeed();
      funded();
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain, deposit: '250000' });
      await funding.settled(EVM_SETTLEMENT.chain);
      const asked = chains.state.opens[0];
      expect(asked?.chain).toBe(EVM_SETTLEMENT.chain);
      expect(asked?.kind).toBe('evm');
      expect(asked?.connectorUrl).toBe(SANDBOX.connectorUrl);
      expect(asked?.rpcUrl).toBe(SANDBOX.rpc.evm);
      expect(asked?.deposit).toBe(250_000n);
      // The store seam of #85/#87: the console's own directory, not the
      // client's idea of the current working directory. What proves it is
      // where the binding landed.
      const bindings = channelStoreFor(paths, SANDBOX.id).store.listBindings?.() ?? [];
      expect(bindings.map((entry) => entry.binding.channelId)).toEqual([
        `0xchannel-${EVM_SETTLEMENT.chain}`,
      ]);
      expect(channelStoreFor(paths, SANDBOX.id).filePath).toContain(
        join('profiles', SANDBOX.id, 'channels')
      );
    });

    it('will not take a deposit that is not a whole number of base units', async () => {
      await withSeed();
      funded();
      await expect(
        store().openChannel({ chain: EVM_SETTLEMENT.chain, deposit: '1.5' })
      ).rejects.toBeInstanceOf(FundingError);
      await expect(
        store().openChannel({ chain: EVM_SETTLEMENT.chain, deposit: '0' })
      ).rejects.toThrow(/above zero/u);
    });

    it('refuses a chain this connector does not settle on', async () => {
      await withSeed();
      funded();
      await expect(store().openChannel({ chain: 'evm:1' })).rejects.toThrow(
        /does not settle on/u
      );
    });

    it('borrows the payer keys for the open and gives them back wiped', async () => {
      await withSeed();
      funded();
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain });
      await funding.settled(EVM_SETTLEMENT.chain);
      const keys = chains.state.opens[0]?.keys;
      expect(keys?.evm.privateKey.every((byte) => byte === 0)).toBe(true);
      expect(keys?.solana.secretKey.every((byte) => byte === 0)).toBe(true);
    });

    it('needs no key at all to show the view', async () => {
      await withSeed();
      funded();
      // A read that asked the Signer would prompt a phone every poll. Nothing
      // here goes near one: the seed is opened once, at sign-in.
      const unsealing = new ChainSeedStore({
        signer: () => signedIn,
        seedRelays: () => [RELAY],
        cache: new InMemoryChainSeedCache(),
        writer: () => fakePaidWriter(relay),
        dial: fakeRelayNetwork([relay]),
        timeoutMs: 200,
      });
      await unsealing.refresh();
      let borrowed = 0;
      const spy = {
        status: () => unsealing.status(),
        usePayerKeys: (use: Parameters<ChainSeedStore['usePayerKeys']>[0]) => {
          borrowed += 1;
          return unsealing.usePayerKeys(use);
        },
      } as unknown as ChainSeedStore;
      await fundingStoreFor({ chainSeed: spy, paths, chains }).status({ refresh: true });
      expect(borrowed).toBe(0);
    });
  });

  describe('channel state', () => {
    it('calls a channel it has no record of "none", not "empty"', async () => {
      await withSeed();
      funded();
      const status = await store().status();
      expect(status.chains[0]?.channel.phase).toBe('none');
      expect(status.chains[0]?.channel.reason).toMatch(/not the same as there being none/u);
      expect(status.chains[0]?.channel.available).toBeUndefined();
    });

    it('reports a spent watermark and what is left of the collateral', async () => {
      await withSeed();
      funded();
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain, deposit: '1000' });
      await funding.settled(EVM_SETTLEMENT.chain);
      channelStoreFor(paths, SANDBOX.id).store.save(`0xchannel-${EVM_SETTLEMENT.chain}`, {
        nonce: 4,
        cumulativeAmount: 250n,
      });
      const status = await funding.status();
      expect(status.chains[0]?.channel).toMatchObject({
        phase: 'open',
        deposit: '1000',
        spent: '250',
        available: '750',
        nonce: 4,
      });
    });

    it('does not call an uncertain watermark a balance', async () => {
      await withSeed();
      funded();
      const funding = store();
      await funding.openChannel({ chain: EVM_SETTLEMENT.chain, deposit: '1000' });
      await funding.settled(EVM_SETTLEMENT.chain);
      channelStoreFor(paths, SANDBOX.id).store.save(`0xchannel-${EVM_SETTLEMENT.chain}`, {
        nonce: 4,
        cumulativeAmount: 250n,
        watermarkUncertain: true,
      });
      const channel = (await funding.status()).chains[0]?.channel;
      expect(channel?.watermarkUncertain).toBe(true);
      expect(channel?.reason).toMatch(/may be higher/u);
    });
  });

  describe('prices', () => {
    it('repeats the connector’s quote and never computes one', async () => {
      await withSeed();
      funded();
      const quoting = fakeChainPort({
        quote: { route: 'g.toon.provider.ci.v1.spawn', price: '5100', packets: 0 },
      });
      quoting.state.wallets = chains.state.wallets;
      const status = await fundingStoreFor({
        chainSeed: seed,
        paths,
        chains: quoting,
        suggestedPackets: 20,
      }).status();
      expect(status.quote).toEqual({
        route: 'g.toon.provider.ci.v1.spawn',
        price: '5100',
        packets: 20,
      });
      // A suggestion is the quoted price times a packet count, and the packet
      // count is the only number this console contributed.
      expect(status.chains[0]?.suggestedDeposit).toBe('102000');
    });

    it('carries a metered route’s per-kibibyte rate unmultiplied', async () => {
      await withSeed();
      funded();
      const quoting = fakeChainPort({
        quote: { route: 'g.toon.store', price: '1100', pricePerKib: '10', packets: 0 },
      });
      quoting.state.wallets = chains.state.wallets;
      const status = await fundingStoreFor({
        chainSeed: seed,
        paths,
        chains: quoting,
      }).status();
      // TOON_Network#82: the client and the connector round a per-KiB charge
      // differently, so the console states the rate and lets the connector
      // decide what a packet costs.
      expect(status.quote?.pricePerKib).toBe('10');
    });
  });

  describe('the faucet', () => {
    it('asks for the chain’s own address and re-reads afterwards', async () => {
      await withSeed();
      funded();
      const funding = fundingStoreFor({
        chainSeed: seed,
        paths,
        chains,
        profile: { ...SANDBOX, faucetUrl: 'https://faucet.test' },
      });
      const before = await funding.status();
      const status = await funding.drip({ chain: SOLANA_SETTLEMENT.chain });
      expect(chains.state.drips).toEqual([
        {
          faucetUrl: 'https://faucet.test',
          kind: 'solana',
          address: before.chains[1]?.deposit.address,
        },
      ]);
      expect(status.faucet?.lastDrip).toMatchObject({
        chain: 'solana',
        state: 'delivered',
      });
    });

    it('refuses on a network with no faucet rather than inventing one', async () => {
      await withSeed();
      await expect(store().drip({ chain: EVM_SETTLEMENT.chain })).rejects.toThrow(
        /has no faucet/u
      );
    });
  });

  it('keeps one network’s channel state away from another’s', async () => {
    await withSeed();
    funded();
    const sandbox = store();
    await sandbox.openChannel({ chain: EVM_SETTLEMENT.chain });
    await sandbox.settled(EVM_SETTLEMENT.chain);

    const devnet = fundingStoreFor({
      chainSeed: seed,
      paths,
      chains,
      profile: DEVNET,
      health: healthWith([EVM_SETTLEMENT]),
    });
    // Same account, same chain key, other profile: a devnet watermark replayed
    // against a sandbox channel is a refused claim at best.
    expect((await devnet.status()).chains[0]?.channel.phase).toBe('none');
  });
});
