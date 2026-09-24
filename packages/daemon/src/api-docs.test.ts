import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { fakePaidWriter } from './chain-seed.testkit.js';
import { articleTemplate } from './docs-article.js';
import { DocsStore } from './docs.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { idleLeases } from './lease.testkit.js';
import type { NostrEvent } from './nostr.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import type { RelayReadResult } from './relay-pool.js';

/**
 * The docs routes (TOON_Network#102, #148).
 *
 * `GET /api/docs` and `GET /api/docs/<d>` are the TUI Docs view's two calls
 * (`tui/src/views/docs.rs`), and this is where their fixtures come from —
 * `writeApiFixture` below writes each route's REAL response, against the
 * REAL `docs/` this repository ships, so `tui/tests/fixture_contract.rs`
 * checks the hand-kept Rust types against exactly what a person's console
 * would answer, not a shape invented for the test.
 */

describe('the docs routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let deps: ApiDeps;

  const call = (method: string, path: string): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body: undefined });

  function baseDeps(docs: DocsStore | undefined): ApiDeps {
    const chainSeed = new ChainSeedStore({
      signer: () => undefined,
      seedRelays: () => [],
      cache: new InMemoryChainSeedCache(),
      writer: () => fakePaidWriter(undefined),
    });
    return {
      profiles: new ProfileStore(activeProfileFilePath(paths)),
      session: undefined as never,
      chainSeed,
      funding: fundingStoreFor({ chainSeed, paths, chains: fakeChainPort() }),
      ...idleLeases(paths),
      version: { name: '@toon-protocol/console-daemon', version: '0.1.0' },
      paths,
      startedAt: new Date('2026-09-24T00:00:00Z'),
      readHealth: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readDirectory: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      readTemplates: () => Promise.resolve({ state: 'unconfigured', reason: 'not asked' }),
      ...(docs === undefined ? {} : { docs }),
    };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-docs-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('answers a 503 rather than 500 when this build has no docs installed', async () => {
    deps = baseDeps(undefined);
    const answer = await call('GET', '/api/docs');
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: 'no_docs' });
  });

  it('refuses a write: this surface is read-only', async () => {
    deps = baseDeps(new DocsStore({ relays: () => [], npub: () => undefined }));
    const answer = await call('POST', '/api/docs');
    expect(answer.status).toBe(405);
  });

  it(
    'answers the index with the REAL bundled docs when no npub is configured, ' +
      'says so, and writes the TUI fixture',
    async () => {
      deps = baseDeps(new DocsStore({ relays: () => [], npub: () => undefined }));
      const answer = await call('GET', '/api/docs');

      expect(answer.status).toBe(200);
      const body = answer.body as {
        author?: unknown;
        fallback?: string;
        docs: { d: string; source: string }[];
      };
      expect(body.author).toBeUndefined();
      expect(body.fallback).toContain('No documentation npub is configured');
      expect(body.docs.map((doc) => doc.d)).toContain('first-workload');
      expect(body.docs.every((doc) => doc.source === 'bundled')).toBe(true);

      // The TUI's fixture contract (TOON_Network#139, ADR 0028): the REAL
      // response this assertion just checked, committed so `tui/`'s
      // `DocsIndex` is checked against it without running this daemon.
      writeApiFixture('docs', body);
    }
  );

  it(
    'answers one bundled page with its markdown, and writes the TUI fixture',
    async () => {
      deps = baseDeps(new DocsStore({ relays: () => [], npub: () => undefined }));
      const answer = await call('GET', '/api/docs/first-workload');

      expect(answer.status).toBe(200);
      const body = answer.body as { doc: { d: string; markdown: string; source: string } };
      expect(body.doc.d).toBe('first-workload');
      expect(body.doc.source).toBe('bundled');
      expect(body.doc.markdown).toContain('# Your first workload');
      expect(body.doc.markdown).toContain('[Funding](funding)');

      writeApiFixture('doc', body);
    }
  );

  it('404s on a doc id this build has never heard of', async () => {
    deps = baseDeps(new DocsStore({ relays: () => [], npub: () => undefined }));
    const answer = await call('GET', '/api/docs/not-a-real-page');
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ error: 'unknown_doc' });
  });

  it('reads published NIP-23 articles off the relays when an npub is configured', async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const npub = npubEncode(pubkey);
    const published: NostrEvent = finalizeEvent(
      articleTemplate(
        {
          d: 'concepts',
          title: 'Concepts, published',
          summary: 'Straight off a relay.',
          order: 1,
          publishedAt: '2026-09-24',
          tags: ['toon-network'],
          markdown: '# Concepts\n\nThis came from a relay, not the tarball.',
        },
        1_800_000_000
      ),
      secretKey
    ) as unknown as NostrEvent;

    const result: RelayReadResult = {
      events: [published],
      relays: [{ url: 'wss://relay.test', state: 'read', events: 1 }],
      rejected: 0,
    };
    deps = baseDeps(
      new DocsStore({
        relays: () => ['wss://relay.test'],
        npub: () => npub,
        query: () => Promise.resolve(result),
      })
    );

    const answer = await call('GET', '/api/docs');
    expect(answer.status).toBe(200);
    const body = answer.body as {
      author?: { npub: string };
      fallback?: string;
      docs: { d: string; source: string; address?: string }[];
    };
    expect(body.author?.npub).toBe(npub);
    expect(body.fallback).toBeUndefined();
    const concepts = body.docs.find((doc) => doc.d === 'concepts');
    expect(concepts?.source).toBe('relays');
    expect(concepts?.address).toBe(`30023:${pubkey}:concepts`);
  });
});
