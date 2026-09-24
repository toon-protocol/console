import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakePaidWriter,
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import {
  GOOD_SPAWN,
  giveChannel,
  leaseFixture,
  spawnRefused,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import { fakeProviderPort } from './lease.testkit.js';
import type { LeaseVaultStatus } from './lease-vault.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX } from './profiles.js';

/**
 * The lease routes (TOON_Network#92).
 *
 * The rule this file exists to pin: **no answer on this surface carries a
 * Root Secret.** It goes in nowhere — nothing posts one — and it comes out
 * nowhere, on a spawn that worked, a spawn that was refused, or a read of the
 * whole vault. The secret is minted in the daemon, sealed to the account, and
 * never spoken about again.
 *
 * The second rule: **a preflight is free and a spawn is not**, so the two are
 * different routes and the preflight is the one a window may call whenever it
 * likes.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';

describe('the lease routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let port: FakeProviderPort;
  let fixture: LeaseFixture;
  let deps: ApiDeps;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-leases-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    relay = fakeRelayServer(RELAY);
    account = fakeAccount();
    await publishRelayListEvent(account, [relay], [RELAY]);

    const seed = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(relay),
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });
    seed.acknowledgeWarning();
    await seed.mint();

    port = fakeProviderPort();
    fixture = leaseFixture({
      account,
      chainSeed: seed,
      paths,
      dial: fakeRelayNetwork([relay]),
      relays: [RELAY],
      relayServer: relay,
      provider: port,
    });
    giveChannel(paths, SANDBOX.id, PROVIDER_CONNECTOR);
    await fixture.vault.refresh();

    const profiles = new ProfileStore(activeProfileFilePath(paths));
    profiles.setActive(SANDBOX.id);
    deps = {
      profiles,
      session: undefined as never,
      chainSeed: seed,
      funding: fundingStoreFor({ chainSeed: seed, paths, chains: fakeChainPort() }),
      vault: fixture.vault,
      leases: fixture.leases,
      version: { name: '@toon-protocol/console-daemon', version: '0.1.0' },
      paths,
      startedAt: new Date('2026-09-23T00:00:00Z'),
      readHealth: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readDirectory: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readTemplates: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('answers the whole vault on GET', async () => {
    const answer = await call('GET', '/api/leases');
    expect(answer.status).toBe(200);
    expect((answer.body as LeaseVaultStatus).writes).toMatchObject({
      relays: [RELAY],
      destination: 'g.toon.relay',
      price: '1',
      ready: true,
    });
  });

  it('spawns, and lists the workload afterwards', async () => {
    const spawned = await call('POST', '/api/leases/spawn', GOOD_SPAWN);
    expect(spawned.status).toBe(200);
    // TOON_Network#146's New workload view spawns through this exact route;
    // its preflight confirmation and post-spawn "select the new workload"
    // hook are checked against this real answer's shape.
    writeApiFixture('leases-spawn', spawned.body);

    const listed = (await call('GET', '/api/leases')).body as LeaseVaultStatus;
    expect(listed.leases).toHaveLength(1);
    expect(listed.leases[0]?.access?.host).toBe('203.0.113.7');
  });

  it('carries no Root Secret, in any answer, ever', async () => {
    const answers = [
      await call('POST', '/api/leases/preflight', GOOD_SPAWN),
      await call('POST', '/api/leases/spawn', GOOD_SPAWN),
      await call('GET', '/api/leases'),
      await call('POST', '/api/leases/refresh'),
    ];
    for (const answer of answers) {
      const serialized = JSON.stringify(answer.body);
      expect(serialized.toLowerCase()).not.toContain('root_secret');
      expect(serialized.toLowerCase()).not.toContain('rootsecret');
      expect(serialized).not.toContain('"secret"');
    }
  });

  it('answers a preflight without sending anything', async () => {
    const answer = await call('POST', '/api/leases/preflight', GOOD_SPAWN);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, route: 'g.toon.provider.basic.v1.spawn' });
    expect(port.sent).toHaveLength(0);
    // TOON_Network#146's Preflight stage checks its Rust type against this
    // real answer.
    writeApiFixture('leases-preflight', answer.body);
  });

  it('surfaces the provider’s OWN code when a spawn is refused', async () => {
    port.answer = spawnRefused('no_capacity', 'nothing free here');
    const answer = await call('POST', '/api/leases/spawn', GOOD_SPAWN);

    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({
      error: 'spawn_refused',
      providerError: 'no_capacity',
    });
    expect((answer.body as { message: string }).message).toContain('nothing free here');
    // And nothing is left in the vault pointing at a lease that never was.
    expect(((await call('GET', '/api/leases')).body as LeaseVaultStatus).leases).toHaveLength(
      0
    );
  });

  it('refuses a body that names no provider or listing', async () => {
    const answer = await call('POST', '/api/leases/spawn', { image: GOOD_SPAWN.image });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'invalid_request' });
    expect(port.sent).toHaveLength(0);
  });

  it('refuses a body whose image has no digest', async () => {
    const answer = await call('POST', '/api/leases/spawn', {
      ...GOOD_SPAWN,
      image: { reference: 'traefik/whoami' },
    });
    expect(answer.status).toBe(400);
    expect(port.sent).toHaveLength(0);
  });

  it('answers 404 for a route under /api/leases it does not serve', async () => {
    expect((await call('GET', '/api/leases/nope')).status).toBe(404);
    expect((await call('DELETE', '/api/leases')).status).toBe(404);
  });
});
