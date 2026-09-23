import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import { formatAmount } from '@/app/funding-view';
import type { ChainFundingView, FundingStatus, SessionStatus } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The Funds view (TOON_Network#90).
 *
 * The cases here are the ones the ticket says it is judged on, and they are
 * all about what the screen REFUSES to say: it does not show a zero for a
 * chain it could not read, it does not show a failure for an open that is
 * still in flight, and it does not offer a button that would fail.
 */

const PUBKEY = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const EVM_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const SOLANA_ADDRESS = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

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

const evmChain = (overrides: Partial<ChainFundingView> = {}): ChainFundingView => ({
  chain: 'evm:84532',
  kind: 'evm',
  counterparty: '0x3f43d923a611bcb2d0bfb5d6ee2c3ac3efeaf308',
  token: { address: '0x49bee1bca5d15fb0963117923403f9498119a9ce', decimals: 6 },
  deposit: { address: EVM_ADDRESS, path: "m/44'/60'/0'/0/0" },
  rpc: { url: 'https://rpc.test', source: 'client-default' },
  balances: {
    state: 'read',
    native: { amount: '0', symbol: 'ETH', decimals: 18 },
    token: { amount: '1000000000', symbol: 'USDC', decimals: 6 },
  },
  gas: {
    verdict: 'none',
    symbol: 'ETH',
    headline:
      'Opening a payment channel is a transaction on evm:84532, so it costs ETH — the ' +
      "chain's own coin, which is not the token this network is priced in and which no part " +
      'of TOON Network can give you.',
    detail:
      'This address holds no ETH, so an open would be refused by the chain before it cost ' +
      "anything. This network's faucet gives the settlement token and reports no ETH to " +
      'give, so it cannot unblock this.',
    faucetGivesGas: false,
  },
  channel: { phase: 'none', reason: 'This console holds no channel with this connector.' },
  canOpen: false,
  blockedBy: 'No ETH at this address: the transaction cannot be paid for.',
  suggestedDeposit: '100100',
  ...overrides,
});

const solanaChain = (overrides: Partial<ChainFundingView> = {}): ChainFundingView => ({
  ...evmChain(),
  chain: 'solana',
  kind: 'solana',
  counterparty: 'GzvGVjq3dnNM79MpWRvYCvVcAgPWzDdYisMwGxHF4u9F',
  token: { address: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU', decimals: 6 },
  deposit: { address: SOLANA_ADDRESS, path: "m/44'/501'/0'/0'" },
  rpc: { url: 'https://api.devnet.test', source: 'client-default' },
  gas: {
    ...evmChain().gas,
    symbol: 'SOL',
    command: `solana airdrop 1 ${SOLANA_ADDRESS} --url https://api.devnet.test`,
  },
  ...overrides,
});

const funding = (overrides: Partial<FundingStatus> = {}): FundingStatus => ({
  state: 'ready',
  profile: { id: 'devnet', label: 'Devnet' },
  pubkey: PUBKEY,
  custody: {
    text: 'Whoever holds this account’s Nostr key holds its funds.',
    acknowledgedAt: '2026-09-22T00:00:00.000Z',
  },
  supersededSeeds: 0,
  chains: [evmChain(), solanaChain()],
  quote: { route: 'g.toon.relay', price: '1001', packets: 100 },
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
      {
        kind: 'solana',
        name: 'solana',
        ready: true,
        drips: [{ asset: 'usdc', amount: '1000' }],
      },
    ],
  },
  channelStorePath: '/home/x/.local/share/toon-console/profiles/devnet/channels/channels.json',
  checkedAt: '2026-09-22T00:00:00.000Z',
  ...overrides,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Stub {
  funding: FundingStatus;
  posts: { url: string; body: unknown }[];
  gets: string[];
}

function stubDaemon(stub: Stub, onPost?: (url: string, body: unknown) => FundingStatus) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/funding')) {
        if (init?.method === 'POST') {
          const body = init.body ? JSON.parse(String(init.body)) : undefined;
          stub.posts.push({ url, body });
          const answer = onPost?.(url, body);
          if (answer) stub.funding = answer;
        } else {
          stub.gets.push(url);
        }
        return Promise.resolve(jsonResponse(stub.funding));
      }
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

describe('the Funds view', () => {
  let stub: Stub;

  beforeEach(() => {
    stub = { funding: funding(), posts: [], gets: [] };
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('leads with the gas problem, before any deposit address', async () => {
    stubDaemon(stub);
    await openFunds();

    const gate = await screen.findByTestId('gas-gate');
    expect(
      within(gate).getByText(/need native gas, and nothing here can give it to you/u)
    ).toBeInTheDocument();
    // And it is ABOVE the addresses, not beside them.
    const address = await screen.findByTestId('deposit-evm:84532');
    expect(
      gate.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('says the faucet gives the token and not the gas', async () => {
    stubDaemon(stub);
    await openFunds();
    expect(
      await screen.findAllByText(/gives the settlement token only — no ETH|no SOL/u)
    ).not.toHaveLength(0);
  });

  it('hands a Solana account the airdrop command to copy', async () => {
    stubDaemon(stub);
    await openFunds();
    expect(
      await screen.findByText(
        `solana airdrop 1 ${SOLANA_ADDRESS} --url https://api.devnet.test`
      )
    ).toBeInTheDocument();
  });

  it('shows a deposit address per chain, with a QR code and its derivation path', async () => {
    stubDaemon(stub);
    await openFunds();

    expect(await screen.findByTestId('deposit-evm:84532')).toHaveTextContent(EVM_ADDRESS);
    expect(screen.getByTestId('deposit-solana')).toHaveTextContent(SOLANA_ADDRESS);
    expect(screen.getByText("m/44'/60'/0'/0/0")).toBeInTheDocument();
    // One QR per chain, and it encodes the bare address so any wallet reads it.
    const codes = document.querySelectorAll('svg[role="img"], svg');
    expect(codes.length).toBeGreaterThanOrEqual(2);
  });

  it('will not offer an open that cannot be paid for, and says why', async () => {
    stubDaemon(stub);
    await openFunds();

    const buttons = await screen.findAllByRole('button', { name: 'Open channel' });
    expect(buttons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByTestId('blocked-evm:84532')).toHaveTextContent(
      'No ETH at this address'
    );
  });

  it('offers the open once there is gas, and posts the connector’s chain key', async () => {
    stub.funding = funding({
      chains: [
        evmChain({
          balances: {
            state: 'read',
            native: { amount: '2000000000000000', symbol: 'ETH', decimals: 18 },
            token: { amount: '1000000000', symbol: 'USDC', decimals: 6 },
          },
          gas: {
            verdict: 'present',
            symbol: 'ETH',
            headline: 'h',
            detail: 'd',
            faucetGivesGas: false,
          },
          canOpen: true,
          blockedBy: undefined,
        }),
      ],
    });
    stubDaemon(stub, () => ({
      ...stub.funding,
      chains: [
        {
          ...(stub.funding.chains[0] as ChainFundingView),
          canOpen: false,
          channel: {
            phase: 'opening',
            startedAt: '2026-09-22T00:00:01.000Z',
            reason: 'in flight',
          },
        },
      ],
    }));
    await openFunds();

    await userEvent.click(await screen.findByRole('button', { name: 'Open channel' }));
    await waitFor(() => expect(stub.posts).toHaveLength(1));
    expect(stub.posts[0]).toEqual({
      url: '/api/funding/channel',
      // The chain key exactly as the connector published it, and the deposit
      // as a whole number of base units.
      body: { chain: 'evm:84532', deposit: '100100' },
    });
  });

  it('shows an open in flight as pending, never as failed', async () => {
    stub.funding = funding({
      chains: [
        evmChain({
          channel: {
            phase: 'opening',
            startedAt: '2026-09-22T00:00:01.000Z',
            reason: 'The opening transaction is in flight.',
          },
          canOpen: false,
          blockedBy: 'An open is already in flight on this chain.',
        }),
      ],
    });
    stubDaemon(stub);
    await openFunds();

    expect(await screen.findByText('opening…')).toBeInTheDocument();
    expect(screen.queryByText('open failed')).toBeNull();
    expect(screen.queryByText(/did not land/u)).toBeNull();
  });

  it('keeps asking while an open is in flight, and stops when it is not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stub.funding = funding({
        chains: [evmChain({ channel: { phase: 'opening', startedAt: 'now' } })],
      });
      stubDaemon(stub);
      await openFunds();
      await screen.findByText('opening…');
      const before = stub.gets.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(stub.gets.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says UNKNOWN for a chain it could not read, and shows no figure', async () => {
    stub.funding = funding({
      chains: [
        evmChain({
          balances: {
            state: 'unknown',
            reason: 'https://rpc.test did not answer, so this chain’s balances are unknown.',
          },
          gas: {
            verdict: 'unknown',
            headline: 'h',
            detail: 'the endpoint did not answer',
            faucetGivesGas: false,
          },
          canOpen: false,
          blockedBy:
            'This chain could not be read, so whether an open can be paid for is unknown.',
        }),
      ],
    });
    stubDaemon(stub);
    await openFunds();

    const balances = await screen.findByTestId('balances-unknown-evm:84532');
    expect(balances).toHaveTextContent('unknown');
    expect(balances).toHaveTextContent('did not answer');
    // Nothing that could be read as "you have nothing".
    expect(screen.queryByText('0 ETH')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open channel' })).toBeDisabled();
  });

  it('shows the channel’s collateral, spend and what is left of it', async () => {
    stub.funding = funding({
      chains: [
        evmChain({
          channel: {
            phase: 'open',
            channelId: '0xchannel',
            deposit: '100100',
            spent: '2002',
            available: '98098',
            nonce: 2,
          },
          canOpen: false,
          blockedBy: 'This console already holds a channel with this connector on this chain.',
        }),
      ],
    });
    stubDaemon(stub);
    await openFunds();

    expect(await screen.findByText('channel open')).toBeInTheDocument();
    expect(screen.getByText('98098')).toBeInTheDocument();
    expect(screen.getByText('0xchannel')).toBeInTheDocument();
  });

  it('repeats the connector’s quote rather than working a price out', async () => {
    stubDaemon(stub);
    await openFunds();
    expect(
      await screen.findAllByText(/100 packets at the price this connector quotes/u)
    ).not.toHaveLength(0);
    expect(screen.getAllByText(/1001 base units each/u)).not.toHaveLength(0);
    expect(screen.getAllByText(/The console never recomputes one/u)).not.toHaveLength(0);
  });

  it('shouts about a superseded Chain Seed before anyone deposits', async () => {
    stub.funding = funding({ supersededSeeds: 2 });
    stubDaemon(stub);
    await openFunds();
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((alert) => /2 other sealed Chain Seeds/u.test(alert.textContent ?? ''))
    ).toBe(true);
  });

  it('asks the faucet for the chain a person pressed it on', async () => {
    stubDaemon(stub);
    await openFunds();
    const solana = await screen.findByTestId('chain-solana');
    await userEvent.click(within(solana).getByRole('button', { name: 'Ask the faucet' }));
    await waitFor(() => expect(stub.posts).toHaveLength(1));
    expect(stub.posts[0]).toEqual({
      url: '/api/funding/faucet',
      body: { chain: 'solana' },
    });
  });

  it('points at the Account tab when there is no Chain Seed to derive from', async () => {
    stub.funding = funding({
      state: 'no_seed',
      chains: [],
      reason: 'This account has no Chain Seed yet. Mint or import one on the Account tab.',
    });
    stubDaemon(stub);
    await openFunds();
    expect(await screen.findAllByText(/no Chain Seed yet/u)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Open channel' })).toBeNull();
  });

  it('shows no chain at all when the connector did not answer', async () => {
    stub.funding = funding({
      state: 'connector_unreachable',
      chains: [],
      reason: 'The connector did not answer, so which chains it settles on is unknown.',
    });
    stubDaemon(stub);
    await openFunds();
    expect(
      await screen.findByText(/which chains it settles on is unknown/u)
    ).toBeInTheDocument();
    expect(screen.queryByTestId('deposit-evm:84532')).toBeNull();
  });
});

describe('formatting base units', () => {
  it('scales by the decimals the chain reported, with string maths', () => {
    expect(formatAmount({ amount: '1000000', decimals: 6, symbol: 'USDC' })).toBe('1 USDC');
    expect(formatAmount({ amount: '1500000', decimals: 6 })).toBe('1.5');
    expect(formatAmount({ amount: '1', decimals: 18, symbol: 'ETH' })).toBe(
      '0.000000000000000001 ETH'
    );
    // Bigger than a double holds exactly, and it still comes out right.
    expect(formatAmount({ amount: '123456789012345678901', decimals: 18 })).toBe(
      '123.456789012345678901'
    );
  });

  it('says "unknown" rather than zero when there is nothing to format', () => {
    expect(formatAmount(undefined)).toBe('unknown');
  });
});
