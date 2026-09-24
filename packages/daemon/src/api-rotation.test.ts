import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakeAccount,
  fakePaidWriter,
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import type { ConnectorHealth } from './connector-health.js';
import { continuationFor } from './continuation.js';
import type { DirectoryResult } from './directory.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import {
  GOOD_SPAWN,
  connectorHealth,
  fakeProvider,
  fakeProviderPort,
  giveChannel,
  leaseFixture,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import type { LeasePacket, PacketOutcome } from './lease.js';
import type { VaultedLease } from './lease-vault.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import type { RotationResult, RotationView } from './rotation.js';
import { rotatedOk, rotationFixture } from './rotation.testkit.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';
import { providerRoutes, silence, workloadFixture } from './workload.testkit.js';

/**
 * The rotation routes (TOON_Network#96, spec §6.8).
 *
 * Three rules are pinned here.
 *
 * **No answer carries a Root Secret or a token.** A rotation has TWO root
 * secrets in flight — the one the lease holds and the one it is moving to —
 * and neither, nor any token derived from either, has a field on this surface
 * to come back through.
 *
 * **A GET changes nothing and sends no lease packet.** `GET …/rotation` says
 * how far a rotation has got; it asks connectors what they carry, which is
 * free, and that is all.
 *
 * **Rotating is a POST, and only a POST.** It is a revocation: it ends every
 * Gateway Grant this lease has handed out. Nothing that reads should be able
 * to cause one.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER = 'd'.repeat(64);
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';

describe('the rotation routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let leases: LeaseFixture;
  let port: FakeProviderPort;
  let deps: ApiDeps;
  let workloadId: string;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(''), body });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-rotation-api-'));
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

    leases = leaseFixture({
      account,
      chainSeed: seed,
      paths,
      dial: fakeRelayNetwork([relay]),
      relays: [RELAY],
      relayServer: relay,
      provider: fakeProviderPort(),
    });
    giveChannel(paths, SANDBOX.id, PROVIDER_CONNECTOR);
    await leases.vault.refresh();
    workloadId = (await leases.leases.spawn(GOOD_SPAWN)).lease!.workloadId;

    port = fakeProviderPort(rotatedOk);
    const { workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      notes: new InMemoryWorkloadNoteStore(),
    });
    const rotation = rotationFixture({ vault: leases.vault, ops: workloads.memberOps() });

    const profiles = new ProfileStore(activeProfileFilePath(paths));
    profiles.setActive(SANDBOX.id);
    deps = {
      profiles,
      session: undefined as never,
      chainSeed: seed,
      funding: fundingStoreFor({ chainSeed: seed, paths, chains: fakeChainPort() }),
      vault: leases.vault,
      leases: leases.leases,
      workloads,
      rotation,
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

  /** The record the relay holds, unsealed: where both root secrets are. */
  const vaulted = async (): Promise<VaultedLease> => {
    const event = relay.events
      .filter((candidate) =>
        (candidate.tags.find((tag) => tag[0] === 'd')?.[1] ?? '').startsWith(
          'toon-console/lease/'
        )
      )
      .at(-1);
    return JSON.parse(await account.unsealFromSelf(event!.content)) as VaultedLease;
  };

  /* ---------------------------------------------------------------------- */

  it('says how far a rotation has got on GET, having sent no lease packet', async () => {
    const answer = await call('GET', `/api/workloads/${workloadId}/rotation`);

    expect(answer.status).toBe(200);
    const view = answer.body as RotationView;
    expect(view.workloadId).toBe(workloadId);
    expect(view.underWay).toBe(false);
    expect(view.of).toBe(1);
    expect(view.confirmed).toBe(0);
    expect(port.sent).toHaveLength(0);

    // The TUI's fixture contract (TOON_Network#144, ADR 0028): the "not
    // rotated yet" state the detail pane shows before anything has rotated.
    writeApiFixture('workload-rotation', answer.body);
  });

  it('rotates on POST and answers what each member did', async () => {
    const answer = await call('POST', `/api/workloads/${workloadId}/rotate`);

    expect(answer.status).toBe(200);
    const result = answer.body as RotationResult;
    expect(result.started).toBe(true);
    expect(result.rotated).toBe(true);
    expect(result.members.map((member) => member.rotated)).toEqual([true]);
    expect(port.sent.map((packet) => packet.route)).toEqual(['g.toon.provider.rotate']);

    // The TUI's fixture contract (TOON_Network#144, ADR 0028).
    writeApiFixture('workload-rotate', answer.body);
  });

  it('never carries a Root Secret or a Continuation Token in an answer', async () => {
    const before = (await vaulted()).root_secret;
    const answers = [
      await call('GET', `/api/workloads/${workloadId}/rotation`),
      await call('POST', `/api/workloads/${workloadId}/rotate`),
      await call('GET', `/api/workloads/${workloadId}/rotation`),
      await call('GET', `/api/leases`),
      await call('GET', `/api/workloads`),
    ];
    const after = (await vaulted()).root_secret;

    expect(after).not.toBe(before);
    for (const answer of answers) {
      const said = JSON.stringify(answer.body);
      for (const root of [before, after]) {
        expect(said).not.toContain(root);
        expect(said).not.toContain(continuationFor(root, PROVIDER));
      }
    }
  });

  it('answers 404 for a workload this account holds no record of', async () => {
    const answer = await call('POST', `/api/workloads/${'f'.repeat(64)}/rotate`);

    expect(answer.status).toBe(404);
    expect((answer.body as { error: string }).error).toBe('unknown_lease');
  });

  it('has no route it does not have', async () => {
    expect((await call('GET', `/api/workloads/${workloadId}/rotate`)).status).toBe(404);
    expect((await call('POST', `/api/workloads/${workloadId}/rotation`)).status).toBe(404);
    expect(port.sent).toHaveLength(0);
  });

  it('says so rather than pretending when rotation is not wired', async () => {
    deps = { ...deps, rotation: undefined };
    const answer = await call('POST', `/api/workloads/${workloadId}/rotate`);

    expect(answer.status).toBe(501);
    expect((answer.body as { error: string }).error).toBe('rotation_unwired');
    expect(port.sent).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* A Standby Set, through the HTTP routes (TOON_Network#144).                 */
/*                                                                            */
/* §6.8 and ADR 0018 say a member the tenant cannot reach does not block the  */
/* rest, and a set rotated at some members and not others is a valid state —  */
/* not an error. The console's Workloads detail pane (TOON_Network#144) has  */
/* to show that state correctly, so this is the fixture that proves it: a    */
/* rotate that reaches the primary and finds the standby silent, read back   */
/* through `GET …/rotation` as `underWay: true` with `confirmed: 1, of: 2`.  */
/* -------------------------------------------------------------------------- */

const SET_STANDBY = 'e'.repeat(64);
const SET_STANDBY_CONNECTOR = 'https://provider2.example/ilp';

describe('rotating a Standby Set through the HTTP routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let leases: LeaseFixture;
  let port: FakeProviderPort;
  let deps: ApiDeps;
  let workloadId: string;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(''), body });

  /** Two providers selling `warm`, mirroring `rotation.test.ts`'s own two. */
  const twoProviders = (): (() => Promise<DirectoryResult>) => {
    const warm = { name: 'warm', version: 1, leaseIntervalSeconds: 600, price: 1000 };
    return () =>
      Promise.resolve({
        state: 'ok',
        relays: { seed: [], read: [] },
        filters: {},
        providers: [
          fakeProvider({
            pubkey: PROVIDER,
            ilpAddress: 'g.toon.provider',
            connectorUrl: PROVIDER_CONNECTOR,
            listing: { ...warm, standbyPrice: 400, address: `30432:${PROVIDER}:warm` },
          }),
          fakeProvider({
            pubkey: SET_STANDBY,
            ilpAddress: 'g.toon.provider2',
            connectorUrl: SET_STANDBY_CONNECTOR,
            listing: { ...warm, standbyPrice: 400, address: `30432:${SET_STANDBY}:warm` },
          }),
        ],
        listingsWithoutProfile: 0,
        rejectedEvents: 0,
        readAt: '2026-09-23T00:00:00.000Z',
      } as DirectoryResult);
  };

  const twoConnectors = (asked: NetworkProfile): Promise<ConnectorHealth> => {
    const routes = asked.connectorUrl.includes('provider2.example')
      ? providerRoutes({ ilpAddress: 'g.toon.provider2', listing: 'warm', standbyPrice: '400' })
      : asked.connectorUrl.includes('provider.example')
        ? providerRoutes({ ilpAddress: 'g.toon.provider', listing: 'warm', standbyPrice: '400' })
        : [];
    return Promise.resolve(connectorHealth({ endpoint: asked.connectorUrl, routes }));
  };

  /** The §6.2 answer each member gives its own spawn. */
  const setSpawnOk = (packet: LeasePacket): PacketOutcome => {
    const body = packet.body as { request: { op: string; content: { workload_id: string } } };
    const standby = body.request.op === 'standby';
    const answer = {
      workload_id: body.request.content.workload_id,
      role: standby ? 'standby' : 'primary',
      expires_at: 1_790_003_600,
      ...(standby ? {} : { access: { host: '203.0.113.7', ssh_port: 40000 } }),
    };
    return {
      kind: 'answered',
      status: 200,
      body: answer,
      text: JSON.stringify(answer),
      cost: standby ? '400' : '1000',
      channelId: '0xchannel',
    };
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-rotation-set-api-'));
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

    const spawnPort = fakeProviderPort(setSpawnOk);
    leases = leaseFixture({
      account,
      chainSeed: seed,
      paths,
      dial: fakeRelayNetwork([relay]),
      relays: [RELAY],
      relayServer: relay,
      provider: spawnPort,
      directory: twoProviders(),
      health: twoConnectors,
    });
    giveChannel(paths, SANDBOX.id, PROVIDER_CONNECTOR);
    giveChannel(paths, SANDBOX.id, SET_STANDBY_CONNECTOR, 'evm:31337', '0xchannel2');
    await leases.vault.refresh();
    const spawned = await leases.leases.spawnSet({
      ...GOOD_SPAWN,
      listing: 'warm',
      standbys: [{ provider: SET_STANDBY, listing: 'warm' }],
    });
    workloadId = spawned.lease!.workloadId;

    port = fakeProviderPort(rotatedOk);
    const { workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      notes: new InMemoryWorkloadNoteStore(),
      directory: twoProviders(),
      health: twoConnectors,
    });
    const rotation = rotationFixture({ vault: leases.vault, ops: workloads.memberOps() });

    const profiles = new ProfileStore(activeProfileFilePath(paths));
    profiles.setActive(SANDBOX.id);
    deps = {
      profiles,
      session: undefined as never,
      chainSeed: seed,
      funding: fundingStoreFor({ chainSeed: seed, paths, chains: fakeChainPort() }),
      vault: leases.vault,
      leases: leases.leases,
      workloads,
      rotation,
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

  it('leaves a member unreached rather than blocking the rest, and says so on GET', async () => {
    port.answer = (packet) =>
      packet.route.startsWith('g.toon.provider2') ? silence() : rotatedOk(packet);

    const rotated = await call('POST', `/api/workloads/${workloadId}/rotate`);
    expect(rotated.status).toBe(200);
    const result = rotated.body as RotationResult;
    expect(result.started).toBe(true);
    expect(result.rotated).toBe(false);
    expect(result.confirmed).toBe(1);
    expect(result.of).toBe(2);

    // The TUI's fixture contract (TOON_Network#144, ADR 0028): a partially
    // rotated Standby Set is a state the detail pane must show correctly.
    writeApiFixture('workload-rotate-partial', rotated.body);

    const read = await call('GET', `/api/workloads/${workloadId}/rotation`);
    expect(read.status).toBe(200);
    const view = read.body as RotationView;
    expect(view.underWay).toBe(true);
    expect(view.confirmed).toBe(1);
    expect(view.of).toBe(2);
    writeApiFixture('workload-rotation-partial', read.body);

    // Finishing it asks only the member that has not confirmed, and never
    // starts a second rotation (ADR 0018).
    port.answer = rotatedOk;
    const finished = await call('POST', `/api/workloads/${workloadId}/rotate`);
    expect((finished.body as RotationResult).rotated).toBe(true);
    expect((finished.body as RotationResult).confirmed).toBe(2);
    writeApiFixture('workload-rotate-finished', finished.body);
  });
});
