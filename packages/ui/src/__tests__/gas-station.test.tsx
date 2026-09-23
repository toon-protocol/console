import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type {
  ChainFundingView,
  FundingStatus,
  GasPurchase,
  GasQuote,
  GasStationStatus,
  SessionStatus,
} from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * Buying the next chain's gas, on screen (TOON_Network#119).
 *
 * What this file is really testing is the ORDER, because the order is the
 * acceptance criterion. A quote is shown before anything is executed. The
 * button that executes names the quote on the screen. A chain no gas station
 * will sell for gets the reason and no button. And the sentence about the
 * first channel survives the arrival of a feature that might have been
 * mistaken for solving it.
 */

const PUBKEY = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const SOLANA_ADDRESS = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const FEE_PAYER = '6sQY9XTTD4pS9YDuH6T8Eey5hRLoCoDhJ66p6th1toc7';

const signedIn: SessionStatus = {
  signedIn: true,
  account: {
    pubkey: PUBKEY,
    npub: 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu',
    signerId: 'signer-1',
    signerKind: 'local',
    signerLabel: 'npub1zutze…7nu',
    signedInAt: '2026-09-22T00:00:00.000Z',
    profileState: 'none',
  },
  signers: [],
  keystore: { backend: 'libsecret', location: 'gnome-keyring', needsPassphrase: false },
};

const blocked = (chain: string, kind: 'evm' | 'solana'): ChainFundingView => ({
  chain,
  kind,
  counterparty: 'Ho1dEr',
  token: { address: 'M1nt', decimals: 6 },
  deposit: { address: SOLANA_ADDRESS, path: "m/44'/501'/0'/0'" },
  rpc: { url: 'https://rpc.test', source: 'client-default' },
  balances: { state: 'read', native: { amount: '0', symbol: 'SOL', decimals: 9 } },
  gas: {
    verdict: 'none',
    symbol: kind === 'evm' ? 'ETH' : 'SOL',
    headline: `Opening a payment channel is a transaction on ${chain}.`,
    detail: 'This address holds none of it.',
    faucetGivesGas: false,
  },
  channel: { phase: 'none' },
  canOpen: false,
  blockedBy: 'no gas',
});

const funding: FundingStatus = {
  state: 'ready',
  profile: { id: 'devnet', label: 'Devnet' },
  pubkey: PUBKEY,
  custody: { text: 'Whoever holds this account’s Nostr key holds its funds.' },
  supersededSeeds: 0,
  chains: [blocked('solana', 'solana'), blocked('evm:84532', 'evm')],
  checkedAt: '2026-09-22T00:00:00.000Z',
};

const buyable: GasStationStatus = {
  state: 'ready',
  station: {
    connectorUrl: 'https://proxy.gas.test/ilp',
    selfEndpoint: 'https://proxy.gas.test/ilp',
    doors: ['g.toon.gas', 'g.toon.relay.gas'],
    reachable: true,
  },
  chains: [
    {
      chain: 'solana',
      kind: 'solana',
      recipient: SOLANA_ADDRESS,
      verdict: 'buyable',
      reason:
        'This console can buy 10000000 lamports of SOL for this address, paid from the ' +
        'channel it already holds on evm:84532.',
      payer: {
        chain: 'evm:84532',
        channelId: '0xchannel',
        available: '900000',
        payAt: 'https://proxy.relay.test/ilp',
        via: 'forwarded',
      },
      destination: 'g.toon.relay.gas',
      price: '1001',
      lamports: '10000000',
    },
    {
      chain: 'evm:84532',
      kind: 'evm',
      recipient: '0xabc',
      verdict: 'unsupported',
      reason:
        'A gas station will not sell native ETH on evm:84532, and that is a decision rather ' +
        'than a gap. Its EVM job (kind:5098) relays a call you signed and pays the gas for it.',
    },
  ],
  checkedAt: '2026-09-22T00:00:00.000Z',
};

const quote: GasQuote = {
  chain: 'solana',
  quoteId: 'q-42',
  feePayer: FEE_PAYER,
  recipient: SOLANA_ADDRESS,
  lamports: '10000000',
  maxLamports: '12020000',
  recentBlockhash: '8Uo3Zk2Vw5w4kPUSyz3gGxU5bJb6yJ1qRZ8WJpqbFuNd',
  expiresAt: Date.parse('2026-09-22T00:01:00.000Z'),
  destination: 'g.toon.relay.gas',
  payAt: 'https://proxy.relay.test/ilp',
  price: '1001',
  cost: '1001',
  attempts: [
    { destination: 'g.toon.relay.gas', phase: 'quote', outcome: 'receipt', cost: '1001' },
    { destination: 'g.toon.relay.gas', phase: 'quote', outcome: 'receipt', cost: '1001' },
  ],
};

const delivered: GasPurchase = {
  chain: 'solana',
  state: 'delivered',
  signature: '5KtPn1LGuxhF',
  slot: '4242',
  lamports: '10000000',
  recipient: SOLANA_ADDRESS,
  attempts: [],
  cost: '3003',
  at: '2026-09-22T00:00:30.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Stub {
  gas: GasStationStatus;
  posts: { url: string; body: unknown }[];
  /** What each gas POST answers, by path. */
  answers: Map<string, { body: unknown; status?: number }>;
}

function stubDaemon(stub: Stub): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/funding/gas')) {
        if (init?.method === 'POST') {
          stub.posts.push({
            url,
            body: init.body ? JSON.parse(String(init.body)) : undefined,
          });
          const answer = stub.answers.get(url);
          if (!answer) throw new Error(`no stubbed answer for ${url}`);
          return Promise.resolve(jsonResponse(answer.body, answer.status ?? 200));
        }
        return Promise.resolve(jsonResponse(stub.gas));
      }
      if (url.startsWith('/api/funding')) return Promise.resolve(jsonResponse(funding));
      if (url.startsWith('/api/account')) return Promise.resolve(jsonResponse(signedIn));
      if (url.startsWith('/api/chain-seed')) {
        return Promise.resolve(
          jsonResponse({
            state: 'ready',
            relayList: {
              state: 'none',
              read: [],
              write: [],
              writeTargets: [],
              writeTargetSource: 'none',
            },
            warning: { text: '' },
            supersededSeeds: 0,
            checkedAt: '2026-09-22T00:00:00.000Z',
          })
        );
      }
      if (url.startsWith('/api/profiles')) {
        return Promise.resolve(jsonResponse({ activeId: 'devnet', profiles: [] }));
      }
      if (url.startsWith('/api/health')) {
        return Promise.resolve(jsonResponse({ error: 'not in this test' }, 500));
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

async function openFunds(): Promise<void> {
  render(<ConsoleApp />);
  await userEvent.click(await screen.findByRole('button', { name: 'Funds' }));
}

describe('buying the next chain’s gas', () => {
  let stub: Stub;

  beforeEach(() => {
    stub = { gas: buyable, posts: [], answers: new Map() };
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('offers a quote for the chain it can buy, and nothing but a reason for the one it cannot', async () => {
    stubDaemon(stub);
    await openFunds();

    const solana = await screen.findByTestId('gas-buy-solana');
    expect(
      within(solana).getByRole('button', { name: /Get a quote \(1001 base units\)/u })
    ).toBeTruthy();

    const evm = screen.getByTestId('gas-buy-evm:84532');
    expect(within(evm).queryByRole('button')).toBeNull();
    expect(evm.textContent).toContain('kind:5098');
  });

  it('shows the quote before anything is executed, and pays for that quote', async () => {
    stub.answers.set('/api/funding/gas/quote', { body: quote });
    stub.answers.set('/api/funding/gas/buy', { body: delivered });
    stubDaemon(stub);
    await openFunds();

    await userEvent.click(await screen.findByRole('button', { name: /Get a quote/u }));

    // The station's own figures, on screen, before a second packet is paid
    // for: what it will move, where it lands, and its own ceiling.
    const shown = await screen.findByTestId('gas-quote-solana');
    expect(shown.textContent).toContain('10000000 lamports');
    expect(shown.textContent).toContain(SOLANA_ADDRESS);
    expect(shown.textContent).toContain(FEE_PAYER);
    expect(shown.textContent).toContain('12020000 lamports');
    // And what quoting has already cost — both packets, summed.
    expect(shown.textContent).toContain('2002 base units so far');

    await userEvent.click(screen.getByRole('button', { name: /Pay 1001 base units/u }));

    await waitFor(() => expect(screen.getByTestId('gas-purchase')).toBeTruthy());
    const bought = screen.getByTestId('gas-purchase');
    expect(bought.textContent).toContain('5KtPn1LGuxhF');
    expect(bought.textContent).toContain('3003 base units');

    // The purchase named the quote it was shown, and nothing else.
    const buy = stub.posts.find((post) => post.url.endsWith('/buy'));
    expect(buy?.body).toEqual({ chain: 'solana', quoteId: 'q-42' });
    // There is no path from the panel to an execute without a quote first.
    expect(stub.posts.map((post) => post.url)).toEqual([
      '/api/funding/gas/quote',
      '/api/funding/gas/buy',
    ]);
  });

  it('says a refusal in the station’s own words, and what it cost', async () => {
    stub.answers.set('/api/funding/gas/quote', { body: quote });
    stub.answers.set('/api/funding/gas/buy', {
      body: {
        ...delivered,
        state: 'refused',
        signature: undefined,
        reason: 'float_exhausted',
        detail: 'the fee payer holds 0 lamports',
      },
    });
    stubDaemon(stub);
    await openFunds();

    await userEvent.click(await screen.findByRole('button', { name: /Get a quote/u }));
    await userEvent.click(await screen.findByRole('button', { name: /Pay 1001/u }));

    const bought = await screen.findByTestId('gas-purchase');
    expect(bought.textContent).toContain('float_exhausted');
    expect(bought.textContent).toContain('the packet was billed');
    expect(bought.textContent).toContain('3003 base units');
  });

  it('shows what a refused quote cost, rather than only that it failed', async () => {
    stub.answers.set('/api/funding/gas/quote', {
      status: 502,
      body: {
        error: 'job_refused',
        message:
          'The quote was refused: g.toon.relay.gas does not take a quote. It was still ' +
          'billed 1001 base units in total.',
        attempts: [
          {
            destination: 'g.toon.relay.gas',
            phase: 'quote',
            outcome: 'refused',
            cost: '1001',
          },
        ],
      },
    });
    stubDaemon(stub);
    await openFunds();

    await userEvent.click(await screen.findByRole('button', { name: /Get a quote/u }));
    const panel = await screen.findByTestId('gas-buy-solana');
    await waitFor(() =>
      expect(within(panel).getByRole('alert').textContent).toContain(
        'still billed 1001 base units'
      )
    );
    // And no quote is shown, so there is nothing to press "pay" on.
    expect(screen.queryByTestId('gas-quote-solana')).toBeNull();
  });

  it('offers the channel that reaches the door, when a refusal taught it there is one', async () => {
    stub.gas = {
      ...buyable,
      chains: buyable.chains.map((chain) =>
        chain.verdict === 'buyable'
          ? {
              ...chain,
              verdict: 'no_route' as const,
              reason:
                'The only door that channel can reach — g.toon.relay.gas — has already ' +
                'refused a quote or an execute from this console, and a purchase needs both.',
              openChannelWith: 'https://proxy.gas.test/ilp',
            }
          : chain
      ),
      checkedAt: '2026-09-22T00:00:00.000Z',
    };
    stubDaemon(stub);
    await openFunds();

    const panel = await screen.findByTestId('gas-buy-solana');
    expect(panel.textContent).toContain('has already refused');
    // There is no quote button on a dead end — but there IS the one thing that
    // opens it, and it names the chain the channel would be opened on.
    expect(within(panel).queryByRole('button', { name: /Get a quote/u })).toBeNull();
    expect(
      within(panel).getByRole('button', {
        name: /Open a channel with the gas station’s connector on evm:84532/u,
      })
    ).toBeTruthy();
  });

  it('keeps saying the first channel has no route through this', async () => {
    stub.gas = {
      state: 'ready',
      station: buyable.station,
      chains: buyable.chains.map((chain) =>
        chain.verdict === 'buyable'
          ? {
              ...chain,
              verdict: 'no_channel' as const,
              payer: undefined,
              reason:
                'A gas station is paid over a payment channel, and this account has none.',
            }
          : chain
      ),
      firstChannel:
        'The FIRST channel on the FIRST chain has no route through this, and buying gas ' +
        'cannot give it one.',
      checkedAt: '2026-09-22T00:00:00.000Z',
    };
    stubDaemon(stub);
    await openFunds();

    const sentence = await screen.findByTestId('first-channel');
    expect(sentence.textContent).toContain('FIRST channel on the FIRST chain');
    // And no button anywhere offers to buy a way out of it.
    expect(screen.queryByRole('button', { name: /Get a quote/u })).toBeNull();
  });
});
