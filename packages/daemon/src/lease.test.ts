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
import { continuationFor } from './continuation.js';
import type { DirectoryResult } from './directory.js';
import { LeaseError, REQUEST_WINDOW_S, routeCarries, type SpawnRequest } from './lease.js';
import {
  GOOD_SPAWN,
  connectorHealth,
  fakeProvider,
  fakeAnon,
  fakeProviderPort,
  giveChannel,
  leaseFixture,
  spawnOk,
  spawnRefused,
  type FakeProviderPort,
  type LeaseFixture,
} from './lease.testkit.js';
import { LEASE_VAULT_KIND, type VaultedLease } from './lease-vault.js';
import {
  buildSpawnContent,
  canonicalSpawnContent,
  type SpawnContent,
} from './spawn-content.js';
import { InMemoryLeaseVaultCache } from './lease-vault-cache.js';
import { consolePaths, profileDataDir, type ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';

/**
 * Spawning a workload (TOON_Network#92, spec §6.1, §6.2).
 *
 * Three rules are pinned here, and each of them costs real money when it is
 * broken.
 *
 * **Nothing is sent that could have been caught first.** A refused paid
 * request is still billed (spec §5, ADR 0003, TOON_Network#115), so every case
 * below that refuses a request also asserts that NO packet went out.
 *
 * **The vault record is written before the packet.** The provider fake looks
 * at the relay when it is asked to send, and finds the record already there.
 *
 * **A refusal leaves nothing behind.** A provider that answered `{ "error" }`
 * on a paid route took the money and started nothing, so the record goes and
 * the provider's own code is what a person is shown.
 */

const RELAY = 'wss://own.relay.test';
const PROVIDER = 'd'.repeat(64);
const PROVIDER_CONNECTOR = 'https://provider.example/ilp';

describe('spawning a workload', () => {
  let home: string;
  let paths: ConsolePaths;
  let relay: FakeRelayServer;
  let account: FakeAccount;
  let seed: ChainSeedStore;
  let port: FakeProviderPort;
  let fixture: LeaseFixture;

  const build = async (
    input: {
      directory?: () => Promise<DirectoryResult>;
      health?: (profile: NetworkProfile) => Promise<ReturnType<typeof connectorHealth>>;
      channelAt?: string | null;
      hidden?: ReturnType<typeof fakeAnon> | null;
    } = {}
  ) => {
    port = fakeProviderPort();
    fixture = leaseFixture({
      account,
      chainSeed: seed,
      paths,
      dial: fakeRelayNetwork([relay]),
      relays: [RELAY],
      relayServer: relay,
      provider: port,
      cache: new InMemoryLeaseVaultCache(),
      ...(input.directory === undefined ? {} : { directory: input.directory }),
      ...(input.health === undefined ? {} : { health: input.health }),
      ...(input.hidden === undefined || input.hidden === null ? {} : { hidden: input.hidden }),
    });
    // A rebuild starts from no channel at all: the binding lives in a file
    // under `paths`, and one left over from the default build would make the
    // "there is no channel" case pass for the wrong reason.
    rmSync(join(profileDataDir(paths, SANDBOX.id), 'channels'), {
      recursive: true,
      force: true,
    });
    if (input.channelAt !== null) {
      giveChannel(paths, SANDBOX.id, input.channelAt ?? PROVIDER_CONNECTOR);
    }
    await fixture.vault.refresh();
    return fixture;
  };

  /** The Lease Request the fake provider was handed, out of the packet. */
  const sentRequest = () =>
    (port.sent[0]?.body as { request: Record<string, unknown> } | undefined)?.request;

  /**
   * The vault records the relay holds.
   *
   * By `d` and not by kind: the Chain Seed is a kind-30078 of this account's
   * too (ADR 0020), and a test that counted kinds would count it.
   */
  const vaultEvents = () =>
    relay.events.filter(
      (candidate) =>
        candidate.kind === LEASE_VAULT_KIND &&
        (candidate.tags.find((tag) => tag[0] === 'd')?.[1] ?? '').startsWith(
          'toon-console/lease/'
        )
    );

  /** The sealed record the relay holds, opened with the account's own key. */
  const vaulted = async (): Promise<VaultedLease | undefined> => {
    const event = vaultEvents()[0];
    if (!event) return undefined;
    return JSON.parse(await account.unsealFromSelf(event.content)) as VaultedLease;
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-spawn-'));
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
    await build();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('a spawn that works', () => {
    it('vaults the Root Secret BEFORE the packet goes out', async () => {
      let recordWasThere = false;
      port.answer = (packet) => {
        recordWasThere = vaultEvents().length > 0;
        return spawnOk(packet);
      };

      const result = await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);

      expect(recordWasThere).toBe(true);
      expect(result.lease?.state).toBe('live');
    });

    it('sends a Lease Request of exactly §6.1’s six keys', async () => {
      await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
      const request = sentRequest();

      expect(Object.keys(request ?? {}).sort()).toEqual([
        'content',
        'continuation',
        'expiration',
        'op',
        'provider',
        'request_id',
      ]);
      expect(request?.op).toBe('spawn');
      expect(request?.provider).toBe(PROVIDER);
      expect(request?.request_id).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('presents the Continuation Token this lease’s Root Secret derives', async () => {
      await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
      const record = await vaulted();

      // The one thing that must agree across the vault and the wire: the token
      // the provider stores has to be the one this secret derives, or the
      // lease is bought and unreadable forever (spec §6.1.1).
      expect(sentRequest()?.continuation).toBe(continuationFor(record!.root_secret, PROVIDER));
    });

    it('sets an expiration inside the Request window (§7.2)', async () => {
      const before = Math.floor(Date.now() / 1000);
      await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
      const expiration = sentRequest()?.expiration as number;

      expect(expiration).toBeGreaterThan(before);
      expect(expiration).toBeLessThanOrEqual(before + REQUEST_WINDOW_S);
    });

    it('carries only the content fields §6.2 names', async () => {
      await fixture.leases.spawn({
        ...(GOOD_SPAWN as SpawnRequest),
        env: { GREETING: 'hello' },
        volumeGb: 2,
      });
      const content = sentRequest()?.content as Record<string, unknown>;

      expect(Object.keys(content).sort()).toEqual([
        'env',
        'image',
        'ports',
        'ssh_public_key',
        'volume_gb',
        'workload_id',
      ]);
      expect(content.ports).toEqual([{ container_port: 80, protocol: 'tcp' }]);
    });

    it('seals to the provider’s pinned connector key, never to whoever answered', async () => {
      await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
      expect(port.sent[0]?.sealTo).toBe('0x04aa');
      expect(port.sent[0]?.route).toBe('g.toon.provider.basic.v1.spawn');
    });

    it('writes the access details back into the vault record', async () => {
      const result = await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);

      expect(result.lease?.access?.host).toBe('203.0.113.7');
      expect(result.lease?.expiresAt).toBe(1_790_003_600);
      expect(result.cost).toBe('1000');
      expect((await vaulted())?.state).toBe('live');
    });

    it('never puts the Root Secret in what it answers', async () => {
      const result = await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
      const secret = (await vaulted())!.root_secret;
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(fixture.vault.status())).not.toContain(secret);
    });

    it('publishes nothing at all for a lease marked local only', async () => {
      await fixture.leases.spawn({ ...(GOOD_SPAWN as SpawnRequest), localOnly: true });

      expect(vaultEvents()).toHaveLength(0);
      expect(fixture.vault.list()[0]?.localOnly).toBe(true);
      // It still ran: local only is about where the secret lives, not whether
      // the workload does.
      expect(port.sent).toHaveLength(1);
    });
  });

  describe('a spawn from a Template (#94’s seam)', () => {
    /** What `expandTemplate` hands over: a §6.2 content, already built. */
    const expanded = () =>
      buildSpawnContent({
        image: { digest: GOOD_SPAWN.image.digest },
        env: { GREETING: 'hello' },
        ports: [{ container_port: 80, protocol: 'tcp' as const }],
        sshPublicKey: GOOD_SPAWN.sshPublicKey,
        template: `30436:${'9'.repeat(64)}:whoami`,
      });

    it('sends the expanded content UNCHANGED, and notes the Template', async () => {
      const content = expanded();
      const result = await fixture.leases.spawnFromTemplate({
        template: content.template!,
        provider: PROVIDER,
        listing: `30432:${PROVIDER}:basic`,
        listingVersion: 1,
        content,
      });

      // Nothing between the expansion and the wire reinterprets it.
      expect(canonicalSpawnContent(sentRequest()?.content as never)).toBe(
        canonicalSpawnContent(content)
      );
      expect(result.lease?.template).toBe(content.template);
    });

    it('is the SAME request as the equivalent manual spawn', async () => {
      const content = expanded();
      await fixture.leases.spawnFromTemplate({
        template: content.template!,
        provider: PROVIDER,
        listing: 'basic',
        listingVersion: 1,
        content,
      });
      const fromTemplate = sentRequest()?.content as SpawnContent;

      // The manual half spawns the SAME workload id on purpose, so the two
      // contents can be compared field for field — which means starting from a
      // console that has never heard of it. Reusing an id inside one account's
      // vault is refused, and rightly: it would replace a Root Secret.
      relay.events = relay.events.filter((event) => event.kind !== LEASE_VAULT_KIND);
      await build();
      await fixture.leases.spawn({
        ...(GOOD_SPAWN as SpawnRequest),
        image: { digest: GOOD_SPAWN.image.digest },
        env: { GREETING: 'hello' },
        workloadId: fromTemplate.workload_id,
      });
      const manual = sentRequest()?.content as SpawnContent;

      // The Template's own address is the ONE difference, and it is the field
      // §6.2 has for exactly that: informational provenance.
      const { template: _provenance, ...sameAsManual } = fromTemplate;
      expect(canonicalSpawnContent(sameAsManual)).toBe(canonicalSpawnContent(manual));
    });

    it('refuses a listing version that has been republished since (ADR 0009)', async () => {
      const content = expanded();
      await expect(
        fixture.leases.spawnFromTemplate({
          template: content.template!,
          provider: PROVIDER,
          listing: 'basic',
          listingVersion: 7,
          content,
        })
      ).rejects.toThrow(/republished at v1/u);
      expect(port.sent).toHaveLength(0);
    });

    it('refuses a Standby Set on the path that buys ONE lease (§7)', async () => {
      const content = buildSpawnContent({
        image: { digest: GOOD_SPAWN.image.digest },
        ports: [{ container_port: 80, protocol: 'tcp' as const }],
        sshPublicKey: GOOD_SPAWN.sshPublicKey,
        standbySet: [PROVIDER, 'e'.repeat(64)],
      });
      await expect(
        fixture.leases.spawnFromTemplate({
          template: `30436:${'9'.repeat(64)}:whoami`,
          provider: PROVIDER,
          listing: 'basic',
          listingVersion: 1,
          content,
        })
      ).rejects.toThrow(/buys one lease/u);
      expect(port.sent).toHaveLength(0);
    });
  });

  describe('a spawn that is refused', () => {
    it('leaves no vault record, and says what the provider said', async () => {
      port.answer = spawnRefused('no_capacity', 'nothing free here');

      await expect(fixture.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toMatchObject({
        code: 'spawn_refused',
        providerError: 'no_capacity',
      });

      expect(fixture.vault.list()).toHaveLength(0);
      expect(fixture.cache.read(account.pubkey).size).toBe(0);
      // A relay that honours NIP-09 has dropped it; this fake does not, so
      // what is left is the tombstone that replaced it — and the secret it
      // used to hold is not in it.
      const left = await vaulted();
      expect(left?.state).toBe('retracted');
      expect(left?.root_secret).toBe('0'.repeat(64));
    });

    it('says that a refusal was still billed (ADR 0003)', async () => {
      port.answer = spawnRefused('refused_image', 'that image is not allowed here');
      await expect(fixture.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toThrow(
        /still billed 1000 base units/u
      );
    });

    it('takes the record back when the packet itself was rejected', async () => {
      port.answer = {
        kind: 'refused',
        code: 'F03',
        refusedBy: 'destination',
        message: 'insufficient amount',
        cost: '0',
      };

      await expect(fixture.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toMatchObject({
        code: 'spawn_refused',
      });
      expect(fixture.vault.list()).toHaveLength(0);
    });

    it('refuses before publishing anything when the account has no Chain Seed', async () => {
      const stranger = fakeAccount();
      const nothing = leaseFixture({
        account: stranger,
        chainSeed: new ChainSeedStore({
          signer: () => stranger,
          seedRelays: () => [RELAY],
          cache: new InMemoryChainSeedCache(),
          writer: () => fakePaidWriter(relay),
          dial: fakeRelayNetwork([relay]),
          timeoutMs: 200,
        }),
        paths,
        dial: fakeRelayNetwork([relay]),
        relays: [RELAY],
        relayServer: relay,
        provider: port,
        cache: new InMemoryLeaseVaultCache(),
      });
      await nothing.vault.refresh();

      await expect(nothing.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toThrow(
        /no readable Chain Seed/u
      );
      expect(vaultEvents()).toHaveLength(0);
      expect(port.sent).toHaveLength(0);
    });

    it('takes the record back when the spawn never even left', async () => {
      // The payer keys could not be borrowed — a remote signer refused, say.
      // Nothing was paid and no lease exists, so the record must not either.
      const refusing = leaseFixture({
        account,
        chainSeed: {
          status: () => seed.status(),
          usePayerKeys: () => Promise.reject(new Error('the signer refused')),
        } as unknown as ChainSeedStore,
        paths,
        dial: fakeRelayNetwork([relay]),
        relays: [RELAY],
        relayServer: relay,
        provider: port,
        cache: new InMemoryLeaseVaultCache(),
      });
      await refusing.vault.refresh();

      await expect(refusing.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toThrow(
        /the signer refused/u
      );
      expect(port.sent).toHaveLength(0);
      expect(refusing.vault.list()).toHaveLength(0);
      const left = await vaulted();
      expect(left?.state).toBe('retracted');
    });

    it('KEEPS the record when the packet’s fate is unknown', async () => {
      port.answer = { kind: 'unknown', message: 'the socket closed' };

      await expect(fixture.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toMatchObject({
        code: 'spawn_unconfirmed',
      });
      // A workload may be running behind it, and this secret is the only thing
      // that could ever stop it.
      expect(fixture.vault.list()).toHaveLength(1);
      expect(fixture.vault.list()[0]?.state).toBe('spawning');
    });
  });

  describe('validating before anything is paid (TOON_Network#115)', () => {
    const refuses = async (request: SpawnRequest, match: RegExp) => {
      const preflight = await fixture.leases.preflight(request);
      expect(preflight.ok).toBe(false);
      expect(preflight.problems.join(' ')).toMatch(match);
      await expect(fixture.leases.spawn(request)).rejects.toBeInstanceOf(LeaseError);
      // The whole point: nothing was sent, so nothing was billed — and no
      // vault record was written either.
      expect(port.sent).toHaveLength(0);
      expect(vaultEvents()).toHaveLength(0);
    };

    it('refuses a reference carrying its own tag', async () =>
      refuses(
        {
          ...(GOOD_SPAWN as SpawnRequest),
          image: { ...GOOD_SPAWN.image, reference: 'traefik/whoami:latest' },
        },
        /carries no tag/u
      ));

    it('refuses a reference carrying its own digest', async () =>
      refuses(
        {
          ...(GOOD_SPAWN as SpawnRequest),
          image: {
            ...GOOD_SPAWN.image,
            reference: `traefik/whoami@${GOOD_SPAWN.image.digest}`,
          },
        },
        /carries no `@digest`/u
      ));

    it('refuses a digest that is not `sha256:` and 64 hex', async () =>
      refuses(
        {
          ...(GOOD_SPAWN as SpawnRequest),
          image: { ...GOOD_SPAWN.image, digest: 'sha256:oops' },
        },
        /64 lowercase hex/u
      ));

    it('refuses `reference` and `registry_entry` together (§6.2’s one-of)', async () =>
      refuses(
        {
          ...(GOOD_SPAWN as SpawnRequest),
          image: {
            ...GOOD_SPAWN.image,
            registryEntry: { address: `30434:${'a'.repeat(64)}:whoami:latest` },
          },
        },
        /must not both be present/u
      ));

    it('refuses a volume larger than the listing sells', async () =>
      refuses({ ...(GOOD_SPAWN as SpawnRequest), volumeGb: 99 }, /does not fit it/u));

    it('refuses a missing SSH public key', async () =>
      refuses({ ...(GOOD_SPAWN as SpawnRequest), sshPublicKey: '' }, /SSH public key/u));

    it('refuses — loudly — a PRIVATE key pasted into the form', async () =>
      refuses(
        {
          ...(GOOD_SPAWN as SpawnRequest),
          sshPublicKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blb\n-----END-----',
        },
        /That is a PRIVATE key/u
      ));

    it('refuses a provider key that is not lowercase hex', async () =>
      refuses(
        { ...(GOOD_SPAWN as SpawnRequest), provider: PROVIDER.toUpperCase() },
        /64 lowercase hex/u
      ));

    it('refuses an environment variable name a shell could not export', async () =>
      refuses(
        { ...(GOOD_SPAWN as SpawnRequest), env: { 'not a name': 'x' } },
        /environment variable name/u
      ));

    it('refuses a listing this provider does not publish', async () =>
      refuses(
        { ...(GOOD_SPAWN as SpawnRequest), listing: 'enormous' },
        /no current Listing/u
      ));

    it('refuses a provider with no current Profile on the relays', async () =>
      refuses({ ...(GOOD_SPAWN as SpawnRequest), provider: 'a'.repeat(64) }, /no provider/iu));
  });

  describe('which connector collects', () => {
    it('pays at the provider’s own connector when the profile’s carries no route', async () => {
      const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
      expect(view.payment?.connectorUrl).toBe(PROVIDER_CONNECTOR);
      expect(view.payment?.via).toBe('provider-connector');
    });

    it('pays at the profile’s own connector when it publishes a carrying route', async () => {
      await build({
        health: (profile) =>
          Promise.resolve(
            connectorHealth({
              endpoint: profile.connectorUrl,
              routes:
                profile.connectorUrl === SANDBOX.connectorUrl
                  ? [{ prefix: 'g.toon.provider', price: '1100' }]
                  : [],
            })
          ),
        channelAt: SANDBOX.connectorUrl,
      });

      const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
      expect(view.payment?.connectorUrl).toBe(SANDBOX.connectorUrl);
      expect(view.payment?.via).toBe('profile-connector');
      // The hub's own price, repeated — never a figure this console computed.
      expect(view.payment?.routePrice).toBe('1100');
    });

    it('refuses before paying when there is no channel with that connector', async () => {
      await build({ channelAt: null });
      const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);

      expect(view.ok).toBe(false);
      expect(view.problems.join(' ')).toMatch(/No payment channel/u);
      await expect(fixture.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toMatchObject({
        status: 409,
      });
      expect(port.sent).toHaveLength(0);
    });

    /**
     * A Hidden Provider (TOON_Network#98, spec §10, ADR 0008).
     *
     * Its connector IS the `.anyone` address; there is no second one and no
     * host to fall back to, which is the whole of ADR 0008. So the three cases
     * are: a circuit, no circuit at all, and a circuit that would not build —
     * and the second and third must look identical from the outside, because
     * the one thing neither may become is a direct dial.
     */
    describe('a Hidden Provider', () => {
      const HIDDEN_CONNECTOR = `http://${'a'.repeat(56)}.anyone/ilp`;
      /** §10: a lease's access names a per-lease `.anyone` host, never an IP. */
      const hiddenSpawnOk = (packet: Parameters<typeof spawnOk>[0]) => {
        const ok = spawnOk(packet) as Extract<
          ReturnType<typeof spawnOk>,
          { kind: 'answered' }
        >;
        const body = {
          ...(ok.body as Record<string, unknown>),
          access: {
            host: `${'b'.repeat(56)}.anyone`,
            ssh_port: 40000,
            ports: [{ container_port: 80, host_port: 41000 }],
          },
        };
        return { ...ok, body, text: JSON.stringify(body) };
      };
      const hiddenDirectory = () => () =>
        Promise.resolve({
          state: 'ok',
          relays: { seed: [], read: [] },
          filters: {},
          providers: [fakeProvider({ hidden: true, connectorUrl: HIDDEN_CONNECTOR })],
          listingsWithoutProfile: 0,
          rejectedEvents: 0,
          readAt: '2026-09-22T00:00:00.000Z',
        } as DirectoryResult);

      it('pays at its `.anyone` connector over a circuit, and says so', async () => {
        const anon = fakeAnon();
        await build({
          directory: hiddenDirectory(),
          hidden: anon,
          channelAt: HIDDEN_CONNECTOR,
        });

        const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
        expect(view.problems).toEqual([]);
        expect(view.provider?.hidden).toBe(true);
        expect(view.payment).toMatchObject({
          connectorUrl: HIDDEN_CONNECTOR,
          via: 'provider-connector',
          overAnon: true,
        });
        expect(anon.opens).toBeGreaterThan(0);
      });

      it('sends the packet with the proxy and nothing else', async () => {
        await build({
          directory: hiddenDirectory(),
          hidden: fakeAnon({ socksProxy: 'socks5h://127.0.0.1:19050' }),
          channelAt: HIDDEN_CONNECTOR,
        });
        port.answer = hiddenSpawnOk;

        await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
        const packet = port.sent[0];
        expect(packet?.socksProxy).toBe('socks5h://127.0.0.1:19050');
        // An injected `fetch` or websocket would beat the proxy in silence.
        expect(packet).not.toHaveProperty('fetch');
        expect(packet).not.toHaveProperty('createWebSocket');
      });

      it('vaults the lease with no host for the provider anywhere in it', async () => {
        await build({
          directory: hiddenDirectory(),
          hidden: fakeAnon(),
          channelAt: HIDDEN_CONNECTOR,
        });
        port.answer = hiddenSpawnOk;

        const result = await fixture.leases.spawn(GOOD_SPAWN as SpawnRequest);
        const record = vaultEvents()[0];
        const sealed = JSON.stringify(result.lease);
        // The lease's OWN address is a per-lease `.anyone` host and belongs
        // here — §10 says a tenant dials it exactly as it would an IP. What
        // must not be here is a location: an IP, or a `host` for the provider.
        expect(result.lease?.access?.host).toMatch(/\.anyone$/u);
        expect(sealed).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/u);
        expect(result.lease?.provider).not.toHaveProperty('host');
        expect(result.lease?.provider.hidden).toBe(true);
        // And the record on the relay is sealed, so it says nothing either.
        expect(record?.content ?? '').not.toMatch(/anyone|\d{1,3}(\.\d{1,3}){3}/u);
      });

      it('leaves the sandbox’s own loopback chain off the circuit', async () => {
        // `anon` builds no circuit to a private address, so proxying the local
        // chain would fail rather than hide anything.
        await build({
          directory: hiddenDirectory(),
          hidden: fakeAnon(),
          channelAt: HIDDEN_CONNECTOR,
        });
        const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
        expect(view.payment?.rpcOverAnon).toBe(false);
      });

      it('refuses when there is no carriage at all, and sends nothing', async () => {
        await build({ directory: hiddenDirectory(), channelAt: HIDDEN_CONNECTOR });

        const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
        expect(view.problems.join(' ')).toMatch(/Anyone Protocol circuit/u);
        expect(view.ok).toBe(false);
        await expect(fixture.leases.spawn(GOOD_SPAWN as SpawnRequest)).rejects.toThrow(
          LeaseError
        );
        expect(port.sent).toHaveLength(0);
      });

      it('refuses when the circuit will not build, rather than dialling direct', async () => {
        const anon = fakeAnon({ fails: 'nothing is listening on socks5h://127.0.0.1:19050' });
        await build({
          directory: hiddenDirectory(),
          hidden: anon,
          channelAt: HIDDEN_CONNECTOR,
        });

        const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
        expect(view.problems.join(' ')).toMatch(/nothing is listening/u);
        // The refusal names no connector to try instead, and the payment view
        // — the only place a second endpoint could appear — was never built.
        expect(view.payment).toBeUndefined();
        expect(port.sent).toHaveLength(0);
      });
    });
  });

  it('shows the listing’s own price, and does not recompute one', async () => {
    const view = await fixture.leases.preflight(GOOD_SPAWN as SpawnRequest);
    expect(view.listing).toMatchObject({
      price: 1000,
      leaseIntervalSeconds: 3600,
      version: 1,
    });
    expect(view.route).toBe('g.toon.provider.basic.v1.spawn');
  });
});

describe('an ILP prefix carries a destination beneath it', () => {
  it('matches by segment, never by characters', () => {
    expect(routeCarries('g.toon.provider', 'g.toon.provider.basic.v1.spawn')).toBe(true);
    expect(routeCarries('g.toon.provider', 'g.toon.provider')).toBe(true);
    // The trap: `g.toon.provider2` starts with `g.toon.provider` as a string.
    expect(routeCarries('g.toon.provider', 'g.toon.provider2.basic.v1.spawn')).toBe(false);
  });
});
