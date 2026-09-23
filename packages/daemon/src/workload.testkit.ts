import type { ChainSeedStore } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import type { DirectoryResult } from './directory.js';
import type { HiddenTransportPort } from './hidden-transport.js';
import { connectorHealth, fakeProvider, fakeProviderPort } from './lease.testkit.js';
import type { FakeProviderPort } from './lease.testkit.js';
import type { LeaseVault } from './lease-vault.js';
import type { LeasePacket, PacketOutcome } from './lease.js';
import type { ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import type { TakeoverReading } from './takeover.js';
import { InMemoryWorkloadNoteStore, type WorkloadNoteStore } from './workload-cache.js';
import { WorkloadStore, type AutoExtendReader } from './workload.js';

/**
 * The dashboard over fakes (TOON_Network#93).
 *
 * Every case this ticket turns on is a provider behaving in a way no live one
 * can be asked to behave on demand — answering `{ "ended": "eviction" }`,
 * refusing `not_tenant`, going silent halfway through a status — and each of
 * those decides something different about what a person is shown and whether
 * money leaves a channel. So the port is faked here, exactly as #92 faked it,
 * and `lease-route.ts` stays the thin layer that is not.
 */

/** The provider's §6.5 answer to a `status` on a lease that is running. */
export function statusOk(
  overrides: {
    state?: unknown;
    role?: string;
    expiresAt?: number;
    access?: unknown;
    takeover?: { winner: string };
    template?: string;
  } = {}
): (packet: LeasePacket) => PacketOutcome {
  return (packet) => {
    const body = packet.body as { request?: { content?: { workload_id?: string } } };
    const answer = {
      workload_id: body.request?.content?.workload_id ?? 'unknown',
      role: overrides.role ?? 'standalone',
      state: overrides.state ?? 'running',
      expires_at: overrides.expiresAt ?? 1_790_003_600,
      ...(overrides.access === undefined
        ? { access: { host: '203.0.113.7', ssh_port: 40000 } }
        : { access: overrides.access }),
      ...(overrides.takeover === undefined ? {} : { takeover: overrides.takeover }),
      ...(overrides.template === undefined ? {} : { template: overrides.template }),
    };
    return {
      kind: 'answered',
      status: 200,
      body: answer,
      text: JSON.stringify(answer),
    };
  };
}

/** §6.3's answer to an extension that worked. */
export function extendOk(expiresAt: number, cost = '1000'): PacketOutcome {
  const answer = { workload_id: 'echoed', expires_at: expiresAt };
  return {
    kind: 'answered',
    status: 200,
    body: answer,
    text: JSON.stringify(answer),
    cost,
    channelId: '0xchannel',
  };
}

/** §6.6's answer to a termination that worked. */
export const TERMINATE_OK: PacketOutcome = {
  kind: 'answered',
  status: 200,
  body: { workload_id: 'echoed', state: { ended: 'termination' } },
  text: '{"workload_id":"echoed","state":{"ended":"termination"}}',
};

/** A refusal the provider answered with. On a paid route it is still billed. */
export function refusal(error: string, message = 'no', cost?: string): PacketOutcome {
  const body = { error, message };
  return {
    kind: 'answered',
    status: 409,
    body,
    text: JSON.stringify(body),
    ...(cost === undefined ? {} : { cost, channelId: '0xchannel' }),
  };
}

/** A packet whose fate nobody reported: the provider has gone silent. */
export function silence(message = 'the socket closed'): PacketOutcome {
  return { kind: 'unknown', message };
}

/**
 * A connector that carries a provider's whole route family.
 *
 * `free` names the routes it prices at zero — which on a provider's OWN
 * connector is `status`, `terminate`, `availability` and `rotate` (§5), and on
 * a hop is nothing at all, because a hop charges to carry.
 */
export function providerRoutes(input: {
  ilpAddress?: string;
  listing?: string;
  version?: number;
  price?: string;
  /** What this node charges for the free routes. `0` at the provider's own. */
  freePrice?: string;
  /** Present only for a tier that prices a Warm Standby (§4.2). */
  standbyPrice?: string;
}): readonly { prefix: string; price: string }[] {
  const address = input.ilpAddress ?? 'g.toon.provider';
  const listing = input.listing ?? 'basic';
  const version = input.version ?? 1;
  const free = input.freePrice ?? '0';
  return [
    { prefix: `${address}.${listing}.v${version}.spawn`, price: input.price ?? '1000' },
    { prefix: `${address}.${listing}.v${version}.extend`, price: input.price ?? '1000' },
    // The two standby rows exist only because a Listing prices standbys
    // (§4.2, §5). A connector MUST NOT terminate a route the provider did
    // not price, so a fixture for a tier that sells none leaves them out.
    ...(input.standbyPrice === undefined
      ? []
      : [
          {
            prefix: `${address}.${listing}.v${version}.standby`,
            price: input.standbyPrice,
          },
          {
            prefix: `${address}.${listing}.v${version}.standby.extend`,
            price: input.standbyPrice,
          },
        ]),
    { prefix: `${address}.status`, price: free },
    { prefix: `${address}.terminate`, price: free },
    { prefix: `${address}.availability`, price: free },
  ];
}

export interface WorkloadFixture {
  readonly workloads: WorkloadStore;
  readonly port: FakeProviderPort;
  readonly notes: WorkloadNoteStore;
}

/**
 * The two connectors a lease is reachable through, told apart.
 *
 * Devnet's shape, which is also the honest default: the tenant's own connector
 * publishes no route towards the provider, and the provider's own terminates
 * its whole family — pricing `status` and `terminate` at nothing, as §5 says,
 * and an extension at the Listing's price.
 */
export function defaultHealth(asked: NetworkProfile): Promise<ConnectorHealth> {
  const isProvider = asked.connectorUrl.includes('provider.example');
  return Promise.resolve(
    connectorHealth({
      endpoint: asked.connectorUrl,
      routes: isProvider ? providerRoutes({}) : [],
    })
  );
}

/** A hop that carries a provider's routes and charges its own fee for each. */
export function hopHealth(providerConnector: string) {
  return (asked: NetworkProfile): Promise<ConnectorHealth> =>
    Promise.resolve(
      connectorHealth({
        endpoint: asked.connectorUrl,
        routes:
          asked.connectorUrl === providerConnector
            ? providerRoutes({})
            : providerRoutes({ freePrice: '100', price: '1100' }),
      })
    );
}

export function workloadFixture(input: {
  vault: LeaseVault;
  chainSeed: ChainSeedStore;
  paths: ConsolePaths;
  profile?: NetworkProfile;
  provider?: FakeProviderPort;
  hidden?: HiddenTransportPort;
  notes?: WorkloadNoteStore;
  directory?: () => Promise<DirectoryResult>;
  health?: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  autoExtend?: () => AutoExtendReader;
  readTakeover?: (query: {
    workloadId: string;
    standbySet: readonly string[];
    relays: readonly string[];
  }) => Promise<TakeoverReading>;
  now?: () => Date;
}): WorkloadFixture {
  const profile = input.profile ?? SANDBOX;
  const port = input.provider ?? fakeProviderPort(statusOk());
  const notes = input.notes ?? new InMemoryWorkloadNoteStore(input.now);
  const workloads = new WorkloadStore({
    profile: () => profile,
    vault: input.vault,
    chainSeed: input.chainSeed,
    readHealth: input.health ?? defaultHealth,
    readDirectory:
      input.directory ??
      (() =>
        Promise.resolve({
          state: 'ok',
          relays: { seed: [], read: [] },
          filters: {},
          providers: [fakeProvider()],
          listingsWithoutProfile: 0,
          rejectedEvents: 0,
          readAt: '2026-09-22T00:00:00.000Z',
        })),
    provider: port,
    ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
    paths: input.paths,
    notes,
    ...(input.autoExtend === undefined ? {} : { autoExtend: input.autoExtend }),
    ...(input.readTakeover === undefined ? {} : { readTakeover: input.readTakeover }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { workloads, port, notes };
}
