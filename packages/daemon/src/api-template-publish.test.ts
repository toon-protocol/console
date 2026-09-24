import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountSession } from './account-session.js';
import { writeApiFixture } from './api-fixtures.testkit.js';
import { handleApi, type ApiDeps, type ApiResponse } from './api.js';
import { generateAccountKey, toNsec } from './account-key.js';
import { ChainSeedStore } from './chain-seed.js';
import { InMemoryChainSeedCache } from './chain-seed-cache.js';
import { brokeWriter, fakePaidWriter, fakeRelayServer, type FakeWriter } from './chain-seed.testkit.js';
import { fakeChainPort, fundingStoreFor } from './funding.testkit.js';
import { keystoreFilePath, PassphraseFileKeystore } from './keystore-file.js';
import { idleLeases } from './lease.testkit.js';
import { activeProfileFilePath, consolePaths, type ConsolePaths } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';
import { ConsoleTemplatePublisher } from './template-publish.js';

/**
 * `POST /api/templates/publish(/preview)`, at the API seam (TOON_Network#138).
 *
 * A user who generated their key inside the console holds neither an nsec
 * nor a Chain Seed mnemonic, so `main-template-publish.ts` (env-var keys) is
 * not something they can run — this is the seam that lets them publish a
 * Template the same way the Chain Seed publishes: signed by the session's
 * `ConsoleSigner`, paid from the session's own relay channel, and never a raw
 * key anywhere near the request or the response.
 *
 * What matters here, beyond the happy path: a preview sends nothing (no
 * event reaches any relay, nothing is billed), a publish writes exactly the
 * two events — the image entry, then the Template — both signed by the
 * SESSION's pubkey, and every refusal (signed out, unresolved image, a
 * write nothing can pay for) is clear and leaves nothing written.
 */

const MANIFEST_DIGEST = `sha256:${'e'.repeat(64)}`;
const SINGLE_MANIFEST = {
  config: {
    digest: `sha256:${'c'.repeat(64)}`,
    size: 1234,
    mediaType: 'application/vnd.oci.image.config.v1+json',
  },
  layers: [
    {
      digest: `sha256:${'d'.repeat(64)}`,
      size: 2_226_327,
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    },
  ],
};

const IMAGE = `ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`;
const RAW_TEMPLATE = {
  name: 'ssh-box',
  title: 'SSH box (Alpine)',
  summary: 'An SSH shell with your key and nothing else.',
  ports: [{ container_port: 22, protocol: 'tcp' }],
  env_fixed: {},
  env_tenant: [],
  ssh_key: { required: true, note: 'your own key' },
};
const PROFILE_RELAY = 'wss://relay.toon.test';

function fetchOk(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(SINGLE_MANIFEST), {
      status: 200,
      headers: {
        'content-type': 'application/vnd.oci.image.manifest.v1+json',
        'content-length': '512',
      },
    })) as typeof fetch;
}

function fetchMissing(): typeof fetch {
  return (async () => new Response('not found', { status: 404 })) as typeof fetch;
}

describe('the Template publish routes', () => {
  let home: string;
  let paths: ConsolePaths;
  let deps: ApiDeps;
  let session: AccountSession;
  let writer: FakeWriter;

  const call = (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    handleApi(deps, { method, path, query: new URLSearchParams(), body });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-template-publish-api-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    const relay = fakeRelayServer(PROFILE_RELAY);
    writer = fakePaidWriter(relay);
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
        seedRelays: () => [],
        cache: new InMemoryChainSeedCache(),
        writer: () => writer,
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
      startedAt: new Date('2026-09-24T00:00:00Z'),
      readHealth: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not asked in this test' }),
      readDirectory: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not asked in this test' }),
      readTemplates: () =>
        Promise.resolve({ state: 'unconfigured', reason: 'not asked in this test' }),
      templatePublish: new ConsoleTemplatePublisher({
        signer: () => session.signingPort(),
        writer: () => writer,
        fetchImpl: fetchOk(),
      }),
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
      passphrase: 'a passphrase for the test',
    });
    return key.pubkey;
  }

  it('refuses a preview when nobody is signed in', async () => {
    const response = await call('POST', '/api/templates/publish/preview', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'not_signed_in' });
    expect(writer.written).toEqual([]);
  });

  it('previews the two events and their price, and sends nothing', async () => {
    const pubkey = await signIn();

    const response = await call('POST', '/api/templates/publish/preview', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      entryKind: number;
      entryAddress: string;
      templateKind: number;
      templateAddress: string;
      title: string;
      summary: string;
      imageDigest: string;
      targets: { ready: boolean; price?: string; totalPrice?: string };
    };
    expect(body.entryKind).toBe(30434);
    expect(body.templateKind).toBe(30436);
    expect(body.entryAddress).toBe(`30434:${pubkey}:ssh-box:latest`);
    expect(body.templateAddress).toBe(`30436:${pubkey}:ssh-box`);
    expect(body.title).toBe('SSH box (Alpine)');
    expect(body.imageDigest).toBe(MANIFEST_DIGEST);
    expect(body.targets.ready).toBe(true);
    expect(body.targets.price).toBe('1');

    // A preview is a free, read-only quote: nothing was written, and no
    // relay this test can see holds either event.
    expect(writer.written).toEqual([]);
    writeApiFixture('template-publish-preview', response.body);
  });

  it('shows blockedBy in a preview rather than pretending a write is payable', async () => {
    await signIn();
    writer = brokeWriter(fakeRelayServer(PROFILE_RELAY));
    deps = {
      ...deps,
      templatePublish: new ConsoleTemplatePublisher({
        signer: () => session.signingPort(),
        writer: () => writer,
        fetchImpl: fetchOk(),
      }),
    };

    const response = await call('POST', '/api/templates/publish/preview', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });

    expect(response.status).toBe(200);
    const body = response.body as { targets: { ready: boolean; blockedBy?: string } };
    expect(body.targets.ready).toBe(false);
    expect(body.targets.blockedBy).toBeTruthy();
    writeApiFixture('template-publish-preview-blocked', response.body);
  });

  it('refuses a preview whose image cannot be resolved', async () => {
    await signIn();
    deps = {
      ...deps,
      templatePublish: new ConsoleTemplatePublisher({
        signer: () => session.signingPort(),
        writer: () => writer,
        fetchImpl: fetchMissing(),
      }),
    };

    const response = await call('POST', '/api/templates/publish/preview', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'image_unresolved' });
  });

  it('refuses a request with no template or no image', async () => {
    await signIn();
    const noTemplate = await call('POST', '/api/templates/publish/preview', { image: IMAGE });
    expect(noTemplate.status).toBe(400);
    expect(noTemplate.body).toMatchObject({ error: 'invalid_request' });

    const noImage = await call('POST', '/api/templates/publish/preview', {
      template: RAW_TEMPLATE,
    });
    expect(noImage.status).toBe(400);
    expect(noImage.body).toMatchObject({ error: 'invalid_request' });
  });

  it('publishes exactly two events, signed by the session pubkey, image entry first', async () => {
    const pubkey = await signIn();

    const response = await call('POST', '/api/templates/publish', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      outcomes: { what: string; address: string; eventId: string; cost?: string }[];
      cost: string;
      templateAddress: string;
    };
    expect(body.outcomes.map((outcome) => outcome.what)).toEqual(['image-entry', 'template']);
    expect(body.templateAddress).toBe(`30436:${pubkey}:ssh-box`);
    expect(body.cost).toBe('2');

    expect(writer.written).toHaveLength(2);
    expect(writer.written.map((event) => event.kind)).toEqual([30434, 30436]);
    expect(writer.written.every((event) => event.pubkey === pubkey)).toBe(true);

    // The gallery reads the relay live (no cache to invalidate — see
    // `handleTemplates`), so it must show what was just published.
    writeApiFixture('template-publish', response.body);
  });

  it('refuses a publish when signed out, and writes nothing', async () => {
    const response = await call('POST', '/api/templates/publish', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'not_signed_in' });
    expect(writer.written).toEqual([]);
  });

  it('refuses a publish nothing can pay for, and writes nothing', async () => {
    await signIn();
    const broke = brokeWriter(fakeRelayServer(PROFILE_RELAY));
    deps = {
      ...deps,
      templatePublish: new ConsoleTemplatePublisher({
        signer: () => session.signingPort(),
        writer: () => broke,
        fetchImpl: fetchOk(),
      }),
    };

    const response = await call('POST', '/api/templates/publish', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(broke.written).toEqual([]);
  });

  it('refuses a publish whose image cannot be resolved, and writes nothing', async () => {
    await signIn();
    deps = {
      ...deps,
      templatePublish: new ConsoleTemplatePublisher({
        signer: () => session.signingPort(),
        writer: () => writer,
        fetchImpl: fetchMissing(),
      }),
    };

    const response = await call('POST', '/api/templates/publish', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'image_unresolved' });
    expect(writer.written).toEqual([]);
  });

  it('answers 501, never a guess, when the route is not wired', async () => {
    await signIn();
    const { templatePublish: _templatePublish, ...withoutPublisher } = deps;
    deps = withoutPublisher;

    const response = await call('POST', '/api/templates/publish', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ error: 'template_publish_unwired' });
  });

  it('has no route it does not have', async () => {
    const response = await call('POST', '/api/templates/publish/reveal');
    expect(response.status).toBe(404);
  });

  it('never echoes key material: no nsec, mnemonic or the raw secret key surfaces anywhere', async () => {
    await signIn();
    const preview = await call('POST', '/api/templates/publish/preview', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    const published = await call('POST', '/api/templates/publish', {
      template: RAW_TEMPLATE,
      image: IMAGE,
    });
    const everything = JSON.stringify([preview.body, published.body]);
    // A bech32 nsec, or 12/24 space-joined lowercase words that could be a
    // BIP-39 phrase, would both be a leak of exactly the material ADR 0020
    // says must never reach a response.
    expect(everything).not.toMatch(/nsec1[0-9a-z]+/u);
    expect(everything).not.toMatch(/(?:[a-z]+ ){11,23}[a-z]+/u);
  });
});
