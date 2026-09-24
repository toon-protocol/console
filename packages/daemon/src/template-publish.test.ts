import { describe, expect, it } from 'vitest';

import { fakeProvider, sign } from './directory.testkit.js';
import { RelayWriteError, type RelayWriteReceipt, type RelayWriteRequest } from './relay-write.js';
import type { RelayWriter, RelayWriteTargets } from './relay-write.js';
import { readImageEntry, readTemplateContent, resolveImage } from './templates.js';
import {
  parseImageReference,
  planTemplatePublish,
  publishTemplatePlan,
  readTemplateInputFile,
  resolveOciEntry,
  type TemplatePublishPlan,
} from './template-publish.js';
import type { NostrEvent } from './nostr.js';

/**
 * `template:publish`'s event building, against fixtures — never a real
 * registry and never a real relay (TOON_Network#138).
 *
 * The strongest check here is a round trip: build the plan, sign both
 * events with a throwaway test key, and feed them straight into
 * `templates.ts`'s OWN readers — `readTemplateContent`, `readImageEntry`,
 * `resolveImage` — the exact functions the console's gallery calls on a
 * real relay's answer. If those call the built events "available", the
 * publish script is not just producing plausible JSON; it produces
 * something the console can actually resolve.
 */

const MANIFEST_DIGEST = `sha256:${'e'.repeat(64)}`;
const AMD64_DIGEST = `sha256:${'b'.repeat(64)}`;
const ARM64_DIGEST = `sha256:${'a'.repeat(64)}`;

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

const INDEX = {
  manifests: [
    {
      digest: ARM64_DIGEST,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      platform: { architecture: 'arm64', os: 'linux' },
    },
    {
      digest: AMD64_DIGEST,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      platform: { architecture: 'amd64', os: 'linux' },
    },
  ],
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', ...headers },
  });
}

describe('parseImageReference', () => {
  it('splits a digest-pinned reference into registry, repository and digest', () => {
    expect(parseImageReference(`ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`)).toEqual({
      registry: 'ghcr.io',
      repository: 'toon-protocol/ssh-box',
      tag: 'latest',
      digest: MANIFEST_DIGEST,
    });
  });

  it('expands a Docker Hub two-part name, defaulting the tag', () => {
    expect(parseImageReference('traefik/whoami:v1.10.2')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'traefik/whoami',
      tag: 'v1.10.2',
    });
    expect(parseImageReference('alpine')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'library/alpine',
      tag: 'latest',
    });
  });

  it('does not mistake a registry port for a tag', () => {
    expect(parseImageReference('registry.example:5000/team/app:1.2')).toEqual({
      registry: 'registry.example:5000',
      repository: 'team/app',
      tag: '1.2',
    });
  });

  it('refuses a digest that is not sha256 hex', () => {
    expect(() => parseImageReference('ghcr.io/x/y@sha256:nothex')).toThrow(/sha256/u);
  });
});

describe('resolveOciEntry', () => {
  it('resolves a single-platform manifest fetched by digest', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse(200, SINGLE_MANIFEST, {
        'content-length': '512',
      });
    }) as typeof fetch;

    const { ref, entry } = await resolveOciEntry(
      `ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`,
      'amd64',
      { fetchImpl }
    );

    expect(ref).toEqual({
      registry: 'ghcr.io',
      repository: 'toon-protocol/ssh-box',
      tag: 'latest',
      digest: MANIFEST_DIGEST,
    });
    expect(entry.digest).toBe(MANIFEST_DIGEST);
    // The manifest is the first blob, config second, layers after.
    expect(entry.blobs).toHaveLength(3);
    for (const blob of entry.blobs) {
      expect(blob.source).toEqual({
        type: 'oci',
        registry: 'ghcr.io',
        repository: 'toon-protocol/ssh-box',
      });
    }
    expect(calls[0]).toContain(`/v2/toon-protocol/ssh-box/manifests/${MANIFEST_DIGEST}`);
  });

  it('resolves a multi-arch index down to the requested platform', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const s = String(url);
      if (s.endsWith(`/manifests/${MANIFEST_DIGEST}`)) {
        return new Response(JSON.stringify(INDEX), {
          status: 200,
          headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' },
        });
      }
      if (s.endsWith(`/manifests/${AMD64_DIGEST}`)) {
        return jsonResponse(200, SINGLE_MANIFEST, { 'content-length': '999' });
      }
      throw new Error(`unexpected fetch: ${s}`);
    }) as typeof fetch;

    const { entry } = await resolveOciEntry(
      `ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`,
      'amd64',
      { fetchImpl }
    );
    expect(entry.digest).toBe(AMD64_DIGEST);
  });

  it('refuses an index with no manifest for the requested arch', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(INDEX), {
        status: 200,
        headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' },
      })) as typeof fetch;

    await expect(
      resolveOciEntry(`ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`, 'riscv64', {
        fetchImpl,
      })
    ).rejects.toThrow(/no linux\/riscv64 manifest/u);
  });

  it('retries once with a pull token after an anonymous 401', async () => {
    let attempt = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const s = String(url);
      if (s.includes('/manifests/')) {
        attempt += 1;
        if (attempt === 1) {
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://auth.example/token",service="registry.example"',
            },
          });
        }
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer test-token'
        );
        return jsonResponse(200, SINGLE_MANIFEST, { 'content-length': '10' });
      }
      if (s.startsWith('https://auth.example/token')) {
        return new Response(JSON.stringify({ token: 'test-token' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${s}`);
    }) as typeof fetch;

    const { entry } = await resolveOciEntry(`ghcr.io/x/y@${MANIFEST_DIGEST}`, 'amd64', {
      fetchImpl,
    });
    expect(entry.digest).toBe(MANIFEST_DIGEST);
  });

  it('refuses a registry that answers with anything but 200', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(
      resolveOciEntry(`ghcr.io/x/y@${MANIFEST_DIGEST}`, 'amd64', { fetchImpl })
    ).rejects.toThrow(/404/u);
  });
});

describe('readTemplateInputFile', () => {
  const VALID = {
    name: 'ssh-box',
    title: 'SSH box (Alpine)',
    summary: 'An SSH shell with your key and nothing else.',
    ports: [{ container_port: 22, protocol: 'tcp' }],
    env_fixed: {},
    env_tenant: [],
    ssh_key: { required: true, note: 'your own key' },
  };

  it('reads a well-formed template.json', () => {
    const file = readTemplateInputFile(VALID);
    expect(file).toEqual({
      name: 'ssh-box',
      title: 'SSH box (Alpine)',
      summary: 'An SSH shell with your key and nothing else.',
      ports: [{ containerPort: 22, protocol: 'tcp' }],
      envFixed: {},
      envTenant: [],
      sshKeyRequired: true,
      sshKeyNote: 'your own key',
    });
  });

  it('refuses a name that is not lowercase-hyphenated', () => {
    expect(() => readTemplateInputFile({ ...VALID, name: 'SSH Box' })).toThrow(/name/u);
  });

  it('refuses a missing title or summary', () => {
    const { title, ...withoutTitle } = VALID;
    void title;
    expect(() => readTemplateInputFile(withoutTitle)).toThrow(/title/u);
    const { summary, ...withoutSummary } = VALID;
    void summary;
    expect(() => readTemplateInputFile(withoutSummary)).toThrow(/summary/u);
  });

  it('refuses ssh_key.required: false — this Template is always about the key', () => {
    expect(() =>
      readTemplateInputFile({ ...VALID, ssh_key: { required: false } })
    ).toThrow(/ssh_key\.required/u);
  });

  it('refuses a missing ssh_key entirely', () => {
    const { ssh_key: _sshKey, ...rest } = VALID;
    expect(() => readTemplateInputFile(rest)).toThrow(/ssh_key/u);
  });

  it('refuses a bad port', () => {
    expect(() =>
      readTemplateInputFile({ ...VALID, ports: [{ container_port: 0, protocol: 'tcp' }] })
    ).toThrow(/container_port/u);
    expect(() =>
      readTemplateInputFile({ ...VALID, ports: [{ container_port: 22, protocol: 'sctp' }] })
    ).toThrow(/protocol/u);
  });

  it('refuses a non-object top level', () => {
    expect(() => readTemplateInputFile(null)).toThrow(/object/u);
    expect(() => readTemplateInputFile([1, 2])).toThrow(/object/u);
  });
});

describe('planTemplatePublish', () => {
  const publisher = fakeProvider('template-publish-test');

  function samplePlan(overrides: Partial<Parameters<typeof planTemplatePublish>[0]> = {}) {
    const file = readTemplateInputFile({
      name: 'ssh-box',
      title: 'SSH box (Alpine)',
      summary: 'An SSH shell with your key and nothing else.',
      ports: [{ container_port: 22, protocol: 'tcp' }],
      env_fixed: {},
      env_tenant: [],
      ssh_key: { required: true },
    });
    return planTemplatePublish({
      pubkey: publisher.pubkey,
      file,
      entry: {
        digest: MANIFEST_DIGEST,
        media_type: 'application/vnd.oci.image.manifest.v1+json',
        blobs: [
          {
            digest: MANIFEST_DIGEST,
            size: 512,
            media_type: 'application/vnd.oci.image.manifest.v1+json',
            source: { type: 'oci', registry: 'ghcr.io', repository: 'toon-protocol/ssh-box' },
          },
          {
            digest: `sha256:${'c'.repeat(64)}`,
            size: 1234,
            media_type: 'application/vnd.oci.image.config.v1+json',
            source: { type: 'oci', registry: 'ghcr.io', repository: 'toon-protocol/ssh-box' },
          },
        ],
      },
      ref: { registry: 'ghcr.io', repository: 'toon-protocol/ssh-box', tag: 'latest' },
      image: `ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`,
      now: new Date('2026-09-24T00:00:00Z'),
      ...overrides,
    });
  }

  it('addresses both events under the given pubkey', () => {
    const plan = samplePlan();
    expect(plan.entryAddress).toBe(`30434:${publisher.pubkey}:ssh-box:latest`);
    expect(plan.templateAddress).toBe(`30436:${publisher.pubkey}:ssh-box`);
    expect(plan.entryEvent.kind).toBe(30434);
    expect(plan.templateEvent.kind).toBe(30436);
    expect(plan.imageDigest).toBe(MANIFEST_DIGEST);
  });

  it('names the entry, never an upstream reference, in the Template image', () => {
    const plan = samplePlan();
    const content = JSON.parse(plan.templateEvent.content) as {
      image: { digest: string; registry_entry?: { address: string; relay?: string } };
    };
    expect(content.image.digest).toBe(MANIFEST_DIGEST);
    expect(content.image.registry_entry?.address).toBe(plan.entryAddress);
    expect(content.image).not.toHaveProperty('reference');
  });

  it('carries a relay hint only when one was given', () => {
    const withRelay = samplePlan({ relay: 'wss://relay.example' });
    const content = JSON.parse(withRelay.templateEvent.content) as {
      image: { registry_entry?: { relay?: string } };
    };
    expect(content.image.registry_entry?.relay).toBe('wss://relay.example');

    const without = samplePlan();
    const contentWithout = JSON.parse(without.templateEvent.content) as {
      image: { registry_entry?: { relay?: string } };
    };
    expect(contentWithout.image.registry_entry?.relay).toBeUndefined();
  });

  it('carries the title, summary and ssh_key note alongside the normative fields', () => {
    const plan = samplePlan();
    const content = JSON.parse(plan.templateEvent.content) as {
      title: string;
      summary: string;
      ssh_key: { required: boolean };
    };
    expect(content.title).toBe('SSH box (Alpine)');
    expect(content.ssh_key).toEqual({ required: true });
  });

  it("round-trips through templates.ts's OWN readers as an available Template", () => {
    const plan = samplePlan();
    const entryEvent = sign(publisher, plan.entryEvent) as NostrEvent;
    const templateEvent = sign(publisher, plan.templateEvent) as NostrEvent;

    const content = readTemplateContent(templateEvent);
    if ('reason' in content) throw new Error(`not a Template: ${content.reason}`);
    expect(content.image.digest).toBe(MANIFEST_DIGEST);
    expect(content.ports).toEqual([{ containerPort: 22, protocol: 'tcp' }]);

    const entry = readImageEntry(entryEvent, plan.entryAddress);
    if ('reason' in entry) throw new Error(`entry rejected: ${entry.reason}`);
    expect(entry.digest).toBe(MANIFEST_DIGEST);
    expect(entry.signer).toBe(publisher.pubkey);

    const availability = resolveImage(content.image, {
      entries: [entryEvent],
      blobRecords: [],
      seenOn: new Set(['ws://relay.test']),
    });
    expect(availability.state).toBe('available');
  });
});

describe('publishTemplatePlan', () => {
  const publisher = fakeProvider('publish-plan-test');

  function fakePlan(): TemplatePublishPlan {
    const file = readTemplateInputFile({
      name: 'ssh-box',
      title: 'SSH box (Alpine)',
      summary: 'An SSH shell with your key and nothing else.',
      ports: [{ container_port: 22, protocol: 'tcp' }],
      env_fixed: {},
      env_tenant: [],
      ssh_key: { required: true },
    });
    return planTemplatePublish({
      pubkey: publisher.pubkey,
      file,
      entry: {
        digest: MANIFEST_DIGEST,
        media_type: 'application/vnd.oci.image.manifest.v1+json',
        blobs: [
          {
            digest: MANIFEST_DIGEST,
            size: 512,
            media_type: 'application/vnd.oci.image.manifest.v1+json',
            source: { type: 'oci', registry: 'ghcr.io', repository: 'toon-protocol/ssh-box' },
          },
        ],
      },
      ref: { registry: 'ghcr.io', repository: 'toon-protocol/ssh-box', tag: 'latest' },
      image: `ghcr.io/toon-protocol/ssh-box@${MANIFEST_DIGEST}`,
      now: new Date('2026-09-24T00:00:00Z'),
    });
  }

  function writerFor(options: { refuseSecond?: boolean } = {}): {
    writer: RelayWriter;
    written: NostrEvent[];
  } {
    const written: NostrEvent[] = [];
    const writer: RelayWriter = {
      targets: (): Promise<RelayWriteTargets> =>
        Promise.resolve({
          relays: ['ws://relay.test'],
          plan: [
            {
              url: 'ws://relay.test',
              ready: true,
              destination: 'g.toon.relay',
              price: '1',
            },
          ],
          destination: 'g.toon.relay',
          price: '1',
          totalPrice: '1',
          ready: true,
        }),
      write: (request: RelayWriteRequest): Promise<RelayWriteReceipt> => {
        const event = request.event as NostrEvent;
        if (options.refuseSecond && written.length === 1) {
          return Promise.reject(
            new RelayWriteError('write_refused', 'refused. Still billed 1.', 502)
          );
        }
        written.push(event);
        return Promise.resolve({
          at: new Date(0).toISOString(),
          what: request.what,
          relays: ['ws://relay.test'],
          destination: 'g.toon.relay',
          payAt: 'https://connector.test/ilp',
          chain: 'evm:84532',
          cost: '1',
          writes: [
            { url: 'ws://relay.test', destination: 'g.toon.relay', state: 'written', cost: '1' },
          ],
        });
      },
    };
    return { writer, written };
  }

  it('signs and writes the image entry before the Template, and sums the cost', async () => {
    const { writer, written } = writerFor();
    const plan = fakePlan();
    const report = await publishTemplatePlan(plan, {
      sign: (template) =>
        Promise.resolve(sign(publisher, template) as unknown as NostrEvent),
      writer,
    });

    expect(report.cost).toBe('2');
    expect(report.outcomes.map((outcome) => outcome.what)).toEqual(['image-entry', 'template']);
    expect(written.map((event) => event.kind)).toEqual([30434, 30436]);
    expect(report.outcomes[0]?.address).toBe(plan.entryAddress);
    expect(report.outcomes[1]?.address).toBe(plan.templateAddress);
    for (const outcome of report.outcomes) {
      expect(outcome.cost).toBe('1');
      expect(outcome.eventId).toHaveLength(64);
    }
  });

  it('propagates a refusal from the second write rather than hiding it', async () => {
    const { writer } = writerFor({ refuseSecond: true });
    const plan = fakePlan();
    await expect(
      publishTemplatePlan(plan, {
        sign: (template) =>
          Promise.resolve(sign(publisher, template) as unknown as NostrEvent),
        writer,
      })
    ).rejects.toThrow(/refused/u);
  });
});
