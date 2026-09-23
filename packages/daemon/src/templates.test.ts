import { describe, expect, it } from 'vitest';

import { fakeRelays, type RecordedRequest } from './directory.testkit.js';
import type { NostrEvent } from './nostr.js';
import { DEVNET, MAINNET, type NetworkProfile } from './profiles.js';
import { queryRelays } from './relay-pool.js';
import {
  K_IMAGE,
  parseCoordinate,
  readBlobRecord,
  readTemplateContent,
  readTemplates,
  type TemplateGalleryView,
} from './templates.js';
import {
  blobRecordEvent,
  fakePublisher,
  FIXTURE_DIGEST,
  imageEntryEvent,
  metadataEvent,
  specEvent,
  templateEvent,
} from './templates.testkit.js';

/**
 * The Template gallery (TOON_Network#94, spec §8.3).
 *
 * The cases below are the four things the ticket asks for, in the order it
 * asks for them: that a Template is listed with its publisher and its image's
 * content address, that only what a Template marks tenant-settable can be
 * edited (`template-spawn.test.ts` has that half), that an unresolvable image
 * is shown as unavailable rather than spawned, and that expansion produces a
 * manual spawn's content exactly.
 *
 * The spec's own golden Template is here too. It is signed by the provider's
 * publisher test key, so it passes through `verifyEvent` like anything else off
 * a relay — which is the point of using it rather than one this file signed.
 */

const RELAY = 'wss://relay.test';
const OTHER_RELAY = 'wss://hint.test';

const profile: NetworkProfile = { ...DEVNET, relayUrl: RELAY };

const publisher = fakePublisher('template-publisher');
const stranger = fakePublisher('somebody-else');

function gallery(
  events: readonly NostrEvent[],
  options: { relays?: { url: string; events: NostrEvent[] }[]; profile?: NetworkProfile } = {}
): Promise<TemplateGalleryView> {
  const recorded: RecordedRequest[] = [];
  const { dial } = fakeRelays(
    options.relays ?? [{ url: RELAY, events: [...events] }],
    recorded
  );
  return readTemplates({
    profile: options.profile ?? profile,
    timeoutMs: 200,
    query: (query) => queryRelays({ ...query, dial }),
  }).then((result) => {
    expect(result.state).toBe('ok');
    return result as TemplateGalleryView;
  });
}

describe('readTemplates', () => {
  it('lists a Template with its publisher and its image by content address', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'static-site', envTenant: ['SITE_TITLE'] }),
      imageEntryEvent(publisher),
      metadataEvent(publisher, { name: 'toonlabs', display_name: 'TOON Labs' }),
    ]);

    expect(view.templates).toHaveLength(1);
    const template = view.templates[0]!;
    expect(template.name).toBe('static-site');
    expect(template.address).toBe(`30436:${publisher.pubkey}:static-site`);
    expect(template.publisher.pubkey).toBe(publisher.pubkey);
    expect(template.publisher.npub.startsWith('npub1')).toBe(true);
    expect(template.publisher.name).toBe('toonlabs');
    expect(template.image.digest).toBe(FIXTURE_DIGEST);
    expect(template.availability.state).toBe('available');
    if (template.availability.state !== 'available') throw new Error('unreachable');
    expect(template.availability.entry?.canonicalName).toBe(
      `${template.publisher.npub}/web:1.0`
    );
    expect(template.availability.entry?.digest).toBe(FIXTURE_DIGEST);
  });

  it('grants no capability, because a Template has none to grant', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'static-site' }),
      imageEntryEvent(publisher),
    ]);
    // ADR 0004: capabilities come from a Listing. Not "empty" — absent.
    expect(JSON.stringify(view.templates[0])).not.toMatch(/capabilit/iu);
  });

  it('separates what a publisher fixed from what a tenant may set', async () => {
    const view = await gallery([
      templateEvent(publisher, {
        name: 'static-site',
        envFixed: { MODE: 'production' },
        envTenant: ['SITE_TITLE'],
      }),
      imageEntryEvent(publisher),
    ]);
    expect(view.templates[0]?.envFixed).toEqual({ MODE: 'production' });
    expect(view.templates[0]?.envTenant).toEqual(['SITE_TITLE']);
  });

  it('warns, rather than refuses, when a name is both fixed and settable', async () => {
    const view = await gallery([
      templateEvent(publisher, {
        name: 'static-site',
        envFixed: { MODE: 'production' },
        envTenant: ['MODE'],
      }),
      imageEntryEvent(publisher),
    ]);
    expect(view.templates[0]?.warnings.join(' ')).toMatch(/MODE.*fixed/su);
  });

  it('goes to the relay a Template names for its entry, and only to a websocket one', async () => {
    const recorded: RecordedRequest[] = [];
    const { dial } = fakeRelays(
      [
        {
          url: RELAY,
          events: [
            templateEvent(publisher, { name: 'on-hint', entryRelay: OTHER_RELAY }),
            templateEvent(publisher, {
              name: 'bad-hint',
              entryRelay: 'http://elsewhere.test',
            }),
          ],
        },
        { url: OTHER_RELAY, events: [imageEntryEvent(publisher)] },
      ],
      recorded
    );
    const result = (await readTemplates({
      profile,
      timeoutMs: 200,
      query: (query) => queryRelays({ ...query, dial }),
    })) as TemplateGalleryView;

    expect(recorded.map((request) => request.url)).toContain(OTHER_RELAY);
    expect(recorded.map((request) => request.url)).not.toContain('http://elsewhere.test');
    // `bad-hint` is not a Template at all: §8.3's `relay` is a websocket URL.
    expect(result.rejected.map((entry) => entry.name)).toEqual(['bad-hint']);
    expect(result.templates[0]?.availability.state).toBe('available');
  });

  it('shows a Template whose entry is on no relay as unavailable, with the reason', async () => {
    const view = await gallery([templateEvent(publisher, { name: 'static-site' })]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('unavailable');
    if (availability.state !== 'unavailable') throw new Error('unreachable');
    expect(availability.reason).toMatch(/Image Registry entry .* on none of the relays read/u);
  });

  it('refuses an entry that is about another image', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'static-site' }),
      imageEntryEvent(publisher, { digest: `sha256:${'9'.repeat(64)}` }),
    ]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('unavailable');
    if (availability.state !== 'unavailable') throw new Error('unreachable');
    expect(availability.reason).toMatch(/a different image/u);
  });

  it('refuses a blob whose source type it does not know, rather than skipping it', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'static-site' }),
      imageEntryEvent(publisher, {
        blobs: [
          {
            digest: FIXTURE_DIGEST,
            size: 549,
            source: { type: 'lading', locator: 'somewhere' },
          },
        ],
      }),
    ]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('unavailable');
    if (availability.state !== 'unavailable') throw new Error('unreachable');
    expect(availability.reason).toMatch(/source this console does not know/u);
  });

  it('will not take an entry a relay served under somebody else’s key', async () => {
    // The entry's address names `publisher`; this one is the stranger's, with
    // the same `d`. A relay that answers with it is answering with an image
    // nobody asked for, and the coordinate is what decides.
    const view = await gallery([
      templateEvent(publisher, { name: 'static-site' }),
      imageEntryEvent(stranger),
    ]);
    expect(view.templates[0]?.availability.state).toBe('unavailable');
  });

  it('resolves a digest-alone Template through a Blob Record, by `#x`', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'by-digest', entryAddress: null }),
      // Signed by somebody else entirely: ADR 0006 trusts the digest, not the
      // signer — a wrong record fails verification at fetch time.
      blobRecordEvent(stranger),
    ]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('available');
    if (availability.state !== 'available') throw new Error('unreachable');
    expect(availability.blobRecord?.shape).toBe('inline');
    expect(availability.blobRecord?.parts).toBe(3);
    expect(availability.checked).toMatch(/ITS OWN Relay Set/u);
  });

  it('shows a digest-alone Template with no Blob Record as unavailable', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'by-digest', entryAddress: null }),
    ]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('unavailable');
    if (availability.state !== 'unavailable') throw new Error('unreachable');
    expect(availability.reason).toMatch(/no Blob Record/u);
  });

  it('will not resolve a Blob Record that carries both `parts` and `pages`', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'by-digest', entryAddress: null }),
      blobRecordEvent(publisher, { shape: 'both' }),
    ]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('unavailable');
    if (availability.state !== 'unavailable') throw new Error('unreachable');
    expect(availability.reason).toMatch(/both `parts` and `pages`/u);
  });

  it('takes a paged Blob Record for what it is', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'by-digest', entryAddress: null }),
      blobRecordEvent(publisher, { shape: 'paged' }),
    ]);
    const availability = view.templates[0]!.availability;
    expect(availability.state).toBe('available');
    if (availability.state !== 'available') throw new Error('unreachable');
    expect(availability.blobRecord?.shape).toBe('paged');
  });

  it('keeps the current version of a Template and sets the older one aside', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'static-site', createdAt: 1_790_000_000 }),
      templateEvent(publisher, {
        name: 'static-site',
        createdAt: 1_790_000_900,
        envTenant: ['SITE_TITLE'],
      }),
      imageEntryEvent(publisher),
    ]);
    expect(view.templates).toHaveLength(1);
    expect(view.templates[0]?.envTenant).toEqual(['SITE_TITLE']);
  });

  it('shows spawnable Templates before ones that cannot be spawned', async () => {
    const view = await gallery([
      templateEvent(publisher, { name: 'a-broken' }),
      templateEvent(publisher, { name: 'z-working', entryAddress: null }),
      blobRecordEvent(publisher),
    ]);
    expect(view.templates.map((template) => template.name)).toEqual(['z-working', 'a-broken']);
  });

  it('says a profile with no relay has nothing to read', async () => {
    const result = await readTemplates({ profile: MAINNET });
    expect(result.state).toBe('unconfigured');
  });
});

describe('readTemplateContent', () => {
  const read = (draft: Parameters<typeof templateEvent>[1]) =>
    readTemplateContent(templateEvent(publisher, draft));

  it('refuses a Template that names an upstream image', () => {
    const content = read({
      name: 'upstream',
      rawContent: JSON.stringify({
        version: 1,
        image: { reference: 'docker.io/library/alpine', digest: FIXTURE_DIGEST },
        ports: [],
        env_fixed: {},
        env_tenant: [],
      }),
    });
    // §8.3: a Template names an image by content address, never as a pull.
    expect(content).toEqual({ reason: expect.stringMatching(/content address/u) });
  });

  it('refuses a digest that is not 64 lowercase hex characters', () => {
    expect(read({ name: 'shouty', digest: `sha256:${'C0A6'.repeat(16)}` })).toEqual({
      reason: expect.stringMatching(/lowercase hex/u),
    });
  });

  it('refuses an env name that is not one', () => {
    expect(read({ name: 'sneaky', envTenant: ['PATH=/evil'] })).toEqual({
      reason: expect.stringMatching(/not a variable name/u),
    });
  });

  it('refuses a port outside 1–65535', () => {
    expect(read({ name: 'wide', ports: [{ containerPort: 70_000 }] })).toEqual({
      reason: expect.stringMatching(/container_port/u),
    });
  });
});

describe('parseCoordinate', () => {
  it('keeps an entry’s own colon, splitting into at most three parts', () => {
    const address = `${K_IMAGE}:${publisher.pubkey}:web:1.0`;
    expect(parseCoordinate(address, K_IMAGE)).toEqual({
      pubkey: publisher.pubkey,
      d: 'web:1.0',
    });
  });

  it('refuses a coordinate of another kind', () => {
    expect(parseCoordinate(`30432:${publisher.pubkey}:basic`, K_IMAGE)).toBeUndefined();
  });
});

describe('readBlobRecord', () => {
  it('refuses a record whose parts do not add up to its size', () => {
    const event = blobRecordEvent(publisher, {
      rawContent: JSON.stringify({
        digest: FIXTURE_DIGEST,
        size: 235_008,
        part_size: 102_400,
        parts: [
          { txid: 'one', sha256: '1'.repeat(64), size: 102_400 },
          { txid: 'two', sha256: '2'.repeat(64), size: 102_400 },
          { txid: 'three', sha256: '3'.repeat(64), size: 1 },
        ],
      }),
    });
    expect(readBlobRecord(event)).toEqual({ reason: expect.stringMatching(/sum to/u) });
  });

  it('refuses a record with neither `parts` nor `pages`', () => {
    const event = blobRecordEvent(publisher, { shape: 'neither' });
    expect(readBlobRecord(event)).toEqual({ reason: expect.stringMatching(/neither/u) });
  });

  it('refuses pages that name more parts than the blob could hold', () => {
    const event = blobRecordEvent(publisher, {
      rawContent: JSON.stringify({
        digest: FIXTURE_DIGEST,
        size: 235_008,
        part_size: 102_400,
        pages: [
          { txid: 'page-0', sha256: 'a'.repeat(64), parts: 700 },
          { txid: 'page-1', sha256: 'b'.repeat(64), parts: 700 },
        ],
      }),
    });
    // §8.4: the page count is checked against what `size` and `part_size`
    // imply BEFORE a single page is fetched, so a record cannot force an
    // unbounded number of reads by listing pages that cannot exist.
    expect(readBlobRecord(event)).toEqual({ reason: expect.stringMatching(/1400 parts/u) });
  });
});

describe('the spec’s own golden fixtures', () => {
  it('reads the Template the provider’s wire tests generate', async () => {
    const template = specEvent('registry.template');
    const entry = specEvent('registry.image_entry');
    const view = await gallery([template, entry]);

    expect(view.rejectedEvents).toBe(0); // it verified: id re-derived, sig checked
    expect(view.templates).toHaveLength(1);
    const read = view.templates[0]!;
    expect(read.name).toBe('static-site');
    expect(read.version).toBe(1);
    expect(read.ports).toEqual([{ containerPort: 8080, protocol: 'tcp' }]);
    expect(read.dataPath).toBe('/data');
    expect(read.envFixed).toEqual({ MODE: 'production' });
    expect(read.envTenant).toEqual(['SITE_TITLE']);
    expect(read.minResources).toEqual({ cpuMillicores: 500, memoryMb: 256, storageGb: 4 });
    expect(read.image.registryEntry?.address).toBe(
      '30434:2c0b7cf95324a07d05398b240174dc0c2be444d96b159aa6c7f7b1e668680991:web:1.0'
    );
    expect(read.availability.state).toBe('available');
    if (read.availability.state !== 'available') throw new Error('unreachable');
    expect(read.availability.entry?.blobs).toHaveLength(4);
    expect(read.availability.entry?.blobs.map((blob) => blob.source.type)).toEqual([
      'toon-store',
      'toon-store',
      'oci',
      'toon-store',
    ]);
  });

  it('reads the golden Blob Record, inline and paged, as the same blob', () => {
    const inline = readBlobRecord(specEvent('registry.blob_record'));
    const paged = readBlobRecord(specEvent('registry.blob_record.paged'));
    expect('reason' in inline).toBe(false);
    expect('reason' in paged).toBe(false);
    if ('reason' in inline || 'reason' in paged) throw new Error('unreachable');
    expect(inline.parts).toBe(3);
    expect(paged.parts).toBe(3);
    expect(inline.digest).toBe(paged.digest);
    expect(inline.shape).toBe('inline');
    expect(paged.shape).toBe('paged');
  });
});
