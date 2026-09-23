import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { CHAIN_SEED_KIND, ChainSeedStore, type ChainSeedStatus } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import {
  fakeRelayNetwork,
  fakeRelayServer,
  publishRelayListEvent,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import { generateAccountKey, toNsec } from './account-key.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
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
 * — not in a success, not in an error, not in the per-relay detail attached to
 * a failed publish.
 */

const PASSPHRASE = 'a passphrase for the test';
const VECTOR = 'abandon '.repeat(11) + 'about';
const VECTOR_EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OWN = 'wss://relay.own.test';
const PROFILE_RELAY = 'wss://relay.toon.test';
const PAID = 'restricted: writes require ILP payment';

describe('the chain seed routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let deps: ApiDeps;
  let own: FakeRelayServer;
  let toon: FakeRelayServer;
  let session: AccountSession;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  const status = async (): Promise<ChainSeedStatus> =>
    (await call('GET', '/api/chain-seed')).body as ChainSeedStatus;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-seed-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    own = fakeRelayServer(OWN);
    toon = fakeRelayServer(PROFILE_RELAY, { refuse: PAID });
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
        cache: new InMemoryChainSeedCache(),
        dial: fakeRelayNetwork([own, toon]),
        timeoutMs: 200,
      }),
      funding: fundingStoreFor({
        chainSeed: new ChainSeedStore({
          signer: () => undefined,
          seedRelays: () => [],
          cache: new InMemoryChainSeedCache(),
        }),
        paths,
        chains: fakeChainPort(),
      }),
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

    const minted = await call('POST', '/api/chain-seed/mint');
    expect(minted.status).toBe(409);
    expect(minted.body).toMatchObject({ error: 'not_signed_in' });
  });

  it('mints through the signed-in account and shows its addresses', async () => {
    const pubkey = await signIn();
    await publishRelayListEvent(session.signingPort()!, [own, toon], [OWN]);

    expect((await call('POST', '/api/chain-seed/acknowledge')).status).toBe(200);
    const minted = (await call('POST', '/api/chain-seed/mint')).body as ChainSeedStatus;

    expect(minted.state).toBe('ready');
    expect(minted.pubkey).toBe(pubkey);
    expect(minted.addresses?.evm.address).toMatch(/^0x/u);
    expect(own.events.some((event) => event.kind === CHAIN_SEED_KIND)).toBe(true);
  });

  it('imports a mnemonic and never echoes it back', async () => {
    await signIn();
    await publishRelayListEvent(session.signingPort()!, [own, toon], [OWN]);
    await call('POST', '/api/chain-seed/acknowledge');

    const imported = await call('POST', '/api/chain-seed/import', { mnemonic: VECTOR });
    expect(imported.status).toBe(200);
    expect((imported.body as ChainSeedStatus).addresses?.evm.address).toBe(VECTOR_EVM);
    expect(JSON.stringify(imported.body)).not.toMatch(/abandon/u);
    expect(JSON.stringify(await status())).not.toMatch(/abandon/u);
  });

  it('keeps a bad mnemonic out of the answer that rejects it', async () => {
    await signIn();
    await publishRelayListEvent(session.signingPort()!, [own, toon], [OWN]);
    await call('POST', '/api/chain-seed/acknowledge');

    const bad = await call('POST', '/api/chain-seed/import', {
      mnemonic: 'correct horse battery staple correct horse battery staple',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_mnemonic' });
    expect(JSON.stringify(bad.body)).not.toMatch(/horse/u);
  });

  it('answers the paid-relay refusal with 402 and the relay’s own words', async () => {
    await signIn();
    await call('POST', '/api/chain-seed/acknowledge');

    const refused = await call('POST', '/api/chain-seed/import', { mnemonic: VECTOR });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ error: 'relay_payment_required' });
    const body = refused.body as { message: string; relays: { reason?: string }[] };
    expect(body.message).toContain(PROFILE_RELAY);
    expect(body.relays[0]?.reason).toBe(PAID);
    expect(JSON.stringify(refused.body)).not.toMatch(/abandon/u);
  });

  it('refuses to mint before the warning has been read', async () => {
    await signIn();
    await publishRelayListEvent(session.signingPort()!, [own, toon], [OWN]);
    const refused = await call('POST', '/api/chain-seed/mint');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'warning_not_acknowledged' });
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
  });

  it('has no route it does not have', async () => {
    const missing = await call('POST', '/api/chain-seed/reveal');
    expect(missing.status).toBe(404);
  });
});
