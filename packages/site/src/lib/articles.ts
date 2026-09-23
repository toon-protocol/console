import { SimplePool } from 'nostr-tools/pool';
import { verifyEvent } from 'nostr-tools/pure';
import { decode } from 'nostr-tools/nip19';
import type { Event as NostrEvent } from 'nostr-tools/core';

import { BUNDLED_DOCS, type Doc } from './docs';

/**
 * Reading the published articles, in the browser (TOON_Network#102).
 *
 * The site does the same thing the console does and for the same reasons: it
 * asks the relays for kind 30023 events by the documentation npub, keeps the
 * current one per `d` tag, and falls back to the Markdown it was built with.
 *
 * Two rules it must not bend.
 *
 * **Reading is free; writing is not.** A relay READ is not priced by the spec,
 * so a static page can open a socket and ask. A relay WRITE on TOON Network is
 * a paid TOON packet, and nothing in this bundle writes one — publishing is
 * `toon-docs-publish`, a command a human runs with a funded channel.
 *
 * **Every event is verified, and by the right key.** `verifyEvent` re-derives
 * the id and checks the signature, and anything not by `pubkey` is dropped. A
 * relay that could serve an article under the documentation key would be
 * choosing what this site says about how to look after money.
 */

export const ARTICLE_KIND = 30023;

export interface ArticlesResult {
  readonly docs: readonly Doc[];
  /**
   * Why the bundle is showing, when it is. A sentence, because it goes into
   * the banner above what a person is reading.
   */
  readonly fallback?: string;
  readonly pubkey?: string;
}

/** An npub or bare hex, as 32 hex bytes. @throws on anything else. */
export function toPubkey(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) return trimmed.toLowerCase();
  const decoded = decode(trimmed);
  if (decoded.type !== 'npub') {
    throw new Error(`That is a “${decoded.type}”, not an npub.`);
  }
  return decoded.data;
}

const tagValue = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find((tag) => tag[0] === name)?.[1];

/** NIP-01's replacement rule: later wins, and a tie goes to the lower id. */
export function supersedes(candidate: NostrEvent, held: NostrEvent): boolean {
  if (candidate.created_at !== held.created_at) return candidate.created_at > held.created_at;
  return candidate.id < held.id;
}

/** One event as a page, or `undefined` when it is not one. */
export function articleFromEvent(event: NostrEvent): Doc | undefined {
  if (event.kind !== ARTICLE_KIND) return undefined;
  const d = tagValue(event, 'd');
  if (d === undefined || d.length === 0) return undefined;
  const published = Number(tagValue(event, 'published_at'));
  return {
    d,
    title: tagValue(event, 'title') ?? d,
    summary: tagValue(event, 'summary') ?? '',
    order: Number(tagValue(event, 'order') ?? '999'),
    publishedAt: new Date(
      (Number.isFinite(published) && published > 0 ? published : event.created_at) * 1000
    )
      .toISOString()
      .slice(0, 10),
    tags: event.tags.flatMap((tag) => (tag[0] === 't' && tag[1] ? [tag[1]] : [])),
    markdown: event.content,
    source: 'relays',
    address: `${ARTICLE_KIND}:${event.pubkey}:${d}`,
    updatedAt: event.created_at,
  };
}

/**
 * Published pages laid over bundled ones, by `d`.
 *
 * The published copy wins, a page the relays do not carry keeps its bundled
 * copy, and a page published after this build went out is added. The reading
 * order stays the bundle's where there is one, because `order` is front matter
 * this site knows and a Nostr client would not show.
 */
export function mergeDocs(
  bundled: readonly Doc[],
  events: readonly NostrEvent[],
  pubkey: string
): { docs: readonly Doc[]; published: number } {
  const current = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.pubkey !== pubkey) continue;
    if (!verifyEvent(event)) continue;
    const d = tagValue(event, 'd');
    if (d === undefined || d.length === 0) continue;
    const held = current.get(d);
    if (held !== undefined && !supersedes(event, held)) continue;
    current.set(d, event);
  }

  const byD = new Map(bundled.map((doc) => [doc.d, doc]));
  let published = 0;
  for (const [d, event] of current) {
    const article = articleFromEvent(event);
    if (article === undefined) continue;
    const known = byD.get(d);
    byD.set(d, { ...article, order: known?.order ?? 900 + byD.size });
    published += 1;
  }

  return {
    docs: [...byD.values()].sort(
      (left, right) => left.order - right.order || left.d.localeCompare(right.d)
    ),
    published,
  };
}

export interface LoadOptions {
  readonly npub?: string;
  readonly relays?: readonly string[];
  readonly timeoutMs?: number;
  /** Injected so a test needs no socket. */
  readonly querySync?: (
    relays: string[],
    filter: { kinds: number[]; authors: string[] }
  ) => Promise<NostrEvent[]>;
}

const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Every page, published where there is one.
 *
 * It never rejects. A docs site that showed a stack trace because a relay was
 * down would be failing at the one job the bundle exists to do.
 */
export async function loadDocs(options: LoadOptions): Promise<ArticlesResult> {
  const relays = (options.relays ?? []).filter((url) => url.length > 0);
  const npub = options.npub?.trim();

  if (!npub) {
    return {
      docs: BUNDLED_DOCS,
      fallback:
        'These pages are the ones this site was built with. No documentation npub is ' +
        'configured yet, so nothing was read from a relay.',
    };
  }

  let pubkey: string;
  try {
    pubkey = toPubkey(npub);
  } catch (error) {
    return {
      docs: BUNDLED_DOCS,
      fallback: `The configured documentation npub is not usable, so these are the pages this
        site was built with: ${error instanceof Error ? error.message : String(error)}`
        .replace(/\s+/gu, ' ')
        .trim(),
    };
  }

  if (relays.length === 0) {
    return {
      docs: BUNDLED_DOCS,
      pubkey,
      fallback: 'No relay is configured, so these are the pages this site was built with.',
    };
  }

  let events: NostrEvent[];
  try {
    events = await (options.querySync ?? querySync)([...relays], {
      kinds: [ARTICLE_KIND],
      authors: [pubkey],
    });
  } catch (error) {
    return {
      docs: BUNDLED_DOCS,
      pubkey,
      fallback: `The relays could not be reached, so these are the pages this site was built
        with: ${error instanceof Error ? error.message : String(error)}`
        .replace(/\s+/gu, ' ')
        .trim(),
    };
  }

  const merged = mergeDocs(BUNDLED_DOCS, events, pubkey);
  return {
    docs: merged.docs,
    pubkey,
    ...(merged.published > 0
      ? {}
      : {
          fallback:
            'The relays hold no published articles for that npub yet, so these are the pages ' +
            'this site was built with.',
        }),
  };
}

/** The default reader: one pool, one question, closed at EOSE. */
async function querySync(
  relays: string[],
  filter: { kinds: number[]; authors: string[] }
): Promise<NostrEvent[]> {
  const pool = new SimplePool();
  try {
    return await pool.querySync(relays, filter, { maxWait: DEFAULT_TIMEOUT_MS });
  } finally {
    pool.close(relays);
  }
}
