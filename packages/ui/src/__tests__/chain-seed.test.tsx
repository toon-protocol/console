import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type { ChainSeedStatus, SessionStatus } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The Chain Seed card, from the window's side (TOON_Network#89, ADR 0020,
 * TOON_Network#120).
 *
 * Three things are under test. A person is warned once, can mint or import,
 * and then sees where their money goes. The words they type reach
 * `/api/chain-seed/import` and NOTHING else: not `localStorage`, not
 * `sessionStorage`, not the URL, and not any other request — `bodies` records
 * every request so the test can look. And a seed that has been minted but not
 * published shows as **not yet recoverable**, with no published record beside
 * it to be confused with one.
 */

const VECTOR = 'abandon '.repeat(11) + 'about';
const NPUB = 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu';
const PUBKEY = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const WARNING = 'Whoever holds this account’s Nostr key holds its funds.';
const NOT_RECOVERABLE =
  'This Chain Seed is NOT YET RECOVERABLE. It is sealed on this machine and on nothing else.';
const BLOCKED =
  'This account holds no payment channel with the connector at https://connector.test/ilp.';

/** A network where one relay write can be bought, at the price it quoted. */
const PAYABLE = {
  relays: ['wss://relay.toon.test'],
  destination: 'g.toon.relay',
  payAt: 'https://connector.test/ilp',
  price: '1',
  chain: 'evm:84532',
  channelId: '0xchannel',
  ready: true,
};

const signedIn: SessionStatus = {
  signedIn: true,
  account: {
    pubkey: PUBKEY,
    npub: NPUB,
    signerId: 'signer-1',
    signerKind: 'local',
    signerLabel: 'npub1zutze…7nu',
    signedInAt: '2026-09-22T00:00:00.000Z',
    profileState: 'none',
  },
  signers: [],
  keystore: { backend: 'libsecret', location: 'gnome-keyring', needsPassphrase: false },
};

const noSeed = (
  acknowledged: boolean,
  relays: string[] = ['wss://own.test']
): ChainSeedStatus => ({
  state: 'absent',
  pubkey: PUBKEY,
  relayList: {
    state: relays.length > 0 ? 'present' : 'none',
    read: relays,
    write: relays,
  },
  writes: PAYABLE,
  warning: {
    text: WARNING,
    ...(acknowledged ? { acknowledgedAt: '2026-09-22T00:00:00.000Z' } : {}),
  },
  supersededSeeds: 0,
  checkedAt: '2026-09-22T00:00:00.000Z',
});

const ready: ChainSeedStatus = {
  ...noSeed(true),
  state: 'ready',
  origin: 'imported',
  addresses: {
    evm: { address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', path: "m/44'/60'/0'/0/0" },
    solana: {
      address: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      path: "m/44'/501'/0'/0'",
    },
  },
  record: {
    eventId: 'f'.repeat(64),
    publishedAt: '2026-09-22T00:00:00.000Z',
    source: 'relays',
    relays: ['wss://own.test'],
  },
};

/** Minted, sealed, on this disk and nowhere else (TOON_Network#120). */
const held: ChainSeedStatus = {
  ...noSeed(true),
  state: 'not_yet_recoverable',
  origin: 'minted',
  addresses: ready.addresses!,
  held: {
    since: '2026-09-23T00:00:00.000Z',
    origin: 'minted',
    text: NOT_RECOVERABLE,
    steps: ['Send the chain’s own coin to the payer address below.', 'Open a channel.'],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Stub {
  seed: ChainSeedStatus;
  /** Every POST this window made: the URL, and the body if it carried one. */
  bodies: { url: string; body: unknown }[];
}

function stubDaemon(
  stub: Stub,
  onPost?: (url: string, body: unknown) => ChainSeedStatus | Response
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        stub.bodies.push({
          url,
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
      }
      if (url.startsWith('/api/chain-seed') || url === '/api/account/relays') {
        if (init?.method === 'POST') {
          const answer = onPost?.(url, init.body ? JSON.parse(String(init.body)) : undefined);
          if (answer instanceof Response) return Promise.resolve(answer);
          if (answer) stub.seed = answer;
        }
        return Promise.resolve(jsonResponse(stub.seed));
      }
      if (url.startsWith('/api/account')) return Promise.resolve(jsonResponse(signedIn));
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

async function openAccount(): Promise<void> {
  render(<ConsoleApp />);
  await userEvent.click(await screen.findByRole('button', { name: 'Account' }));
}

/** Everything a browser store holds, as one string to search. */
function dump(store: Storage | undefined): string {
  if (!store) return '';
  return Object.keys(store)
    .map((key) => `${key}=${store.getItem(key) ?? ''}`)
    .join('\n');
}

describe('the Chain Seed card', () => {
  let stub: Stub;

  beforeEach(() => {
    stub = { seed: noSeed(false), bodies: [] };
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('warns before it offers anything, and only once', async () => {
    stubDaemon(stub, () => noSeed(true));
    await openAccount();

    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mint a Chain Seed' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /I understand/u }));

    expect(
      await screen.findByRole('button', { name: 'Mint a Chain Seed' })
    ).toBeInTheDocument();
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('shows both addresses and the paths they came from', async () => {
    stub.seed = ready;
    stubDaemon(stub);
    await openAccount();

    expect(await screen.findByText(ready.addresses!.evm.address)).toBeInTheDocument();
    expect(screen.getByText(ready.addresses!.solana.address)).toBeInTheDocument();
    expect(screen.getByText("m/44'/60'/0'/0/0")).toBeInTheDocument();
    expect(screen.getByText("m/44'/501'/0'/0'")).toBeInTheDocument();
  });

  it('offers no way to see the words — there is no reveal and no export', async () => {
    stub.seed = ready;
    stubDaemon(stub);
    await openAccount();
    await screen.findByText(ready.addresses!.evm.address);

    for (const name of [
      /reveal/iu,
      /show.*(seed|phrase|mnemonic)/iu,
      /export/iu,
      /back.?up/iu,
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('sends an imported mnemonic to the daemon and nowhere else', async () => {
    stub.seed = noSeed(true);
    stubDaemon(stub, () => ready);
    await openAccount();

    await userEvent.click(await screen.findByRole('button', { name: 'Import a mnemonic' }));
    const words = screen.getByLabelText(/BIP-39 words/u);
    await userEvent.type(words, VECTOR);
    await userEvent.click(screen.getByRole('button', { name: /Import as the Chain Seed/u }));

    await waitFor(() =>
      expect(screen.getByText(ready.addresses!.evm.address)).toBeInTheDocument()
    );

    const carried = stub.bodies.filter((sent) =>
      JSON.stringify(sent.body).includes('abandon')
    );
    expect(carried).toHaveLength(1);
    expect(carried[0]?.url).toBe('/api/chain-seed/import');
    expect(dump(window.localStorage)).not.toContain('abandon');
    expect(dump(window.sessionStorage)).not.toContain('abandon');
    expect(window.location.href).not.toContain('abandon');
  });

  it('shows a minted seed as NOT YET RECOVERABLE, with no record beside it', async () => {
    stub.seed = noSeed(true);
    stubDaemon(stub, () => held);
    await openAccount();

    await userEvent.click(await screen.findByRole('button', { name: 'Mint a Chain Seed' }));

    // The state, in the words the ticket chose, above the addresses it is
    // about to invite deposits to.
    expect((await screen.findAllByText(/not yet recoverable/iu)).length).toBeGreaterThan(1);
    expect(screen.getByText(held.held!.text)).toBeInTheDocument();
    expect(screen.getByText(held.addresses!.evm.address)).toBeInTheDocument();
    // Nothing that could be read as a published record.
    expect(screen.queryByText(/Published 2026/u)).toBeNull();
    expect(screen.queryByText(/Read from wss/u)).toBeNull();
  });

  it('publishes the held seed with one paid write, and says what it costs', async () => {
    stub.seed = held;
    stubDaemon(stub, (url) => (url === '/api/chain-seed/publish' ? ready : stub.seed));
    await openAccount();

    expect((await screen.findAllByText(/1 base units/u)).length).toBeGreaterThan(0);
    await userEvent.click(
      screen.getByRole('button', { name: /Publish it — one paid write/u })
    );

    await waitFor(() => expect(screen.queryAllByText(/not yet recoverable/iu)).toEqual([]));
    expect(stub.bodies.some((sent) => sent.url === '/api/chain-seed/publish')).toBe(true);
  });

  it('says why a write could not be bought, and keeps saying the seed is held', async () => {
    stub.seed = {
      ...held,
      writes: { relays: ['wss://relay.toon.test'], ready: false, blockedBy: BLOCKED },
      held: { ...held.held!, lastAttempt: BLOCKED },
    };
    stubDaemon(stub);
    await openAccount();

    expect((await screen.findAllByText(/not yet recoverable/iu)).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/no payment channel/u).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Publish it/u })).toBeDisabled();
  });

  it('offers a relay list when the account has published none', async () => {
    stub.seed = noSeed(true, []);
    stubDaemon(stub, (url) => (url === '/api/account/relays' ? noSeed(true) : stub.seed));
    await openAccount();

    expect(await screen.findByText(/no NIP-65 relay list/u)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Publish a relay list/u), 'wss://own.test');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(screen.getByText(/names wss:\/\/own\.test to write to/u)).toBeInTheDocument()
    );
    expect(stub.bodies.find((sent) => sent.url === '/api/account/relays')?.body).toEqual({
      relays: [{ url: 'wss://own.test' }],
    });
  });

  it('is not there at all when nobody is signed in', async () => {
    stub.seed = {
      state: 'signed_out',
      relayList: { state: 'unknown', read: [], write: [] },
      writes: { relays: [], ready: false },
      warning: { text: WARNING },
      supersededSeeds: 0,
      checkedAt: '2026-09-22T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/chain-seed')) return Promise.resolve(jsonResponse(stub.seed));
        if (url.startsWith('/api/account')) {
          return Promise.resolve(
            jsonResponse({ signedIn: false, signers: [], keystore: signedIn.keystore })
          );
        }
        if (url.startsWith('/api/profiles')) {
          return Promise.resolve(jsonResponse({ activeId: 'devnet', profiles: [] }));
        }
        return Promise.resolve(jsonResponse({ error: 'not in this test' }, 500));
      })
    );
    await openAccount();

    expect(await screen.findByText('Connect a remote signer')).toBeInTheDocument();
    expect(screen.queryByText('Chain Seed')).toBeNull();
  });
});
