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
import { continuationFor, gatewaySub } from './continuation.js';
import { GatewayError, type GatewayStore } from './gateway.js';
import { canonicalLabel } from './gateway-name.js';
import {
  GATEWAY_CONNECTOR,
  GATEWAY_DOMAIN_SUFFIX,
  GATEWAY_ROUTE,
  GATEWAY_SEAL_KEY,
  NO_GRANT,
  SERVING,
  fakeProbe,
  gatewayFixture,
  gatewayHealth,
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
import type { SpawnRequest } from './lease.js';
import { InMemoryLeaseVaultCache } from './lease-vault-cache.js';
import { LeaseVault, type VaultedLease } from './lease-vault.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SANDBOX } from './profiles.js';
import { InMemoryWorkloadNoteStore } from './workload-cache.js';

/**
 * Handing a workload to a Workload Gateway, and taking it back
 * (TOON_Network#97, spec §12, §6.5.1).
 *
 * Five rules are pinned here, and the first two are the ones that would cost
 * somebody their lease if they broke.
 *
 * **A grant leaves this console in exactly one place.** Sealed, inside a
 * handover or a withdrawal. Never in an answer, never in a note on disk,
 * never in a message. Whoever holds a grant reads that lease's `status`.
 *
 * **One grant per member, derived from that member's own token.** Checked
 * against §6.5.1's arithmetic over the vault's real Root Secret rather than
 * against anything this test file made up, because a single value shared
 * across the set would be admitted at the primary and `bad_grant` everywhere
 * else — and a gateway resolving a workload asks all of them (§12.4).
 *
 * **The hostname is derived, not believed.** The console computes §12.2's
 * label itself and compares.
 *
 * **A withdrawal ends serving, not reading.** The answer says so, because a
 * person who thinks they revoked something will not rotate.
 *
 * **Nothing is sent that a check here could have caught.** A handover is
 * free, so this matters less than it does for an extension — but a gateway
 * rate-limits admission per member named (§12.1), and a console that fired
 * malformed handovers at it would spend a real lease's budget of attempts.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER = 'd'.repeat(64);
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const SECONDS = Math.floor(NOW.getTime() / 1000);

describe('the Workload Gateway', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let leases: LeaseFixture;
  let gateway: GatewayStore;
  let port: FakeProviderPort;
  let probe: FakeProbe;
  let notes: InMemoryWorkloadNoteStore;
  let workloadId: string;
  let hostname: string;

  const build = (
    input: {
      health?: Parameters<typeof gatewayFixture>[0]['health'];
      profile?: Parameters<typeof gatewayFixture>[0]['profile'];
    } = {}
  ) => {
    port = fakeProviderPort(handoverOk(hostname));
    probe = fakeProbe();
    notes = new InMemoryWorkloadNoteStore(() => NOW);
    ({ gateway } = gatewayFixture({
      vault: leases.vault,
      chainSeed: seed,
      paths,
      port,
      probe,
      notes,
      now: () => NOW,
      ...(input.health === undefined ? {} : { health: input.health }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    }));
  };

  /** The message the fake gateway was handed, for the last packet it took. */
  const lastBody = () => port.sent.at(-1)?.body as Record<string, unknown> | undefined;
  const lastHandover = () => lastBody()?.handover as Record<string, unknown>;
  const lastWithdrawal = () => lastBody()?.withdrawal as Record<string, unknown>;

  /**
   * The lease's real Continuation Token for a member, out of the vault — so a
   * grant is checked against §6.5.1's own arithmetic over the secret the
   * console actually holds, not against anything this file made up.
   */
  const tokenFor = async (member = PROVIDER): Promise<string> =>
    leases.vault.withContinuation(workloadId, member, (continuation) =>
      Promise.resolve(continuation)
    );

  /** The sealed record itself, unsealed the way a second machine would. */
  const vaulted = async (): Promise<VaultedLease> => {
    const event = relay.events
      .filter(
        (candidate) =>
          candidate.tags.find((tag) => tag[0] === 'd')?.[1] ===
          `toon-console/lease/${workloadId}`
      )
      .at(-1);
    return JSON.parse(await account.unsealFromSelf(event!.content)) as VaultedLease;
  };

  /**
   * Amend the vault record — what a standby (#95) adds and what a rotation
   * (#96) replaces.
   *
   * A rotation changes the Root Secret, and the vault rightly refuses to
   * publish a different secret over a record it already holds (that guard is
   * what stops a reused workload id destroying a lease). So the amended
   * record is published through a SECOND vault over the same account and the
   * same relay — which is exactly what a rotation run from another machine
   * looks like — and this console then reads it back the ordinary way.
   */
  const revault = async (changes: Partial<VaultedLease>): Promise<VaultedLease> => {
    const record = { ...(await vaulted()), ...changes } as VaultedLease;
    const elsewhere = new LeaseVault({
      signer: () => account,
      seedRelays: () => [RELAY],
      cache: new InMemoryLeaseVaultCache(),
      writer: fakePaidWriter(relay),
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
      // Strictly later than the record the spawn wrote, so NIP-01's
      // replacement is unambiguous. The spawn's clock is the real one; this
      // module's, deliberately, is not.
      now: () => new Date(Date.now() + 60_000),
    });
    await elsewhere.publish(record);
    await leases.vault.refresh();
    return record;
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-gateway-'));
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
    giveChannel(paths, SANDBOX.id, GATEWAY_CONNECTOR);
    await leases.vault.refresh();
    const spawned = await leases.leases.spawn(GOOD_SPAWN as SpawnRequest);
    workloadId = spawned.lease!.workloadId;
    hostname = `${canonicalLabel(workloadId)}.${GATEWAY_DOMAIN_SUFFIX}`;
    build();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------------- */

  describe('the hostname (§12.2)', () => {
    it('shows it before anything is handed over, and sends nothing to say so', async () => {
      const view = await gateway.view(workloadId);

      expect(view.hostname).toBe(hostname);
      expect(view.held).toBe(false);
      expect(view.handover).toBeUndefined();
      expect(port.sent).toHaveLength(0);
      expect(probe.knocked).toHaveLength(0);
    });

    it('names the gateway, its route and its price, all from its own GET /ilp', async () => {
      const view = await gateway.view(workloadId);

      expect(view.gateway).toEqual({
        connectorUrl: GATEWAY_CONNECTOR,
        ilpAddress: 'g.toon.workload-gateway',
        route: GATEWAY_ROUTE,
        price: '0',
        domain: GATEWAY_DOMAIN_SUFFIX,
      });
      expect(view.ok).toBe(true);
    });

    it('reports `no_grant` as the healthy empty state, not as a fault', async () => {
      probe.answer = NO_GRANT;
      const view = await gateway.view(workloadId, { probe: true });

      expect(probe.knocked).toEqual([`https://${hostname}/`]);
      expect(view.serving?.kind).toBe('no_grant');
      expect(view.problems).toEqual([]);
    });

    it('shows no hostname on a profile that names no gateway', async () => {
      build({ profile: gatewayProfile({ gatewayDomain: '', gatewayConnectorUrl: '' }) });
      const view = await gateway.view(workloadId);

      expect(view.hostname).toBeUndefined();
      expect(view.ok).toBe(false);
      expect(view.problems.join(' ')).toContain('names no Workload Gateway');
    });

    it('refuses a workload this account holds no lease for', async () => {
      await expect(gateway.view('f'.repeat(64))).rejects.toBeInstanceOf(GatewayError);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('a handover (§12.1)', () => {
    it('derives §6.5.1’s grant for each member, from that member’s OWN token', async () => {
      await gateway.handover(workloadId, { expiresIn: 3600 });
      const message = lastHandover();
      const set = message.standby_set as { provider: string; grant: string }[];

      expect(set).toHaveLength(1);
      expect(set[0]!.provider).toBe(PROVIDER);
      // The whole point: not a value this file invented, but the spec's own
      // arithmetic over the Root Secret the vault really holds.
      expect(set[0]!.grant).toBe(gatewaySub(await tokenFor(), message.expires_at as number));
      expect(set[0]!.grant).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('sends §12.1’s message under its one key, with no field the spec does not name', async () => {
      await gateway.handover(workloadId, { expiresIn: 3600, name: 'blog' });

      expect(Object.keys(lastBody()!)).toEqual(['handover']);
      expect(Object.keys(lastHandover()).sort()).toEqual([
        'expires_at',
        'http_port',
        'name',
        'standby_set',
        'workload_id',
      ]);
      expect(lastHandover().workload_id).toBe(workloadId);
      expect(lastHandover().expires_at).toBe(SECONDS + 3600);
      // The CONTAINER port the spawn asked for. The gateway maps it through
      // the provider's `access.ports` itself (§12.4 step 5).
      expect(lastHandover().http_port).toBe(80);
    });

    it('seals to the gateway connector’s own key and buys the route where it is free', async () => {
      await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(port.sent.at(-1)?.route).toBe(GATEWAY_ROUTE);
      // Not the profile's connector: a hop that merely forwards would charge
      // its own fee for a message the gateway prices at nothing (spec §5).
      expect(port.sent.at(-1)?.payAt).toBe(GATEWAY_CONNECTOR);
      expect(port.sent.at(-1)?.sealTo).toBe(GATEWAY_SEAL_KEY);
    });

    it('shows the hostname the gateway answered, and that it is the one derived', async () => {
      port.answer = handoverOk(hostname, SECONDS + 3600);
      const result = await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(result.sent).toBe(true);
      expect(result.hostname).toBe(hostname);
      expect(result.expectedHostname).toBe(hostname);
      expect(result.matches).toBe(true);
      expect(result.view.held).toBe(true);
    });

    it('says when the gateway answered a hostname this console did not derive', async () => {
      // Nothing in the protocol stops a gateway answering anything it likes,
      // and a person acting on a name nobody else can derive would be stuck.
      port.answer = handoverOk('somebody-elses-name.gw.example');
      const result = await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(result.matches).toBe(false);
      expect(result.expectedHostname).toBe(hostname);
    });

    it('reports `not_admitted` as a fact about the LEASE, and drops nothing of its own', async () => {
      port.answer = gatewayRefusal('not_admitted', 'nobody vouched');
      const result = await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(result.sent).toBe(true);
      expect(result.gatewayError).toBe('not_admitted');
      expect(result.message).toContain('none of them accepted');
      expect(result.message).toContain('rotated');
      // Nothing was admitted, so this console holds nothing either.
      expect(result.view.held).toBe(false);
      expect(result.view.handover).toBeUndefined();
    });

    it('keeps `admission_failed` apart from `not_admitted`', async () => {
      port.answer = gatewayRefusal('admission_failed', 'a relay was down');
      const result = await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(result.gatewayError).toBe('admission_failed');
      expect(result.message).toContain('could not carry the request out');
      expect(result.message).not.toContain('none of them accepted');
    });

    it('carries through a refusal code this build has never heard of', async () => {
      // §12 requires a reader not to refuse a code it does not know.
      port.answer = gatewayRefusal('some_future_code', 'from a later gateway');
      const result = await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(result.gatewayError).toBe('some_future_code');
      expect(result.message).toContain('some_future_code');
    });

    it('refuses a moment already past, sending nothing', async () => {
      const result = await gateway.handover(workloadId, { expiresAt: SECONDS - 1 });

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('already out of force');
      expect(port.sent).toHaveLength(0);
    });

    it('refuses a name that is not one DNS label, sending nothing', async () => {
      for (const name of ['Blog', 'a.b', '-x', 'x'.repeat(64)]) {
        const result = await gateway.handover(workloadId, { expiresIn: 60, name });
        expect(result.sent, name).toBe(false);
        expect(result.problems.join(' '), name).toContain('one DNS label');
      }
      expect(port.sent).toHaveLength(0);
    });

    it('refuses a port the spawn never asked for, sending nothing', async () => {
      const result = await gateway.handover(workloadId, { expiresIn: 60, httpPort: 9999 });

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('nothing to forward to');
      expect(port.sent).toHaveLength(0);
    });

    it('refuses both `expiresAt` and `expiresIn`, rather than picking one', async () => {
      const result = await gateway.handover(workloadId, {
        expiresAt: SECONDS + 60,
        expiresIn: 60,
      });

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('not both');
      expect(port.sent).toHaveLength(0);
    });

    it('does not decide on its own what a silent gateway did', async () => {
      port.answer = { kind: 'unknown', message: 'the socket closed' };
      probe.answer = SERVING;
      const result = await gateway.handover(workloadId, { expiresIn: 3600 });

      expect(result.sent).toBe(true);
      expect(result.message).toContain('unknown');
      // The hostname is the authority, and asking it is free.
      expect(probe.knocked).toEqual([`https://${hostname}/`]);
      expect(result.view.serving?.kind).toBe('serving');
    });

    it('names the price when no connector carries the route for nothing', async () => {
      build({
        health: gatewayHealth({ routes: [{ prefix: GATEWAY_ROUTE, price: '250' }] }),
      });
      const result = await gateway.handover(workloadId, { expiresIn: 60 });

      // There IS a channel at the gateway's connector here, so it goes — and
      // the route it went on carries the price so a person can see it.
      expect(result.route?.price).toBe('250');
      expect(result.route?.reason).toContain('terminates it');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('what is remembered', () => {
    it('keeps no grant, no token and no secret anywhere on disk', async () => {
      await gateway.handover(workloadId, { expiresIn: 3600 });
      const grant = (lastHandover().standby_set as { grant: string }[])[0]!.grant;
      const note = notes.read(account.pubkey, workloadId);

      expect(note?.gateway).toBeDefined();
      expect(JSON.stringify(note)).not.toContain(grant);
      expect(JSON.stringify(note)).not.toContain((await vaulted()).root_secret);
      expect(JSON.stringify(note)).not.toContain(await tokenFor());
      // What it keeps instead is the two inputs that derive the same grant.
      expect(note?.gateway?.expiresAt).toBe(SECONDS + 3600);
      expect(note?.gateway?.standbySet).toEqual([PROVIDER]);
    });

    it('puts no grant into any answer, on success or on a refusal', async () => {
      const admitted = await gateway.handover(workloadId, { expiresIn: 3600 });
      const grant = (lastHandover().standby_set as { grant: string }[])[0]!.grant;
      expect(JSON.stringify(admitted)).not.toContain(grant);

      port.answer = gatewayRefusal('not_admitted');
      const refused = await gateway.handover(workloadId, { expiresIn: 3600 });
      expect(JSON.stringify(refused)).not.toContain(grant);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('a withdrawal (§12.7)', () => {
    beforeEach(async () => {
      port.answer = handoverOk(hostname, SECONDS + 3600);
      await gateway.handover(workloadId, { expiresIn: 3600 });
      port.answer = withdrawalOk(hostname);
    });

    it('bears the grant in force, re-derived from the moment the handover named', async () => {
      await gateway.withdraw(workloadId);
      const message = lastWithdrawal();

      expect(Object.keys(lastBody()!)).toEqual(['withdrawal']);
      expect(Object.keys(message).sort()).toEqual([
        'expires_at',
        'standby_set',
        'workload_id',
      ]);
      expect(message.expires_at).toBe(SECONDS + 3600);
      expect((message.standby_set as { grant: string }[])[0]!.grant).toBe(
        gatewaySub(await tokenFor(), SECONDS + 3600)
      );
    });

    it('carries no `http_port` and no `name` — those are a handover’s', async () => {
      await gateway.withdraw(workloadId);

      expect(lastWithdrawal()).not.toHaveProperty('http_port');
      expect(lastWithdrawal()).not.toHaveProperty('name');
    });

    it('says that it ended SERVING and not reading, and names what would', async () => {
      const result = await gateway.withdraw(workloadId);

      expect(result.withdrawn).toBe(true);
      expect(result.message).toContain('ends serving, not reading');
      expect(result.message).toContain('Rotating');
      expect(result.view.held).toBe(false);
      expect(result.view.handover?.withdrawnAt).toBe(NOW.toISOString());
    });

    it('refuses to send one for a workload it never handed over', async () => {
      const second = await leases.leases.spawn({
        ...(GOOD_SPAWN as SpawnRequest),
        workloadId: 'c'.repeat(64),
      });
      const result = await gateway.withdraw(second.lease!.workloadId);

      expect(result.sent).toBe(false);
      expect(result.problems.join(' ')).toContain('knows of no grant to bear');
      // One packet only: the handover from the `beforeEach`.
      expect(port.sent).toHaveLength(1);
    });

    it('reports `not_withdrawn` without pretending anything changed', async () => {
      port.answer = gatewayRefusal('not_withdrawn', 'not serving that');
      const result = await gateway.withdraw(workloadId);

      expect(result.gatewayError).toBe('not_withdrawn');
      expect(result.withdrawn).toBeUndefined();
      expect(result.view.held).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('rotation and takeover', () => {
    it('re-hands a grant derived from whatever token the vault holds NOW', async () => {
      // The seam TOON_Network#96 fills: a rotation replaces the Root Secret in
      // the vault record, and this derives through the vault every time — so a
      // handover after a rotation carries the NEW token's grant with nothing
      // here to change. The rotation itself is #96's; what is pinned here is
      // that this module reads rather than remembers.
      await gateway.handover(workloadId, { expiresIn: 3600 });
      const before = (lastHandover().standby_set as { grant: string }[])[0]!.grant;

      await revault({ root_secret: 'a'.repeat(64) });

      await gateway.handover(workloadId, { expiresIn: 3600 });
      const after = (lastHandover().standby_set as { grant: string }[])[0]!.grant;

      expect(after).not.toBe(before);
      expect(after).toBe(
        gatewaySub(continuationFor('a'.repeat(64), PROVIDER), SECONDS + 3600)
      );
    });

    it('derives one grant for every member of the Standby Set, primary first', async () => {
      // The seam TOON_Network#95 fills: whatever a Standby Set grows to, this
      // derives per member, because `gateway_sub` is per member (§6.1.1, §7).
      const standby = 'b'.repeat(64);
      const record = await revault({ standby_set: [PROVIDER, standby] });

      await gateway.handover(workloadId, { expiresIn: 3600 });
      const set = lastHandover().standby_set as { provider: string; grant: string }[];

      expect(set.map((entry) => entry.provider)).toEqual([PROVIDER, standby]);
      expect(set[0]!.grant).not.toBe(set[1]!.grant);
      expect(set[1]!.grant).toBe(
        gatewaySub(continuationFor(record.root_secret, standby), SECONDS + 3600)
      );
    });

    it('keeps serving the same hostname across a takeover, because the id is what it names', async () => {
      // §12.2's label is a function of the workload id alone, and §12.4 has
      // the gateway resolve that id across the whole set — so a Takeover
      // changes which member answers and changes nothing about the name.
      await gateway.handover(workloadId, { expiresIn: 3600 });
      const before = (await gateway.view(workloadId)).hostname;

      await revault({ standby_set: ['b'.repeat(64), PROVIDER] });

      probe.answer = SERVING;
      const after = await gateway.view(workloadId, { probe: true });
      expect(after.hostname).toBe(before);
      expect(after.serving?.kind).toBe('serving');
    });
  });
});
