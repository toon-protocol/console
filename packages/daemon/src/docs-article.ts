import { decode, npubEncode } from 'nostr-tools/nip19';
import type { EventTemplate } from 'nostr-tools/core';

import type { BundledDoc } from './docs-content.js';
import { supersedes, tagValue, tagValues, type NostrEvent } from './nostr.js';

/**
 * A documentation page as a NIP-23 long-form article (TOON_Network#102).
 *
 * Kind 30023 is **addressable**: a relay keeps one event per
 * `(kind, pubkey, d)` and drops the older one. So the `d` tag is not metadata
 * about the article, it IS the article — the thing a re-publication replaces.
 * That single fact is the acceptance criterion "re-publishing an edited doc
 * replaces it rather than duplicating it", and it is bought by putting the
 * page's file-name slug in `d` and never generating one.
 *
 * Everything else here follows from wanting these pages to read the same in a
 * third-party Nostr client as they do on the site. NIP-23 names `title`,
 * `summary`, `published_at` and `t` tags, and clients render them; a page that
 * carried its title only inside its Markdown would show up in a feed as an
 * untitled wall of text.
 *
 * `published_at` is the page's own front-matter date and stays put across
 * edits, while `created_at` moves — that is NIP-23's own distinction between
 * when a piece was first published and when this version of it was signed, and
 * it is also what makes the replacement rule work: a relay keeps the event
 * with the later `created_at`.
 */

/** NIP-23 long-form content. */
export const ARTICLE_KIND = 30023;

/**
 * What a page looks like once it is an article, from either direction.
 *
 * The same shape whether it came off a relay or out of the repository, because
 * the console and the site render one thing and the fallback must not be a
 * second-class citizen with fewer fields.
 */
export interface DocArticle {
  readonly d: string;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt: string;
  readonly tags: readonly string[];
  readonly markdown: string;
  /** Where this copy came from. */
  readonly source: 'relays' | 'bundled';
  /** Present on a relay copy: the event this is, and when it was signed. */
  readonly eventId?: string;
  readonly updatedAt?: number;
  readonly pubkey?: string;
  /** `30023:<pubkey>:<d>` — what a Nostr client needs to find it again. */
  readonly address?: string;
}

/** NIP-01's coordinate for an addressable event: what replaces what. */
export function articleAddress(pubkey: string, d: string): string {
  return `${ARTICLE_KIND}:${pubkey}:${d}`;
}

/**
 * The unsigned article for one page.
 *
 * `created_at` is passed in rather than read from the clock so that a
 * publication is reproducible: the same page at the same moment produces the
 * same event, and a test can prove that two runs differ in nothing but the
 * timestamp.
 *
 * The `alt` tag is NIP-31: it is what a client that does not know kind 30023
 * shows instead of nothing.
 */
export function articleTemplate(doc: BundledDoc, createdAt: number): EventTemplate {
  return {
    kind: ARTICLE_KIND,
    created_at: createdAt,
    content: doc.markdown,
    tags: [
      // First, and never generated: this is the article's identity.
      ['d', doc.d],
      ['title', doc.title],
      ['summary', doc.summary],
      ['published_at', String(publishedAtSeconds(doc.publishedAt))],
      ...doc.tags.map((topic) => ['t', topic]),
      ['alt', `TOON Network documentation: ${doc.title}`],
    ],
  };
}

/** A front-matter `YYYY-MM-DD` as NIP-23 wants it: unix seconds, as a string. */
export function publishedAtSeconds(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/** The repository's copy, in the shape a renderer takes. */
export function bundledArticle(doc: BundledDoc): DocArticle {
  return {
    d: doc.d,
    title: doc.title,
    summary: doc.summary,
    publishedAt: doc.publishedAt,
    tags: doc.tags,
    markdown: doc.markdown,
    source: 'bundled',
  };
}

/**
 * A relay's event, read as an article — or `undefined` when it is not one.
 *
 * Deliberately strict about the `d` tag and nothing else. A missing title is
 * survivable (fall back to the `d`); a missing or empty `d` is not, because
 * there is then no identity to key the article by and no way to tell it apart
 * from another page by the same author.
 *
 * The caller has already checked the signature — `queryRelays` verifies every
 * event it keeps — and has already decided WHOSE articles it wanted. Neither
 * check is repeated here, and neither may be skipped there.
 */
export function articleFromEvent(event: NostrEvent): DocArticle | undefined {
  if (event.kind !== ARTICLE_KIND) return undefined;
  const d = tagValue(event, 'd');
  if (d === undefined || d.length === 0) return undefined;
  const published = Number(tagValue(event, 'published_at'));
  return {
    d,
    title: tagValue(event, 'title') ?? d,
    summary: tagValue(event, 'summary') ?? '',
    publishedAt:
      Number.isFinite(published) && published > 0
        ? new Date(published * 1000).toISOString().slice(0, 10)
        : new Date(event.created_at * 1000).toISOString().slice(0, 10),
    tags: tagValues(event, 't'),
    markdown: event.content,
    source: 'relays',
    eventId: event.id,
    updatedAt: event.created_at,
    pubkey: event.pubkey,
    address: articleAddress(event.pubkey, d),
  };
}

/**
 * The current article for each `d`, out of everything the relays sent.
 *
 * Several relays hold the same page, and a relay that has not yet caught up
 * holds last week's. NIP-01's rule decides: later `created_at` wins, and a tie
 * goes to the lower id. `supersedes` is the console's one implementation of
 * that rule and this uses it rather than a second copy — the Provider
 * Directory picks the current Listing exactly the same way.
 *
 * Events by anyone other than `pubkey` are dropped. A relay is not trusted to
 * say whose article this is, and an article rendered in the console from
 * somebody else's key would be somebody else choosing what the docs say.
 */
export function currentArticles(
  events: readonly NostrEvent[],
  pubkey: string
): Map<string, { article: DocArticle; event: NostrEvent }> {
  const held = new Map<string, { article: DocArticle; event: NostrEvent }>();
  for (const event of events) {
    if (event.pubkey !== pubkey) continue;
    const article = articleFromEvent(event);
    if (article === undefined) continue;
    const previous = held.get(article.d);
    if (previous !== undefined && !supersedes(event, previous.event)) continue;
    held.set(article.d, { article, event });
  }
  return held;
}

export class NpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NpubError';
  }
}

/**
 * The docs author, as 32 hex bytes, from either spelling.
 *
 * An npub is what a person copies out of a client, and hex is what a relay
 * filter takes. Accepting both is the whole of it; accepting an `nsec` by
 * mistake is what the kind check is for, because pasting a private key into a
 * "which author" setting is a mistake somebody will make exactly once.
 */
export function docsAuthorPubkey(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) return trimmed.toLowerCase();
  if (!trimmed.startsWith('npub1')) {
    throw new NpubError(`“${trimmed.slice(0, 12)}…” is not an npub or a 32-byte hex pubkey.`);
  }
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(trimmed);
  } catch (error) {
    throw new NpubError(
      `That npub does not decode: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (decoded.type !== 'npub') {
    throw new NpubError(
      `That is a “${decoded.type}”, not an npub. The docs author is a PUBLIC key.`
    );
  }
  return decoded.data;
}

/** The same key, spelled the way a person reads it. */
export function docsAuthorNpub(pubkey: string): string {
  return npubEncode(pubkey);
}
