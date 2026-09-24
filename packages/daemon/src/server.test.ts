import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import type { ApiDeps } from './api.js';
import type { ConnectorHealth } from './connector-health.js';
import type { AnonTransportView, HiddenTransportPort } from './hidden-transport.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { activeProfileFilePath, consolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { fakePaidWriter } from './chain-seed.testkit.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { idleLeases } from './lease.testkit.js';
import { startServer, type RunningServer } from './server.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';

const TOKEN = 'a-launch-token';

const HEALTHY: ConnectorHealth = {
  state: 'ok',
  endpoint: 'https://connector.example',
  selfEndpoint: 'https://connector.example',
  ilpAddresses: ['g.toon.relay'],
  settlements: [
    {
      chain: 'evm:84532',
      kind: 'evm',
      settlementAddress: '0x3f43',
      tokenAddress: '0x49be',
      decimals: 6,
    },
  ],
  routes: [{ prefix: 'g.toon.relay', price: '1' }],
  peerCarriages: [],
  supportedVersions: [1],
};

/**
 * A ready Hidden Providers carriage — kept in `beforeEach`'s deps (rather
 * than left unset) so `/api/health`'s fixture below carries `anon`, and the
 * TUI's Health view has a real `AnonTransportView` to render, not an absent
 * field.
 */
const READY_ANON: AnonTransportView = {
  state: 'ready',
  socksProxy: 'socks5h://127.0.0.1:9050',
  reason: 'A SOCKS5h proxy answered at socks5h://127.0.0.1:9050, so a `.anyone` address can be dialled.',
};

function fakeHiddenTransport(view: AnonTransportView): HiddenTransportPort {
  return {
    configured: () => view.socksProxy,
    open: () => Promise.reject(new Error('not used by these tests')),
    describe: () => Promise.resolve(view),
    close: () => Promise.resolve(),
  };
}

describe('the daemon server', () => {
  let home: string;
  let uiRoot: string;
  let running: RunningServer;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-server-'));
    uiRoot = mkdtempSync(join(tmpdir(), 'toon-console-ui-'));
    writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>TOON Console</title>');
    writeFileSync(join(uiRoot, 'app.js'), 'export default 1;');

    const paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const session = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => [],
    });
    const deps: ApiDeps = {
      profiles: new ProfileStore(activeProfileFilePath(paths)),
      session,
      chainSeed: new ChainSeedStore({
        signer: () => session.signingPort(),
        seedRelays: () => [],
        cache: new InMemoryChainSeedCache(),
        writer: () => fakePaidWriter(undefined),
      }),
      funding: fundingStoreFor({
        chainSeed: new ChainSeedStore({
          signer: () => undefined,
          seedRelays: () => [],
          cache: new InMemoryChainSeedCache(),
          writer: () => fakePaidWriter(undefined),
        }),
        paths,
        chains: fakeChainPort(),
      }),
      ...idleLeases(paths),
      version: { name: '@toon-protocol/console-daemon', version: '0.1.0' },
      paths,
      startedAt: new Date('2026-09-22T00:00:00Z'),
      readHealth: () => Promise.resolve(HEALTHY),
      hidden: fakeHiddenTransport(READY_ANON),
      readDirectory: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not what this file tests' }),
      readTemplates: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not what this file tests' }),
    };
    running = await startServer({ deps, token: TOKEN, uiRoot, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await running.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(uiRoot, { recursive: true, force: true });
  });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${running.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });

  it('binds loopback only', () => {
    expect(running.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('refuses an API call with no token', async () => {
    const response = await fetch(`${running.url}/api/health`);
    expect(response.status).toBe(401);
  });

  it('refuses an API call with the wrong token', async () => {
    const response = await fetch(`${running.url}/api/health`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(response.status).toBe(401);
  });

  it('refuses a token of a different length without throwing', async () => {
    const response = await fetch(`${running.url}/api/health`, {
      headers: { authorization: 'Bearer x' },
    });
    expect(response.status).toBe(401);
  });

  it('refuses a request whose Host is not loopback (DNS rebinding)', async () => {
    // Raw `node:http`, because `fetch` sets `Host` from the URL and quietly
    // drops a caller's — and it is exactly a forged `Host` that is under test.
    const status = await new Promise<number>((done, fail) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: running.port,
          path: '/api/health',
          headers: { host: 'console.attacker.example', authorization: `Bearer ${TOKEN}` },
        },
        (response) => {
          response.resume();
          done(response.statusCode ?? 0);
        }
      );
      request.on('error', fail);
      request.end();
    });
    expect(status).toBe(403);
  });

  it('answers health with the daemon version and the live connector read', async () => {
    const response = await api('/api/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      daemon: { version: string };
      profile: { id: string };
      connector: { state: string; settlements: { chain: string }[] };
      storage: { channels: string };
    };
    expect(body.daemon.version).toBe('0.1.0');
    expect(body.profile.id).toBe('devnet');
    expect(body.connector.state).toBe('ok');
    expect(body.connector.settlements[0]?.chain).toBe('evm:84532');
    expect(body.storage.channels).toContain(join('profiles', 'devnet', 'channels'));

    // The TUI's fixture contract (TOON_Network#139, ADR 0028): the REAL
    // response this assertion just checked, committed so `tui/`'s hand-kept
    // Rust types are checked against it without running this daemon.
    writeApiFixture('health', body);
  });

  it('answers the profile list, and the TUI fixture for it (TOON_Network#141)', async () => {
    const response = await api('/api/profiles');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { activeId: string; profiles: { id: string }[] };
    expect(body.activeId).toBe('devnet');
    expect(body.profiles.map((profile) => profile.id)).toContain('devnet');

    writeApiFixture('profiles', body);
  });

  it('switches the active profile and keeps it switched', async () => {
    const switched = await api('/api/profiles/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sandbox' }),
    });
    expect(switched.status).toBe(200);
    expect(((await switched.json()) as { activeId: string }).activeId).toBe('sandbox');

    const health = (await (await api('/api/health')).json()) as { profile: { id: string } };
    expect(health.profile.id).toBe('sandbox');
  });

  it('refuses to switch to a profile it does not have', async () => {
    const response = await api('/api/profiles/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'moonnet' }),
    });
    expect(response.status).toBe(404);
  });

  it('serves the UI shell without a token, since a navigation carries no header', async () => {
    const response = await fetch(`${running.url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('TOON Console');
  });

  it('answers an unknown path with the shell, so the UI owns its own routes', async () => {
    const response = await fetch(`${running.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('never serves a file from outside the UI root', async () => {
    // Percent-encoded, so the client does not normalize the traversal away
    // before it reaches the daemon — the daemon's own guard is what is tested.
    const response = await fetch(`${running.url}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('TOON Console');
  });
});
