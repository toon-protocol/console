import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { handleApi, type ApiDeps } from './api.js';
import type { ConnectorHealth } from './connector-health.js';
import type { DirectoryFilters, DirectoryResult } from './directory.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { consolePaths, activeProfileFilePath } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';

/**
 * The directory route, at the seam the API is built around: a `{ method,
 * path, query }` in, an answer out, no socket. What is under test here is the
 * QUERY STRING — the one place a person's filter is turned into something the
 * directory can act on, and the one place a typo can be caught before it comes
 * back as an empty network.
 */

const EMPTY: DirectoryResult = { state: 'unconfigured', reason: 'nothing to read' };

describe('GET /api/directory', () => {
  let home: string;
  let asked: DirectoryFilters[] = [];
  let deps: ApiDeps;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-api-'));
    asked = [];
    const paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
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
        Promise.resolve({ state: 'unconfigured', reason: '' } as ConnectorHealth),
      readDirectory: (_profile, filters) => {
        asked.push(filters);
        return Promise.resolve(EMPTY);
      },
      readTemplates: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not what this file tests' }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const get = (query: string) =>
    handleApi(deps, {
      method: 'GET',
      path: '/api/directory',
      query: new URLSearchParams(query),
    });

  it('reads the directory of whichever profile is active', async () => {
    const answer = await get('');
    expect(answer.status).toBe(200);
    expect(asked).toEqual([{}]);
  });

  it('carries every filter through, and takes each capability as a further demand', async () => {
    await get(
      'isolation=dedicated-host&arch=arm64&gpu=nvidia-rtx-4090&capability=docker&capability=nesting&hidden=true'
    );
    expect(asked[0]).toEqual({
      isolation: 'dedicated-host',
      arch: 'arm64',
      gpu: 'nvidia-rtx-4090',
      capabilities: ['docker', 'nesting'],
      hidden: true,
    });
  });

  it('treats `hidden` as three-valued: both, only, or none', async () => {
    await get('');
    await get('hidden=true');
    await get('hidden=false');
    expect(asked.map((filters) => filters.hidden)).toEqual([undefined, true, false]);
  });

  it('accepts `gpu=any`, which no relay filter can express', async () => {
    await get('gpu=any');
    expect(asked[0]?.gpu).toBe('any');
  });

  it('refuses a value outside the label vocabulary, rather than showing an empty network', async () => {
    for (const query of [
      'isolation=shared_kernel',
      'arch=x86_64',
      'gpu=NVIDIA_4090',
      'hidden=yes',
    ]) {
      const answer = await get(query);
      expect(answer.status, query).toBe(400);
      expect((answer.body as { error: string }).error).toBe('invalid_filter');
    }
    expect(asked).toEqual([]);
  });

  it('is behind the same 404 as every other unknown route when the method is wrong', async () => {
    const answer = await handleApi(deps, {
      method: 'POST',
      path: '/api/directory',
      query: new URLSearchParams(),
    });
    expect(answer.status).toBe(404);
  });
});
