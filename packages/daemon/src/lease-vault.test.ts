import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import {
  LEASE_VAULT_KIND,
  LeaseVault,
  LeaseVaultError,
  leaseVaultD,
  type VaultedLease,
} from './lease-vault.js';
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
 */

const OWN = 'wss://own.relay.test';
const OTHER = 'wss://other.relay.test';

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
  let own: FakeRelayServer;
  let other: FakeRelayServer;
  let account: FakeAccount;
  let vault: LeaseVault;

  const vaultFor = (
    signer: FakeAccount,
    relays: readonly FakeRelayServer[],
    cache: LeaseVaultCache = new InMemoryLeaseVaultCache()
  ) =>
    new LeaseVault({
      signer: () => signer,
      seedRelays: () => [OTHER],
      cache,
      dial: fakeRelayNetwork(relays),
      timeoutMs: 200,
    });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-vault-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    own = fakeRelayServer(OWN);
    other = fakeRelayServer(OTHER);
    account = fakeAccount();
    // The account writes to its OWN relay and reads from the network's.
    await publishRelayListEvent(
      account,
      [own, other],
      [
        [OWN, 'write'],
        [OTHER, 'read'],
      ]
    );
    vault = vaultFor(account, [own, other]);
    await vault.refresh();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('publishes one sealed record per lease to the account’s WRITE relays', async () => {
    const view = await vault.publish(leaseRecord());

    expect(view.workloadId).toBe(WORKLOAD);
    expect(view.relays).toEqual([OWN]);
    const held = own.events.find((event) => event.kind === LEASE_VAULT_KIND);
    expect(held).toBeDefined();
    expect(tagValue(held!, 'd')).toBe(`toon-console/lease/${WORKLOAD}`);
    // The relay holds a ciphertext. Not the secret, and not the workload's
    // image or ports either — the `d` tag is the whole of what it learns.
    expect(held!.content).not.toContain(ROOT_SECRET);
    expect(held!.content).not.toContain('traefik');
    // The read relay is not written to: NIP-65 says which is which.
    expect(other.events.some((event) => event.kind === LEASE_VAULT_KIND)).toBe(false);
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
    const fresh = vaultFor(account, [own, other], new InMemoryLeaseVaultCache());
    const status = await fresh.refresh();

    expect(status.leases).toHaveLength(1);
    expect(status.leases[0]?.workloadId).toBe(WORKLOAD);
    expect(status.leases[0]?.source).toBe('relays');
    expect(status.leases[0]?.listing.name).toBe('basic');
  });

  it('keeps a local-only lease off every relay, and on this disk alone', async () => {
    const cache = new FileLeaseVaultCache(paths);
    const local = vaultFor(account, [own, other], cache);
    await local.refresh();

    const view = await local.publish(leaseRecord({ local_only: true }));

    expect(view.localOnly).toBe(true);
    expect(view.relays).toEqual([]);
    expect(own.events.some((event) => event.kind === LEASE_VAULT_KIND)).toBe(false);
    expect(other.events.some((event) => event.kind === LEASE_VAULT_KIND)).toBe(false);

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

  it('refuses, and caches NOTHING, when every relay charges for the write', async () => {
    const paying = fakeRelayServer(OWN, {
      refuse: 'restricted: writes require ILP payment',
    });
    const cache = new InMemoryLeaseVaultCache();
    const broke = vaultFor(account, [paying, other], cache);
    await broke.refresh();

    await expect(broke.publish(leaseRecord())).rejects.toMatchObject({
      code: 'relay_payment_required',
      status: 402,
    });
    expect(cache.read(account.pubkey).size).toBe(0);
    expect(broke.list()).toHaveLength(0);
  });

  it('says where a record would go, and why there', () => {
    expect(vault.status().writeTargets).toEqual([OWN]);
    expect(vault.status().writeTargetSource).toBe('nip65');
  });

  it('falls back to the network profile’s relay when the account named none', async () => {
    const bare = fakeAccount();
    const noList = vaultFor(bare, [own, other]);
    await noList.refresh();
    expect(noList.status().writeTargets).toEqual([OTHER]);
    expect(noList.status().writeTargetSource).toBe('profile');
  });

  it('confirms a lease in place: same `d`, now carrying its access', async () => {
    await vault.publish(leaseRecord());
    const confirmed = await vault.confirm(WORKLOAD, {
      role: 'standalone',
      expires_at: 1_790_003_600,
      access: { host: '203.0.113.7', ssh_port: 40000 },
    });

    expect(confirmed.confirmed).toBe(true);
    // NIP-01 replacement: one record, not two.
    expect(own.events.filter((event) => event.kind === LEASE_VAULT_KIND)).toHaveLength(1);
    expect(vault.list()[0]?.state).toBe('live');
    expect(vault.list()[0]?.access?.host).toBe('203.0.113.7');
    expect(vault.list()[0]?.expiresAt).toBe(1_790_003_600);
  });

  it('retracts a record so nothing is left pointing at a lease that never was', async () => {
    const cache = new InMemoryLeaseVaultCache();
    const held = vaultFor(account, [own, other], cache);
    await held.refresh();
    await held.publish(leaseRecord());

    const taken = await held.retract(WORKLOAD, 'the spawn was refused: no_capacity');

    expect(taken.retracted).toBe(true);
    expect(held.list()).toHaveLength(0);
    expect(cache.read(account.pubkey).size).toBe(0);
    // A NIP-09 deletion went out beside the tombstone, for the relays that
    // honour one.
    expect(own.events.some((event) => event.kind === 5)).toBe(true);
    // And a fresh machine reading the relay sees no lease either: whatever is
    // left under that `d` is a tombstone, which `list` does not show.
    const fresh = vaultFor(account, [own, other], new InMemoryLeaseVaultCache());
    expect((await fresh.refresh()).leases).toHaveLength(0);
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
    own.events = [...own.events, forged as never];

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
    own.events = [...own.events, seedRecord as never];
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
      seedRelays: () => [OTHER],
      cache: new InMemoryLeaseVaultCache(),
      dial: fakeRelayNetwork([own, other]),
      timeoutMs: 200,
    });
    await switching.refresh();
    expect(switching.list()).toHaveLength(1);
    who = fakeAccount();
    expect(switching.status().state).toBe('unknown');
    expect(switching.list()).toHaveLength(0);
  });
});
