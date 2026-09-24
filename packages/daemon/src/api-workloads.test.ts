import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { AutoExtender, InMemoryAutoExtendStore } from './auto-extend.js';
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
import { continuationFor } from './continuation.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import {
  GOOD_SPAWN,
  giveChannel,
  leaseFixture,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import { fakeProviderPort } from './lease.testkit.js';
import type { VaultedLease } from './lease-vault.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SANDBOX } from './profiles.js';
import type { DashboardView, WorkloadCard } from './workload.js';
import {
  extendOk,
  refusal,
  silence,
  statusOk,
  TERMINATE_OK,
  workloadFixture,
} from './workload.testkit.js';

/**
 * The dashboard routes (TOON_Network#93).
 *
 * Two rules are pinned here, and both are about what a local HTTP surface must
 * never make easy.
 *
 * **No answer carries a Root Secret or a Continuation Token.** The token is
 * derived inside the vault for the length of one packet; it is in no type on
 * this surface and in no error message, on a card, a dashboard, an extension
 * or a termination.
 *
 * **Spending is a POST, and arming a budget takes a confirmation.** A GET
 * never spends, a refresh sends only what a provider prices at zero, and
 * `POST …/auto-extend` without `confirm: true` arms nothing.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';
const PROVIDER = 'd'.repeat(64);

describe('the dashboard routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let leases: LeaseFixture;
  let port: FakeProviderPort;
  let deps: ApiDeps;
  let workloadId: string;

  const call = (
    method: string,
    path: string,
    body?: unknown,
    query = ''
  ): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(query), body });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-workloads-api-'));
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

    port = fakeProviderPort(statusOk());
    const budgetStore = new InMemoryAutoExtendStore();
    const { workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      autoExtend: () => budgets,
    });
    const budgets: AutoExtender = new AutoExtender({
      store: budgetStore,
      workloads,
      pubkey: () => account.pubkey,
      profileId: () => SANDBOX.id,
    });

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
      autoExtend: budgets,
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

  /** The lease's Root Secret, out of the relay's own copy. */
  const secret = async (): Promise<string> => {
    const event = relay.events
      .filter((candidate) =>
        (candidate.tags.find((tag) => tag[0] === 'd')?.[1] ?? '').startsWith(
          'toon-console/lease/'
        )
      )
      .at(-1);
    return (JSON.parse(await account.unsealFromSelf(event!.content)) as VaultedLease)
      .root_secret;
  };

  it('answers one card per lease on GET, having sent nothing', async () => {
    const answer = await call('GET', '/api/workloads');

    expect(answer.status).toBe(200);
    const view = answer.body as DashboardView;
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]?.workloadId).toBe(workloadId);
    expect(port.sent).toHaveLength(0);
  });

  it('asks the providers on `?refresh=1`, and only on the free route', async () => {
    const answer = await call('GET', '/api/workloads', undefined, 'refresh=1');

    expect((answer.body as DashboardView).cards[0]?.status.kind).toBe('read');
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.route).toBe('g.toon.provider.status');

    // The TUI's fixture contract (TOON_Network#139, ADR 0028): the REAL
    // dashboard this assertion just checked, committed so `tui/`'s hand-kept
    // `Dashboard` type is checked against it without running this daemon.
    writeApiFixture('workloads', answer.body);
  });

  it('answers one card, and refuses a workload id this account does not hold', async () => {
    const one = await call('GET', `/api/workloads/${workloadId}`);
    expect(one.status).toBe(200);
    expect((one.body as WorkloadCard).workloadId).toBe(workloadId);

    const missing = await call('GET', `/api/workloads/${'f'.repeat(64)}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: 'unknown_workload' });

    const nonsense = await call('GET', '/api/workloads/not-a-workload-id');
    expect(nonsense.status).toBe(400);
    expect(nonsense.body).toMatchObject({ error: 'invalid_workload_id' });
  });

  it('extends on POST, and says what it cost', async () => {
    port.answer = (packet) =>
      packet.route.endsWith('.extend') ? extendOk(1_790_007_200) : statusOk()(packet);

    const answer = await call('POST', `/api/workloads/${workloadId}/extend`);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ sent: true, cost: '1000', expiresAt: 1_790_007_200 });

    // The TUI's fixture contract (TOON_Network#139, ADR 0028).
    writeApiFixture('workload-extend', answer.body);
  });

  it('answers a refusal as a 200 that says it was refused, with the provider’s code', async () => {
    port.answer = (packet) =>
      packet.route.endsWith('.extend')
        ? refusal('no_capacity', 'nothing free', '1000')
        : statusOk()(packet);

    const answer = await call('POST', `/api/workloads/${workloadId}/extend`);

    // Not a transport failure: the packet went, the provider answered, and it
    // was billed. The route says so rather than throwing a 502 at the window.
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ providerError: 'no_capacity', cost: '1000' });
  });

  it('terminates on POST, and the card reflects the ended lease', async () => {
    port.answer = TERMINATE_OK;

    const answer = await call('POST', `/api/workloads/${workloadId}/terminate`);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ sent: true, ended: 'termination' });
    const card = (answer.body as { card: WorkloadCard }).card;
    expect(card.endedAs).toBe('termination');

    // The TUI's fixture contract (TOON_Network#139, ADR 0028).
    writeApiFixture('workload-terminate', answer.body);
  });

  it('reports Expired on `unknown_workload` once paid, and forgets it on DELETE (TOON_Network#138)', async () => {
    port.answer = refusal('unknown_workload', 'this provider holds no lease with that id');

    const answer = await call('GET', `/api/workloads/${workloadId}`, undefined, 'refresh=1');
    expect(answer.status).toBe(200);
    const card = answer.body as WorkloadCard;
    expect(card.status.kind).toBe('read');
    if (card.status.kind !== 'read') throw new Error('unreachable');
    expect(card.status.life).toEqual({ phase: 'ended', ending: 'expired' });
    expect(card.endedAs).toBe('expired');

    // The TUI's fixture contract (TOON_Network#138, ADR 0028).
    writeApiFixture('workload-expired', answer.body);

    const forgotten = await call('DELETE', `/api/workloads/${workloadId}`);
    expect(forgotten.status).toBe(200);
    expect(forgotten.body).toMatchObject({ workloadId, forgotten: true });
    writeApiFixture('workload-forget', forgotten.body);

    const gone = await call('GET', '/api/workloads');
    expect((gone.body as DashboardView).cards).toHaveLength(0);
  });

  it('refuses DELETE on a workload this console has not seen end', async () => {
    const answer = await call('DELETE', `/api/workloads/${workloadId}`);

    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: 'not_ended' });
    // Untouched: still in the vault and on the dashboard.
    expect(((await call('GET', '/api/workloads')).body as DashboardView).cards).toHaveLength(1);
  });

  it('shows a silent provider as silent rather than failing the request', async () => {
    port.answer = silence();

    const answer = await call('GET', `/api/workloads/${workloadId}`, undefined, 'refresh=1');

    expect(answer.status).toBe(200);
    expect((answer.body as WorkloadCard).status.kind).toBe('silent');
  });

  it('arms a budget only with a confirmation and the price it was shown', async () => {
    const unconfirmed = await call('POST', `/api/workloads/${workloadId}/auto-extend`, {
      budget: '3000',
      agreedPrice: '1000',
    });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body).toMatchObject({ error: 'not_confirmed' });

    const moved = await call('POST', `/api/workloads/${workloadId}/auto-extend`, {
      budget: '3000',
      agreedPrice: '7',
      confirm: true,
    });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ error: 'price_moved' });

    const armed = await call('POST', `/api/workloads/${workloadId}/auto-extend`, {
      budget: '3000',
      agreedPrice: '1000',
      confirm: true,
    });
    expect(armed.status).toBe(200);
    expect((armed.body as WorkloadCard).autoExtend).toMatchObject({
      armed: true,
      budget: '3000',
      spent: '0',
      remaining: '3000',
    });

    // The TUI's fixture contract (TOON_Network#144, ADR 0028): the console's
    // detail pane shows this budget and what remains of it.
    writeApiFixture('workload-auto-extend-armed', armed.body);

    const off = await call('DELETE', `/api/workloads/${workloadId}/auto-extend`);
    expect((off.body as WorkloadCard).autoExtend?.armed).toBe(false);

    // TOON_Network#144: "off" is a state, not an absence — the budget is
    // still shown, remembered, with `armed: false`.
    writeApiFixture('workload-auto-extend-off', off.body);
  });

  it('carries no Root Secret and no Continuation Token, in any answer', async () => {
    port.answer = (packet) =>
      packet.route.endsWith('.extend') ? extendOk(1_790_007_200) : statusOk()(packet);
    const answers = [
      await call('GET', '/api/workloads', undefined, 'refresh=1'),
      await call('GET', `/api/workloads/${workloadId}`, undefined, 'refresh=1'),
      await call('POST', `/api/workloads/${workloadId}/extend`),
      await call('POST', `/api/workloads/${workloadId}/auto-extend`, {
        budget: '3000',
        agreedPrice: '1000',
        confirm: true,
      }),
    ];

    const root = await secret();
    const token = continuationFor(root, PROVIDER);
    for (const answer of answers) {
      const json = JSON.stringify(answer.body);
      expect(json).not.toContain(root);
      expect(json).not.toContain(token);
    }
  });

  it('has no route it does not have', async () => {
    expect((await call('POST', '/api/workloads')).status).toBe(404);
    // `…/rotate` exists now (TOON_Network#96) and has its own tests; what is
    // pinned here is that this build wired the dashboard without it, and says
    // so rather than pretending to have rotated anything.
    expect((await call('POST', `/api/workloads/${workloadId}/rotate`)).status).toBe(501);
    expect((await call('GET', `/api/workloads/${workloadId}/rotate`)).status).toBe(404);
    expect((await call('GET', `/api/workloads/${workloadId}/extend`)).status).toBe(404);
  });
});
