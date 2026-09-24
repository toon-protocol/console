import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { handleApi, type ApiDeps } from './api.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { fakePaidWriter } from './chain-seed.testkit.js';
import type { ConnectorHealth } from './connector-health.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { idleLeases } from './lease.testkit.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { activeProfileFilePath, consolePaths, userProfilesFilePath } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';

/**
 * `PUT`/`DELETE /api/profiles/<id>` (TOON_Network#150) at the route seam:
 * `handleApi` in, an `ApiResponse` out, no socket (the token requirement
 * itself is one guard `server.ts` applies ahead of `handleApi` for every
 * `/api/*` route, and `server.test.ts` is what proves that once, not per
 * route).
 */
describe('PUT and DELETE /api/profiles/<id>', () => {
  let home: string;
  let deps: ApiDeps;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-api-profiles-'));
    const paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const session = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => [],
    });
    deps = {
      profiles: new ProfileStore(
        activeProfileFilePath(paths),
        undefined,
        userProfilesFilePath(paths)
      ),
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
      startedAt: new Date('2026-09-24T00:00:00Z'),
      readHealth: () =>
        Promise.resolve({ state: 'unconfigured', reason: '' } as ConnectorHealth),
      readDirectory: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not what this file tests' }),
      readTemplates: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not what this file tests' }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const put = (id: string, body: unknown) =>
    handleApi(deps, {
      method: 'PUT',
      path: `/api/profiles/${id}`,
      query: new URLSearchParams(),
      body,
    });
  const del = (id: string) =>
    handleApi(deps, {
      method: 'DELETE',
      path: `/api/profiles/${id}`,
      query: new URLSearchParams(),
    });

  it('overrides one field of a built-in, and answers the updated profile list', async () => {
    const answer = await put('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    expect(answer.status).toBe(200);
    const body = answer.body as {
      profiles: {
        id: string;
        connectorUrl: string;
        origin: string;
        overriddenFields: string[];
      }[];
    };
    const devnet = body.profiles.find((p) => p.id === 'devnet')!;
    expect(devnet.connectorUrl).toBe('https://my-fork.example/ilp');
    expect(devnet.origin).toBe('user');
    expect(devnet.overriddenFields).toEqual(['connectorUrl']);

    writeApiFixture('profiles-overridden', body);
  });

  it('adds a profile under a new id, with a label', async () => {
    const answer = await put('my-devnet', {
      label: 'My devnet fork',
      connectorUrl: 'https://my-fork.example/ilp',
      relayUrl: 'wss://my-fork.example',
    });
    expect(answer.status).toBe(200);
    const body = answer.body as { profiles: { id: string; label: string; origin: string }[] };
    const added = body.profiles.find((p) => p.id === 'my-devnet')!;
    expect(added.label).toBe('My devnet fork');
    expect(added.origin).toBe('user');

    writeApiFixture('profiles-added', body);
  });

  it('refuses a new id with no label', async () => {
    const answer = await put('my-devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    expect(answer.status).toBe(400);
    expect((answer.body as { error: string }).error).toBe('invalid_profile');
  });

  it('refuses an invalid URL, per field, and stores nothing', async () => {
    const answer = await put('devnet', {
      connectorUrl: 'not-a-url',
      relayUrl: 'https://wrong-scheme.example',
    });
    expect(answer.status).toBe(400);
    const body = answer.body as { error: string; errors: Record<string, string> };
    expect(body.error).toBe('invalid_profile');
    expect(Object.keys(body.errors).sort()).toEqual(['connectorUrl', 'relayUrl']);

    const list = await handleApi(deps, {
      method: 'GET',
      path: '/api/profiles',
      query: new URLSearchParams(),
    });
    const devnet = (list.body as { profiles: { id: string; origin: string }[] }).profiles.find(
      (p) => p.id === 'devnet'
    )!;
    expect(devnet.origin).toBe('built-in');

    writeApiFixture('profiles-invalid', body);
  });

  it('refuses http:// for a non-loopback, non-sandbox profile', async () => {
    const answer = await put('devnet', { connectorUrl: 'http://connector.example/ilp' });
    expect(answer.status).toBe(400);
  });

  it('allows http:// overriding the sandbox profile at a non-loopback host', async () => {
    const answer = await put('sandbox', { connectorUrl: 'http://docker-host.lan:3200/ilp' });
    expect(answer.status).toBe(200);
  });

  it('refuses an id outside the safe alphabet', async () => {
    const answer = await put('UPPERCASE', { label: 'x' });
    expect(answer.status).toBe(400);
    expect((answer.body as { error: string }).error).toBe('invalid_profile_id');
  });

  it('a path-traversal id never even reaches profile validation — it is not a route', async () => {
    const answer = await put('..%2Fescape', { label: 'x' });
    // `decodeURIComponent` turns `..%2Fescape` into `../escape`, which
    // `handleApi`'s own route match refuses for containing `/` before this
    // file's `putProfile` is ever called.
    expect(answer.status).toBe(404);
  });

  it('never accepts a chain fact — the body has no field for one', async () => {
    const answer = await put('devnet', {
      connectorUrl: 'https://my-fork.example/ilp',
      chainId: 84532,
      settlementAddress: '0x1234',
    });
    expect(answer.status).toBe(200);
    const body = answer.body as { profiles: { id: string }[] };
    expect(JSON.stringify(body)).not.toMatch(/84532|0x1234/u);
  });

  it('resets a built-in override on DELETE', async () => {
    await put('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    const answer = await del('devnet');
    expect(answer.status).toBe(200);
    const body = answer.body as { profiles: { id: string; origin: string }[] };
    expect(body.profiles.find((p) => p.id === 'devnet')?.origin).toBe('built-in');
  });

  it('removes a profile added under a new id on DELETE', async () => {
    await put('my-devnet', { label: 'My devnet fork' });
    const answer = await del('my-devnet');
    expect(answer.status).toBe(200);
    const body = answer.body as { profiles: { id: string }[] };
    expect(body.profiles.map((p) => p.id)).not.toContain('my-devnet');
  });

  it('refuses to delete an unknown profile', async () => {
    const answer = await del('nope');
    expect(answer.status).toBe(404);
  });

  it('refuses to remove the active profile — switch first', async () => {
    await put('my-devnet', { label: 'My devnet fork' });
    await handleApi(deps, {
      method: 'POST',
      path: '/api/profiles/active',
      query: new URLSearchParams(),
      body: { id: 'my-devnet' },
    });
    const answer = await del('my-devnet');
    expect(answer.status).toBe(409);

    writeApiFixture('profiles-active-delete-refused', answer.body);
  });

  it('resetting the active built-in profile is allowed, and stays active', async () => {
    await put('devnet', { connectorUrl: 'https://my-fork.example/ilp' });
    const answer = await del('devnet');
    expect(answer.status).toBe(200);
    const body = answer.body as { activeId: string };
    expect(body.activeId).toBe('devnet');
  });
});
