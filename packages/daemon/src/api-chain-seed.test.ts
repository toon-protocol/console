import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { CHAIN_SEED_KIND, ChainSeedStore, type ChainSeedStatus } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  brokeWriter,
  fakePaidWriter,
  fakeRelayNetwork,
  fakeRelayServer,
  type FakeRelayServer,
  type FakeWriter,
} from './chain-seed.testkit.js';
import { generateAccountKey, toNsec } from './account-key.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { idleLeases } from './lease.testkit.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';

/**
 * The Chain Seed over the API, with a REAL session behind it: a key imported
 * into the file keystore, signed in, and sealing through the same
 * `AccountSession` the UI drives.
 *
 * The rule this file exists to pin is the one in `api.ts`'s header, sharpened:
 * a mnemonic goes IN on `/api/chain-seed/import` and must never come back out
 * — not in a success, not in an error, not in the per-write detail attached to
 * a publish that was refused.
 *
 * The second rule is #120's ordering, seen from the outside: a mint answers
 * `not_yet_recoverable`, and only `POST /api/chain-seed/publish` — one paid
 * write — turns that into `ready`.
 *
 * This file is also the TUI's fixture source for the Chain Seed view
 * (TOON_Network#142, ADR 0020): every state `ChainSeedCard` distinguishes —
 * `unknown` (not looked for yet), `absent` before and after the custody
 * warning is acknowledged, `not_yet_recoverable` ready to publish and
 * blocked on payment, `ready`, and `unreadable` — gets a real response
 * written via `writeApiFixture` at the point a test already asserts on it.
 */

const PASSPHRASE = 'a passphrase for the test';
const VECTOR = 'abandon '.repeat(11) + 'about';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OWN = 'wss://relay.own.test';
const PROFILE_RELAY = 'wss://relay.toon.test';

describe('the chain seed routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let deps: ApiDeps;
  let own: FakeRelayServer;
  let toon: FakeRelayServer;
  let writer: FakeWriter;
  let session: AccountSession;
  /**
   * Kept by reference (rather than built inline in `deps`) so the
   * `unreadable` test below can seed a stranger's cache directly — the same
   * shortcut `chain-seed.test.ts`'s `seededCache` uses, since the API has no
   * route that writes a raw event into another account's cache.
   */
  let cache: InMemoryChainSeedCache;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  const status = async (): Promise<ChainSeedStatus> =>
    (await call('GET', '/api/chain-seed')).body as ChainSeedStatus;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-seed-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    own = fakeRelayServer(OWN);
    toon = fakeRelayServer(PROFILE_RELAY);
    writer = fakePaidWriter(toon);
    cache = new InMemoryChainSeedCache();
    session = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => [],
    });
    deps = {
      profiles: new ProfileStore(activeProfileFilePath(paths)),
      session,
      chainSeed: new ChainSeedStore({
        signer: () => session.signingPort(),
        seedRelays: () => [PROFILE_RELAY],
        cache,
        writer: () => writer,
        dial: fakeRelayNetwork([own, toon]),
        timeoutMs: 200,
      }),
      funding: fundingStoreFor({
        chainSeed: new ChainSeedStore({
          signer: () => undefined,
          seedRelays: () => [],
          cache: new InMemoryChainSeedCache(),
          writer: () => writer,
        }),
        paths,
        chains: fakeChainPort(),
      }),
      ...idleLeases(paths),
      version: { name: '@toon-protocol/console-daemon', version: '0.1.0' },
      paths,
      startedAt: new Date('2026-09-22T00:00:00Z'),
      readHealth: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not asked in this test' }),
      readDirectory: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not asked in this test' }),
      readTemplates: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not asked in this test' }),
    };
  });

  afterEach(async () => {
    await session.signOut();
    rmSync(home, { recursive: true, force: true });
  });

  async function signIn(): Promise<string> {
    const key = generateAccountKey();
    const nsec = toNsec(key);
    await call('POST', '/api/account/signers/local', {
      mode: 'nsec',
      nsec,
      passphrase: PASSPHRASE,
    });
    return key.pubkey;
  }

  it('says there is nothing to show before anyone signs in', async () => {
    const before = await status();
    expect(before.state).toBe('signed_out');
    expect(before.warning.text).toMatch(/holds its funds/u);
    writeApiFixture('chain-seed-signed-out', before);

    const minted = await call('POST', '/api/chain-seed/mint');
    expect(minted.status).toBe(409);
    expect(minted.body).toMatchObject({ error: 'not_signed_in' });
  });

  it('mints, holds, and publishes on a route of its own', async () => {
    const pubkey = await signIn();

    // Signed in, but nothing has looked for a seed yet — `unknown`, not
    // `absent`: the two must render differently (ADR 0020).
    const freshlySignedIn = await status();
    expect(freshlySignedIn.state).toBe('unknown');
    writeApiFixture('chain-seed-unknown', freshlySignedIn);

    expect((await call('POST', '/api/chain-seed/acknowledge')).status).toBe(200);

    // Acknowledged, then looked for and found nothing: `absent`, warning
    // already acknowledged — the state the Mint/Import buttons render for.
    const lookedAndAbsent = (await call('POST', '/api/chain-seed/refresh'))
      .body as ChainSeedStatus;
    expect(lookedAndAbsent.state).toBe('absent');
    expect(lookedAndAbsent.warning.acknowledgedAt).toBeDefined();
    writeApiFixture('chain-seed-absent-acknowledged', lookedAndAbsent);

    const minted = (await call('POST', '/api/chain-seed/mint')).body as ChainSeedStatus;

    expect(minted.state).toBe('not_yet_recoverable');
    expect(minted.held?.text).toContain('NOT YET RECOVERABLE');
    expect(minted.pubkey).toBe(pubkey);
    expect(minted.addresses?.evm.address).toMatch(/^0x/u);
    expect(minted.record).toBeUndefined();
    expect(toon.events).toEqual([]);
    writeApiFixture('chain-seed-not-yet-recoverable', minted);

    const published = (await call('POST', '/api/chain-seed/publish')).body as ChainSeedStatus;
    expect(published.state).toBe('ready');
    expect(published.held).toBeUndefined();
    expect(published.lastPublish?.cost).toBe('1');
    expect(toon.events.some((event) => event.kind === CHAIN_SEED_KIND)).toBe(true);
    writeApiFixture('chain-seed-ready', published);
  });

  it('imports a mnemonic and never echoes it back', async () => {
    await signIn();
    await call('POST', '/api/chain-seed/acknowledge');

    const imported = await call('POST', '/api/chain-seed/import', { mnemonic: VECTOR });
    expect(imported.status).toBe(200);
    expect((imported.body as ChainSeedStatus).addresses?.evm.address).toBe(VECTOR_EVM);
    expect(JSON.stringify(imported.body)).not.toMatch(/abandon/u);
    expect(JSON.stringify(await status())).not.toMatch(/abandon/u);
  });

  it('keeps a bad mnemonic out of the answer that rejects it', async () => {
    await signIn();
    await call('POST', '/api/chain-seed/acknowledge');

    const bad = await call('POST', '/api/chain-seed/import', {
      mnemonic: 'correct horse battery staple correct horse battery staple',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_mnemonic' });
    expect(JSON.stringify(bad.body)).not.toMatch(/horse/u);
  });

  it('answers 402 when the write cannot be paid for, and keeps the seed held', async () => {
    writer = brokeWriter(toon);
    await signIn();
    await call('POST', '/api/chain-seed/acknowledge');

    const imported = await call('POST', '/api/chain-seed/import', { mnemonic: VECTOR });
    expect((imported.body as ChainSeedStatus).state).toBe('not_yet_recoverable');
    // Held, and `writes.ready` is false: nothing here can be paid for, so
    // the TUI's Publish button must show why rather than a price.
    expect((imported.body as ChainSeedStatus).writes.ready).toBe(false);
    writeApiFixture('chain-seed-not-yet-recoverable-blocked', imported.body);

    const refused = await call('POST', '/api/chain-seed/publish');
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ error: 'no_channel' });
    const body = refused.body as { message: string };
    expect(body.message).toContain('NOT YET RECOVERABLE');
    expect(JSON.stringify(refused.body)).not.toMatch(/abandon/u);

    // Still held, still saying so, and still on no relay.
    expect((await status()).state).toBe('not_yet_recoverable');
    expect(toon.events).toEqual([]);
  });

  it('refuses to mint before the warning has been read', async () => {
    await signIn();

    // Looked for, found nothing, warning still unread: the custody warning
    // must show, not the Mint/Import form (ADR 0020) — distinct from
    // `chain-seed-absent-acknowledged` above only in `warning.acknowledgedAt`.
    const lookedNotAcknowledged = (await call('POST', '/api/chain-seed/refresh'))
      .body as ChainSeedStatus;
    expect(lookedNotAcknowledged.state).toBe('absent');
    expect(lookedNotAcknowledged.warning.acknowledgedAt).toBeUndefined();
    writeApiFixture('chain-seed-absent', lookedNotAcknowledged);

    const refused = await call('POST', '/api/chain-seed/mint');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'warning_not_acknowledged' });
  });

  it('shows a record this signer cannot open as unreadable, rather than guessing', async () => {
    // The account that actually seals and publishes the record.
    const owner = await signIn();
    await call('POST', '/api/chain-seed/acknowledge');
    await call('POST', '/api/chain-seed/mint');
    const published = (await call('POST', '/api/chain-seed/publish')).body as ChainSeedStatus;
    expect(published.state).toBe('ready');
    const event = toon.events.find((candidate) => candidate.kind === CHAIN_SEED_KIND);
    expect(event).toBeDefined();
    expect(event?.pubkey).toBe(owner);
    await call('POST', '/api/account/signout');

    // A second account whose cache is seeded — the only way, short of a
    // second console entirely, that this account's own refresh sees an
    // event sealed to somebody else's key. `#readRecords` filters by
    // `authors: [pubkey]`, so no relay read would ever hand this event to a
    // stranger; the cache does not filter, which is exactly the gap
    // `chain-seed.test.ts`'s `seededCache` exercises directly.
    const stranger = await signIn();
    expect(stranger).not.toBe(owner);
    cache.writeEvent(stranger, { event: event!, published: true });

    const unreadable = (await call('POST', '/api/chain-seed/refresh'))
      .body as ChainSeedStatus;
    expect(unreadable.state).toBe('unreadable');
    expect(unreadable.reason).toBeTruthy();
    writeApiFixture('chain-seed-unreadable', unreadable);
  });

  it('publishes a relay list on request, and checks what it is given', async () => {
    await signIn();
    const bad = await call('POST', '/api/account/relays', { relays: [] });
    expect(bad.status).toBe(400);

    const wrong = await call('POST', '/api/account/relays', {
      relays: [{ url: OWN, mode: 'archive' }],
    });
    expect(wrong.status).toBe(400);

    const published = await call('POST', '/api/account/relays', { relays: [{ url: OWN }] });
    expect(published.status).toBe(200);
    expect((published.body as ChainSeedStatus).relayList.write).toEqual([OWN]);
    // It was bought like every other write, and it went where one can be.
    expect((published.body as ChainSeedStatus).lastPublish?.cost).toBe('1');
    expect(toon.events.some((event) => event.kind === 10002)).toBe(true);
  });

  it('has no route it does not have', async () => {
    const missing = await call('POST', '/api/chain-seed/reveal');
    expect(missing.status).toBe(404);
  });
});
