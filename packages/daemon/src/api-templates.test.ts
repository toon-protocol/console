import { fakePaidWriter } from './chain-seed.testkit.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import type { ConnectorHealth } from './connector-health.js';
import { fakeRelays } from './directory.testkit.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { keystoreFilePath, PassphraseFileKeystore } from './keystore-file.js';
import type { NostrEvent } from './nostr.js';
import { idleLeases } from './lease.testkit.js';
import { activeProfileFilePath, consolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { DEVNET } from './profiles.js';
import { queryRelays } from './relay-pool.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';
import type { TemplateSpawnRequest } from './template-spawn.js';
import { readTemplates } from './templates.js';
import { fakePublisher, imageEntryEvent, templateEvent } from './templates.testkit.js';

/**
 * The Template routes (TOON_Network#94), at the API seam.
 *
 * What these care about is the boundary, not the expansion: that the gallery
 * is served, that a Template nobody published is a `404` rather than a guess,
 * and — the one that matters — that a window cannot set a setting the
 * publisher fixed by posting it. The daemon re-reads the Template from the
 * relays every time, so what the request says about the Template is nothing at
 * all beyond which one it is.
 *
 * The last two show the seam #92 fills: with no spawn port wired, a spawn is
 * `501` AND the finished expansion; with one wired, the same expansion arrives
 * at it unchanged.
 */

const RELAY = 'wss://relay.test';
const SSH_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@fixture';

const publisher = fakePublisher('api-template-publisher');

describe('the Template routes', () => {
  let home: string;
  let deps: ApiDeps;
  let spawned: TemplateSpawnRequest[];

  const relayEvents: NostrEvent[] = [
    templateEvent(publisher, {
      name: 'static-site',
      ports: [{ containerPort: 8080 }],
      envFixed: { MODE: 'production' },
      envTenant: ['SITE_TITLE'],
    }),
    imageEntryEvent(publisher),
  ];

  const address = `30436:${publisher.pubkey}:static-site`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-templates-'));
    spawned = [];
    const paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const session = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => [],
    });
    const { dial } = fakeRelays([{ url: RELAY, events: relayEvents }]);
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
      startedAt: new Date('2026-09-23T00:00:00Z'),
      readHealth: () =>
        Promise.resolve({ state: 'unconfigured', reason: '' } as ConnectorHealth),
      readDirectory: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not what this file tests' }),
      readTemplates: () =>
        readTemplates({
          profile: { ...DEVNET, relayUrl: RELAY },
          timeoutMs: 200,
          query: (query) => queryRelays({ ...query, dial }),
        }),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), ...(body ? { body } : {}) });

  it('serves the gallery', async () => {
    const response = await call('GET', '/api/templates');
    expect(response.status).toBe(200);
    const body = response.body as { state: string; templates: { name: string }[] };
    expect(body.state).toBe('ok');
    expect(body.templates.map((template) => template.name)).toEqual(['static-site']);
  });

  it('expands a Template into a spawn', async () => {
    const response = await call('POST', '/api/templates/expand', {
      template: address,
      env: { SITE_TITLE: 'a small site' },
      sshPublicKey: SSH_KEY,
    });
    expect(response.status).toBe(200);
    const body = response.body as { spawn: { env: Record<string, string>; template: string } };
    expect(body.spawn.env).toEqual({ MODE: 'production', SITE_TITLE: 'a small site' });
    expect(body.spawn.template).toBe(address);
  });

  it('refuses a setting the Template did not mark tenant-settable', async () => {
    const response = await call('POST', '/api/templates/expand', {
      template: address,
      env: { MODE: 'debug' },
      sshPublicKey: SSH_KEY,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'not_tenant_settable' });
  });

  it('is a 404 for a Template no relay carries', async () => {
    const response = await call('POST', '/api/templates/expand', {
      template: `30436:${publisher.pubkey}:nothing-like-it`,
      sshPublicKey: SSH_KEY,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'unknown_template' });
  });

  it('asks for the SSH key rather than spawning without one', async () => {
    const response = await call('POST', '/api/templates/expand', { template: address });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_request' });
  });

  it('answers 501 and the expansion while the paid spawn is unwired', async () => {
    const response = await call('POST', '/api/templates/spawn', {
      template: address,
      listing: `30432:${publisher.pubkey}:basic`,
      listingVersion: 1,
      provider: publisher.pubkey,
      sshPublicKey: SSH_KEY,
    });
    expect(response.status).toBe(501);
    const body = response.body as { error: string; expansion: { spawn: { image: unknown } } };
    expect(body.error).toBe('spawn_unwired');
    expect(body.expansion.spawn.image).toMatchObject({
      registry_entry: { address: `30434:${publisher.pubkey}:web:1.0` },
    });
  });

  it('hands the expansion to the spawn port once one is wired', async () => {
    deps = {
      ...deps,
      spawnFromTemplate: (request) => {
        spawned.push(request);
        return Promise.resolve({ workload_id: request.content.workload_id });
      },
    };
    const response = await call('POST', '/api/templates/spawn', {
      template: address,
      listing: `30432:${publisher.pubkey}:basic`,
      listingVersion: 1,
      provider: publisher.pubkey,
      sshPublicKey: SSH_KEY,
      env: { SITE_TITLE: 'a small site' },
      localOnly: true,
    });
    expect(response.status).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.template).toBe(address);
    expect(spawned[0]?.listing).toBe(`30432:${publisher.pubkey}:basic`);
    expect(spawned[0]?.localOnly).toBe(true);
    expect(spawned[0]?.content.env).toEqual({
      MODE: 'production',
      SITE_TITLE: 'a small site',
    });
  });

  it('will not sell a lease for an image it could not resolve', async () => {
    // The same Template, on a relay that carries no Image Registry entry.
    const { dial } = fakeRelays([{ url: RELAY, events: [relayEvents[0] as NostrEvent] }]);
    deps = {
      ...deps,
      readTemplates: () =>
        readTemplates({
          profile: { ...DEVNET, relayUrl: RELAY },
          timeoutMs: 200,
          query: (query) => queryRelays({ ...query, dial }),
        }),
      spawnFromTemplate: (request) => {
        spawned.push(request);
        return Promise.resolve({});
      },
    };
    const response = await call('POST', '/api/templates/spawn', {
      template: address,
      listing: `30432:${publisher.pubkey}:basic`,
      listingVersion: 1,
      provider: publisher.pubkey,
      sshPublicKey: SSH_KEY,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'image_unresolved' });
    expect(spawned).toHaveLength(0);
  });
});
