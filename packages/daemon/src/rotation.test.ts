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
import { continuationFor, gatewaySub } from './continuation.js';
import type { DirectoryResult } from './directory.js';
import { gatewayFixture, gatewayHealth, handoverOk } from './gateway.testkit.js';
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
import type { LeasePacket, PacketOutcome, StandbySetSpawnRequest } from './lease.js';
import { LEASE_VAULT_KIND, type VaultedLease } from './lease-vault.js';
import { InMemoryLeaseVaultCache } from './lease-vault-cache.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import type { RotationStore } from './rotation.js';
import { byRoute, rotatedOk, rotationFixture, unavailable } from './rotation.testkit.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';
import type { WorkloadStore } from './workload.js';
import {
  providerRoutes,
  refusal,
  silence,
  statusOk,
  workloadFixture,
} from './workload.testkit.js';

/**
 * **Rotation** (TOON_Network#96, spec §6.8, ADR 0018, ADR 0021).
 *
 * Six things this ticket has to get right, and each one is a different way of
 * lying to somebody whose token has leaked.
 *
 * **The new Root Secret is recorded before the first request.** Not after the
 * answer, and not "as well". A member that accepts `next` while this console
 * holds no record of where `next` came from is a paid, running workload nobody
 * can read, extend or stop.
 *
 * **Both roots are held until every member confirms.** A partially rotated set
 * is a valid state (§6.8), and it is only valid because each member is read
 * with whichever root holds it.
 *
 * **A member that cannot be reached does not block the rest**, and what is
 * left is resumable — with the SAME new root, never a third.
 *
 * **`unavailable` is a refusal.** Nothing changed and the old token still
 * works, so it is shown as retryable and never as success, and the retry is a
 * rotate rather than a `status` probe (TOON_Network#78).
 *
 * **A lost answer is settled by reading.** A replay is `stale_request` and the
 * old token is `not_tenant`, so the only thing that settles it is a `status`
 * presenting `next` (ADR 0018's Consequences).
 *
 * **Nothing derived from a Root Secret leaves the vault.** Two roots now, and
 * neither one — nor any token or grant of either — appears in an answer.
 */

const RELAY = 'wss://own.relay.test';
const PRIMARY = 'd'.repeat(64);
const STANDBY = 'e'.repeat(64);
const PRIMARY_CONNECTOR = 'https://provider.example/ilp';
const STANDBY_CONNECTOR = 'https://provider2.example/ilp';
const SECONDS = 1_790_000_000;

/** Two providers selling `warm`, as the sandbox's two do. */
function twoProviders(): () => Promise<DirectoryResult> {
  const warm = { name: 'warm', version: 1, leaseIntervalSeconds: 600, price: 1000 };
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
          listing: { ...warm, standbyPrice: 400, address: `30432:${STANDBY}:warm` },
        }),
      ],
      listingsWithoutProfile: 0,
      rejectedEvents: 0,
      readAt: '2026-09-23T00:00:00.000Z',
    } as DirectoryResult);
}

/** Each provider's own connector, pricing its four free routes at zero (§5). */
function twoConnectors(asked: NetworkProfile): Promise<ConnectorHealth> {
  const routes = asked.connectorUrl.includes('provider2.example')
    ? providerRoutes({ ilpAddress: 'g.toon.provider2', listing: 'warm', standbyPrice: '400' })
    : asked.connectorUrl.includes('provider.example')
      ? providerRoutes({ ilpAddress: 'g.toon.provider', listing: 'warm', standbyPrice: '400' })
      : [];
  return Promise.resolve(connectorHealth({ endpoint: asked.connectorUrl, routes }));
}

/** The §6.2 answer each member gives its own spawn. */
function setSpawnOk(packet: LeasePacket): PacketOutcome {
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
}

describe('rotating a lease’s Continuation Token across its Standby Set', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let leases: LeaseFixture;
  let port: FakeProviderPort;
  let workloads: WorkloadStore;
  let rotation: RotationStore;
  let workloadId: string;
  let oldRoot: string;

  const request: StandbySetSpawnRequest = {
    ...GOOD_SPAWN,
    listing: 'warm',
    standbys: [{ provider: STANDBY, listing: 'warm' }],
  };

  /** The lease-vault event the relay serves right now, newest last. */
  const vaultEvent = () => {
    const events = relay.events
      .filter(
        (candidate) =>
          candidate.kind === LEASE_VAULT_KIND &&
          (candidate.tags.find((tag) => tag[0] === 'd')?.[1] ?? '').startsWith(
            'toon-console/lease/'
          )
      )
      .sort((left, right) => left.created_at - right.created_at);
    return events.at(-1);
  };

  /** One sealed record, opened. This is where both root secrets live. */
  const unseal = async (event = vaultEvent()): Promise<VaultedLease> => {
    if (event === undefined) throw new Error('no vault record');
    return JSON.parse(await account.unsealFromSelf(event.content)) as VaultedLease;
  };

  /** The vault record as it stands on the relay, unsealed. Holds the secrets. */
  const vaulted = (): Promise<VaultedLease> => unseal();

  const requestIn = (packet: LeasePacket | undefined) =>
    (packet?.body as { request: Record<string, unknown> } | undefined)?.request;

  const build = (answer: Parameters<typeof fakeProviderPort>[0]) => {
    port = fakeProviderPort(answer);
    ({ workloads } = workloadFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      provider: port,
      notes: new InMemoryWorkloadNoteStore(),
      directory: twoProviders(),
      health: twoConnectors,
      now: () => new Date(SECONDS * 1000),
    }));
    rotation = rotationFixture({
      vault: leases.vault,
      ops: workloads.memberOps(),
      now: () => new Date(SECONDS * 1000),
    });
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-rotation-'));
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

    const spawnPort = fakeProviderPort(setSpawnOk);
    leases = leaseFixture({
      account,
      chainSeed: seed,
      paths,
      dial: fakeRelayNetwork([relay]),
      relays: [RELAY],
      relayServer: relay,
      provider: spawnPort,
      cache: new InMemoryLeaseVaultCache(),
      directory: twoProviders(),
      health: twoConnectors,
    });
    giveChannel(paths, SANDBOX.id, PRIMARY_CONNECTOR);
    giveChannel(paths, SANDBOX.id, STANDBY_CONNECTOR, 'evm:31337', '0xchannel2');
    await leases.vault.refresh();
    const spawned = await leases.leases.spawnSet(request);
    workloadId = spawned.lease!.workloadId;
    oldRoot = (await vaulted()).root_secret;
    build(rotatedOk);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------------- */

  describe('what one rotate request says (§6.8)', () => {
    it('presents the token the member holds and names one derived from a FRESH root', async () => {
      const result = await rotation.rotate(workloadId);
      const record = await vaulted();

      expect(result.rotated).toBe(true);
      // A fresh Root Secret, not a fresh token: §6.8 recommends it so the
      // rotation retires the OLD root as well.
      expect(record.root_secret).not.toBe(oldRoot);
      const [first, second] = port.sent;
      expect(requestIn(first)?.continuation).toBe(continuationFor(oldRoot, PRIMARY));
      expect((requestIn(first)?.content as { next: string }).next).toBe(
        continuationFor(record.root_secret, PRIMARY)
      );
      // Per member, under that member's own key — so no member of the set can
      // rotate another's lease with what it was given (§6.1.1, §7).
      expect(requestIn(second)?.continuation).toBe(continuationFor(oldRoot, STANDBY));
      expect((requestIn(second)?.content as { next: string }).next).toBe(
        continuationFor(record.root_secret, STANDBY)
      );
    });

    it('carries §6.1’s six keys and a content of exactly `{ workload_id, next }`', async () => {
      await rotation.rotate(workloadId);
      const sent = requestIn(port.sent[0]);

      expect(Object.keys(sent ?? {}).sort()).toEqual([
        'content',
        'continuation',
        'expiration',
        'op',
        'provider',
        'request_id',
      ]);
      expect(sent?.op).toBe('rotate');
      expect(sent?.provider).toBe(PRIMARY);
      // A field this spec does not name is `invalid_request` (ADR 0004), and a
      // `gateway_expires_at` here is refused on the shape (§6.5.1, §6.8).
      expect(Object.keys(sent?.content as object).sort()).toEqual(['next', 'workload_id']);
      expect(JSON.stringify(port.sent[0]?.body)).not.toContain('gateway_expires_at');
    });

    it('sends one request per member, each on that member’s own free route', async () => {
      await rotation.rotate(workloadId);

      expect(port.sent.map((packet) => packet.route)).toEqual([
        'g.toon.provider.rotate',
        'g.toon.provider2.rotate',
      ]);
      // Bought where it is free (§5): a hop that charges to carry a free route
      // is not where it is bought (TOON_Network#93's rule, borrowed whole).
      expect(port.sent.map((packet) => packet.payAt)).toEqual([
        PRIMARY_CONNECTOR,
        STANDBY_CONNECTOR,
      ]);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the vault record (ADR 0021)', () => {
    it('is written BEFORE the first request leaves', async () => {
      expect((await vaulted()).rotation).toBeUndefined();
      let atFirstPacket: ReturnType<typeof vaultEvent>;
      port.answer = (packet) => {
        atFirstPacket ??= vaultEvent();
        return rotatedOk(packet);
      };

      await rotation.rotate(workloadId);

      // The record the relay was serving when the FIRST packet went out
      // already named the new root. A crash between that packet and its answer
      // therefore loses nothing: the secret that now reads this member is on
      // the account's own relays (ADR 0021).
      const seen = await unseal(atFirstPacket);
      expect(seen.rotation?.root_secret).toBe((await vaulted()).root_secret);
      expect(seen.rotation?.confirmed).toEqual([]);
      expect(seen.root_secret).toBe(oldRoot);
    });

    it('holds BOTH roots while a member has not confirmed, and only the new one after', async () => {
      // The standby takes the rotate and says nothing, and says nothing to the
      // `status` that follows either: whether it rotated is not known.
      port.answer = (packet) =>
        packet.route.startsWith('g.toon.provider2') ? silence() : rotatedOk(packet);
      const partial = await rotation.rotate(workloadId);
      const midway = await vaulted();

      expect(partial.rotated).toBe(false);
      expect(partial.confirmed).toBe(1);
      expect(partial.of).toBe(2);
      // Both roots, and `root_secret` is still the OLD one: the member that
      // has not confirmed is still read with it.
      expect(midway.root_secret).toBe(oldRoot);
      expect(midway.rotation?.root_secret).toBeDefined();
      expect(midway.rotation?.confirmed).toEqual([PRIMARY]);

      // Each member is read with whichever root holds it — which is what makes
      // a partially rotated set a state rather than a breakage.
      port.answer = statusOk();
      await workloads.readStatus(workloadId, { member: PRIMARY });
      expect(requestIn(port.sent.at(-1))?.continuation).toBe(
        continuationFor(midway.rotation!.root_secret, PRIMARY)
      );
      await workloads.readStatus(workloadId, { member: STANDBY });
      expect(requestIn(port.sent.at(-1))?.continuation).toBe(
        continuationFor(oldRoot, STANDBY)
      );
    });

    it('resumes with the SAME new root and asks only the members that have not confirmed', async () => {
      port.answer = (packet) =>
        packet.route.startsWith('g.toon.provider2') ? silence() : rotatedOk(packet);
      await rotation.rotate(workloadId);
      const midway = await vaulted();
      const newRoot = midway.rotation!.root_secret;

      port.answer = rotatedOk;
      const sentBefore = port.sent.length;
      const finished = await rotation.rotate(workloadId);
      const after = await vaulted();

      // One packet, to the one member that had not confirmed.
      expect(port.sent.slice(sentBefore).map((packet) => packet.route)).toEqual([
        'g.toon.provider2.rotate',
      ]);
      expect(finished.rotated).toBe(true);
      // The same new root, never a third: a third would strand the member the
      // second one already reached.
      expect(after.root_secret).toBe(newRoot);
      expect(after.rotation).toBeUndefined();
      expect(after.rotated_at).toBeDefined();
      expect(finished.members.find((member) => member.pubkey === PRIMARY)?.already).toBe(true);
    });

    it('rotates nothing, and mints nothing, when no member can be reached', async () => {
      // A connector that carries no `.rotate` at all: §5's route is not there
      // to be bought, so nothing is sent — and no relay write is bought to say
      // a rotation started.
      ({ workloads } = workloadFixture({
        vault: leases.vault,
        chainSeed: seed,
        paths,
        provider: port,
        notes: new InMemoryWorkloadNoteStore(),
        directory: twoProviders(),
        health: (asked) =>
          Promise.resolve(connectorHealth({ endpoint: asked.connectorUrl, routes: [] })),
      }));
      rotation = rotationFixture({ vault: leases.vault, ops: workloads.memberOps() });
      const before = vaultEvent();
      port.sent.length = 0;

      const result = await rotation.rotate(workloadId);

      expect(result.started).toBe(false);
      expect(result.rotated).toBe(false);
      expect(port.sent).toHaveLength(0);
      expect(vaultEvent()).toBe(before);
      expect((await vaulted()).rotation).toBeUndefined();
      expect(result.problems.join(' ')).toContain('no Root Secret was minted');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('what a member answers', () => {
    it('shows `unavailable` as RETRYABLE, not as success, and does not probe', async () => {
      port.answer = (packet) =>
        packet.route.startsWith('g.toon.provider.') ? unavailable() : rotatedOk(packet);
      const result = await rotation.rotate(workloadId);
      const record = await vaulted();
      const primary = result.members.find((member) => member.pubkey === PRIMARY);

      expect(primary?.rotated).toBe(false);
      expect(primary?.retryable).toBe(true);
      expect(primary?.providerError).toBe('unavailable');
      expect(primary?.message).toContain('NOTHING');
      // "`unavailable` is not a lost answer — the request WAS answered, and
      // refused" (§6.8), so no `status` probe follows it.
      expect(port.sent.filter((packet) => packet.route === 'g.toon.provider.status')).toEqual(
        []
      );
      expect(result.rotated).toBe(false);
      expect(record.rotation?.confirmed).toEqual([STANDBY]);
    });

    it('settles a LOST answer with a `status` presenting the new token', async () => {
      const record = () => vaulted();
      port.answer = byRoute({ rotate: silence('the socket closed'), status: statusOk() });
      const result = await rotation.rotate(workloadId);
      const after = await record();
      const primary = result.members.find((member) => member.pubkey === PRIMARY);

      expect(primary?.rotated).toBe(true);
      expect(primary?.recovered).toBe(true);
      // The probe presents `next`, and acceptance is the whole answer.
      const probe = port.sent.find((packet) => packet.route === 'g.toon.provider.status');
      expect(requestIn(probe)?.continuation).toBe(continuationFor(after.root_secret, PRIMARY));
      // Nothing was re-sent: a replay would be `stale_request` (ADR 0018).
      expect(
        port.sent.filter((packet) => packet.route === 'g.toon.provider.rotate')
      ).toHaveLength(1);
    });

    it('reads `not_tenant` on the rotate as an earlier run’s answer having landed', async () => {
      port.answer = byRoute({
        rotate: refusal('not_tenant', 'not the tenant'),
        status: statusOk(),
      });
      const result = await rotation.rotate(workloadId);

      expect(result.rotated).toBe(true);
      expect(result.members.every((member) => member.recovered === true)).toBe(true);
    });

    it('reads a `not_tenant` PROBE as the rotation not having taken effect', async () => {
      port.answer = byRoute({
        rotate: silence(),
        status: refusal('not_tenant', 'not the tenant'),
      });
      const result = await rotation.rotate(workloadId);
      const primary = result.members.find((member) => member.pubkey === PRIMARY);

      expect(primary?.rotated).toBe(false);
      expect(primary?.retryable).toBe(true);
      expect(primary?.message).toContain('old token still holds');
      expect((await vaulted()).rotation?.confirmed).toEqual([]);
    });

    it('reports a refusal about the LEASE without asking anything else', async () => {
      port.answer = refusal('expired', 'that lease has ended');
      const result = await rotation.rotate(workloadId);

      expect(result.rotated).toBe(false);
      expect(result.members[0]?.providerError).toBe('expired');
      expect(result.members[0]?.retryable).toBeUndefined();
      expect(result.members[0]?.message).toContain('has ended');
      expect(port.sent.some((packet) => packet.route.endsWith('.status'))).toBe(false);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('what rotating ends', () => {
    it('makes every later request present the new token', async () => {
      await rotation.rotate(workloadId);
      const record = await vaulted();

      port.answer = statusOk();
      await workloads.readStatus(workloadId, { member: PRIMARY });

      const presented = requestIn(port.sent.at(-1))?.continuation;
      expect(presented).toBe(continuationFor(record.root_secret, PRIMARY));
      // And it is NOT the value the provider stored at spawn: that one is
      // `not_tenant` from the moment the rotation took effect (ADR 0018).
      expect(presented).not.toBe(continuationFor(oldRoot, PRIMARY));
    });

    it('ends every Gateway Grant of the old token: a handover after it carries new ones', async () => {
      const gatewayPort = fakeProviderPort(handoverOk('example.gw.example'));
      const { gateway } = gatewayFixture({
        vault: leases.vault,
        chainSeed: seed,
        paths,
        port: gatewayPort,
        health: gatewayHealth(),
        now: () => new Date(SECONDS * 1000),
      });
      await gateway.handover(workloadId, { expiresIn: 3600 });
      const before = (
        gatewayPort.sent.at(-1)?.body as { handover: { standby_set: { grant: string }[] } }
      ).handover.standby_set.map((entry) => entry.grant);

      await rotation.rotate(workloadId);
      const record = await vaulted();

      await gateway.handover(workloadId, { expiresIn: 3600 });
      const after = (
        gatewayPort.sent.at(-1)?.body as { handover: { standby_set: { grant: string }[] } }
      ).handover.standby_set.map((entry) => entry.grant);

      // The old grants were derived from the old tokens, which no provider
      // stores any more: each one is `bad_grant` now (§6.5.1, §6.8).
      expect(after).not.toEqual(before);
      expect(before[0]).toBe(gatewaySub(continuationFor(oldRoot, PRIMARY), SECONDS + 3600));
      expect(after[0]).toBe(
        gatewaySub(continuationFor(record.root_secret, PRIMARY), SECONDS + 3600)
      );
      expect(after[1]).toBe(
        gatewaySub(continuationFor(record.root_secret, STANDBY), SECONDS + 3600)
      );
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('secrets', () => {
    it('never carries a Root Secret, a token or a grant in an answer', async () => {
      port.answer = byRoute({ rotate: silence(), status: statusOk() });
      const partial = await rotation.rotate(workloadId);
      const view = await rotation.view(workloadId);
      const record = await vaulted();
      const said = JSON.stringify([partial, view]);

      for (const secret of [oldRoot, record.root_secret, record.rotation?.root_secret]) {
        if (secret === undefined) continue;
        expect(said).not.toContain(secret);
        expect(said).not.toContain(continuationFor(secret, PRIMARY));
        expect(said).not.toContain(continuationFor(secret, STANDBY));
      }
    });

    it('refuses a workload this account holds no record of', async () => {
      await expect(rotation.rotate('f'.repeat(64))).rejects.toThrow(/holds no vault record/u);
    });
  });
});
