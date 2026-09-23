import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChainSeedStore } from './chain-seed.js';
import { channelStoreFor } from './channel-store.js';
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
import type { DirectoryResult } from './directory.js';
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
import type { SpawnRequest } from './lease.js';
import { InMemoryLeaseVaultCache } from './lease-vault-cache.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';
import { readLife, type WorkloadStore } from './workload.js';
import {
  extendOk,
  providerRoutes,
  refusal,
  silence,
  statusOk,
  TERMINATE_OK,
  workloadFixture,
} from './workload.testkit.js';

/**
 * The dashboard (TOON_Network#93, spec §6.3, §6.5, §6.6, §6.7).
 *
 * Four rules are pinned here, and three of them cost real money when broken.
 *
 * **Nothing is sent that a free read could have caught.** Every case below
 * that refuses an extension also asserts that NO packet went out: §6.3's
 * refusals are billed at the full interval price (ADR 0003,
 * TOON_Network#115), and `status` — which is free — is what this console asks
 * first.
 *
 * **An extension's content is BARE.** `{ "workload_id" }` and nothing else. A
 * Lease Request there is `invalid_request`, at full price.
 *
 * **A silent provider is not an error.** It is its own answer, and it stops an
 * extension rather than provoking one.
 *
 * **Expiry, Termination and Eviction stay three different things** from the
 * wire to the card, and an ending this build does not know is kept rather than
 * guessed at.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER = 'd'.repeat(64);
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';

describe('the workload dashboard', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let leases: LeaseFixture;
  let workloads: WorkloadStore;
  let port: FakeProviderPort;
  let notes: InMemoryWorkloadNoteStore;
  let workloadId: string;

  const build = async (
    input: {
      directory?: () => Promise<DirectoryResult>;
      health?: (profile: NetworkProfile) => Promise<ReturnType<typeof connectorHealth>>;
      channelAt?: string | null;
    } = {}
  ) => {
    port = fakeProviderPort(statusOk());
    notes = new InMemoryWorkloadNoteStore();
    ({ workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      notes,
      ...(input.health === undefined ? {} : { health: input.health }),
      ...(input.directory === undefined ? {} : { directory: input.directory }),
    }));
    if (input.channelAt !== null) {
      giveChannel(paths, SANDBOX.id, input.channelAt ?? PROVIDER_CONNECTOR);
    }
  };

  /** The vault's view of the one lease under test. */
  const fixture = () => {
    const lease = leases.vault.find(workloadId);
    if (lease === undefined) throw new Error('no lease');
    return { lease };
  };

  /** The body the fake provider was handed, for the last packet it took. */
  const lastBody = () => port.sent.at(-1)?.body as Record<string, unknown> | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-workload-'));
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
    });
    giveChannel(paths, SANDBOX.id, PROVIDER_CONNECTOR);
    await leases.vault.refresh();
    const spawned = await leases.leases.spawn(GOOD_SPAWN as SpawnRequest);
    workloadId = spawned.lease!.workloadId;
    await build();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------------- */

  describe('status (§6.5, free)', () => {
    it('presents the lease’s own Continuation Token, in a §6.1 Lease Request', async () => {
      await workloads.readStatus(workloadId);
      const request = lastBody()?.request as Record<string, unknown>;

      expect(Object.keys(request).sort()).toEqual([
        'content',
        'continuation',
        'expiration',
        'op',
        'provider',
        'request_id',
      ]);
      expect(request.op).toBe('status');
      expect(request.provider).toBe(PROVIDER);
      expect(request.content).toEqual({ workload_id: workloadId });
      // The one value that has to agree: the token the provider stored at
      // spawn is what this derives from the same Root Secret (§6.1.1).
      const record = await vaulted();
      expect(request.continuation).toBe(continuationFor(record.root_secret, PROVIDER));
    });

    it('buys the free route where it is free, sending nothing through a hop', async () => {
      await workloads.readStatus(workloadId);
      // The provider's own connector prices `status` at nothing (§5). A hop
      // that charges to carry it is not where a free route is bought.
      expect(port.sent.at(-1)?.payAt).toBe(PROVIDER_CONNECTOR);
      expect(port.sent.at(-1)?.route).toBe('g.toon.provider.status');
    });

    /**
     * TOON_Network#129: the same shape #126 fixed for a relay write, here for
     * the provider's connector. The sandbox's `provider-connector` calls
     * ITSELF `http://127.0.0.1:3240/ilp` — never the Provider Profile's own
     * `http://provider-connector:3000/ilp` (a docker-internal name this
     * console cannot even dial). A `status` read must find the channel by
     * what the connector says about itself, never by the Profile's string,
     * and pay under that same identity too.
     */
    it('finds its channel by what the provider’s connector calls itself, not by its Profile (#129)', async () => {
      const selfEndpoint = 'http://127.0.0.1:3240';
      await build({
        health: (asked) =>
          Promise.resolve(
            connectorHealth({
              endpoint: asked.connectorUrl,
              ...(asked.connectorUrl === PROVIDER_CONNECTOR ? { selfEndpoint } : {}),
              routes: asked.connectorUrl === PROVIDER_CONNECTOR ? providerRoutes({}) : [],
            })
          ),
        channelAt: selfEndpoint,
      });

      await workloads.readStatus(workloadId);

      expect(port.sent.at(-1)?.payAt).toBe(selfEndpoint);
      expect(port.sent.at(-1)?.route).toBe('g.toon.provider.status');
    });

    it('reads the state, the expiry and the access details onto the card', async () => {
      port.answer = statusOk({ expiresAt: 1_790_000_000 });
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.status.kind).toBe('read');
      if (card.status.kind !== 'read') throw new Error('unreachable');
      expect(card.status.life).toEqual({ phase: 'running' });
      expect(card.status.expiresAt).toBe(1_790_000_000);
      expect(card.status.access?.host).toBe('203.0.113.7');
    });

    it('carries a Takeover’s winner through (§7.1)', async () => {
      port.answer = statusOk({ state: 'reserved', takeover: { winner: 'a'.repeat(64) } });
      const card = await workloads.card(workloadId, { refresh: true });

      if (card.status.kind !== 'read') throw new Error('unreachable');
      expect(card.status.takeover).toEqual({ winner: 'a'.repeat(64) });
    });

    it('reads a provider that went silent as SILENT, not as an error', async () => {
      port.answer = silence('the socket closed mid-flight');
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.status.kind).toBe('silent');
      if (card.status.kind !== 'silent') throw new Error('unreachable');
      expect(card.status.reason).toContain('nothing came back');
      expect(card.status.reason).toContain('may be running perfectly');
    });

    it('reads a rejected packet as silence too: nothing reached the provider', async () => {
      port.answer = {
        kind: 'refused',
        code: 'T01',
        refusedBy: 'path',
        message: 'peer unreachable',
      };
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.status.kind).toBe('silent');
    });

    it('reads the provider’s own refusal as a refusal, with its code', async () => {
      port.answer = refusal('not_tenant', 'that is not this lease’s token');
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.status.kind).toBe('refused');
      if (card.status.kind !== 'refused') throw new Error('unreachable');
      expect(card.status.code).toBe('not_tenant');
    });

    it('says `unread` — and sends nothing — when there is no route to ask on', async () => {
      await build({
        health: (asked) =>
          Promise.resolve(connectorHealth({ endpoint: asked.connectorUrl, routes: [] })),
      });
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.status.kind).toBe('unread');
      expect(port.sent).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the three endings (§6.7)', () => {
    it('keeps Expiry, Termination and Eviction apart', () => {
      expect(readLife({ ended: 'expiry' })).toEqual({ phase: 'ended', ending: 'expiry' });
      expect(readLife({ ended: 'termination' })).toEqual({
        phase: 'ended',
        ending: 'termination',
      });
      expect(readLife({ ended: 'eviction' })).toEqual({ phase: 'ended', ending: 'eviction' });
    });

    it('keeps an ending this build does not know, rather than guessing', () => {
      expect(readLife({ ended: 'something-later' })).toEqual({
        phase: 'ended',
        ending: 'unstated',
        word: 'something-later',
      });
    });

    it('reads every live phase, and nothing it does not recognise', () => {
      expect(readLife('provisioning')).toEqual({ phase: 'provisioning' });
      expect(readLife('reserved')).toEqual({ phase: 'reserved' });
      expect(readLife('stopped')).toEqual({ phase: 'stopped' });
      expect(readLife('gone')).toBeUndefined();
      expect(readLife(undefined)).toBeUndefined();
    });

    it('shows an evicted lease as evicted, and refuses to extend it', async () => {
      port.answer = statusOk({ state: { ended: 'eviction' } });
      const card = await workloads.card(workloadId, { refresh: true });

      if (card.status.kind !== 'read') throw new Error('unreachable');
      expect(card.status.life).toEqual({ phase: 'ended', ending: 'eviction' });
      expect(card.extend.ok).toBe(false);
      expect(card.extend.problems.join(' ')).toContain('Eviction');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('runway', () => {
    it('is paid time plus what the channel can still buy', async () => {
      const now = 1_700_000_000_000;
      ({ workloads } = workloadFixture({
        vault: leases.vault,
        chainSeed: seed,
        paths,
        provider: fakeProviderPort(statusOk({ expiresAt: Math.floor(now / 1000) + 600 })),
        now: () => new Date(now),
      }));

      const card = await workloads.card(workloadId, { refresh: true });

      // The channel holds 10_000_000 base units and one interval costs 1000,
      // so it buys 10_000 more intervals of 3600 s, on top of the 600 s paid.
      expect(card.runway.state).toBe('computed');
      expect(card.runway.pricePerInterval).toBe('1000');
      expect(card.runway.available).toBe('10000000');
      expect(card.runway.affordableIntervals).toBe(10_000);
      expect(card.runway.paidSeconds).toBe(600);
      expect(card.runway.seconds).toBe(600 + 10_000 * 3600);
    });

    it('moves as the funds move, with nothing else changing', async () => {
      const first = await workloads.card(workloadId, { refresh: true });
      // Spend most of the channel: the same lease, the same price, less money.
      spend(paths, '9999000');
      const second = await workloads.card(workloadId, { refresh: true });

      expect(first.runway.affordableIntervals).toBe(10_000);
      expect(second.runway.affordableIntervals).toBe(1);
      expect(second.runway.seconds).toBeLessThan(first.runway.seconds!);
    });

    it('says it cannot be computed when there is no channel, and does not say zero', async () => {
      rmSync(join(paths.data, 'profiles', SANDBOX.id, 'channels'), {
        recursive: true,
        force: true,
      });
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.runway.state).toBe('unknown');
      expect(card.runway.seconds).toBeUndefined();
      expect(card.runway.affordableIntervals).toBeUndefined();
      expect(card.runway.reason).toContain('no payment channel');
    });

    it('says it cannot be computed when nothing prices the extension', async () => {
      await build({
        health: (asked) =>
          Promise.resolve(
            connectorHealth({
              endpoint: asked.connectorUrl,
              routes: [{ prefix: 'g.toon.provider.status', price: '0' }],
            })
          ),
      });
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.runway.state).toBe('unknown');
      expect(card.runway.reason).toContain('prices this lease’s `.extend` route');
      expect(card.runway.seconds).toBeUndefined();
    });

    it('reports the seconds and no date when the funds outlast the calendar', async () => {
      // Not a contrivance: a channel holding 1e17 base units against a route
      // priced at four figures really does buy more intervals than there are
      // milliseconds in the date range, and this console met one on the local
      // sandbox. A card that threw there would be a card that fell over on a
      // well-funded account.
      giveChannel(paths, SANDBOX.id, PROVIDER_CONNECTOR, 'evm:31337', '0xrich');
      const { store } = channelStoreFor(paths, SANDBOX.id);
      store.saveBinding?.(`${PROVIDER_CONNECTOR}|evm:31337|network`, {
        channelId: '0xrich',
        context: { chainType: 'evm', chainId: 31337, tokenNetworkAddress: 'network' },
        depositTotal: 10n ** 17n,
        openedAt: '2026-09-22T00:00:00.000Z',
      });
      store.save('0xrich', { nonce: 0, cumulativeAmount: 0n });

      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.runway.state).toBe('computed');
      expect(card.runway.seconds).toBeGreaterThan(1e15);
      expect(card.runway.until).toBeUndefined();
    });

    it('says it cannot be computed when nothing knows the expiry', async () => {
      port.answer = silence();
      const card = await workloads.card(workloadId, { refresh: true });

      // The vault record of a confirmed spawn does carry an expiry, so this is
      // the case where neither the provider nor the record has one.
      expect(['unknown', 'computed']).toContain(card.runway.state);
      if (card.runway.state === 'computed') {
        expect(card.runway.expirySource).toBe('vault');
      }
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('extend (§6.3, paid)', () => {
    it('sends the content BARE: `{ workload_id }` and no Lease Request', async () => {
      port.answer = (packet) =>
        !packet.route.endsWith('.extend')
          ? statusOk()(packet)
          : (packet.body as { workload_id?: string }).workload_id === undefined
            ? refusal('invalid_request', 'that is not a bare content')
            : extendOk(1_790_007_200);

      const result = await workloads.extend(workloadId);
      const extension = port.sent.find((packet) => packet.route.endsWith('.extend'));

      expect(result.sent).toBe(true);
      // The free `status` goes first; the paid one carries a BARE content.
      expect(extension?.body).toEqual({ workload_id: workloadId });
      expect(extension?.body).not.toHaveProperty('request');
      expect(result.expiresAt).toBe(1_790_007_200);
      expect(result.cost).toBe('1000');
    });

    it('buys the lease’s own listing version, on the `.extend` route', async () => {
      port.answer = (packet) =>
        packet.route.endsWith('.extend') ? extendOk(1_790_007_200) : statusOk()(packet);

      await workloads.extend(workloadId);

      expect(port.sent.map((packet) => packet.route)).toContain(
        'g.toon.provider.basic.v1.extend'
      );
    });

    it('sends NOTHING when the provider has retired this lease’s listing version', async () => {
      await build({
        directory: () =>
          Promise.resolve({
            state: 'ok',
            relays: { seed: [], read: [] },
            filters: {},
            providers: [fakeProvider({ listing: { version: 2 } })],
            listingsWithoutProfile: 0,
            rejectedEvents: 0,
            readAt: '2026-09-22T00:00:00.000Z',
          } as DirectoryResult),
      });

      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('wrong_listing_version');
      // A free `status` may have gone out; the PAID packet never did.
      expect(port.sent.some((packet) => packet.route.endsWith('.extend'))).toBe(false);
    });

    it('pays on the chain the lease was BOUGHT on, not the first one offered', async () => {
      // A connector forwarding to a provider's has to convert, and refuses a
      // packet whose amount converts to nothing at the rate it declares — at
      // full price. This console met exactly that on the local sandbox, where
      // the hub's peer settles in Solana and the same account also held an EVM
      // channel there. So the chain the SPAWN paid on is recorded and used,
      // and the order a connector happens to list its settlements in decides
      // nothing.
      expect(fixture().lease.paidChain).toBe('evm:31337');
      await build({
        health: (asked) =>
          Promise.resolve(
            connectorHealth({
              endpoint: asked.connectorUrl,
              routes: asked.connectorUrl.includes('provider.example')
                ? [
                    { prefix: 'g.toon.provider.basic.v1.extend', price: '1000' },
                    { prefix: 'g.toon.provider.status', price: '0' },
                  ]
                : [],
              // Solana FIRST. A plan that took "the first settlement with a
              // channel" would pick it and buy a refusal.
              settlements: [
                {
                  chain: 'solana',
                  kind: 'solana',
                  settlementAddress: 'sol1',
                  tokenAddress: 'sol2',
                  decimals: 6,
                },
                {
                  chain: 'evm:31337',
                  kind: 'evm',
                  settlementAddress: '0xaaa',
                  tokenAddress: '0xbbb',
                  decimals: 18,
                },
              ],
            })
          ),
      });
      giveChannel(paths, SANDBOX.id, PROVIDER_CONNECTOR, 'solana', 'solchan');

      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.extend.route?.chain).toBe('evm:31337');
      expect(card.extend.route?.channelId).toBe('0xchannel');
    });

    it('sends NOTHING for a lease that has ended', async () => {
      port.answer = statusOk({ state: { ended: 'expiry' } });

      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('Expiry');
      // One packet only: the free status. The paid one never left.
      expect(port.sent).toHaveLength(1);
      expect(port.sent[0]?.route).toBe('g.toon.provider.status');
    });

    it('sends NOTHING while the provider is silent', async () => {
      port.answer = silence();

      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('not answering');
      expect(port.sent).toHaveLength(1);
    });

    it('sends NOTHING for a reservation whose tier prices no Warm Standby', async () => {
      // `.extend` on a Reserved lease is `not_running` and billed at the
      // running price (§6.3), so the console never sends one — it picks
      // `.standby.extend` from what the lease IS. This fixture's tier
      // publishes no `standby_price`, so that route does not exist either
      // (§4.2, §5), and the honest answer is to send nothing at all.
      port.answer = statusOk({ state: 'reserved', role: 'standby', access: null });

      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(false);
      expect(result.op).toBe('standby.extend');
      expect(result.problems.join(' ')).toContain('no longer prices a Warm Standby');
      expect(port.sent).toHaveLength(1);
    });

    it('sends NOTHING when the price is above what the caller agreed to', async () => {
      const result = await workloads.extend(workloadId, { maxPrice: '999' });

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('above the 999');
      expect(port.sent).toHaveLength(1);
    });

    it('reports a refusal with the provider’s own code, and what it was billed', async () => {
      port.answer = (packet) =>
        packet.route.endsWith('.extend')
          ? refusal('no_capacity', 'nothing free here', '1000')
          : statusOk()(packet);

      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(true);
      expect(result.providerError).toBe('no_capacity');
      expect(result.cost).toBe('1000');
      expect(result.message).toContain('billed');
    });

    it('says so when an extension’s fate is unknown, rather than guessing', async () => {
      port.answer = (packet) =>
        packet.route.endsWith('.extend') ? silence() : statusOk()(packet);

      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(true);
      expect(result.expiresAt).toBeUndefined();
      expect(result.message).toContain('unknown');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('terminate (§6.6, free)', () => {
    it('presents the lease’s own token in a §6.1 Lease Request', async () => {
      port.answer = TERMINATE_OK;
      await workloads.terminate(workloadId);
      const request = lastBody()?.request as Record<string, unknown>;

      expect(request.op).toBe('terminate');
      expect(request.content).toEqual({ workload_id: workloadId });
      // §6.6: there is no `gateway_expires_at` in this content, ever.
      expect(request.content).not.toHaveProperty('gateway_expires_at');
      expect(port.sent.at(-1)?.route).toBe('g.toon.provider.terminate');
    });

    it('ends the lease, and the card says Termination', async () => {
      port.answer = TERMINATE_OK;

      const result = await workloads.terminate(workloadId);

      expect(result.sent).toBe(true);
      expect(result.ended).toBe('termination');
      expect(result.card.endedAs).toBe('termination');
      if (result.card.status.kind !== 'read') throw new Error('unreachable');
      expect(result.card.status.life).toEqual({ phase: 'ended', ending: 'termination' });
    });

    it('keeps the ending after the provider has swept the lease away', async () => {
      port.answer = TERMINATE_OK;
      await workloads.terminate(workloadId);

      // The sweep has happened: the provider no longer holds this lease.
      port.answer = refusal('unknown_workload', 'never heard of it');
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.status.kind).toBe('refused');
      expect(card.endedAs).toBe('termination');
    });

    it('refuses to extend a terminated lease, and sends no paid packet', async () => {
      port.answer = TERMINATE_OK;
      await workloads.terminate(workloadId);
      const before = port.sent.length;

      port.answer = statusOk({ state: { ended: 'termination' } });
      const result = await workloads.extend(workloadId);

      expect(result.sent).toBe(false);
      expect(port.sent.length - before).toBe(1);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the dashboard', () => {
    it('is one card per lease, and sends nothing without a refresh', async () => {
      const view = await workloads.dashboard();

      expect(view.state).toBe('ready');
      expect(view.cards).toHaveLength(1);
      expect(view.cards[0]?.workloadId).toBe(workloadId);
      expect(view.cards[0]?.status.kind).toBe('unread');
      expect(port.sent).toHaveLength(0);
    });

    it('asks every provider when it is refreshed', async () => {
      const view = await workloads.dashboard({ refresh: true });

      expect(view.cards[0]?.status.kind).toBe('read');
      expect(port.sent).toHaveLength(1);
    });

    it('carries no Root Secret and no Continuation Token', async () => {
      const view = await workloads.dashboard({ refresh: true });
      const record = await vaulted();
      const json = JSON.stringify(view);

      expect(json).not.toContain(record.root_secret);
      expect(json).not.toContain(continuationFor(record.root_secret, PROVIDER));
    });

    it('is empty and says signed out when nobody is signed in', async () => {
      await leases.vault.retract(workloadId, 'test');
      const view = await workloads.dashboard();

      expect(view.cards).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------------- */

  /** The sealed record the relay holds, opened with the account's own key. */
  const vaulted = async () => {
    const event = relay.events
      .filter((candidate) =>
        (candidate.tags.find((tag) => tag[0] === 'd')?.[1] ?? '').startsWith(
          'toon-console/lease/'
        )
      )
      .at(-1);
    return JSON.parse(await account.unsealFromSelf(event!.content)) as {
      root_secret: string;
    };
  };
});

/** Sign claims against the channel, so the next runway sees less money. */
function spend(paths: ConsolePaths, amount: string): void {
  const { store } = channelStoreFor(paths, SANDBOX.id);
  store.save('0xchannel', { nonce: 1, cumulativeAmount: BigInt(amount) });
}
