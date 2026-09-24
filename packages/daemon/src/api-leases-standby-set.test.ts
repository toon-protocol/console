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
  fakeProvider,
  fakeProviderPort,
  giveChannel,
  leaseFixture,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import type { LeaseVaultStatus } from './lease-vault.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX } from './profiles.js';

/**
 * A Standby Set's own pair of routes (spec §7, TOON_Network#95):
 * `POST /api/leases/standby-set/preflight` and `POST /api/leases/standby-set`.
 *
 * Mirrors `api-leases.test.ts`'s own setup, with one difference the routes
 * themselves need: a Provider Directory of TWO providers, since a set names a
 * primary and at least one Warm Standby and `checkStandbySet` refuses a
 * `standby_set` that repeats a provider. The standby's own Listing prices a
 * `standbyPrice` — the primary's does not need to — because §4.2 says a
 * `.standby` route only exists for a tier that published one.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';
const PRIMARY = 'd'.repeat(64);
const STANDBY = 'e'.repeat(64);

describe('a Standby Set’s routes', () => {
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
    home = mkdtempSync(join(tmpdir(), 'toon-console-standby-set-api-'));
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
      directory: () =>
        Promise.resolve({
          state: 'ok',
          relays: { seed: [], read: [] },
          filters: {},
          providers: [
            fakeProvider({ pubkey: PRIMARY }),
            fakeProvider({
              pubkey: STANDBY,
              ilpAddress: 'g.toon.provider2',
              listing: { standbyPrice: 400 },
            }),
          ],
          listingsWithoutProfile: 0,
          rejectedEvents: 0,
          readAt: '2026-09-22T00:00:00.000Z',
        }),
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

  it('prices the primary and every Warm Standby, spending nothing', async () => {
    const answer = await call('POST', '/api/leases/standby-set/preflight', {
      ...GOOD_SPAWN,
      standbys: [{ provider: STANDBY, listing: 'basic' }],
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true });
    const body = answer.body as { members: { role: string }[] };
    expect(body.members.map((member) => member.role)).toEqual(['primary', 'standby']);
    expect(port.sent).toHaveLength(0);
    // TOON_Network#146's New workload view checks its Rust
    // `StandbySetPreflightView` against this real answer.
    writeApiFixture('leases-standby-set-preflight', answer.body);
  });

  it('spawns the primary and every Warm Standby under one workload id', async () => {
    const answer = await call('POST', '/api/leases/standby-set', {
      ...GOOD_SPAWN,
      standbys: [{ provider: STANDBY, listing: 'basic' }],
    });

    expect(answer.status).toBe(200);
    const body = answer.body as { members: { role: string; sent: boolean }[] };
    expect(body.members).toHaveLength(2);
    expect(body.members.every((member) => member.sent)).toBe(true);
    // TOON_Network#146's New workload view checks its Rust `StandbySetResult`
    // against this real answer.
    writeApiFixture('leases-standby-set-spawn', answer.body);

    const listed = (await call('GET', '/api/leases')).body as LeaseVaultStatus;
    expect(listed.leases).toHaveLength(1);
  });

  it('refuses a standby_set naming the same provider twice', async () => {
    const answer = await call('POST', '/api/leases/standby-set', {
      ...GOOD_SPAWN,
      standbys: [{ provider: PRIMARY, listing: 'basic' }],
    });
    expect(answer.status).toBe(400);
    expect(port.sent).toHaveLength(0);
  });

  it('answers 400 for a body with no standbys', async () => {
    const answer = await call('POST', '/api/leases/standby-set/preflight', GOOD_SPAWN);
    expect(answer.status).toBe(400);
  });
});
