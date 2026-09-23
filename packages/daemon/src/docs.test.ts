import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';

import { articleTemplate } from './docs-article.js';
import type { BundledDoc } from './docs-content.js';
import { DocsNotFound, DocsStore } from './docs.js';
import type { NostrEvent } from './nostr.js';
import type { RelayReadResult } from './relay-pool.js';

const BUNDLED: BundledDoc[] = [
  {
    d: 'concepts',
    title: 'Concepts',
    summary: 'The words.',
    order: 1,
    publishedAt: '2026-09-23',
    tags: ['toon-network'],
    markdown: '# Concepts\n\nAs this console shipped.',
  },
  {
    d: 'funding',
    title: 'Funding',
    summary: 'The money.',
    order: 2,
    publishedAt: '2026-09-23',
    tags: ['toon-network'],
    markdown: '# Funding\n\nAs this console shipped.',
  },
];

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);
const npub = npubEncode(pubkey);

const article = (doc: Partial<BundledDoc> & { d: string }, at = 1_800_000_000): NostrEvent =>
  finalizeEvent(
    articleTemplate(
      {
        title: doc.d,
        summary: '',
        order: 1,
        publishedAt: '2026-09-23',
        tags: [],
        markdown: '',
        ...doc,
      },
      at
    ),
    secretKey
  ) as unknown as NostrEvent;

const answered = (events: NostrEvent[]): RelayReadResult => ({
  events,
  relays: [{ url: 'ws://relay.test', state: 'read', events: events.length }],
  rejected: 0,
});

function storeWith(options: {
  npub?: string | undefined;
  relays?: string[];
  query?: () => Promise<RelayReadResult>;
}): DocsStore {
  return new DocsStore({
    relays: () => options.relays ?? ['ws://relay.test'],
    npub: () => options.npub,
    bundled: () => BUNDLED,
    ...(options.query === undefined ? {} : { query: options.query }),
    ttlMs: 0,
  });
}

describe('with no docs npub configured', () => {
  it('serves the bundle and says why, without asking any relay', async () => {
    let asked = false;
    const store = storeWith({
      query: () => {
        asked = true;
        return Promise.resolve(answered([]));
      },
    });
    const index = await store.index();
    expect(asked).toBe(false);
    expect(index.author).toBeUndefined();
    expect(index.docs.map((doc) => doc.source)).toEqual(['bundled', 'bundled']);
    expect(index.fallback).toMatch(/TOON_CONSOLE_DOCS_NPUB/u);
  });
});

describe('with a docs npub', () => {
  it('prefers the published article over the bundled page', async () => {
    const store = storeWith({
      npub,
      query: () =>
        Promise.resolve(
          answered([article({ d: 'concepts', title: 'Concepts', markdown: 'published' })])
        ),
    });
    const page = await store.page('concepts');
    expect(page.doc.source).toBe('relays');
    expect(page.doc.markdown).toBe('published');
    expect(page.fallback).toBeUndefined();
    expect(page.author).toEqual({ npub, pubkey });
  });

  it('shows a page published after this console was packaged', async () => {
    const store = storeWith({
      npub,
      query: () =>
        Promise.resolve(answered([article({ d: 'templates', title: 'Templates' })])),
    });
    const index = await store.index();
    expect(index.docs.map((doc) => doc.d)).toEqual(['concepts', 'funding', 'templates']);
  });

  it('keeps the bundled page for anything the relays do not carry', async () => {
    const store = storeWith({
      npub,
      query: () => Promise.resolve(answered([article({ d: 'concepts' })])),
    });
    const index = await store.index();
    expect(index.docs.find((doc) => doc.d === 'funding')?.source).toBe('bundled');
  });

  it('gives each published page its address, so a Nostr client can find it', async () => {
    const store = storeWith({
      npub,
      query: () => Promise.resolve(answered([article({ d: 'concepts' })])),
    });
    const index = await store.index();
    expect(index.docs.find((doc) => doc.d === 'concepts')?.address).toBe(
      `30023:${pubkey}:concepts`
    );
  });
});

describe('when the relays are not there', () => {
  it('falls back to the bundle and says so, rather than showing an error page', async () => {
    const store = storeWith({
      npub,
      query: () => Promise.reject(new Error('getaddrinfo ENOTFOUND relay.test')),
    });
    const index = await store.index();
    // Offline is the case these docs most need to work in: half of them are
    // about getting online in the first place.
    expect(index.docs).toHaveLength(2);
    expect(index.docs.every((doc) => doc.source === 'bundled')).toBe(true);
    expect(index.fallback).toMatch(/ENOTFOUND/u);
  });

  it('says a relay answered and held nothing, which is a different problem', async () => {
    const store = storeWith({ npub, query: () => Promise.resolve(answered([])) });
    expect((await store.index()).fallback).toMatch(/hold no articles/u);
  });

  it('says no relay answered, and names what each one did', async () => {
    const store = storeWith({
      npub,
      query: () =>
        Promise.resolve({
          events: [],
          relays: [{ url: 'ws://relay.test', state: 'failed', events: 0, reason: 'refused' }],
          rejected: 0,
        }),
    });
    expect((await store.index()).fallback).toMatch(/refused/u);
  });

  it('falls back when the profile names no relay at all', async () => {
    const store = storeWith({ npub, relays: [] });
    expect((await store.index()).fallback).toMatch(/names no relay/u);
  });

  it('falls back when the configured npub is not one', async () => {
    const store = storeWith({ npub: 'nsec1definitelynot' });
    const index = await store.index();
    expect(index.author).toBeUndefined();
    expect(index.fallback).toMatch(/not usable/u);
  });
});

describe('asking for one page', () => {
  it('refuses a page that is in neither the bundle nor the relays', async () => {
    const store = storeWith({ npub, query: () => Promise.resolve(answered([])) });
    await expect(store.page('nothing-like-this')).rejects.toBeInstanceOf(DocsNotFound);
  });
});

describe('the read is cached', () => {
  it('asks the relays once for a burst of page views', async () => {
    let asks = 0;
    const store = new DocsStore({
      relays: () => ['ws://relay.test'],
      npub: () => npub,
      bundled: () => BUNDLED,
      query: () => {
        asks += 1;
        return Promise.resolve(answered([article({ d: 'concepts' })]));
      },
      ttlMs: 60_000,
      now: () => new Date('2026-09-23T00:00:00Z'),
    });
    await store.index();
    await store.page('concepts');
    await store.page('funding');
    expect(asks).toBe(1);
    await store.index({ refresh: true });
    expect(asks).toBe(2);
  });
});
