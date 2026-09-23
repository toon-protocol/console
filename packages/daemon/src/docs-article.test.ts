import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';

import {
  ARTICLE_KIND,
  articleAddress,
  articleFromEvent,
  articleTemplate,
  bundledArticle,
  currentArticles,
  docsAuthorNpub,
  docsAuthorPubkey,
  NpubError,
  publishedAtSeconds,
} from './docs-article.js';
import type { BundledDoc } from './docs-content.js';
import type { NostrEvent } from './nostr.js';

const DOC: BundledDoc = {
  d: 'concepts',
  title: 'Concepts',
  summary: 'The words.',
  order: 1,
  publishedAt: '2026-09-23',
  tags: ['toon-network', 'concepts'],
  markdown: '# Concepts\n\nProvider, Tenant, Lease.',
};

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);
const sign = (doc: BundledDoc, at: number): NostrEvent =>
  finalizeEvent(articleTemplate(doc, at), secretKey) as unknown as NostrEvent;

describe('the article', () => {
  it('is a NIP-23 long-form event whose `d` is the page slug', () => {
    const event = sign(DOC, 1_700_000_000);
    expect(event.kind).toBe(ARTICLE_KIND);
    expect(event.kind).toBe(30023);
    expect(event.tags[0]).toEqual(['d', 'concepts']);
    expect(event.content).toBe(DOC.markdown);
  });

  it('carries title, summary and topics, so a feed shows more than a wall of text', () => {
    const tags = Object.fromEntries(sign(DOC, 1).tags.map((tag) => [tag[0], tag[1]]));
    expect(tags['title']).toBe('Concepts');
    expect(tags['summary']).toBe('The words.');
    expect(tags['alt']).toContain('Concepts');
    expect(
      sign(DOC, 1)
        .tags.filter((tag) => tag[0] === 't')
        .map((tag) => tag[1])
    ).toEqual(['toon-network', 'concepts']);
  });

  it('keeps `published_at` on the front-matter date while `created_at` moves', () => {
    const first = sign(DOC, 1_700_000_000);
    const second = sign({ ...DOC, markdown: 'edited' }, 1_800_000_000);
    const publishedOf = (event: NostrEvent) =>
      event.tags.find((tag) => tag[0] === 'published_at')?.[1];
    expect(publishedOf(first)).toBe(publishedOf(second));
    expect(publishedOf(first)).toBe(String(publishedAtSeconds('2026-09-23')));
    expect(second.created_at).toBeGreaterThan(first.created_at);
  });

  it('gives the same `d`, and therefore the same address, across an edit', () => {
    const before = sign(DOC, 1);
    const after = sign({ ...DOC, title: 'Concepts, revised', markdown: 'new' }, 2);
    expect(articleAddress(after.pubkey, 'concepts')).toBe(
      articleAddress(before.pubkey, 'concepts')
    );
    expect(articleAddress(pubkey, 'concepts')).toBe(`30023:${pubkey}:concepts`);
  });
});

describe('reading one back', () => {
  it('round-trips a page through a signed event', () => {
    const article = articleFromEvent(sign(DOC, 1_700_000_000));
    expect(article).toMatchObject({
      d: 'concepts',
      title: 'Concepts',
      summary: 'The words.',
      markdown: DOC.markdown,
      tags: ['toon-network', 'concepts'],
      source: 'relays',
      publishedAt: '2026-09-23',
    });
  });

  it('is not an article without a `d`: there would be no identity to key it by', () => {
    const event = finalizeEvent(
      { kind: ARTICLE_KIND, created_at: 1, content: 'body', tags: [['title', 'X']] },
      secretKey
    ) as unknown as NostrEvent;
    expect(articleFromEvent(event)).toBeUndefined();
  });

  it('is not an article at another kind', () => {
    const event = finalizeEvent(
      { kind: 1, created_at: 1, content: 'a note', tags: [['d', 'concepts']] },
      secretKey
    ) as unknown as NostrEvent;
    expect(articleFromEvent(event)).toBeUndefined();
  });

  it('says where the bundled copy came from, with the same shape', () => {
    expect(bundledArticle(DOC)).toMatchObject({ d: 'concepts', source: 'bundled' });
  });
});

describe('which one is current', () => {
  it('keeps the later version when two relays disagree', () => {
    const old = sign(DOC, 1_700_000_000);
    const fresh = sign({ ...DOC, markdown: 'the new text' }, 1_700_000_100);
    const held = currentArticles([old, fresh, old], pubkey);
    expect(held.size).toBe(1);
    expect(held.get('concepts')?.article.markdown).toBe('the new text');
  });

  it('is unaffected by the order the relays answered in', () => {
    const old = sign(DOC, 1_700_000_000);
    const fresh = sign({ ...DOC, markdown: 'the new text' }, 1_700_000_100);
    expect(currentArticles([fresh, old], pubkey).get('concepts')?.event.id).toBe(fresh.id);
    expect(currentArticles([old, fresh], pubkey).get('concepts')?.event.id).toBe(fresh.id);
  });

  it('drops events by anyone but the docs key', () => {
    const impostor = generateSecretKey();
    const forged = finalizeEvent(
      articleTemplate({ ...DOC, markdown: 'pay me instead' }, 2_000_000_000),
      impostor
    ) as unknown as NostrEvent;
    // A relay is not trusted to say whose article this is. If it were, whoever
    // can write to a relay the console reads would be writing the docs.
    expect(currentArticles([forged], pubkey).size).toBe(0);
    expect(currentArticles([sign(DOC, 1), forged], pubkey).get('concepts')?.event.pubkey).toBe(
      pubkey
    );
  });
});

describe('naming the docs key', () => {
  it('takes an npub or bare hex, and answers in hex', () => {
    expect(docsAuthorPubkey(npubEncode(pubkey))).toBe(pubkey);
    expect(docsAuthorPubkey(pubkey.toUpperCase())).toBe(pubkey);
    expect(docsAuthorNpub(pubkey)).toBe(npubEncode(pubkey));
  });

  it('refuses an nsec, which somebody will paste here exactly once', () => {
    expect(() => docsAuthorPubkey(nsecEncode(secretKey))).toThrow(NpubError);
    expect(() => docsAuthorPubkey('not-a-key')).toThrow(NpubError);
  });
});
