import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
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
import { continuationFor } from './continuation.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import {
  GOOD_SPAWN,
  fakeProviderPort,
  giveChannel,
  leaseFixture,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import type { VaultedLease } from './lease-vault.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX } from './profiles.js';
import type { RotationResult, RotationView } from './rotation.js';
import { rotatedOk, rotationFixture } from './rotation.testkit.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';
import { workloadFixture } from './workload.testkit.js';

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
  });

  it('rotates on POST and answers what each member did', async () => {
    const answer = await call('POST', `/api/workloads/${workloadId}/rotate`);

    expect(answer.status).toBe(200);
    const result = answer.body as RotationResult;
    expect(result.started).toBe(true);
    expect(result.rotated).toBe(true);
    expect(result.members.map((member) => member.rotated)).toEqual([true]);
    expect(port.sent.map((packet) => packet.route)).toEqual(['g.toon.provider.rotate']);
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
