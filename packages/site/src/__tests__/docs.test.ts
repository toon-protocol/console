import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event as NostrEvent } from 'nostr-tools/core';
import { describe, expect, it } from 'vitest';

import { articleFromEvent, loadDocs, mergeDocs, supersedes, toPubkey } from '@/lib/articles';
import { BUNDLED_DOCS, docBySlug, parseList, splitFrontMatter } from '@/lib/docs';
import { headingsOf, isSafeHref, renderMarkdown, slugify } from '@/lib/markdown';

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

const article = (d: string, body: string, at: number, title = d): NostrEvent =>
  finalizeEvent(
    {
      kind: 30023,
      created_at: at,
      content: body,
      tags: [
        ['d', d],
        ['title', title],
        ['summary', `about ${d}`],
        ['published_at', '1758585600'],
        ['t', 'toon-network'],
      ],
    },
    secretKey
  );

describe('the bundled pages', () => {
  it('are the ones in docs/ at the repository root', () => {
    // The same assertion the daemon makes about the same files. Two builds,
    // one source; if somebody adds a page and forgets one of them, one of
    // these two tests goes red.
    expect(BUNDLED_DOCS.map((doc) => doc.d)).toEqual([
      'concepts',
      'first-workload',
      'funding',
      'gateways',
      'failover',
      'hidden-providers',
      'spec',
    ]);
  });

  it('carry their front matter and none of it in the body', () => {
    const concepts = docBySlug(BUNDLED_DOCS, 'concepts');
    expect(concepts?.title).toBe('Concepts');
    expect(concepts?.summary.length).toBeGreaterThan(20);
    expect(concepts?.markdown.startsWith('# Concepts')).toBe(true);
  });

  it('parse front matter the way the daemon does', () => {
    const { fields, body } = splitFrontMatter('---\nd: x\ntags: [a, b]\n---\n\nbody\n');
    expect(fields['d']).toBe('x');
    expect(parseList(fields['tags'])).toEqual(['a', 'b']);
    expect(body).toBe('body');
  });
});

describe('merging published articles over bundled ones', () => {
  it('prefers the published copy', () => {
    const { docs, published } = mergeDocs(
      BUNDLED_DOCS,
      [article('concepts', 'published text', 1_800_000_000, 'Concepts')],
      pubkey
    );
    expect(published).toBe(1);
    expect(docBySlug(docs, 'concepts')?.markdown).toBe('published text');
    expect(docBySlug(docs, 'concepts')?.source).toBe('relays');
    expect(docBySlug(docs, 'funding')?.source).toBe('bundled');
  });

  it('keeps ONE page when a relay is still serving the superseded copy', () => {
    const old = article('concepts', 'old', 1_800_000_000);
    const fresh = article('concepts', 'new', 1_800_000_100);
    // Two events at one address. A reader must see one page, and the newer.
    const { docs } = mergeDocs(BUNDLED_DOCS, [old, fresh], pubkey);
    expect(docs.filter((doc) => doc.d === 'concepts')).toHaveLength(1);
    expect(docBySlug(docs, 'concepts')?.markdown).toBe('new');
  });

  it('is unaffected by the order the relays answered in', () => {
    const old = article('concepts', 'old', 1_800_000_000);
    const fresh = article('concepts', 'new', 1_800_000_100);
    expect(
      docBySlug(mergeDocs(BUNDLED_DOCS, [fresh, old], pubkey).docs, 'concepts')?.markdown
    ).toBe('new');
  });

  it('drops an event signed by anyone else', () => {
    const impostor = generateSecretKey();
    const forged = finalizeEvent(
      { kind: 30023, created_at: 2_000_000_000, content: 'pay me', tags: [['d', 'concepts']] },
      impostor
    );
    const { published, docs } = mergeDocs(BUNDLED_DOCS, [forged], pubkey);
    expect(published).toBe(0);
    expect(docBySlug(docs, 'concepts')?.source).toBe('bundled');
  });

  it('drops an event whose signature does not check out', () => {
    // Through JSON, the way a relay would hand it over: `finalizeEvent` marks
    // its answer with a symbol that means "already verified", and an object
    // spread would carry that mark onto the forgery.
    const real = article('concepts', 'real', 1_800_000_000);
    const tampered = JSON.parse(
      JSON.stringify({ ...real, content: 'tampered' })
    ) as typeof real;
    expect(mergeDocs(BUNDLED_DOCS, [tampered], pubkey).published).toBe(0);
  });

  it('adds a page published after this build went out', () => {
    const { docs } = mergeDocs(BUNDLED_DOCS, [article('templates', 'new page', 1)], pubkey);
    expect(docBySlug(docs, 'templates')?.title).toBe('templates');
    expect(docs).toHaveLength(BUNDLED_DOCS.length + 1);
  });

  it('breaks a created_at tie by the lower id, as NIP-01 says', () => {
    const left = article('a', 'x', 5);
    const right = article('b', 'y', 5);
    const [lower, higher] = left.id < right.id ? [left, right] : [right, left];
    expect(supersedes(lower!, higher!)).toBe(true);
    expect(supersedes(higher!, lower!)).toBe(false);
  });

  it('is not an article without a `d`', () => {
    const event = finalizeEvent(
      { kind: 30023, created_at: 1, content: 'x', tags: [] },
      secretKey
    );
    expect(articleFromEvent(event)).toBeUndefined();
  });
});

describe('loading, when there is nothing to load from', () => {
  it('shows the bundle and says why, with no npub', async () => {
    const result = await loadDocs({ npub: '', relays: ['wss://relay.test'] });
    expect(result.docs).toEqual(BUNDLED_DOCS);
    expect(result.fallback).toMatch(/No documentation npub/u);
  });

  it('shows the bundle and says why, with no relay', async () => {
    const result = await loadDocs({ npub: pubkey, relays: [] });
    expect(result.fallback).toMatch(/No relay/u);
  });

  it('shows the bundle when every relay fails, never an error page', async () => {
    const result = await loadDocs({
      npub: pubkey,
      relays: ['wss://relay.test'],
      querySync: () => Promise.reject(new Error('socket refused')),
    });
    expect(result.docs).toHaveLength(BUNDLED_DOCS.length);
    expect(result.fallback).toMatch(/socket refused/u);
  });

  it('says the relays answered and hold nothing, which is a different problem', async () => {
    const result = await loadDocs({
      npub: pubkey,
      relays: ['wss://relay.test'],
      querySync: () => Promise.resolve([]),
    });
    expect(result.fallback).toMatch(/hold no published articles/u);
  });

  it('shows the published page with no banner when the relays answer', async () => {
    const result = await loadDocs({
      npub: pubkey,
      relays: ['wss://relay.test'],
      querySync: () => Promise.resolve([article('concepts', 'live', 1_800_000_000)]),
    });
    expect(result.fallback).toBeUndefined();
    expect(docBySlug(result.docs, 'concepts')?.markdown).toBe('live');
  });

  it('refuses an nsec where an npub belongs', () => {
    expect(() => toPubkey('not-a-key')).toThrow();
  });
});

describe('rendering', () => {
  it('renders headings, links, code and tables', () => {
    const html = renderMarkdown('# Title\n\n[a](https://x.test)\n\n`code`');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('href="https://x.test"');
    expect(html).toContain('<code>code</code>');
  });

  it('drops raw HTML in the source rather than escaping and showing it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nafter');
    expect(html).not.toContain('script');
    expect(html).toContain('after');
  });

  it('renders an unsafe link scheme as plain text', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('https://x.test')).toBe(true);
    expect(isSafeHref('/docs/funding')).toBe(true);
    expect(isSafeHref('funding')).toBe(true);
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('href');
    expect(html).toContain('click');
  });

  it('opens external links in a new tab and keeps in-site ones in place', () => {
    expect(renderMarkdown('[a](https://x.test)')).toContain('rel="noopener noreferrer"');
    expect(renderMarkdown('[a](funding)')).not.toContain('target=');
  });

  it('lists the second-level headings for the contents box', () => {
    expect(headingsOf('# Title\n\n## The two parties\n\ntext\n\n## What you buy')).toEqual([
      { id: 'the-two-parties', text: 'The two parties' },
      { id: 'what-you-buy', text: 'What you buy' },
    ]);
    expect(slugify('What a takeover does NOT carry')).toBe('what-a-takeover-does-not-carry');
  });
});
