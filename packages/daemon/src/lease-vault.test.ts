import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  brokeWriter,
  fakeAccount,
  fakePaidWriter,
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
  type FakeAccount,
  type FakeRelayServer,
  type FakeWriter,
} from './chain-seed.testkit.js';
import {
  LEASE_VAULT_KIND,
  LeaseVault,
  LeaseVaultError,
  leaseVaultD,
  type VaultedLease,
} from './lease-vault.js';
import { RelayWriteError } from './relay-write.js';
import {
  FileLeaseVaultCache,
  InMemoryLeaseVaultCache,
  type LeaseVaultCache,
} from './lease-vault-cache.js';
import { tagValue } from './nostr.js';
import { accountLeaseVaultPath, consolePaths, type ConsolePaths } from './paths.js';

/**
 * The Lease Vault (TOON_Network#92, ADR 0021).
 *
 * Two properties are pinned here and nowhere else.
 *
 * **A Root Secret never appears in the clear.** Not on a relay, not on disk,
 * not in anything this module returns. Every test below that touches a record
 * also looks for the secret's 64 hex characters in whatever came out, and none
 * of them finds it.
 *
 * **A record that no relay took is not a record.** Publishing refuses and
 * caches nothing, so the spawn that was about to be paid for is never sent.
 * That is the whole reason the vault write comes first.
 *
 * **Every write here is bought** (TOON_Network#120), so a refusal in these
 * tests is a PAYMENT refused — no channel, a rejected claim — and never a
 * socket saying `restricted`. `fakePaidWriter` is the console's writer without
 * a connector behind it: what it takes, it puts on the relay, so the next read
 * finds it.
 */

const OWN = 'wss://own.relay.test';
/** The network profile's relay: the one a write can be bought to. */
const TOON = 'wss://toon.relay.test';

const ROOT_SECRET = 'a'.repeat(64);
const WORKLOAD = 'b'.repeat(64);

function leaseRecord(overrides: Partial<VaultedLease> = {}): VaultedLease {
  return {
    v: 1,
    state: 'spawning',
    workload_id: WORKLOAD,
    root_secret: ROOT_SECRET,
    standby_set: ['d'.repeat(64)],
    provider: {
      pubkey: 'd'.repeat(64),
      ilp_address: 'g.toon.provider',
      connector_url: 'https://provider.example/ilp',
      connector_seal_key: '0x04aa',
    },
    paid_at: 'https://provider.example/ilp',
    listing: {
      name: 'basic',
      version: 1,
      address: `30432:${'d'.repeat(64)}:basic`,
      lease_interval_s: 3600,
      price: 1000,
    },
    profile_id: 'sandbox',
    image: { reference: 'traefik/whoami', digest: `sha256:${'c'.repeat(64)}` },
    ports: [{ container_port: 80, protocol: 'tcp' }],
    env_keys: [],
    created_at: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('the Lease Vault', () => {
  let home: string;
  let paths: ConsolePaths;
  let toon: FakeRelayServer;
  let own: FakeRelayServer;
  let account: FakeAccount;
  let writer: FakeWriter;
  let vault: LeaseVault;

  const vaultFor = (
    signer: FakeAccount,
    relays: readonly FakeRelayServer[],
    cache: LeaseVaultCache = new InMemoryLeaseVaultCache(),
    paying: FakeWriter = writer
  ) =>
    new LeaseVault({
      signer: () => signer,
      seedRelays: () => [TOON],
      cache,
      writer: paying,
      dial: fakeRelayNetwork(relays),
      timeoutMs: 200,
    });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-vault-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    toon = fakeRelayServer(TOON);
    own = fakeRelayServer(OWN);
    account = fakeAccount();
    // The account also names a relay of its own, which is where READS look —
    // writes go where one can be bought.
    await publishRelayListEvent(account, [toon, own], [[OWN, 'read']]);
    writer = fakePaidWriter(toon);
    vault = vaultFor(account, [toon, own]);
    await vault.refresh();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('publishes one sealed record per lease, as a paid write, and says what it cost', async () => {
    const view = await vault.publish(leaseRecord());

    expect(view.workloadId).toBe(WORKLOAD);
    expect(view.relays).toEqual([TOON]);
    const held = toon.events.find((event) => event.kind === LEASE_VAULT_KIND);
    expect(held).toBeDefined();
    expect(tagValue(held!, 'd')).toBe(`toon-console/lease/${WORKLOAD}`);
    // The relay holds a ciphertext. Not the secret, and not the workload's
    // image or ports either — the `d` tag is the whole of what it learns.
    expect(held!.content).not.toContain(ROOT_SECRET);
    expect(held!.content).not.toContain('traefik');
    // It was bought, and the price is the connector's own.
    expect(vault.status().lastPublish).toMatchObject({
      what: 'stage',
      cost: '1',
      destination: 'g.toon.relay',
      accepted: [TOON],
    });
  });

  it('never returns a Root Secret, in any view', async () => {
    await vault.publish(leaseRecord());
    const status = vault.status();
    const serialized = JSON.stringify(status);

    expect(serialized).not.toContain(ROOT_SECRET);
    expect(serialized.toLowerCase()).not.toContain('secret');

    // A lease view carries several 64-hex values that BELONG there — the
    // account, the workload id, the provider's key, the event id, the image
    // digest. Take those out by name, and nothing 32 bytes long is left: a
    // secret that leaked into a new field would be what remained.
    const stripped = [
      status.pubkey ?? '',
      WORKLOAD,
      'd'.repeat(64),
      'c'.repeat(64),
      status.leases[0]?.recordId ?? '',
    ].reduce((text, known) => (known === '' ? text : text.replaceAll(known, '')), serialized);
    expect(stripped).not.toMatch(/(?<![0-9a-fx])[0-9a-f]{64}(?![0-9a-f])/u);
  });

  it('recovers every lease on a FRESH data directory, from the relays alone', async () => {
    await vault.publish(leaseRecord({ state: 'live', expires_at: 1_790_003_600 }));

    // A different machine: the same account key, an empty cache, and only the
    // network profile's relay to start looking from.
    const fresh = vaultFor(account, [toon, own], new InMemoryLeaseVaultCache());
    const status = await fresh.refresh();

    expect(status.leases).toHaveLength(1);
    expect(status.leases[0]?.workloadId).toBe(WORKLOAD);
    expect(status.leases[0]?.source).toBe('relays');
    expect(status.leases[0]?.listing.name).toBe('basic');
  });

  it('keeps a local-only lease off every relay, and on this disk alone', async () => {
    const cache = new FileLeaseVaultCache(paths);
    const local = vaultFor(account, [toon, own], cache);
    await local.refresh();

    const view = await local.publish(leaseRecord({ local_only: true }));

    // A PRIVACY choice, not a way round a write that could not be paid for:
    // this vault can pay perfectly well, and nothing was bought.
    expect(local.status().writes.ready).toBe(true);
    expect(view.localOnly).toBe(true);
    expect(view.relays).toEqual([]);
    expect(writer.written).toEqual([]);
    expect(toon.events.some((event) => event.kind === LEASE_VAULT_KIND)).toBe(false);
    expect(own.events.some((event) => event.kind === LEASE_VAULT_KIND)).toBe(false);

    // It is on disk, sealed — the cache holds the event, never the plaintext.
    const onDisk = readFileSync(accountLeaseVaultPath(paths, account.pubkey), 'utf8');
    expect(onDisk).toContain(leaseVaultD(WORKLOAD));
    expect(onDisk).not.toContain(ROOT_SECRET);

    // And a console on this machine still finds it, with no relay at all.
    const again = vaultFor(account, [], cache);
    await again.refresh();
    expect(again.list()).toHaveLength(1);
    expect(again.list()[0]?.localOnly).toBe(true);
  });

  it('refuses, and caches NOTHING, when the write cannot be paid for', async () => {
    const cache = new InMemoryLeaseVaultCache();
    const broke = vaultFor(account, [toon, own], cache, brokeWriter(toon));
    await broke.refresh();

    const failed = await broke.publish(leaseRecord()).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(LeaseVaultError);
    expect(failed).toMatchObject({ code: 'relay_payment_required', status: 402 });
    expect((failed as LeaseVaultError).message).toContain('The spawn was NOT sent');
    expect((failed as LeaseVaultError).message).toContain('local only');
    expect(cache.read(account.pubkey).size).toBe(0);
    expect(broke.list()).toHaveLength(0);
    expect(toon.events.some((event) => event.kind === LEASE_VAULT_KIND)).toBe(false);
  });

  it('says where a record would go, what it costs, and what stops it', async () => {
    expect(vault.status().writes).toMatchObject({
      relays: [TOON],
      destination: 'g.toon.relay',
      price: '1',
      ready: true,
    });

    const broke = vaultFor(account, [toon, own], undefined, brokeWriter(toon));
    const blocked = await broke.targets();
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toContain('no payment channel');
  });

  it('confirms a lease in place: same `d`, now carrying its access', async () => {
    await vault.publish(leaseRecord());
    const confirmed = await vault.confirm(WORKLOAD, {
      role: 'standalone',
      expires_at: 1_790_003_600,
      access: { host: '203.0.113.7', ssh_port: 40000 },
    });

    expect(confirmed.confirmed).toBe(true);
    // NIP-01 replacement: one record, not two — and a second paid write.
    expect(toon.events.filter((event) => event.kind === LEASE_VAULT_KIND)).toHaveLength(1);
    expect(writer.written).toHaveLength(2);
    expect(vault.status().lastPublish?.what).toBe('confirm');
    expect(vault.list()[0]?.state).toBe('live');
    expect(vault.list()[0]?.access?.host).toBe('203.0.113.7');
    expect(vault.list()[0]?.expiresAt).toBe(1_790_003_600);
  });

  it('retracts a record so nothing is left pointing at a lease that never was', async () => {
    const cache = new InMemoryLeaseVaultCache();
    const held = vaultFor(account, [toon, own], cache);
    await held.refresh();
    await held.publish(leaseRecord());

    const taken = await held.retract(WORKLOAD, 'the spawn was refused: no_capacity');

    expect(taken.retracted).toBe(true);
    expect(held.list()).toHaveLength(0);
    expect(cache.read(account.pubkey).size).toBe(0);
    // A NIP-09 deletion went out beside the tombstone, for the relays that
    // honour one. Two more paid writes, and the report says what they cost
    // together.
    expect(toon.events.some((event) => event.kind === 5)).toBe(true);
    expect(held.status().lastPublish).toMatchObject({ what: 'retract', cost: '2' });
    // And a fresh machine reading the relay sees no lease either: whatever is
    // left under that `d` is a tombstone, which `list` does not show.
    const fresh = vaultFor(account, [toon, own], new InMemoryLeaseVaultCache());
    expect((await fresh.refresh()).leases).toHaveLength(0);
  });

  it('says a retraction did NOT happen when its write could not be bought', async () => {
    const cache = new InMemoryLeaseVaultCache();
    const paying = fakePaidWriter(toon);
    const held = vaultFor(account, [toon, own], cache, paying);
    await held.refresh();
    await held.publish(leaseRecord());

    paying.refuse = new RelayWriteError('no_channel', 'the channel is spent', 402);
    const taken = await held.retract(WORKLOAD, 'the spawn was refused: no_capacity');

    expect(taken.retracted).toBe(false);
    expect(taken.reason).toContain('the channel is spent');
    // The local copy is gone either way: what the console cannot take back, it
    // at least stops claiming to hold.
    expect(held.list()).toHaveLength(0);
  });

  it('counts a record this signer cannot open, rather than failing the read', async () => {
    await vault.publish(leaseRecord());
    // Somebody else's sealed record, served under this account's pubkey by a
    // relay that should not have: the signature is this account's — the fake
    // account signs it — but the ciphertext is not for this key.
    const stranger = fakeAccount(generateSecretKey());
    const sealed = await stranger.sealToSelf(JSON.stringify(leaseRecord()));
    const forged = await account.sign({
      kind: LEASE_VAULT_KIND,
      created_at: 1_790_000_100,
      tags: [['d', 'toon-console/lease/' + 'f'.repeat(64)]],
      content: sealed,
    });
    toon.events = [...toon.events, forged as never];

    const status = await vault.refresh();
    expect(status.leases).toHaveLength(1);
    expect(status.unreadable).toBe(1);
  });

  it('leaves the Chain Seed’s own kind-30078 record alone', async () => {
    const seedRecord = await account.sign({
      kind: LEASE_VAULT_KIND,
      created_at: 1_790_000_000,
      tags: [['d', 'toon-console/chain-seed']],
      content: await account.sealToSelf(JSON.stringify({ v: 1, mnemonic: 'not a lease' })),
    });
    toon.events = [...toon.events, seedRecord as never];
    await vault.publish(leaseRecord());

    const status = await vault.refresh();
    expect(status.leases).toHaveLength(1);
    // The seed record shares the kind and is excluded by its `d`, so it is not
    // even counted as unreadable.
    expect(status.unreadable).toBe(0);
  });

  it('refuses to publish a SECOND lease under one workload id', async () => {
    await vault.publish(leaseRecord());
    // A different Root Secret under the same `d` would replace the first —
    // NIP-01 replacement is by `d` — and nothing could read that lease again.
    await expect(
      vault.publish(leaseRecord({ root_secret: 'e'.repeat(64) }))
    ).rejects.toMatchObject({ code: 'lease_exists', status: 409 });
    // Confirming the SAME lease is not that: the secret is unchanged.
    await expect(
      vault.publish(leaseRecord({ state: 'live', expires_at: 1_790_003_600 }))
    ).resolves.toMatchObject({ state: 'live' });
  });

  it('refuses a record whose workload id or secret is not 32 bytes of hex', async () => {
    await expect(vault.publish(leaseRecord({ root_secret: 'short' }))).rejects.toBeInstanceOf(
      LeaseVaultError
    );
    await expect(vault.publish(leaseRecord({ workload_id: 'nope' }))).rejects.toBeInstanceOf(
      LeaseVaultError
    );
  });

  it('drops everything when the signed-in account changes', async () => {
    await vault.publish(leaseRecord());
    expect(vault.list()).toHaveLength(1);

    let who: FakeAccount | undefined = account;
    const switching = new LeaseVault({
      signer: () => who,
      seedRelays: () => [TOON],
      cache: new InMemoryLeaseVaultCache(),
      writer,
      dial: fakeRelayNetwork([toon, own]),
      timeoutMs: 200,
    });
    await switching.refresh();
    expect(switching.list()).toHaveLength(1);
    who = fakeAccount();
    expect(switching.status().state).toBe('unknown');
    expect(switching.list()).toHaveLength(0);
  });
});
