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
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { canonicalLabel } from './gateway-name.js';
import type { GatewayView, HandoverResult, WithdrawalResult } from './gateway.js';
import {
  GATEWAY_CONNECTOR,
  GATEWAY_DOMAIN_SUFFIX,
  SERVING,
  fakeProbe,
  gatewayFixture,
  gatewayProfile,
  gatewayRefusal,
  handoverOk,
  withdrawalOk,
  type FakeProbe,
} from './gateway.testkit.js';
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

/**
 * The gateway routes (TOON_Network#97, spec §12).
 *
 * Two rules are pinned here, and the first is the one a local HTTP surface
 * must never make easy to break.
 *
 * **No answer carries a Gateway Grant.** A grant reads a lease's `status`
 * until the moment it names, so it is a secret exactly as the Continuation
 * Token it derives from is. It is derived inside the vault for the length of
 * one sealed message, and there is no field on this surface it could come back
 * through.
 *
 * **A GET never changes anything, and `?probe=1` reaches only the hostname.**
 * Knocking on the name is an ordinary HTTPS request to a public address; it
 * sends no TOON packet, touches no provider and reads no relay.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';

describe('the gateway routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let leases: LeaseFixture;
  let port: FakeProviderPort;
  let probe: FakeProbe;
  let deps: ApiDeps;
  let workloadId: string;
  let hostname: string;

  const call = (
    method: string,
    path: string,
    body?: unknown,
    query = ''
  ): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(query), body });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-gateway-api-'));
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
    giveChannel(paths, SANDBOX.id, GATEWAY_CONNECTOR);
    await leases.vault.refresh();
    workloadId = (await leases.leases.spawn(GOOD_SPAWN)).lease!.workloadId;
    hostname = `${canonicalLabel(workloadId)}.${GATEWAY_DOMAIN_SUFFIX}`;

    port = fakeProviderPort(handoverOk(hostname));
    probe = fakeProbe();
    const { gateway } = gatewayFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      port,
      probe,
      profile: gatewayProfile({ id: SANDBOX.id }),
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
      gateway,
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

  /* ---------------------------------------------------------------------- */

  it('answers the hostname on GET, having sent nothing and knocked on nothing', async () => {
    const answer = await call('GET', `/api/workloads/${workloadId}/gateway`);

    expect(answer.status).toBe(200);
    const view = answer.body as GatewayView;
    expect(view.hostname).toBe(hostname);
    expect(view.held).toBe(false);
    expect(port.sent).toHaveLength(0);
    expect(probe.knocked).toHaveLength(0);

    // The TUI's fixture contract (TOON_Network#144, ADR 0028): the detail
    // pane's empty state, before anything has been handed over.
    writeApiFixture('workload-gateway', answer.body);
  });

  it('knocks on the hostname for `?probe=1`, and sends no TOON packet to do it', async () => {
    probe.answer = SERVING;
    const answer = await call(
      'GET',
      `/api/workloads/${workloadId}/gateway`,
      undefined,
      'probe=1'
    );

    expect((answer.body as GatewayView).serving?.kind).toBe('serving');
    expect(probe.knocked).toEqual([`https://${hostname}/`]);
    expect(port.sent).toHaveLength(0);
  });

  it('hands over on POST, and answers with the hostname the gateway serves', async () => {
    const answer = await call('POST', `/api/workloads/${workloadId}/gateway/handover`, {
      expiresIn: 3600,
      name: 'blog',
    });

    expect(answer.status).toBe(200);
    const result = answer.body as HandoverResult;
    expect(result.sent).toBe(true);
    expect(result.hostname).toBe(hostname);
    expect(result.matches).toBe(true);
    expect(port.sent).toHaveLength(1);

    // The TUI's fixture contract (TOON_Network#144, ADR 0028): the hostname,
    // shown once served.
    writeApiFixture('workload-gateway-handover', answer.body);
    writeApiFixture('workload-gateway-served', result.view);
  });

  it('carries NO Gateway Grant and no Root Secret in any answer', async () => {
    const root = await secret();
    const handed = await call('POST', `/api/workloads/${workloadId}/gateway/handover`, {
      expiresIn: 3600,
    });
    const grant = (
      port.sent.at(-1)?.body as { handover: { standby_set: { grant: string }[] } }
    ).handover.standby_set[0]!.grant;

    for (const answer of [
      handed,
      await call('GET', `/api/workloads/${workloadId}/gateway`),
      await call('POST', `/api/workloads/${workloadId}/gateway/withdraw`),
    ]) {
      const serialized = JSON.stringify(answer.body);
      expect(serialized).not.toContain(grant);
      expect(serialized).not.toContain(root);
    }
  });

  it('withdraws on POST and says it ended serving rather than reading', async () => {
    await call('POST', `/api/workloads/${workloadId}/gateway/handover`, { expiresIn: 3600 });
    port.answer = withdrawalOk(hostname);
    const answer = await call('POST', `/api/workloads/${workloadId}/gateway/withdraw`);

    const result = answer.body as WithdrawalResult;
    expect(result.withdrawn).toBe(true);
    expect(result.message).toContain('ends serving, not reading');
    expect(result.view.held).toBe(false);

    // The TUI's fixture contract (TOON_Network#144, ADR 0028): withdraw ends
    // serving, and the detail pane must not call that "revoked".
    writeApiFixture('workload-gateway-withdraw', answer.body);
  });

  it('passes a gateway’s own refusal through with its code', async () => {
    port.answer = gatewayRefusal('not_admitted');
    const answer = await call('POST', `/api/workloads/${workloadId}/gateway/handover`, {
      expiresIn: 3600,
    });

    // A refusal from the gateway is an OUTCOME, not an HTTP failure: the
    // packet went, the message was read, and the answer says what happened.
    expect(answer.status).toBe(200);
    expect((answer.body as HandoverResult).gatewayError).toBe('not_admitted');
  });

  it('refuses a workload this account holds no lease for, with 404', async () => {
    const answer = await call('GET', `/api/workloads/${'f'.repeat(64)}/gateway`);

    expect(answer.status).toBe(404);
    expect((answer.body as { error: string }).error).toBe('unknown_workload');
  });

  it('answers 404 for a verb it does not serve, and never for a GET that spends', async () => {
    expect((await call('POST', `/api/workloads/${workloadId}/gateway/rotate`)).status).toBe(
      404
    );
    expect((await call('GET', `/api/workloads/${workloadId}/gateway/handover`)).status).toBe(
      404
    );
    expect(port.sent).toHaveLength(0);
  });

  it('says so rather than pretending, in a build with no gateway wired', async () => {
    deps = { ...deps, gateway: undefined };
    const answer = await call('GET', `/api/workloads/${workloadId}/gateway`);

    expect(answer.status).toBe(501);
    expect((answer.body as { error: string }).error).toBe('gateway_unwired');
  });
});
