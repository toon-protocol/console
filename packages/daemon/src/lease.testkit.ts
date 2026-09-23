import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { fakePaidWriter, type FakeWriter } from './chain-seed.testkit.js';
import type { ConnectorHealth, SettlementView } from './connector-health.js';
import { channelStoreFor } from './channel-store.js';
import type { DirectoryResult, ProviderView } from './directory.js';
import {
  LeaseStore,
  type LeasePacket,
  type PacketOutcome,
  type ProviderPort,
} from './lease.js';
import { LeaseVault } from './lease-vault.js';
import { InMemoryLeaseVaultCache, type LeaseVaultCache } from './lease-vault-cache.js';
import type { ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import type { RelayDialer } from './relay-pool.js';
import type { FakeRelayServer } from './chain-seed.testkit.js';
import type { AccountSigning } from './signer.js';

/**
 * A provider that answers what a test tells it to.
 *
 * Every case this ticket turns on is a provider behaving in a way no live one
 * can be asked to behave on demand — refusing with `no_capacity`, rejecting
 * the packet at the connector, going silent after taking it — and each of
 * those decides something different about the vault record. So the port is
 * faked here and `lease-route.ts` is the thin layer that is not.
 */
export interface FakeProviderPort extends ProviderPort {
  /** Every packet it was asked to send, in order. The spawn bodies are here. */
  readonly sent: LeasePacket[];
  /** What the next send answers. Replaced by a test before each case. */
  answer: PacketOutcome | ((packet: LeasePacket) => PacketOutcome);
}

export function fakeProviderPort(
  answer?: PacketOutcome | ((packet: LeasePacket) => PacketOutcome)
): FakeProviderPort {
  const port: FakeProviderPort = {
    sent: [],
    answer: answer ?? spawnOk,
    send(packet: LeasePacket): Promise<PacketOutcome> {
      port.sent.push(packet);
      const given = typeof port.answer === 'function' ? port.answer(packet) : port.answer;
      return Promise.resolve(given);
    },
  };
  return port;
}

/** The provider's own §6.2 answer to a spawn that worked. */
export function spawnOk(packet: LeasePacket): PacketOutcome {
  const body = packet.body as { request: { content: { workload_id: string } } };
  const answer = {
    workload_id: body.request.content.workload_id,
    role: 'standalone',
    expires_at: 1_790_003_600,
    access: {
      host: '203.0.113.7',
      ssh_port: 40000,
      ports: [{ container_port: 80, host_port: 41000 }],
    },
  };
  return {
    kind: 'answered',
    status: 200,
    body: answer,
    text: JSON.stringify(answer),
    cost: '1000',
    channelId: '0xchannel',
  };
}

/** A refusal on a paid route: billed, and the lease does not exist (spec §5). */
export function spawnRefused(
  error = 'no_capacity',
  message = 'nothing free here'
): PacketOutcome {
  const body = { error, message };
  return {
    kind: 'answered',
    status: 409,
    body,
    text: JSON.stringify(body),
    cost: '1000',
    channelId: '0xchannel',
  };
}

/** One provider with one listing, as the directory would have assembled it. */
export function fakeProvider(
  overrides: {
    pubkey?: string;
    ilpAddress?: string;
    connectorUrl?: string;
    listing?: Partial<ProviderView['listings'][number]>;
    hidden?: boolean;
  } = {}
): ProviderView {
  const pubkey = overrides.pubkey ?? 'd'.repeat(64);
  const ilpAddress = overrides.ilpAddress ?? 'g.toon.provider';
  const listing = {
    name: 'basic',
    address: `30432:${pubkey}:basic`,
    version: 1,
    resources: { cpuMillicores: 1000, memoryMb: 1024, storageGb: 10 },
    arch: 'amd64',
    isolation: 'shared-kernel',
    hidden: overrides.hidden === true,
    leaseIntervalSeconds: 3600,
    price: 1000,
    capabilities: [],
    unspecifiedCapabilities: [],
    publishedAt: '2026-09-22T00:00:00.000Z',
    eventId: 'e'.repeat(64),
    ...overrides.listing,
  };
  return {
    pubkey,
    profile: {
      ilpAddress,
      connectorUrl: overrides.connectorUrl ?? 'https://provider.example/ilp',
      connectorSealKey: '0x04aa',
      relays: [],
      settlement: [],
      isolation: 'shared-kernel',
      hidden: overrides.hidden === true,
      publishedAt: '2026-09-22T00:00:00.000Z',
      eventId: 'f'.repeat(64),
    },
    liveness: { state: 'live' },
    listings: [listing],
    relaysRead: [],
    supersededListings: 0,
    rejectedListings: [],
  };
}

/** A connector that publishes exactly the routes and settlements a test wants. */
export function connectorHealth(input: {
  endpoint: string;
  routes?: readonly { prefix: string; price: string }[];
  settlements?: readonly SettlementView[];
  /** What this node answers for itself — where a relay write is bought (#120). */
  ilpAddresses?: readonly string[];
}): ConnectorHealth {
  return {
    state: 'ok',
    endpoint: input.endpoint,
    ilpAddresses: input.ilpAddresses ?? ['g.toon.relay'],
    settlements: input.settlements ?? [
      {
        chain: 'evm:31337',
        kind: 'evm',
        settlementAddress: '0xc0ffee0000000000000000000000000000000001',
        tokenAddress: '0xc0ffee0000000000000000000000000000000002',
        decimals: 6,
      },
    ],
    routes: input.routes ?? [],
    peerCarriages: [],
    supportedVersions: [1],
  };
}

/**
 * A channel binding in the console's own store, so a spawn has something to
 * pay from.
 *
 * The real one is written by an open (#90); a test that had to open a channel
 * to check a spawn would be testing the chain.
 */
export function giveChannel(
  paths: ConsolePaths,
  profileId: string,
  connectorUrl: string,
  chain = 'evm:31337',
  channelId = '0xchannel'
): void {
  const { store } = channelStoreFor(paths, profileId);
  store.saveBinding?.(`${connectorUrl}|${chain}|network`, {
    channelId,
    context: { chainType: 'evm', chainId: 31337, tokenNetworkAddress: 'network' },
    depositTotal: 10_000_000n,
    openedAt: '2026-09-22T00:00:00.000Z',
  });
  store.save(channelId, { nonce: 0, cumulativeAmount: 0n });
}

export interface LeaseFixture {
  readonly vault: LeaseVault;
  readonly leases: LeaseStore;
  readonly provider: FakeProviderPort;
  readonly cache: LeaseVaultCache;
  /** The console's writer, faked: every vault write is bought through it. */
  readonly writer: FakeWriter;
}

/** A vault and a lease store over fakes, with everything else supplied. */
export function leaseFixture(input: {
  account: AccountSigning;
  chainSeed: ChainSeedStore;
  paths: ConsolePaths;
  dial: RelayDialer;
  relays: readonly string[];
  /** The relay a paid write lands on, so a later READ finds what was written. */
  relayServer?: FakeRelayServer;
  profile?: NetworkProfile;
  directory?: () => Promise<DirectoryResult>;
  health?: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  provider?: FakeProviderPort;
  cache?: LeaseVaultCache;
  writer?: FakeWriter;
  now?: () => Date;
}): LeaseFixture {
  const profile = input.profile ?? SANDBOX;
  const cache = input.cache ?? new InMemoryLeaseVaultCache();
  // A writer that can pay, unless a test says otherwise: "this account cannot
  // buy a relay write" is a case of its own, and every other case would
  // otherwise silently become it.
  const writer = input.writer ?? fakePaidWriter(input.relayServer);
  const vault = new LeaseVault({
    signer: () => input.account,
    seedRelays: () => input.relays,
    cache,
    writer,
    dial: input.dial,
    timeoutMs: 200,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const provider = input.provider ?? fakeProviderPort();
  const leases = new LeaseStore({
    profile: () => profile,
    vault,
    chainSeed: input.chainSeed,
    readHealth:
      input.health ??
      ((asked) => Promise.resolve(connectorHealth({ endpoint: asked.connectorUrl }))),
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
    provider,
    paths: input.paths,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { vault, leases, provider, cache, writer };
}

/** A well-formed spawn of the image the fleet's smokes use. */
export const GOOD_SPAWN = {
  provider: 'd'.repeat(64),
  listing: 'basic',
  image: {
    reference: 'traefik/whoami',
    digest: 'sha256:1474027c316661cdec87df2623e13a41e7e1ce0ba99c24917631de8f300b5420',
  },
  ports: [{ containerPort: 80 }],
  sshPublicKey:
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@console',
} as const;

/**
 * A vault and a lease store that do nothing, for the tests of OTHER routes.
 *
 * `ApiDeps` is one object, so every test that drives the API has to name every
 * module in it — including the two this ticket added, which most of those
 * tests have no opinion about. This is that pair: no relays, no directory, no
 * provider. Asking it for anything says so rather than reaching a network.
 */
export function idleLeases(paths: ConsolePaths): {
  vault: LeaseVault;
  leases: LeaseStore;
} {
  const chainSeed = new ChainSeedStore({
    signer: () => undefined,
    seedRelays: () => [],
    cache: new InMemoryChainSeedCache(),
    writer: () => fakePaidWriter(undefined),
  });
  const vault = new LeaseVault({
    signer: () => undefined,
    seedRelays: () => [],
    cache: new InMemoryLeaseVaultCache(),
    writer: fakePaidWriter(undefined),
  });
  const leases = new LeaseStore({
    profile: () => SANDBOX,
    vault,
    chainSeed,
    readHealth: () =>
      Promise.resolve({ state: 'unconfigured', reason: 'not asked' } as ConnectorHealth),
    readDirectory: () =>
      Promise.resolve({ state: 'unconfigured', reason: 'not asked' } as DirectoryResult),
    provider: fakeProviderPort({ kind: 'unknown', message: 'this port sends nothing' }),
    paths,
  });
  return { vault, leases };
}
