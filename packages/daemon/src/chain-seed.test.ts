import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHAIN_SEED_D,
  CHAIN_SEED_KIND,
  ChainSeedError,
  ChainSeedStore,
  deriveAddresses,
} from './chain-seed.js';
import { FileChainSeedCache, InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import { tagValue } from './nostr.js';
import { accountChainSeedPath, consolePaths, type ConsolePaths } from './paths.js';

/**
 * The Chain Seed, end to end through the real NIP-44 sealing, the real
 * NIP-01 read and the real publish — only the socket is a fake.
 *
 * ADR 0020's three claims are what these tests are for: a seed that comes back
 * on a machine that has never seen it, keys that match another wallet when a
 * phrase is imported, and a relay that learns nothing but that a record exists.
 * The fourth is the one the ticket called awkward: a paid relay, no channel,
 * and a console that must fail loudly rather than keep a seed on one disk.
 */

/**
 * BIP-39's canonical phrase. Its EVM address at `m/44'/60'/0'/0/0` is
 * `0x9858EfFD232B4033E47d90003D41EC34EcaEda94` in every wallet that derives
 * the standard path, which is what makes it a vector and not a fixture.
 */
const VECTOR = 'abandon '.repeat(11) + 'about';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const VECTOR_SOLANA = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';

const OWN = 'wss://relay.own.test';
const OTHER = 'wss://relay.other.test';
const PROFILE_RELAY = 'wss://relay.toon.test';
/** What a TOON relay answers an unpaid websocket write with, verbatim. */
const PAID = 'restricted: writes require ILP payment';

interface World {
  readonly account: FakeAccount;
  readonly own: FakeRelayServer;
  readonly toon: FakeRelayServer;
  readonly cache: InMemoryChainSeedCache;
  readonly store: ChainSeedStore;
}

/**
 * One account, its own relay, and the network profile's TOON relay — which
 * refuses an unpaid write, because that is what a TOON relay does.
 */
function world(
  options: { own?: Partial<FakeRelayServer>; toon?: Partial<FakeRelayServer> } = {}
): World {
  const account = fakeAccount();
  const own = fakeRelayServer(OWN, options.own ?? {});
  const toon = fakeRelayServer(PROFILE_RELAY, { refuse: PAID, ...options.toon });
  const relays = [own, toon];
  const cache = new InMemoryChainSeedCache();
  const store = new ChainSeedStore({
    signer: () => account,
    seedRelays: () => [PROFILE_RELAY],
    cache,
    dial: fakeRelayNetwork(relays),
    timeoutMs: 200,
  });
  return { account, own, toon, cache, store };
}

async function readyToMint(w: World): Promise<void> {
  await publishRelayListEvent(w.account, [w.own, w.toon], [OWN]);
  w.store.acknowledgeWarning();
}

describe('minting a Chain Seed', () => {
  let w: World;

  beforeEach(async () => {
    w = world();
    await readyToMint(w);
  });

  it('seals a random seed to the account and publishes it to its write relays', async () => {
    const status = await w.store.mint();

    expect(status.state).toBe('ready');
    expect(status.origin).toBe('minted');
    expect(status.addresses?.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(status.addresses?.evm.path).toBe("m/44'/60'/0'/0/0");
    expect(status.addresses?.solana.path).toBe("m/44'/501'/0'/0'");
    expect(status.record?.relays).toEqual([OWN]);

    const published = w.own.events.filter((event) => event.kind === CHAIN_SEED_KIND);
    expect(published).toHaveLength(1);
    expect(tagValue(published[0]!, 'd')).toBe(CHAIN_SEED_D);
    expect(published[0]!.pubkey).toBe(w.account.pubkey);
  });

  it('gives two accounts two different seeds', async () => {
    const a = await w.store.mint();
    const other = world();
    await readyToMint(other);
    const b = await other.store.mint();
    expect(a.addresses?.evm.address).not.toBe(b.addresses?.evm.address);
  });

  it('tells the relay that a record exists and nothing else', async () => {
    await w.store.mint();
    const published = w.own.events.find((event) => event.kind === CHAIN_SEED_KIND)!;

    // The `d` tag is the only thing in the clear, and it says "this account
    // keeps a console record" — which ADR 0020 accepts by name.
    expect(published.tags).toEqual([['d', CHAIN_SEED_D]]);
    expect(published.content).not.toMatch(/abandon|\bzoo\b/u);
    expect(published.content.split(/\s+/u)).toHaveLength(1);

    // A stranger's key does not open it.
    const stranger = fakeAccount();
    await expect(stranger.unsealFromSelf(published.content)).rejects.toThrow();
  });

  it('refuses to mint a second seed over the first', async () => {
    const first = await w.store.mint();
    const again = w.store.mint();
    await expect(again).rejects.toMatchObject({ code: 'seed_exists' });
    await expect(again).rejects.toThrow(first.addresses!.evm.address);
    expect(w.own.events.filter((event) => event.kind === CHAIN_SEED_KIND)).toHaveLength(1);
  });

  it('never puts the seed in the status, however it is asked for', async () => {
    const status = await w.store.mint();
    expect(JSON.stringify(status)).not.toMatch(/mnemonic|abandon/iu);
  });
});

describe('importing a mnemonic', () => {
  let w: World;

  beforeEach(async () => {
    w = world();
    await readyToMint(w);
  });

  it('derives the addresses every other wallet derives from the same phrase', async () => {
    const status = await w.store.importMnemonic(VECTOR);
    expect(status.origin).toBe('imported');
    expect(status.addresses?.evm.address).toBe(VECTOR_EVM);
    expect(status.addresses?.solana.address).toBe(VECTOR_SOLANA);
  });

  it('takes the words however they were typed', async () => {
    const status = await w.store.importMnemonic(`  ${VECTOR.toUpperCase()}\n `);
    expect(status.addresses?.evm.address).toBe(VECTOR_EVM);
  });

  it('refuses words that are not BIP-39, before anything is sealed', async () => {
    await expect(
      w.store.importMnemonic('abandon '.repeat(11) + 'abandon')
    ).rejects.toMatchObject({ code: 'invalid_mnemonic' });
    expect(w.own.events.filter((event) => event.kind === CHAIN_SEED_KIND)).toHaveLength(0);
  });

  it('is quiet about importing the phrase this account already has', async () => {
    await w.store.importMnemonic(VECTOR);
    const again = await w.store.importMnemonic(VECTOR);
    expect(again.addresses?.evm.address).toBe(VECTOR_EVM);
    expect(w.own.events.filter((event) => event.kind === CHAIN_SEED_KIND)).toHaveLength(1);
  });

  it('refuses a DIFFERENT phrase over an existing seed', async () => {
    await w.store.importMnemonic(VECTOR);
    const other =
      'legal winner thank year wave sausage worth useful legal winner thank yellow';
    await expect(w.store.importMnemonic(other)).rejects.toMatchObject({ code: 'seed_exists' });
  });
});

describe('recovering on a fresh data directory', () => {
  it('reads the seed back off the relays and derives the same addresses', async () => {
    const w = world();
    await readyToMint(w);
    const minted = await w.store.mint();

    // A second machine: the same account and the same relays, and a cache
    // that has never held anything.
    const fresh = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([w.own, w.toon]),
      timeoutMs: 200,
    });

    const recovered = await fresh.refresh();
    expect(recovered.state).toBe('ready');
    expect(recovered.record?.source).toBe('relays');
    expect(recovered.addresses).toEqual(minted.addresses);
  });

  it('finds the record on a relay the account only READS from', async () => {
    const account = fakeAccount();
    const own = fakeRelayServer(OWN);
    const readOnly = fakeRelayServer(OTHER);
    const toon = fakeRelayServer(PROFILE_RELAY, { refuse: PAID });
    // The list has to be findable from the one relay the console starts with.
    await publishRelayListEvent(
      account,
      [own, readOnly, toon],
      [
        [OTHER, 'read'],
        [OWN, 'write'],
      ]
    );

    const store = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([own, readOnly, toon]),
      timeoutMs: 200,
    });
    store.acknowledgeWarning();
    const minted = await store.mint();
    // It went to the WRITE relay, as NIP-65 says.
    expect(minted.record?.relays).toEqual([OWN]);

    // Now let the write relay go away. The read relay never had it, so there
    // is nothing to find — which is the honest answer, not a stale cache.
    const elsewhere = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [OTHER],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([own, readOnly]),
      timeoutMs: 200,
    });
    const found = await elsewhere.refresh();
    expect(found.state).toBe('ready');
    expect(found.relayList.write).toEqual([OWN]);
  });

  it('serves the cached record when every relay is down, and says where it came from', async () => {
    const w = world();
    await readyToMint(w);
    const minted = await w.store.mint();

    const offline = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [PROFILE_RELAY],
      cache: w.cache,
      dial: fakeRelayNetwork([]),
      timeoutMs: 200,
    });
    const status = await offline.refresh();
    expect(status.state).toBe('ready');
    expect(status.record?.source).toBe('cache');
    expect(status.addresses).toEqual(minted.addresses);
  });

  it('says so, rather than guessing, when the record is not this account’s', async () => {
    const w = world();
    await readyToMint(w);
    await w.store.mint();

    const stranger = fakeAccount();
    const theirs = new ChainSeedStore({
      signer: () => stranger,
      seedRelays: () => [PROFILE_RELAY],
      // Their own cache, holding somebody else's sealed record.
      cache: seededCache(
        stranger.pubkey,
        w.own.events.find((e) => e.kind === CHAIN_SEED_KIND)!
      ),
      dial: fakeRelayNetwork([fakeRelayServer(PROFILE_RELAY)]),
      timeoutMs: 200,
    });
    const status = await theirs.refresh();
    expect(status.state).toBe('unreadable');
    expect(status.reason).toBeTruthy();
  });
});

describe('the custody warning', () => {
  it('is required once, before anything is minted, and then remembered', async () => {
    const w = world();
    await publishRelayListEvent(w.account, [w.own, w.toon], [OWN]);

    await expect(w.store.mint()).rejects.toMatchObject({ code: 'warning_not_acknowledged' });
    expect(w.store.status().warning.text).toMatch(/holds its funds/u);
    expect(w.store.status().warning.acknowledgedAt).toBeUndefined();

    const after = w.store.acknowledgeWarning();
    expect(after.warning.acknowledgedAt).toBeTruthy();
    await expect(w.store.mint()).resolves.toMatchObject({ state: 'ready' });
  });

  it('keeps its first answer when it is acknowledged twice', () => {
    const w = world();
    const first = w.store.acknowledgeWarning().warning.acknowledgedAt;
    const second = w.store.acknowledgeWarning().warning.acknowledgedAt;
    expect(second).toBe(first);
  });
});

describe('where a seed is written', () => {
  it('names the profile’s relay when the account has published no list', async () => {
    const w = world();
    const status = await w.store.refresh();
    expect(status.relayList.state).toBe('none');
    expect(status.relayList.writeTargetSource).toBe('profile');
    expect(status.relayList.writeTargets).toEqual([PROFILE_RELAY]);
  });

  it('fails loudly, and keeps nothing, when the only relay charges for writes', async () => {
    const w = world();
    w.store.acknowledgeWarning();

    const failed = await w.store.mint().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ChainSeedError);
    const error = failed as ChainSeedError;
    expect(error.code).toBe('relay_payment_required');
    expect(error.status).toBe(402);
    expect(error.message).toContain(PROFILE_RELAY);
    expect(error.message).toContain(PAID);
    expect(error.message).toMatch(/1 µUSDC/u);
    expect(error.message).not.toMatch(/abandon/u);

    // Nothing was kept: a seed one disk holds is not a Chain Seed.
    expect(w.cache.read(w.account.pubkey)?.event).toBeUndefined();
    expect(w.store.status().state).toBe('absent');
  });

  it('reports a relay that could not be reached differently from one that refused', async () => {
    const w = world({ toon: { down: true } });
    w.store.acknowledgeWarning();
    await expect(w.store.mint()).rejects.toMatchObject({ code: 'not_persisted', status: 502 });
  });

  it('publishes a NIP-65 list for an account that has none, and then mints', async () => {
    const w = world();
    w.store.acknowledgeWarning();

    const listed = await w.store.publishRelayList([{ url: OWN }]);
    expect(listed.relayList.state).toBe('present');
    expect(listed.relayList.write).toEqual([OWN]);
    expect(listed.relayList.writeTargetSource).toBe('nip65');

    const minted = await w.store.mint();
    expect(minted.record?.relays).toEqual([OWN]);
  });

  it('refuses a relay list no relay accepted', async () => {
    const w = world({ own: { refuse: PAID } });
    await expect(w.store.publishRelayList([{ url: OWN }])).rejects.toMatchObject({
      code: 'relay_list_not_published',
    });
  });

  it('refuses a relay URL that is not one', async () => {
    const w = world();
    await expect(
      w.store.publishRelayList([{ url: 'https://relay.test' }])
    ).rejects.toMatchObject({ code: 'invalid_relay_url' });
  });
});

describe('two machines that both minted', () => {
  it('picks the current record and says how many other seeds it saw', async () => {
    const w = world();
    await readyToMint(w);
    await w.store.mint();

    // The other machine, offline at the time, publishes its own a second later.
    const rival = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [OWN],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([w.own]),
      timeoutMs: 200,
      now: () => new Date(Date.now() + 60_000),
    });
    rival.acknowledgeWarning();
    // The rival cannot mint over the first — which is the protection working.
    await expect(rival.mint()).rejects.toMatchObject({ code: 'seed_exists' });

    // But if one got onto the relay anyway, the count is not swallowed.
    w.own.events = [
      ...w.own.events,
      (await w.account.sign({
        kind: CHAIN_SEED_KIND,
        created_at: Math.floor(Date.now() / 1000) + 600,
        tags: [['d', CHAIN_SEED_D]],
        content: await w.account.sealToSelf(
          JSON.stringify({ v: 1, mnemonic: VECTOR, origin: 'minted', created_at: '' })
        ),
      })) as never,
    ];
    const status = await w.store.refresh();
    expect(status.addresses?.evm.address).toBe(VECTOR_EVM);
    expect(status.supersededSeeds).toBe(1);
  });
});

describe('the cache on disk', () => {
  let home: string;
  let paths: ConsolePaths;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-seed-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
  });

  it('holds the sealed event and never the words', async () => {
    const account = fakeAccount();
    const own = fakeRelayServer(OWN);
    await publishRelayListEvent(account, [own], [OWN]);
    const store = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [OWN],
      cache: new FileChainSeedCache(paths),
      dial: fakeRelayNetwork([own]),
      timeoutMs: 200,
    });
    store.acknowledgeWarning();
    await store.importMnemonic(VECTOR);

    const raw = readFileSync(accountChainSeedPath(paths, account.pubkey), 'utf8');
    expect(raw).not.toMatch(/abandon/u);
    expect(raw).toContain(CHAIN_SEED_D);
    expect(JSON.parse(raw).event.kind).toBe(CHAIN_SEED_KIND);

    rmSync(home, { recursive: true, force: true });
  });

  it('is an empty cache when it has been corrupted, not a failed sign-in', () => {
    const cache = new FileChainSeedCache(paths);
    const account = fakeAccount();
    cache.acknowledgeWarning(account.pubkey, new Date('2026-09-22T00:00:00Z'));
    expect(cache.read(account.pubkey)?.warningAcknowledgedAt).toBe('2026-09-22T00:00:00.000Z');
    rmSync(home, { recursive: true, force: true });
    expect(cache.read(account.pubkey)).toBeUndefined();
  });

  it('will not let a pubkey that is not one name a directory', () => {
    expect(() => accountChainSeedPath(paths, '../../etc')).toThrow(/64 hex/u);
  });
});

describe('with nobody signed in', () => {
  it('has no state to show and refuses to mint', async () => {
    const store = new ChainSeedStore({
      signer: () => undefined,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([]),
    });
    expect(store.status().state).toBe('signed_out');
    await expect(store.mint()).rejects.toMatchObject({ code: 'not_signed_in' });
  });
});

describe('deriveAddresses', () => {
  it('uses the client’s paths and hands back no private key', () => {
    const addresses = deriveAddresses(VECTOR);
    expect(addresses).toEqual({
      evm: { address: VECTOR_EVM, path: "m/44'/60'/0'/0/0" },
      solana: { address: VECTOR_SOLANA, path: "m/44'/501'/0'/0'" },
    });
    expect(Object.keys(addresses.evm)).toEqual(['address', 'path']);
  });
});

function seededCache(
  pubkey: string,
  event: Parameters<InMemoryChainSeedCache['writeEvent']>[1]
) {
  const cache = new InMemoryChainSeedCache();
  cache.writeEvent(pubkey, event);
  return cache;
}

describe('looking on a relay nobody named', () => {
  it('finds the seed when the profile’s relay carries no NIP-65 list', async () => {
    // The sandbox and devnet shape: the profile's relay is a TOON relay, it
    // charges for writes, so no account's relay list is on it — and a fresh
    // machine has nowhere to start. One relay URL is the way back in.
    const account = fakeAccount();
    const own = fakeRelayServer(OWN);
    const toon = fakeRelayServer(PROFILE_RELAY, { refuse: PAID });
    const first = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([own, toon]),
      timeoutMs: 200,
    });
    first.acknowledgeWarning();
    await first.publishRelayList([{ url: OWN }]);
    const minted = await first.mint();

    const fresh = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      dial: fakeRelayNetwork([own, toon]),
      timeoutMs: 200,
    });
    expect((await fresh.refresh()).state).toBe('absent');

    const found = await fresh.refresh({ relays: [OWN] });
    expect(found.state).toBe('ready');
    expect(found.addresses).toEqual(minted.addresses);

    // And it is remembered, so the URL is typed once.
    expect((await fresh.refresh()).state).toBe('ready');
  });

  it('publishes nothing while looking', async () => {
    const w = world();
    const before = w.own.events.length;
    await w.store.refresh({ relays: [OWN] });
    expect(w.own.events).toHaveLength(before);
  });

  it('refuses a hint that is not a relay URL', async () => {
    const w = world();
    await expect(w.store.refresh({ relays: ['relay.example'] })).rejects.toMatchObject({
      code: 'invalid_relay_url',
    });
  });
});
