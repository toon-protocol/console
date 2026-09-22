import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type { SessionStatus } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * Signing in, from the window's side.
 *
 * The daemon is stubbed, and one assertion runs through all of it: whatever a
 * person types — an nsec, a mnemonic, a passphrase — reaches `/api/account/*`
 * and NOTHING else. `bodies` records every request so the test can check that
 * no key material went anywhere else, and `sessionStorage` is checked directly
 * because the launch token is the only thing that belongs in it.
 */

const NPUB = 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu';
const PUBKEY = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

const keystore = (backend: 'libsecret' | 'file') => ({
  backend,
  location: backend === 'libsecret' ? 'gnome-keyring (libsecret)' : '/tmp/keystore.json',
  needsPassphrase: backend === 'file',
});

const signedOut = (backend: 'libsecret' | 'file' = 'libsecret'): SessionStatus => ({
  signedIn: false,
  signers: [],
  keystore: keystore(backend),
});

const signedIn = (backend: 'libsecret' | 'file' = 'libsecret'): SessionStatus => ({
  signedIn: true,
  account: {
    pubkey: PUBKEY,
    npub: NPUB,
    signerId: 'signer-1',
    signerKind: 'local',
    signerLabel: 'npub1zutze…7nu',
    signedInAt: '2026-09-22T00:00:00.000Z',
    profileState: 'ready',
    profile: {
      metadata: { name: 'ada', displayName: 'Ada L', picture: 'https://pic/1' },
      relays: ['wss://relay-ws.devnet.toonprotocol.dev'],
      relaySource: 'profile',
      readAt: '2026-09-22T00:00:01.000Z',
    },
  },
  signers: [
    {
      id: 'signer-1',
      kind: 'local',
      label: 'npub1zutze…7nu',
      pubkey: PUBKEY,
      npub: NPUB,
      backend,
      origin: 'generated',
      createdAt: '2026-09-22T00:00:00.000Z',
    },
  ],
  keystore: keystore(backend),
});

/** Everything a browser store holds, as one string to search. */
function dump(store: Storage | undefined): string {
  if (!store) return '';
  return Object.keys(store)
    .map((key) => `${key}=${store.getItem(key) ?? ''}`)
    .join('\n');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Stub {
  account: SessionStatus;
  bodies: { url: string; body: unknown }[];
}

function stubDaemon(
  stub: Stub,
  onPost?: (url: string, body: unknown) => SessionStatus | Response
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.body) stub.bodies.push({ url, body: JSON.parse(String(init.body)) });
      if (url.startsWith('/api/account')) {
        if (init?.method === 'POST' || init?.method === 'DELETE') {
          const answer = onPost?.(url, init.body ? JSON.parse(String(init.body)) : undefined);
          if (answer instanceof Response) return Promise.resolve(answer);
          if (answer) stub.account = answer;
        }
        return Promise.resolve(jsonResponse(stub.account));
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

/**
 * Render the shell and open the Account view, the way a person does: the
 * console is not gated on signing in, so sign-in is one of the three tabs.
 */
async function openAccount(): Promise<void> {
  render(<ConsoleApp />);
  await userEvent.click(await screen.findByRole('button', { name: 'Account' }));
}

describe('signing in with a Nostr signer', () => {
  let stub: Stub;

  beforeEach(() => {
    stub = { account: signedOut(), bodies: [] };
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('offers a remote signer first, and the local keystore beside it', async () => {
    stubDaemon(stub);
    await openAccount();
    expect(await screen.findByText('Connect a remote signer')).toBeInTheDocument();
    expect(screen.getByText('Use the local keystore')).toBeInTheDocument();
    expect(screen.getByText('gnome-keyring')).toBeInTheDocument();
  });

  it('generates a key and shows the account’s name and avatar', async () => {
    stubDaemon(stub, () => signedIn());
    await openAccount();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate and sign in' }));

    expect((await screen.findAllByText('Ada L')).length).toBeGreaterThan(0);
    expect(screen.getByText(NPUB)).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'ada' })[0]).toHaveAttribute(
      'src',
      'https://pic/1'
    );
    expect(stub.bodies.at(-1)?.body).toMatchObject({ mode: 'generate' });
  });

  it('sends an imported nsec to the daemon and keeps it out of the window', async () => {
    stubDaemon(stub, () => signedIn());
    await openAccount();
    await userEvent.click(await screen.findByRole('button', { name: 'Import nsec' }));
    const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
    await userEvent.type(screen.getByLabelText('Secret key'), nsec);
    await userEvent.click(screen.getByRole('button', { name: 'Import and sign in' }));

    await screen.findAllByText('Ada L');
    const posted = stub.bodies.find((sent) => sent.url === '/api/account/signers/local');
    expect(posted?.body).toMatchObject({ mode: 'nsec', nsec });
    // The only thing this window keeps is the launch token.
    expect(dump(sessionStorage)).not.toContain(nsec);
    expect(dump(globalThis.localStorage as Storage | undefined)).not.toContain(nsec);
    expect(document.body.innerHTML).not.toContain(nsec);
  });

  it('asks for a passphrase when the keystore is the encrypted file', async () => {
    stub.account = signedOut('file');
    stubDaemon(stub, () => signedIn('file'));
    await openAccount();
    expect(await screen.findByText('encrypted file')).toBeInTheDocument();
    const passphrase = screen.getByLabelText('Keystore passphrase', {
      selector: '#local-passphrase',
    });
    await userEvent.type(passphrase, 'a passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Generate and sign in' }));

    await screen.findAllByText('Ada L');
    const posted = stub.bodies.find((sent) => sent.url === '/api/account/signers/local');
    expect(posted?.body).toMatchObject({ passphrase: 'a passphrase' });
  });

  it('dials a bunker URI through the daemon', async () => {
    const remote = signedIn();
    stubDaemon(stub, () => ({
      ...remote,
      ...(remote.account
        ? { account: { ...remote.account, signerKind: 'remote' as const } }
        : {}),
    }));
    await openAccount();
    await userEvent.type(
      await screen.findByLabelText('Bunker URI'),
      'bunker://abc?relay=ws://127.0.0.1:10547'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('remote signer')).toBeInTheDocument();
    expect(
      stub.bodies.find((sent) => sent.url === '/api/account/signers/bunker')?.body
    ).toMatchObject({
      uri: 'bunker://abc?relay=ws://127.0.0.1:10547',
    });
  });

  it('shows a nostrconnect invitation to scan', async () => {
    const uri = 'nostrconnect://abcdef?relay=wss%3A%2F%2Frelay.example&secret=xyz';
    stubDaemon(stub, () => ({
      ...signedOut(),
      invitation: { uri, state: 'waiting' as const, expiresAt: '2026-09-22T00:03:00.000Z' },
    }));
    await openAccount();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show a nostrconnect invitation' })
    );
    expect(await screen.findByText(uri)).toBeInTheDocument();
    expect(screen.getByText('Waiting for a signer to accept')).toBeInTheDocument();
  });

  it('signs out back to the sign-in screen, with the signer still listed', async () => {
    stub.account = signedIn();
    stubDaemon(stub, (url) =>
      url.endsWith('/signout') ? { ...signedOut(), signers: signedIn().signers } : signedIn()
    );
    await openAccount();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Connect a remote signer')).toBeInTheDocument();
    expect(screen.getByText('Signers on this machine')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('reports what the daemon said when a sign-in fails', async () => {
    stubDaemon(stub, () =>
      jsonResponse({ error: 'invalid_nsec', message: 'That is not an nsec.' }, 400)
    );
    await openAccount();
    await userEvent.click(await screen.findByRole('button', { name: 'Import nsec' }));
    await userEvent.type(screen.getByLabelText('Secret key'), 'nsec1nonsense');
    await userEvent.click(screen.getByRole('button', { name: 'Import and sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('That is not an nsec.');
    });
  });

  it('signs a test event through the connected signer', async () => {
    stub.account = signedIn();
    stubDaemon(stub, () => signedIn());
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/account/sign') {
          return Promise.resolve(jsonResponse({ event: { id: 'deadbeef', pubkey: PUBKEY } }));
        }
        if (url.startsWith('/api/account')) return Promise.resolve(jsonResponse(stub.account));
        if (url.startsWith('/api/profiles')) {
          return Promise.resolve(jsonResponse({ activeId: 'devnet', profiles: [] }));
        }
        return Promise.resolve(jsonResponse({ error: 'not in this test' }, 500));
      })
    );
    await openAccount();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign a test event' }));
    expect(await screen.findByTestId('test-signature')).toHaveTextContent('deadbeef');
  });
});
