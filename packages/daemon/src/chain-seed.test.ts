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
import { tagValue, type NostrEvent } from './nostr.js';
import { accountChainSeedPath, consolePaths, type ConsolePaths } from './paths.js';

/**
 * The Chain Seed, end to end through the real NIP-44 sealing, the real NIP-01
 * read and the real ordering — only the socket and the payment are fakes.
 *
 * ADR 0020's three claims are what these tests are for: a seed that comes back
 * on a machine that has never seen it, keys that match another wallet when a
 * phrase is imported, and a relay that learns nothing but that a record
 * exists. TOON_Network#120 added the fourth, and it is the one with the sharp
 * edge: a seed cannot pay for its own publication, so between minting it and
 * publishing it there is a window in which one disk holds everything — and the
 * console must say so, in those words, until the paid write lands.
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

interface World {
  readonly account: FakeAccount;
  readonly toon: FakeRelayServer;
  readonly own: FakeRelayServer;
  readonly cache: InMemoryChainSeedCache;
  readonly writer: FakeWriter;
  readonly store: ChainSeedStore;
}

/**
 * One account, the network's TOON relay, and a writer that can pay for a
 * write to it. `own` is a second relay the account may also read from.
 */
function world(options: { writer?: FakeWriter } = {}): World {
  const account = fakeAccount();
  const toon = fakeRelayServer(PROFILE_RELAY);
  const own = fakeRelayServer(OWN);
  const cache = new InMemoryChainSeedCache();
  const writer = options.writer ?? fakePaidWriter(toon);
  const store = new ChainSeedStore({
    signer: () => account,
    seedRelays: () => [PROFILE_RELAY],
    cache,
    writer: () => writer,
    dial: fakeRelayNetwork([toon, own]),
    timeoutMs: 200,
  });
  return { account, toon, own, cache, writer, store };
}

/** Mint, and then do the two things #120 puts between minting and publishing. */
async function mintAndPublish(w: World) {
  w.store.acknowledgeWarning();
  const held = await w.store.mint();
  const published = await w.store.publish();
  return { held, published };
}

describe('minting a Chain Seed', () => {
  let w: World;

  beforeEach(() => {
    w = world();
    w.store.acknowledgeWarning();
  });

  it('holds it, says it is NOT YET RECOVERABLE, and writes to no relay', async () => {
    const status = await w.store.mint();

    expect(status.state).toBe('not_yet_recoverable');
    expect(status.held?.text).toContain('NOT YET RECOVERABLE');
    expect(status.held?.steps.length).toBeGreaterThan(0);
    // The addresses are real: funding one of them is the next step, and it is
    // the only way the publication below can ever be paid for.
    expect(status.addresses?.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(status.addresses?.evm.path).toBe("m/44'/60'/0'/0/0");
    // And nothing pretends a record exists: no event id, no publication date,
    // no relay. A held seed cannot be mistaken for a published one.
    expect(status.record).toBeUndefined();
    expect(w.writer.written).toEqual([]);
    expect(w.toon.events).toEqual([]);
  });

  it('publishes it as ONE paid write, and only then calls it recoverable', async () => {
    const { published } = await mintAndPublish(w);

    expect(published.state).toBe('ready');
    expect(published.held).toBeUndefined();
    expect(published.record?.relays).toEqual([PROFILE_RELAY]);
    expect(published.lastPublish?.what).toBe('chain-seed');
    expect(published.lastPublish?.cost).toBe('1');
    expect(published.lastPublish?.destination).toBe('g.toon.relay');

    const written = w.toon.events.filter((event) => event.kind === CHAIN_SEED_KIND);
    expect(written).toHaveLength(1);
    expect(tagValue(written[0]!, 'd')).toBe(CHAIN_SEED_D);
    expect(written[0]!.pubkey).toBe(w.account.pubkey);
    // The very bytes that were sealed at mint time, not a re-seal.
    expect(w.writer.written[0]?.id).toBe(written[0]?.id);
  });

  it('gives two accounts two different seeds', async () => {
    const a = await w.store.mint();
    const other = world();
    other.store.acknowledgeWarning();
    const b = await other.store.mint();
    expect(a.addresses?.evm.address).not.toBe(b.addresses?.evm.address);
  });

  it('tells the relay that a record exists and nothing else', async () => {
    await mintAndPublish(w);
    const published = w.toon.events.find((event) => event.kind === CHAIN_SEED_KIND)!;

    // The `d` tag is the only thing in the clear, and it says "this account
    // keeps a console record" — which ADR 0020 accepts by name.
    expect(published.tags).toEqual([['d', CHAIN_SEED_D]]);
    expect(published.content).not.toMatch(/abandon|\bzoo\b/u);
    expect(published.content.split(/\s+/u)).toHaveLength(1);

    // A stranger's key does not open it.
    const stranger = fakeAccount();
    await expect(stranger.unsealFromSelf(published.content)).rejects.toThrow();
  });

  it('refuses to mint a second seed over the first — held or published', async () => {
    const held = await w.store.mint();
    // Still unpublished, and still a seed: minting again would strand
    // whatever the first one's addresses were funded with.
    await expect(w.store.mint()).rejects.toMatchObject({ code: 'seed_exists' });

    await w.store.publish();
    const again = w.store.mint();
    await expect(again).rejects.toMatchObject({ code: 'seed_exists' });
    await expect(again).rejects.toThrow(held.addresses!.evm.address);
    expect(w.toon.events.filter((event) => event.kind === CHAIN_SEED_KIND)).toHaveLength(1);
  });

  it('never puts the seed in the status, however it is asked for', async () => {
    const { published } = await mintAndPublish(w);
    expect(JSON.stringify(published)).not.toMatch(/mnemonic|abandon/iu);
  });
});

describe('a seed that is not yet recoverable', () => {
  it('keeps saying so when the write cannot be bought, and changes nothing', async () => {
    const toon = fakeRelayServer(PROFILE_RELAY);
    const w = world({ writer: brokeWriter(toon) });
    w.store.acknowledgeWarning();
    const held = await w.store.mint();
    expect(held.state).toBe('not_yet_recoverable');
    expect(held.writes.ready).toBe(false);
    expect(held.writes.blockedBy).toContain('no payment channel');

    const failed = await w.store.publish().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ChainSeedError);
    expect((failed as ChainSeedError).code).toBe('no_channel');
    expect((failed as ChainSeedError).status).toBe(402);
    expect((failed as ChainSeedError).message).toContain('NOT YET RECOVERABLE');
    expect((failed as ChainSeedError).message).not.toMatch(/abandon/u);

    // Unchanged: still held, still saying so, and the reason is kept.
    const after = w.store.status();
    expect(after.state).toBe('not_yet_recoverable');
    expect(after.held?.lastAttempt).toContain('no payment channel');
    expect(after.record).toBeUndefined();
    expect(toon.events).toEqual([]);
  });

  it('survives a restart as the same temporary state, not as a published seed', async () => {
    const w = world({ writer: brokeWriter(fakeRelayServer(PROFILE_RELAY)) });
    w.store.acknowledgeWarning();
    await w.store.mint();

    // The same machine, a new daemon: the cache is read back, and what it says
    // is "held", not "published".
    const restarted = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [PROFILE_RELAY],
      cache: w.cache,
      writer: () => w.writer,
      dial: fakeRelayNetwork([w.toon]),
      timeoutMs: 200,
    });
    const status = await restarted.refresh();
    expect(status.state).toBe('not_yet_recoverable');
    expect(status.record).toBeUndefined();
    expect(status.addresses).toBeDefined();
  });

  it('is cleared by finding the record on a relay, wherever it was published from', async () => {
    const w = world();
    w.store.acknowledgeWarning();
    await w.store.mint();
    // Another machine of the same account published it. This console's copy
    // says `published: false`, and the relay's answer is what settles it.
    const sealed = w.cache.read(w.account.pubkey)?.event as NostrEvent;
    w.toon.events = [sealed];

    const status = await w.store.refresh();
    expect(status.state).toBe('ready');
    expect(status.record?.source).toBe('relays');
  });

  it('lends its payer keys, because funding them is how the write gets paid', async () => {
    const w = world();
    w.store.acknowledgeWarning();
    const held = await w.store.mint();
    const address = await w.store.usePayerKeys((keys) => Promise.resolve(keys.evm.address));
    expect(address).toBe(held.addresses?.evm.address);
  });
});

describe('importing a mnemonic', () => {
  let w: World;

  beforeEach(() => {
    w = world();
    w.store.acknowledgeWarning();
  });

  it('derives the addresses every other wallet derives from the same phrase', async () => {
    const status = await w.store.importMnemonic(VECTOR);
    expect(status.origin).toBe('imported');
    expect(status.state).toBe('not_yet_recoverable');
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
    expect(w.cache.read(w.account.pubkey)?.event).toBeUndefined();
  });

  it('is quiet about importing the phrase this account already has', async () => {
    await w.store.importMnemonic(VECTOR);
    await w.store.publish();
    const again = await w.store.importMnemonic(VECTOR);
    expect(again.addresses?.evm.address).toBe(VECTOR_EVM);
    expect(w.toon.events.filter((event) => event.kind === CHAIN_SEED_KIND)).toHaveLength(1);
  });

  it('refuses a DIFFERENT phrase over an existing seed', async () => {
    await w.store.importMnemonic(VECTOR);
    const other =
      'legal winner thank year wave sausage worth useful legal winner thank yellow';
    await expect(w.store.importMnemonic(other)).rejects.toMatchObject({ code: 'seed_exists' });
  });
});

describe('recovering on a fresh data directory', () => {
  it('reads the seed back off the relay and derives the same addresses', async () => {
    const w = world();
    const { published } = await mintAndPublish(w);

    // A second machine: the same account and the same relay, and a cache that
    // has never held anything.
    const fresh = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(w.toon),
      dial: fakeRelayNetwork([w.toon]),
      timeoutMs: 200,
    });

    const recovered = await fresh.refresh();
    expect(recovered.state).toBe('ready');
    expect(recovered.record?.source).toBe('relays');
    expect(recovered.addresses).toEqual(published.addresses);
  });

  it('serves the cached record when every relay is down, and says where it came from', async () => {
    const w = world();
    const { published } = await mintAndPublish(w);

    const offline = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [PROFILE_RELAY],
      cache: w.cache,
      writer: () => fakePaidWriter(undefined),
      dial: fakeRelayNetwork([]),
      timeoutMs: 200,
    });
    const status = await offline.refresh();
    expect(status.state).toBe('ready');
    expect(status.record?.source).toBe('cache');
    expect(status.addresses).toEqual(published.addresses);
  });

  it('says so, rather than guessing, when the record is not this account’s', async () => {
    const w = world();
    await mintAndPublish(w);

    const stranger = fakeAccount();
    const theirs = new ChainSeedStore({
      signer: () => stranger,
      seedRelays: () => [PROFILE_RELAY],
      // Their own cache, holding somebody else's sealed record.
      cache: seededCache(
        stranger.pubkey,
        w.toon.events.find((e) => e.kind === CHAIN_SEED_KIND)!
      ),
      writer: () => fakePaidWriter(fakeRelayServer(PROFILE_RELAY)),
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

    await expect(w.store.mint()).rejects.toMatchObject({ code: 'warning_not_acknowledged' });
    expect(w.store.status().warning.text).toMatch(/holds its funds/u);
    expect(w.store.status().warning.acknowledgedAt).toBeUndefined();

    const after = w.store.acknowledgeWarning();
    expect(after.warning.acknowledgedAt).toBeTruthy();
    await expect(w.store.mint()).resolves.toMatchObject({ state: 'not_yet_recoverable' });
  });

  it('keeps its first answer when it is acknowledged twice', () => {
    const w = world();
    const first = w.store.acknowledgeWarning().warning.acknowledgedAt;
    const second = w.store.acknowledgeWarning().warning.acknowledgedAt;
    expect(second).toBe(first);
  });
});

describe('where a seed is written', () => {
  it('is the relay the console can buy a write to, at the price it was quoted', async () => {
    const w = world();
    const status = await w.store.refresh();
    expect(status.writes.ready).toBe(true);
    expect(status.writes.relays).toEqual([PROFILE_RELAY]);
    expect(status.writes.destination).toBe('g.toon.relay');
    expect(status.writes.price).toBe('1');
  });

  it('publishes a NIP-65 list as a paid write, and says what it cost', async () => {
    const w = world();
    const listed = await w.store.publishRelayList([{ url: OWN }]);

    expect(listed.relayList.state).toBe('present');
    expect(listed.relayList.write).toEqual([OWN]);
    expect(listed.lastPublish?.what).toBe('relay-list');
    expect(listed.lastPublish?.cost).toBe('1');
    expect(w.toon.events.some((event) => event.kind === 10002)).toBe(true);
  });

  it('refuses a relay list it cannot pay to write', async () => {
    const w = world({ writer: brokeWriter(fakeRelayServer(PROFILE_RELAY)) });
    await expect(w.store.publishRelayList([{ url: OWN }])).rejects.toMatchObject({
      code: 'no_channel',
      status: 402,
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
    await mintAndPublish(w);

    // The other machine, offline at the time, publishes its own a second later.
    const rival = new ChainSeedStore({
      signer: () => w.account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(w.toon),
      dial: fakeRelayNetwork([w.toon]),
      timeoutMs: 200,
      now: () => new Date(Date.now() + 60_000),
    });
    rival.acknowledgeWarning();
    // The rival cannot mint over the first — which is the protection working.
    await expect(rival.mint()).rejects.toMatchObject({ code: 'seed_exists' });

    // But if one got onto the relay anyway, the count is not swallowed.
    w.toon.events = [
      ...w.toon.events,
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

  it('holds the sealed event, never the words, and says whether it is published', async () => {
    const account = fakeAccount();
    const toon = fakeRelayServer(PROFILE_RELAY);
    const store = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new FileChainSeedCache(paths),
      writer: () => fakePaidWriter(toon),
      dial: fakeRelayNetwork([toon]),
      timeoutMs: 200,
    });
    store.acknowledgeWarning();
    await store.importMnemonic(VECTOR);

    const path = accountChainSeedPath(paths, account.pubkey);
    const held = readFileSync(path, 'utf8');
    expect(held).not.toMatch(/abandon/u);
    expect(held).toContain(CHAIN_SEED_D);
    expect(JSON.parse(held).event.kind).toBe(CHAIN_SEED_KIND);
    // The field that keeps a temporary state from passing for the real thing.
    expect(JSON.parse(held).published).toBe(false);

    await store.publish();
    expect(JSON.parse(readFileSync(path, 'utf8')).published).toBe(true);

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
      writer: () => fakePaidWriter(undefined),
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

function seededCache(pubkey: string, event: NostrEvent) {
  const cache = new InMemoryChainSeedCache();
  cache.writeEvent(pubkey, { event, published: true });
  return cache;
}

describe('looking on a relay nobody named', () => {
  it('finds the seed on a relay a person names, and remembers it', async () => {
    // A fresh machine whose network profile's relay is not the one that
    // answered: one relay URL, read-only, is the way back in.
    const account = fakeAccount();
    const elsewhere = fakeRelayServer(OTHER);
    const toon = fakeRelayServer(PROFILE_RELAY);
    const first = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [OTHER],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(elsewhere),
      dial: fakeRelayNetwork([elsewhere, toon]),
      timeoutMs: 200,
    });
    first.acknowledgeWarning();
    await first.mint();
    const published = await first.publish();

    const fresh = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(toon),
      dial: fakeRelayNetwork([elsewhere, toon]),
      timeoutMs: 200,
    });
    expect((await fresh.refresh()).state).toBe('absent');

    const found = await fresh.refresh({ relays: [OTHER] });
    expect(found.state).toBe('ready');
    expect(found.addresses).toEqual(published.addresses);

    // And it is remembered, so the URL is typed once.
    expect((await fresh.refresh()).state).toBe('ready');
  });

  it('publishes nothing while looking', async () => {
    const w = world();
    await w.store.refresh({ relays: [OWN] });
    expect(w.writer.written).toEqual([]);
    expect(w.own.events).toEqual([]);
  });

  it('refuses a hint that is not a relay URL', async () => {
    const w = world();
    await expect(w.store.refresh({ relays: ['relay.example'] })).rejects.toMatchObject({
      code: 'invalid_relay_url',
    });
  });
});

describe('a relay list this account published', () => {
  it('is read from wherever it can be found, and widens where reads look', async () => {
    const account = fakeAccount();
    const toon = fakeRelayServer(PROFILE_RELAY);
    const own = fakeRelayServer(OWN);
    await publishRelayListEvent(account, [toon], [[OWN, 'write'], OTHER]);

    const store = new ChainSeedStore({
      signer: () => account,
      seedRelays: () => [PROFILE_RELAY],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(toon),
      dial: fakeRelayNetwork([toon, own]),
      timeoutMs: 200,
    });
    const status = await store.refresh();
    expect(status.relayList.state).toBe('present');
    expect(status.relayList.write).toEqual([OWN, OTHER]);
    // A write still goes where a write can be bought, not where the list says.
    expect(status.writes.relays).toEqual([PROFILE_RELAY]);
  });
});
