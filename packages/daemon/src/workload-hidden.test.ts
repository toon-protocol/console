import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import type { DirectoryResult } from './directory.js';
import type { HiddenTransportPort } from './hidden-transport.js';
import {
  GOOD_SPAWN,
  connectorHealth,
  fakeAnon,
  fakeProvider,
  fakeProviderPort,
  giveChannel,
  leaseFixture,
  spawnOk,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import type { LeasePacket, PacketOutcome, SpawnRequest } from './lease.js';
import { InMemoryLeaseVaultCache } from './lease-vault-cache.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';
import {
  TERMINATE_OK,
  extendOk,
  providerRoutes,
  statusOk,
  workloadFixture,
} from './workload.testkit.js';
import { hiddenContradiction, type WorkloadStore } from './workload.js';

/**
 * Living with a lease on a Hidden Provider (TOON_Network#98, spec §10, ADR
 * 0008).
 *
 * A spawn is the easy half. The lease that follows it outlives the page a
 * person spawned from: it is statused on a timer, extended by a budget with
 * nobody watching, and terminated weeks later. Every one of those is a packet
 * at the same `.anyone` connector, and the rule does not soften with distance —
 * each goes over a circuit or it does not go.
 *
 * The case this file exists for is the LAST one. A console that refused a
 * spawn correctly and then, six hours later, let an automatic extension find
 * some other way to the provider would have leaked exactly as completely, and
 * with nobody present to see it.
 */

const RELAY = 'wss://relay.example';
const HIDDEN_CONNECTOR = `http://${'a'.repeat(56)}.anyone/ilp`;
const LEASE_HOST = `${'b'.repeat(56)}.anyone`;

describe('a lease on a Hidden Provider', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let leases: LeaseFixture;
  let workloads: WorkloadStore;
  let port: FakeProviderPort;
  let workloadId: string;

  /** A directory in which the one provider is hidden and has no host at all. */
  const directory = () => () =>
    Promise.resolve({
      state: 'ok',
      relays: { seed: [], read: [] },
      filters: {},
      providers: [fakeProvider({ hidden: true, connectorUrl: HIDDEN_CONNECTOR })],
      listingsWithoutProfile: 0,
      rejectedEvents: 0,
      readAt: '2026-09-22T00:00:00.000Z',
    } as DirectoryResult);

  /**
   * The provider's own connector and nothing else, which is a Hidden
   * Provider's whole story: there is no hub in this path, so the sandbox
   * profile's connector carries none of its routes.
   */
  const health = (asked: NetworkProfile) =>
    Promise.resolve(
      connectorHealth({
        endpoint: asked.connectorUrl,
        routes: asked.connectorUrl === HIDDEN_CONNECTOR ? providerRoutes({}) : [],
      })
    );

  /** §10: a lease's access names a per-lease `.anyone` host in place of an IP. */
  const hiddenSpawn = (packet: LeasePacket): PacketOutcome => {
    const ok = spawnOk(packet) as Extract<PacketOutcome, { kind: 'answered' }>;
    const body = {
      ...(ok.body as Record<string, unknown>),
      access: { host: LEASE_HOST, ssh_port: 40000, ports: [] },
    };
    return { ...ok, body, text: JSON.stringify(body) };
  };

  const dashboardFor = (hidden: HiddenTransportPort | undefined) => {
    port = fakeProviderPort(statusOk({ access: { host: LEASE_HOST, ssh_port: 40000 } }));
    ({ workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      notes: new InMemoryWorkloadNoteStore(),
      health,
      directory: directory(),
      ...(hidden === undefined ? {} : { hidden }),
    }));
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-hidden-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    relay = fakeRelayServer(RELAY);
    account = fakeAccount();
    await publishRelayListEvent(account, [relay], [RELAY]);
    seed = new ChainSeedStore({
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
      cache: new InMemoryLeaseVaultCache(),
      directory: directory(),
      health,
      hidden: fakeAnon(),
      provider: fakeProviderPort(hiddenSpawn),
    });
    giveChannel(paths, SANDBOX.id, HIDDEN_CONNECTOR);
    await leases.vault.refresh();
    const spawned = await leases.leases.spawn(GOOD_SPAWN as SpawnRequest);
    workloadId = spawned.lease!.workloadId;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('statuses, extends and terminates over the circuit', async () => {
    const anon = fakeAnon();
    dashboardFor(anon);
    // By ROUTE, because an extension is preceded by a free `status`: §6.3
    // bills for the `expired` that an ended lease would answer, so the console
    // reads before it spends.
    const running = statusOk({ access: { host: LEASE_HOST, ssh_port: 40000 } });
    port.answer = (packet) =>
      packet.route.endsWith('.extend')
        ? extendOk(1_790_007_200)
        : packet.route.endsWith('.terminate')
          ? TERMINATE_OK
          : running(packet);

    const status = await workloads.readStatus(workloadId);
    const extended = await workloads.extend(workloadId);
    const ended = await workloads.terminate(workloadId);

    expect(status.kind).toBe('read');
    expect(extended.problems).toEqual([]);
    expect(extended.sent).toBe(true);
    expect(ended.sent).toBe(true);
    expect(extended.route?.overAnon).toBe(true);
    expect(ended.route?.overAnon).toBe(true);
    // Every packet, not most of them.
    expect(port.sent.length).toBeGreaterThanOrEqual(3);
    for (const packet of port.sent) {
      expect(packet.payAt).toBe(HIDDEN_CONNECTOR);
      expect(packet.socksProxy).toBe('socks5h://127.0.0.1:19050');
    }
    expect(anon.opens).toBeGreaterThanOrEqual(3);
  });

  it('refuses every op when the circuit will not build, and pays for none', async () => {
    dashboardFor(fakeAnon({ fails: 'nothing is listening on socks5h://127.0.0.1:19050' }));

    const status = await workloads.readStatus(workloadId);
    const extended = await workloads.extend(workloadId);
    const ended = await workloads.terminate(workloadId);

    expect(status.kind).toBe('unread');
    expect(extended.sent).toBe(false);
    expect(ended.sent).toBe(false);
    expect(port.sent).toHaveLength(0);
    for (const said of [
      status.kind === 'unread' ? status.reason : '',
      extended.problems.join(' '),
      ended.problems.join(' '),
    ]) {
      expect(said).toMatch(/nothing is listening/u);
    }
  });

  it('never learns a host for the provider, whatever its Profile carried', async () => {
    // A Profile that leaked one anyway: §4.1 forbids it and nothing enforces
    // it, so this is the case the console has to survive without repeating.
    const leaky = () => () =>
      Promise.resolve({
        state: 'ok',
        relays: { seed: [], read: [] },
        filters: {},
        providers: [
          fakeProvider({
            hidden: true,
            connectorUrl: HIDDEN_CONNECTOR,
            host: '198.51.100.9',
          }),
        ],
        listingsWithoutProfile: 0,
        rejectedEvents: 0,
        readAt: '2026-09-22T00:00:00.000Z',
      } as DirectoryResult);

    port = fakeProviderPort(statusOk({ access: { host: LEASE_HOST, ssh_port: 40000 } }));
    ({ workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      notes: new InMemoryWorkloadNoteStore(),
      health,
      directory: leaky(),
      hidden: fakeAnon(),
    }));

    const card = await workloads.card(workloadId, { refresh: true });

    expect(card.provider.hidden).toBe(true);
    expect(JSON.stringify(card)).not.toContain('198.51.100.9');
    // Nor did a packet go there.
    for (const packet of port.sent) expect(packet.payAt).toBe(HIDDEN_CONNECTOR);
  });
});

/**
 * Two of ADR 0008's five conditions are visible from a tenant's side, and a
 * tenant is entitled to be told when one of them does not hold. The other
 * three — workload egress, the settlement RPC, and whether the provider also
 * answers somewhere else — are not, and nothing here pretends otherwise.
 */
describe('what contradicts a `hidden` declaration', () => {
  const ANYONE = `${'b'.repeat(56)}.anyone`;

  it('says nothing about a provider that never claimed to be hidden', () => {
    expect(
      hiddenContradiction(false, 'https://provider.example/ilp', { host: '203.0.113.7' })
    ).toBeUndefined();
  });

  it('accepts a `.anyone` connector and a `.anyone` lease', () => {
    expect(
      hiddenContradiction(true, HIDDEN_CONNECTOR, { host: ANYONE, ssh_port: 40000 })
    ).toBeUndefined();
  });

  it('names a clearnet connector on a provider that calls itself hidden', () => {
    expect(hiddenContradiction(true, 'https://provider.example/ilp', undefined)).toMatch(
      /clearnet address/u
    );
  });

  it('names a lease that answers at an IP rather than a per-lease address', () => {
    expect(
      hiddenContradiction(true, HIDDEN_CONNECTOR, { host: '203.0.113.7', ssh_port: 40000 })
    ).toMatch(/rather than a per-lease/u);
  });

  it('says nothing about a lease with no access yet: a standby has none', () => {
    expect(hiddenContradiction(true, HIDDEN_CONNECTOR, undefined)).toBeUndefined();
  });
});
