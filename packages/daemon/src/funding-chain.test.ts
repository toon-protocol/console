import { describe, expect, it } from 'vitest';

import { dearestRoute, parseFaucetInfo } from './funding-chain.js';

/**
 * Reading the faucet.
 *
 * The document below is what `https://faucet.devnet.toonprotocol.dev/api/info`
 * answered on 2026-09-22, copied verbatim. It is here because the sentence the
 * console puts in front of a person — *this faucet gives the settlement token
 * and no gas* — is read out of it rather than written into the UI, and a
 * faucet that changed its mind must change that sentence rather than making it
 * a lie.
 *
 * Note the shape it really has: a top-level `ready: false` that is about the
 * faucet's own ETH balance, per-chain `ready` flags that are both true, and an
 * `ethAmount` advertised beside an `eth` balance of `null`. Reading the
 * top-level flag would have reported a faucet that works as broken, and
 * reading `ethAmount` as an offer would have promised gas that is not there.
 */
const LIVE = {
  ethAmount: '100',
  tokenAmount: '10000',
  tokenSymbol: 'USDC',
  faucetBalances: { eth: null, token: '0' },
  ready: false,
  chains: {
    solana: {
      enabled: true,
      route: '/api/solana/usdc-request',
      ready: true,
      drips: { usdc: '1000' },
      cooldownHours: '24',
      usdcMint: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
      rpcUrl: 'https://api.devnet.solana.com',
      mintMode: 'faucet-is-mint-authority',
    },
    baseSepolia: {
      enabled: true,
      route: '/api/base-sepolia/request',
      ready: true,
      chainId: 84532,
      drips: { usdc: '1000' },
      tokenAddress: '0x0C996d7c934c79a6255254875607Fe69df25C0E1',
      faucetKey: '0x7eC0c44Fcd62042711b7005c5E96E2Ccc7a30dBd',
      rpcUrl: 'https://sepolia.base.org',
      mintMode: 'ungated-mint',
    },
  },
};

describe('reading a faucet’s /api/info', () => {
  it('tells the two chains apart by their shape, not by their name', () => {
    const view = parseFaucetInfo('https://faucet.test', LIVE);
    expect(view.chains.map((chain) => [chain.name, chain.kind])).toEqual([
      ['solana', 'solana'],
      ['baseSepolia', 'evm'],
    ]);
  });

  it('reports the per-chain readiness, not the top-level flag', () => {
    const view = parseFaucetInfo('https://faucet.test', LIVE);
    expect(view.state).toBe('ready');
    expect(view.chains.every((chain) => chain.ready)).toBe(true);
  });

  it('accepts `tokenReady` as well, which is the other name for it', () => {
    const view = parseFaucetInfo('https://faucet.test', {
      chains: { c: { chainId: 1, tokenReady: true, drips: { usdc: '5' } } },
    });
    expect(view.chains[0]?.ready).toBe(true);
  });

  it('says this faucet gives NO gas, which is the whole point', () => {
    // It advertises `ethAmount: '100'` and holds `eth: null`. The advertised
    // figure is not an offer; the balance is.
    expect(parseFaucetInfo('https://faucet.test', LIVE).givesGas).toBe(false);
  });

  it('would say otherwise if a faucet actually held some', () => {
    expect(
      parseFaucetInfo('https://faucet.test', {
        ...LIVE,
        faucetBalances: { eth: '5000000000000000000', token: '0' },
      }).givesGas
    ).toBe(true);
    expect(
      parseFaucetInfo('https://faucet.test', {
        chains: { c: { chainId: 1, ready: true, drips: { sol: '1' } } },
      }).givesGas
    ).toBe(true);
  });

  it('carries each chain’s drips and cooldown in the faucet’s own words', () => {
    const solana = parseFaucetInfo('https://faucet.test', LIVE).chains[0];
    expect(solana?.drips).toEqual([{ asset: 'usdc', amount: '1000' }]);
    expect(solana?.cooldownHours).toBe('24');
    expect(solana?.route).toBe('/api/solana/usdc-request');
  });

  it('drops a chain it cannot recognise rather than guessing its family', () => {
    const view = parseFaucetInfo('https://faucet.test', {
      chains: { mystery: { ready: true }, off: { chainId: 1, enabled: false } },
    });
    expect(view.chains).toEqual([]);
  });

  it('survives a document of a shape it has never seen', () => {
    for (const body of [null, 'nope', 42, {}, { chains: 'no' }]) {
      const view = parseFaucetInfo('https://faucet.test', body);
      expect(view.state).toBe('ready');
      expect(view.chains).toEqual([]);
      expect(view.givesGas).toBe(false);
    }
  });
});

/**
 * Which route a suggested deposit is priced against.
 *
 * The routes below are the ones `https://proxy.relay.devnet.toonprotocol.dev/ilp`
 * published on 2026-09-23, copied verbatim. Two of them quote the same flat
 * price and only one of them meters by size, which is the case the tie-break
 * exists for.
 */
describe('the dearest route a connector quotes', () => {
  const DEVNET = [
    { prefix: 'g.toon.relay', price: 1n },
    { prefix: 'g.toon.relay.ephemeral', price: 0n },
    { prefix: 'g.toon.relay.gas', price: 1001n },
    { prefix: 'g.toon.relay.store', price: 1001n, pricePerKib: 10n },
  ];

  it('prefers the metered route when two quote the same flat price', () => {
    expect(dearestRoute(DEVNET)?.prefix).toBe('g.toon.relay.store');
  });

  it('still takes the dearer flat price over a cheaper metered one', () => {
    expect(
      dearestRoute([
        { prefix: 'a', price: 5n, pricePerKib: 100n },
        { prefix: 'b', price: 9n },
      ])?.prefix
    ).toBe('b');
  });

  it('has nothing to quote when every route is free', () => {
    expect(
      dearestRoute([
        { prefix: 'a', price: 0n },
        { prefix: 'b', price: 0n },
      ])
    ).toBeUndefined();
    expect(dearestRoute([])).toBeUndefined();
  });
});
