import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import type { ConnectorHealth } from './connector-health.js';
import { continuationFor } from './continuation.js';
import type { DirectoryResult } from './directory.js';
import {
  GOOD_SPAWN,
  connectorHealth,
  fakeProvider,
  fakeProviderPort,
  giveChannel,
  leaseFixture,
  spawnRefused,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import type { LeasePacket, PacketOutcome, StandbySetSpawnRequest } from './lease.js';
import { LEASE_VAULT_KIND, type VaultedLease } from './lease-vault.js';
import { InMemoryLeaseVaultCache } from './lease-vault-cache.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import type { TakeoverReading } from './takeover.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';
import type { WorkloadStore } from './workload.js';
import { providerRoutes, statusOk, workloadFixture } from './workload.testkit.js';

/**
 * **Warm Standbys and Takeover** (TOON_Network#95, spec §7, ADR 0010).
 *
 * Five things this ticket has to get right, and four of them cost money when
 * they are wrong.
 *
 * **A set is bought as a set.** One content, one workload id, one Root Secret,
 * and a request per member: the primary on `.spawn` at the listing's price and
 * each Warm Standby on `.standby` at its `standby_price` (§7). A half-formed
 * set protects nothing while costing an interval at every member it reached.
 *
 * **A token per member.** `continuation(provider)` derives under the member's
 * own key (§6.1.1), so every member holds a different one and no member can
 * act as the tenant against another.
 *
 * **A reservation is extended on its own route.** `.standby.extend` at the
 * standby price. §6.3 refuses it on `.extend` as `not_running` and bills at
 * the running price, so the console reads what the member IS — free — before
 * it chooses.
 *
 * **A self-stop is not an ending.** §6.7's `stopped` is a primary that stopped
 * its own workload under §7.1: the lease is still paid, still extendable at
 * the running price, still swept at its expiry. An `expiry` is over. The card
 * must never show one as the other.
 *
 * **The runway is the set's.** A set protects a workload only while every
 * member is paid.
 */

const RELAY = 'wss://own.relay.test';
const PRIMARY = 'd'.repeat(64);
const STANDBY = 'e'.repeat(64);
const PRIMARY_CONNECTOR = 'https://provider.example/ilp';
const STANDBY_CONNECTOR = 'https://provider2.example/ilp';

/**
 * Two providers, both selling `warm` at the sandbox's committed prices.
 *
 * `sells.standby` is what makes the second one's tier price a Warm Standby.
 * A tier that sets no `standby_price` sells none and its connector terminates
 * no `.standby` route at all (§4.2, §5), which is a case worth proving
 * without a second fixture.
 */
const sells = { standby: true };

function twoProviders(): () => Promise<DirectoryResult> {
  const warm = {
    name: 'warm',
    version: 1,
    leaseIntervalSeconds: 600,
    price: 1000,
  };
  return () =>
    Promise.resolve({
      state: 'ok',
      relays: { seed: [], read: [] },
      filters: {},
      providers: [
        fakeProvider({
          pubkey: PRIMARY,
          ilpAddress: 'g.toon.provider',
          connectorUrl: PRIMARY_CONNECTOR,
          listing: { ...warm, standbyPrice: 400, address: `30432:${PRIMARY}:warm` },
        }),
        fakeProvider({
          pubkey: STANDBY,
          ilpAddress: 'g.toon.provider2',
          connectorUrl: STANDBY_CONNECTOR,
          listing: {
            ...warm,
            ...(sells.standby ? { standbyPrice: 400 } : {}),
            address: `30432:${STANDBY}:warm`,
          },
        }),
      ],
      listingsWithoutProfile: 0,
      rejectedEvents: 0,
      readAt: '2026-09-23T00:00:00.000Z',
    } as DirectoryResult);
}

/** Each provider's own connector terminates its own family, free routes free. */
function twoConnectors(asked: NetworkProfile): Promise<ConnectorHealth> {
  const routes = asked.connectorUrl.includes('provider2.example')
    ? providerRoutes({
        ilpAddress: 'g.toon.provider2',
        listing: 'warm',
        standbyPrice: '400',
      })
    : asked.connectorUrl.includes('provider.example')
      ? providerRoutes({ ilpAddress: 'g.toon.provider', listing: 'warm', standbyPrice: '400' })
      : [];
  return Promise.resolve(connectorHealth({ endpoint: asked.connectorUrl, routes }));
}

/** The §6.2 answer each member gives its own spawn. */
function setSpawnOk(packet: LeasePacket): PacketOutcome {
  const body = packet.body as {
    request: { op: string; content: { workload_id: string } };
  };
  const standby = body.request.op === 'standby';
  const answer = {
    workload_id: body.request.content.workload_id,
    role: standby ? 'standby' : 'primary',
    expires_at: 1_790_003_600,
    // "`access` is absent for a standby until Takeover" (§6.2).
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
}

describe('a Standby Set', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let leases: LeaseFixture;
  let port: FakeProviderPort;

  const request: StandbySetSpawnRequest = {
    ...GOOD_SPAWN,
    listing: 'warm',
    standbys: [{ provider: STANDBY, listing: 'warm' }],
  };

  const vaulted = async (): Promise<VaultedLease | undefined> => {
    const event = relay.events.find(
      (candidate) =>
        candidate.kind === LEASE_VAULT_KIND &&
        (candidate.tags.find((tag) => tag[0] === 'd')?.[1] ?? '').startsWith(
          'toon-console/lease/'
        )
    );
    if (!event) return undefined;
    return JSON.parse(await account.unsealFromSelf(event.content)) as VaultedLease;
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-standby-'));
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
    sells.standby = true;

    port = fakeProviderPort(setSpawnOk);
    leases = leaseFixture({
      account,
      chainSeed: seed,
      paths,
      dial: fakeRelayNetwork([relay]),
      relays: [RELAY],
      relayServer: relay,
      provider: port,
      cache: new InMemoryLeaseVaultCache(),
      directory: twoProviders(),
      health: twoConnectors,
    });
    giveChannel(paths, SANDBOX.id, PRIMARY_CONNECTOR);
    giveChannel(paths, SANDBOX.id, STANDBY_CONNECTOR, 'evm:31337', '0xchannel2');
    await leases.vault.refresh();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------------- */

  describe('spawning it (§7, §6.2 step 3)', () => {
    it('sends ONE content to each member, the primary on `.spawn` and the standby on `.standby`', async () => {
      const result = await leases.leases.spawnSet(request);

      expect(port.sent).toHaveLength(2);
      const [first, second] = port.sent;
      expect(first?.route).toBe('g.toon.provider.warm.v1.spawn');
      expect(second?.route).toBe('g.toon.provider2.warm.v1.standby');

      const primary = (first?.body as { request: Record<string, unknown> }).request;
      const standby = (second?.body as { request: Record<string, unknown> }).request;
      expect(primary.op).toBe('spawn');
      expect(standby.op).toBe('standby');
      expect(primary.provider).toBe(PRIMARY);
      expect(standby.provider).toBe(STANDBY);
      // "Nothing in the content singles out a member" (§7): the two contents
      // are the same object, same workload id and same membership list.
      expect(standby.content).toEqual(primary.content);
      expect((primary.content as { standby_set: string[] }).standby_set).toEqual([
        PRIMARY,
        STANDBY,
      ]);
      expect(result.members.map((member) => member.ok)).toEqual([true, true]);
      // 1000 for the interval, 400 for the reservation.
      expect(result.cost).toBe('1400');
    });

    it('presents a DIFFERENT Continuation Token to each member (§6.1.1)', async () => {
      await leases.leases.spawnSet(request);
      const record = await vaulted();
      const tokens = port.sent.map(
        (packet) => (packet.body as { request: { continuation: string } }).request.continuation
      );

      expect(record?.root_secret).toMatch(/^[0-9a-f]{64}$/u);
      expect(tokens[0]).toBe(continuationFor(record?.root_secret ?? '', PRIMARY));
      expect(tokens[1]).toBe(continuationFor(record?.root_secret ?? '', STANDBY));
      // The whole point: one member cannot act as the tenant against another.
      expect(tokens[0]).not.toBe(tokens[1]);
    });

    it('vaults ONE record naming the whole set, before anything is sent', async () => {
      let recordWasThere = false;
      port.answer = (packet) => {
        recordWasThere =
          relay.events.filter((candidate) => candidate.kind === LEASE_VAULT_KIND).length > 0;
        return setSpawnOk(packet);
      };

      const result = await leases.leases.spawnSet(request);
      const record = await vaulted();

      expect(recordWasThere).toBe(true);
      expect(record?.standby_set).toEqual([PRIMARY, STANDBY]);
      expect(record?.members?.map((member) => member.pubkey)).toEqual([PRIMARY, STANDBY]);
      expect(record?.members?.map((member) => member.state)).toEqual(['live', 'live']);
      expect(result.lease?.members.map((member) => member.role)).toEqual([
        'primary',
        'standby',
      ]);
    });

    it('buys NO reservation when the primary’s spawn is refused', async () => {
      port.answer = (packet) =>
        packet.route.endsWith('.spawn') ? spawnRefused('no_capacity') : setSpawnOk(packet);

      await expect(leases.leases.spawnSet(request)).rejects.toThrow(/no_capacity/u);

      // A Warm Standby holds capacity for a workload, and there is none.
      expect(port.sent).toHaveLength(1);
      expect(leases.vault.find(port.sent[0] ? '' : '')).toBeUndefined();
    });

    it('keeps the set when a STANDBY refuses: the primary’s lease is real', async () => {
      port.answer = (packet) =>
        packet.route.endsWith('.standby') ? spawnRefused('no_capacity') : setSpawnOk(packet);

      const result = await leases.leases.spawnSet(request);
      const record = await vaulted();

      expect(result.members[0]?.ok).toBe(true);
      expect(result.members[1]?.ok).toBe(false);
      expect(result.members[1]?.providerError).toBe('no_capacity');
      // The account was billed for the refusal (ADR 0003), so it is recorded
      // rather than forgotten.
      expect(result.members[1]?.cost).toBe('1000');
      expect(record?.members?.[1]?.state).toBe('failed');
      expect(record?.state).toBe('live');
    });

    it('refuses a set that names one provider twice, before anything is paid', async () => {
      await expect(
        leases.leases.spawnSet({
          ...request,
          standbys: [{ provider: PRIMARY, listing: 'warm' }],
        })
      ).rejects.toThrow(/named twice/u);

      expect(port.sent).toHaveLength(0);
    });

    it('refuses a standby on a tier that prices no Warm Standby, unpaid', async () => {
      // A tier that sets no `standby_price` sells no Warm Standby, and a
      // connector MUST NOT terminate a route the provider did not price
      // (§4.2, §5). A reservation bought there is `wrong_listing_version` —
      // and billed.
      sells.standby = false;
      const preflight = await leases.leases.preflightSet(request);

      expect(preflight.ok).toBe(false);
      expect(preflight.members[1]?.view.problems.join(' ')).toContain(
        'prices no Warm Standby'
      );
      expect(port.sent).toHaveLength(0);
    });

    it('prices the whole set in a preflight that sends nothing', async () => {
      const preflight = await leases.leases.preflightSet(request);

      expect(preflight.ok).toBe(true);
      expect(preflight.members).toHaveLength(2);
      expect(preflight.members[0]?.view.route).toBe('g.toon.provider.warm.v1.spawn');
      expect(preflight.members[1]?.view.route).toBe('g.toon.provider2.warm.v1.standby');
      expect(preflight.members[1]?.view.payment?.routePrice).toBe('400');
      expect(preflight.cost).toBe('1400');
      expect(port.sent).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('living with it', () => {
    let workloads: WorkloadStore;
    let notes: InMemoryWorkloadNoteStore;
    let dashPort: FakeProviderPort;
    let workloadId: string;
    let takeover: TakeoverReading | undefined;

    /** What each member answers a `status` with, by its route's prefix. */
    let answers: Record<string, PacketOutcome | ((packet: LeasePacket) => PacketOutcome)>;

    const dashboard = () => workloads.dashboard({ refresh: true });

    beforeEach(async () => {
      const spawned = await leases.leases.spawnSet(request);
      workloadId = spawned.lease?.workloadId ?? '';
      answers = {
        'g.toon.provider': statusOk({ role: 'primary', expiresAt: 1_790_003_600 }),
        'g.toon.provider2': statusOk({
          role: 'standby',
          state: 'reserved',
          access: null,
          expiresAt: 1_790_003_600,
        }),
      };
      notes = new InMemoryWorkloadNoteStore();
      dashPort = fakeProviderPort((packet) => {
        const key = packet.route.startsWith('g.toon.provider2')
          ? 'g.toon.provider2'
          : 'g.toon.provider';
        const answer = answers[key];
        if (answer === undefined) throw new Error(`no answer for ${packet.route}`);
        return typeof answer === 'function' ? answer(packet) : answer;
      });
      ({ workloads } = workloadFixture({
        vault: leases.vault,
        chainSeed: seed,
        paths,
        provider: dashPort,
        notes,
        directory: twoProviders(),
        health: twoConnectors,
        readTakeover: () =>
          Promise.resolve(
            takeover ?? {
              state: 'none',
              claims: [],
              rounds: 0,
              relays: [],
              readAt: '2026-09-23T00:00:00.000Z',
            }
          ),
      }));
      takeover = undefined;
    });

    it('lists both members on the card, each with what it is doing', async () => {
      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.set.members).toBe(2);
      expect(card.set.warm).toBe(true);
      expect(card.members.map((member) => member.role)).toEqual(['primary', 'standby']);
      expect(card.members[0]?.status.kind).toBe('read');
      expect(card.members[1]?.status.kind === 'read' && card.members[1].status.life).toEqual({
        phase: 'reserved',
      });
      // A reservation runs nothing until a Takeover, so it has no access.
      expect(
        card.members[1]?.status.kind === 'read' && card.members[1].status.access
      ).toBeUndefined();
      expect(card.members[0]?.runningNow).toBe(true);
      expect(card.members[1]?.runningNow).toBe(false);
    });

    it('extends the RESERVATION on `.standby.extend`, at the standby price', async () => {
      answers['g.toon.provider2'] = (packet) =>
        packet.route.endsWith('.standby.extend')
          ? {
              kind: 'answered',
              status: 200,
              body: { workload_id: workloadId, expires_at: 1_790_004_200 },
              text: '{}',
              cost: '400',
            }
          : statusOk({
              role: 'standby',
              state: 'reserved',
              access: null,
              expiresAt: 1_790_003_600,
            })(packet);

      const result = await workloads.extend(workloadId, { member: STANDBY });

      expect(result.op).toBe('standby.extend');
      expect(result.route?.route).toBe('g.toon.provider2.warm.v1.standby.extend');
      expect(result.route?.price).toBe('400');
      expect(result.sent).toBe(true);
      expect(result.cost).toBe('400');
      expect(result.expiresAt).toBe(1_790_004_200);
    });

    it('sends the reservation’s extension BARE: `{ workload_id }` and nothing else', async () => {
      answers['g.toon.provider2'] = (packet) =>
        packet.route.endsWith('.standby.extend')
          ? {
              kind: 'answered',
              status: 200,
              body: { workload_id: workloadId, expires_at: 1_790_004_200 },
              text: '{}',
              cost: '400',
            }
          : statusOk({
              role: 'standby',
              state: 'reserved',
              access: null,
              expiresAt: 1_790_003_600,
            })(packet);

      await workloads.extend(workloadId, { member: STANDBY });
      const sent = dashPort.sent.find((packet) =>
        packet.route.endsWith('.standby.extend')
      )?.body;

      // Any payer may extend any lease (ADR 0005), so there is no Lease
      // Request here and no token — wrapping it would be `invalid_request`, at
      // full price.
      expect(sent).toEqual({ workload_id: workloadId });
    });

    it('refuses to address a provider that is not in the set', async () => {
      await expect(workloads.extend(workloadId, { member: 'f'.repeat(64) })).rejects.toThrow(
        /not a member/u
      );
      expect(dashPort.sent).toHaveLength(0);
    });

    it('shows a Takeover, who won and WHEN it was announced', async () => {
      // After a Takeover the two members answer different things, which is the
      // whole reason a card asks every member rather than the primary alone.
      answers['g.toon.provider'] = statusOk({
        role: 'primary',
        state: 'stopped',
        access: null,
        expiresAt: 1_790_003_600,
        takeover: { winner: STANDBY },
      });
      answers['g.toon.provider2'] = statusOk({
        role: 'standby',
        state: 'running',
        expiresAt: 1_790_003_600,
        takeover: { winner: STANDBY },
      });
      takeover = {
        state: 'settled',
        claims: [
          {
            claimant: STANDBY,
            index: 1,
            primary: PRIMARY,
            createdAt: 1_790_000_123,
            announcedAt: '2026-09-23T00:15:23.000Z',
            eventId: 'a'.repeat(64),
          },
        ],
        winner: {
          claimant: STANDBY,
          index: 1,
          primary: PRIMARY,
          createdAt: 1_790_000_123,
          announcedAt: '2026-09-23T00:15:23.000Z',
          eventId: 'a'.repeat(64),
        },
        rounds: 1,
        relays: [],
        readAt: '2026-09-23T00:20:00.000Z',
      };

      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.set.takeover?.winner).toBe(STANDBY);
      expect(card.set.takeover?.from).toBe(PRIMARY);
      expect(card.set.takeover?.seenBy).toBe('claim');
      expect(card.set.takeover?.announcedAt).toBe('2026-09-23T00:15:23.000Z');
      expect(card.set.runningMember).toBe(STANDBY);
      expect(card.members[1]?.runningNow).toBe(true);
      // "A position in the set never changes": the winner still answers
      // `role: standby` (§6.7).
      expect(card.members[1]?.role).toBe('standby');
    });

    it('names the winner from `status` alone when no claim can be read', async () => {
      answers['g.toon.provider2'] = statusOk({
        role: 'standby',
        state: 'running',
        expiresAt: 1_790_003_600,
        takeover: { winner: STANDBY },
      });
      takeover = {
        state: 'unread',
        reason: 'no relay answered',
        claims: [],
        rounds: 0,
        relays: [],
        readAt: '2026-09-23T00:20:00.000Z',
      };

      const card = await workloads.card(workloadId, { refresh: true });

      expect(card.set.takeover?.winner).toBe(STANDBY);
      // It says WHERE it learned that, rather than inventing a moment.
      expect(card.set.takeover?.seenBy).toBe('status');
      expect(card.set.takeover?.announcedAt).toBeUndefined();
      expect(card.set.takeover?.firstSeenAt).toBeDefined();
    });

    it('extends the Takeover winner at the RUNNING price: winning buys no time', async () => {
      answers['g.toon.provider2'] = (packet) =>
        packet.route.endsWith('.extend') && !packet.route.endsWith('.standby.extend')
          ? {
              kind: 'answered',
              status: 200,
              body: { workload_id: workloadId, expires_at: 1_790_004_200 },
              text: '{}',
              cost: '1000',
            }
          : statusOk({
              role: 'standby',
              state: 'running',
              expiresAt: 1_790_003_600,
              takeover: { winner: STANDBY },
            })(packet);

      const result = await workloads.extend(workloadId, { member: STANDBY });

      expect(result.op).toBe('extend');
      expect(result.route?.route).toBe('g.toon.provider2.warm.v1.extend');
      expect(result.route?.price).toBe('1000');
      expect(result.sent).toBe(true);
    });

    it('tells a SELF-STOPPED primary from an expired lease', async () => {
      answers['g.toon.provider'] = statusOk({
        role: 'primary',
        state: 'stopped',
        access: null,
        expiresAt: 1_790_003_600,
      });

      const stopped = await workloads.card(workloadId, { refresh: true });

      expect(stopped.members[0]?.selfStopped).toBe(true);
      expect(
        stopped.members[0]?.status.kind === 'read' && stopped.members[0].status.life
      ).toEqual({ phase: 'stopped' });
      // The lease STANDS: still paid, and still extendable at the running
      // price (§7.1 "Stopping is not ending").
      expect(stopped.members[0]?.extend.ok).toBe(true);
      expect(stopped.members[0]?.extend.op).toBe('extend');

      answers['g.toon.provider'] = statusOk({
        role: 'primary',
        state: { ended: 'expiry' },
        access: null,
      });
      const expired = await workloads.card(workloadId, { refresh: true });

      expect(expired.members[0]?.selfStopped).toBe(false);
      expect(
        expired.members[0]?.status.kind === 'read' && expired.members[0].status.life
      ).toEqual({ phase: 'ended', ending: 'expiry' });
      // An ended lease cannot be extended at all: §6.3 answers `expired`, and
      // bills for the answer.
      expect(expired.members[0]?.extend.ok).toBe(false);
      expect(expired.members[0]?.extend.problems.join(' ')).toContain('Expiry');
    });

    it('counts the runway across the whole set, not just the primary', async () => {
      const card = await workloads.card(workloadId, { refresh: true });

      // One round is the primary's 1000 plus the reservation's 400. Each
      // member draws on its own connector's channel, so the round is bounded
      // by the thinner of the two.
      expect(card.runway.setPricePerInterval).toBe('1400');
      expect(card.set.pricePerInterval).toBe('1400');
      expect(card.runway.memberRunways).toHaveLength(2);
      expect(card.runway.memberRunways?.[1]?.op).toBe('standby.extend');
      expect(card.runway.memberRunways?.[1]?.pricePerInterval).toBe('400');
      expect(card.runway.boundBy).toBeDefined();
    });

    it('terminates ONE member: the reservation goes, the primary stands', async () => {
      answers['g.toon.provider2'] = (packet) =>
        packet.route.endsWith('.terminate')
          ? {
              kind: 'answered',
              status: 200,
              body: { workload_id: workloadId, state: { ended: 'termination' } },
              text: '{}',
            }
          : statusOk({
              role: 'standby',
              state: 'reserved',
              access: null,
              expiresAt: 1_790_003_600,
            })(packet);

      await workloads.card(workloadId, { refresh: true });
      const result = await workloads.terminate(workloadId, { member: STANDBY });

      expect(result.member).toBe(STANDBY);
      expect(result.route?.route).toBe('g.toon.provider2.terminate');
      expect(result.ended).toBe('termination');
      // The primary's own lease is untouched: a Termination releases the lease
      // it names and nothing else (§6.6).
      expect(result.card.members[0]?.status.kind).toBe('read');
    });

    it('asks every member, and each with its own Continuation Token', async () => {
      await dashboard();
      const record = await vaulted();
      const asked = dashPort.sent.filter((packet) => packet.route.endsWith('.status'));

      expect(asked.map((packet) => packet.route).sort()).toEqual([
        'g.toon.provider.status',
        'g.toon.provider2.status',
      ]);
      const tokens = asked.map(
        (packet) =>
          (packet.body as { request: { continuation: string; provider: string } }).request
      );
      expect(tokens[0]?.continuation).toBe(
        continuationFor(record?.root_secret ?? '', tokens[0]?.provider ?? '')
      );
      expect(tokens[1]?.continuation).toBe(
        continuationFor(record?.root_secret ?? '', tokens[1]?.provider ?? '')
      );
      expect(tokens[0]?.continuation).not.toBe(tokens[1]?.continuation);
    });
  });
});
