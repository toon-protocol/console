import { fakePaidWriter } from './chain-seed.testkit.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAccountKey, toNsec } from './account-key.js';
import { AccountSession } from './account-session.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { idleLeases } from './lease.testkit.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';

const PASSPHRASE = 'a passphrase for the test';

describe('the account routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let deps: ApiDeps;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-api-account-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const session = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => [],
    });
    deps = {
      profiles: new ProfileStore(activeProfileFilePath(paths)),
      session,
      chainSeed: new ChainSeedStore({
        signer: () => session.signingPort(),
        seedRelays: () => [],
        cache: new InMemoryChainSeedCache(),
        writer: () => fakePaidWriter(undefined),
      }),
      funding: fundingStoreFor({
        chainSeed: new ChainSeedStore({
          signer: () => undefined,
          seedRelays: () => [],
          cache: new InMemoryChainSeedCache(),
          writer: () => fakePaidWriter(undefined),
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
    await deps.session.signOut();
    rmSync(home, { recursive: true, force: true });
  });

  it('says nobody is signed in, and where a key would go', async () => {
    const answer = await call('GET', '/api/account');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ signedIn: false, keystore: { backend: 'file' } });
  });

  it('generates a key, signs in, and signs an event', async () => {
    const created = await call('POST', '/api/account/signers/local', {
      mode: 'generate',
      passphrase: PASSPHRASE,
    });
    expect(created.status).toBe(200);

    const signed = await call('POST', '/api/account/sign', {
      kind: 27_235,
      content: 'proof',
      tags: [['u', 'http://127.0.0.1/api/account']],
    });
    expect(signed.status).toBe(200);
    const event = (signed.body as { event: Parameters<typeof verifyEvent>[0] }).event;
    expect(verifyEvent(event)).toBe(true);
  });

  it('refuses a body with no mode', async () => {
    const answer = await call('POST', '/api/account/signers/local', {
      passphrase: PASSPHRASE,
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'invalid_request' });
  });

  it('turns a bad nsec into something a person can act on', async () => {
    const answer = await call('POST', '/api/account/signers/local', {
      mode: 'nsec',
      nsec: 'nsec1nonsense',
      passphrase: PASSPHRASE,
    });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'invalid_nsec' });
  });

  it('asks for a passphrase rather than storing a key in the clear', async () => {
    const answer = await call('POST', '/api/account/signers/local', { mode: 'generate' });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: 'passphrase_required' });
  });

  it('will not sign for an account that is not signed in', async () => {
    const answer = await call('POST', '/api/account/sign', { kind: 1, content: 'hi' });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: 'not_signed_in' });
  });

  it('signs out, and the signer stays on the list', async () => {
    await call('POST', '/api/account/signers/local', {
      mode: 'generate',
      passphrase: PASSPHRASE,
    });
    const out = await call('POST', '/api/account/signout');
    expect(out.body).toMatchObject({ signedIn: false });
    expect((out.body as { signers: unknown[] }).signers).toHaveLength(1);
  });

  it('signs back in by id', async () => {
    const created = await call('POST', '/api/account/signers/local', {
      mode: 'generate',
      passphrase: PASSPHRASE,
    });
    const id = (created.body as { signers: { id: string }[] }).signers[0]?.id;
    await call('POST', '/api/account/signout');
    const back = await call('POST', '/api/account/signin', { id, passphrase: PASSPHRASE });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ signedIn: true });
  });

  it('answers 401 and not 500 on the wrong passphrase', async () => {
    const created = await call('POST', '/api/account/signers/local', {
      mode: 'generate',
      passphrase: PASSPHRASE,
    });
    const id = (created.body as { signers: { id: string }[] }).signers[0]?.id;
    await call('POST', '/api/account/signout');
    const back = await call('POST', '/api/account/signin', { id, passphrase: 'nope' });
    expect(back.status).toBe(401);
    expect(back.body).toMatchObject({ error: 'wrong_passphrase' });
  });

  it('forgets a signer', async () => {
    const created = await call('POST', '/api/account/signers/local', {
      mode: 'generate',
      passphrase: PASSPHRASE,
    });
    const id = (created.body as { signers: { id: string }[] }).signers[0]?.id ?? '';
    const gone = await call('DELETE', `/api/account/signers/${encodeURIComponent(id)}`);
    expect((gone.body as { signers: unknown[] }).signers).toEqual([]);
  });

  it('refuses a bunker URI that is not one, without dialling anything', async () => {
    const answer = await call('POST', '/api/account/signers/bunker', {
      uri: 'https://example',
    });
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ error: 'invalid_bunker_uri' });
  });

  it('cannot offer a nostrconnect invitation with no relay to answer on', async () => {
    const answer = await call('POST', '/api/account/signers/invite', {});
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ error: 'no_relay' });
  });

  it('has no route it does not have', async () => {
    const answer = await call('POST', '/api/account/nonsense');
    expect(answer.status).toBe(404);
  });

  /**
   * The rule from `api.ts`, as a test: nothing a person typed comes back out,
   * and nothing a person typed reaches a file the keystore does not encrypt.
   */
  it('echoes back no nsec, no mnemonic and no passphrase', async () => {
    const key = generateAccountKey();
    const nsec = toNsec(key);
    const answers = [
      await call('POST', '/api/account/signers/local', {
        mode: 'nsec',
        nsec,
        passphrase: PASSPHRASE,
      }),
      await call('GET', '/api/account'),
      await call('POST', '/api/account/sign', { kind: 1, content: 'hello' }),
      await call('POST', '/api/account/signout'),
      await call('POST', '/api/account/signers/local', {
        mode: 'nip06',
        mnemonic:
          'leader monkey parrot ring guide accident before fence cannon height naive bean',
        passphrase: PASSPHRASE,
      }),
    ];
    for (const answer of answers) {
      const rendered = JSON.stringify(answer.body);
      expect(rendered).not.toContain(nsec);
      expect(rendered).not.toContain(PASSPHRASE);
      expect(rendered).not.toContain('leader monkey parrot');
      expect(rendered).not.toContain(Buffer.from(key.secretKey).toString('hex'));
    }
    const index = readFileSync(signerIndexPath(paths), 'utf8');
    expect(index).not.toContain(nsec);
    expect(index).not.toContain('leader monkey parrot');
    expect(index).not.toContain(PASSPHRASE);
  });
});
