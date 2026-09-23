import {
  ARTICLE_KIND,
  articleAddress,
  bundledArticle,
  currentArticles,
  docsAuthorNpub,
  docsAuthorPubkey,
  NpubError,
  type DocArticle,
} from './docs-article.js';
import { loadDocs, DocsError, type BundledDoc } from './docs-content.js';
import type { NostrFilter } from './nostr.js';
import { queryRelays, type RelayOutcome, type RelayReadResult } from './relay-pool.js';

/**
 * The docs, as the console window reads them (TOON_Network#102).
 *
 * Two copies of every page exist and this decides which one a person sees:
 * the **article** on the relays, which is the published one and can be newer
 * than the app, and the **bundled** Markdown in this repository, which is what
 * the app shipped with. Relays win when they answer. The bundle wins when they
 * do not, and the answer says which it was rather than quietly degrading —
 * "this is the version that shipped with your console" is a thing a person
 * reading about money ought to be told.
 *
 * Reading is FREE and this is the one place in the console where that is worth
 * saying twice. A relay write is a paid TOON packet (ADR 0007, #120); a relay
 * READ is not priced by the spec at all. So the docs load with no account, no
 * Chain Seed and no channel — which matters, because the page that explains
 * how to get those three is one of the pages being loaded.
 *
 * **Whose articles** is configuration, not a constant. `TOON_CONSOLE_DOCS_NPUB`
 * names TOON Network's docs key; with none set, this serves the bundle and
 * says so. There is no default npub baked into this repository, for the same
 * reason there is no chain id in `profiles.ts`: a key that appears in source is
 * a key nobody can rotate.
 */

/** One page in the index: everything but the body. */
export interface DocSummary {
  readonly d: string;
  readonly title: string;
  readonly summary: string;
  readonly order: number;
  readonly publishedAt: string;
  readonly tags: readonly string[];
  readonly source: 'relays' | 'bundled';
  readonly address?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface DocsAuthorView {
  readonly npub: string;
  readonly pubkey: string;
}

export interface DocsIndex {
  /** Absent when no docs npub is configured: then nothing is read at all. */
  readonly author?: DocsAuthorView | undefined;
  readonly relays: readonly string[];
  /** What each relay did, when one was asked. Empty when none was. */
  readonly read: readonly RelayOutcome[];
  /**
   * Why the bundle is being shown, when it is. A sentence, not a code: it goes
   * straight into the banner above the page a person is reading.
   */
  readonly fallback?: string | undefined;
  readonly docs: readonly DocSummary[];
  readonly readAt: string;
}

export interface DocsPage extends DocsIndex {
  readonly doc: DocArticle;
}

export class DocsNotFound extends Error {
  readonly code = 'unknown_doc';
  constructor(d: string) {
    super(`There is no documentation page called “${d}”.`);
    this.name = 'DocsNotFound';
  }
}

export interface DocsDeps {
  /** The relays to ask. The active profile's, in practice. */
  readonly relays: () => readonly string[];
  /** `TOON_CONSOLE_DOCS_NPUB`, or nothing. */
  readonly npub: () => string | undefined;
  /** Injected so a test needs no `docs/` on disk. */
  readonly bundled?: (() => readonly BundledDoc[]) | undefined;
  readonly query?: typeof queryRelays;
  readonly now?: (() => Date) | undefined;
  /** How long a relay read is reused. A doc does not change while it is read. */
  readonly ttlMs?: number | undefined;
}

const DEFAULT_TTL_MS = 60_000;

interface CachedRead {
  readonly at: number;
  readonly key: string;
  readonly index: DocsIndex;
  readonly bodies: ReadonlyMap<string, DocArticle>;
}

export class DocsStore {
  readonly #deps: DocsDeps;
  #bundled: readonly BundledDoc[] | undefined;
  #bundleError: string | undefined;
  #cached: CachedRead | undefined;

  constructor(deps: DocsDeps) {
    this.#deps = deps;
  }

  /** The reading order and what each page is about. No bodies. */
  async index(options: { refresh?: boolean } = {}): Promise<DocsIndex> {
    return (await this.#read(options.refresh === true)).index;
  }

  /** One page, body and all. @throws {DocsNotFound} */
  async page(d: string, options: { refresh?: boolean } = {}): Promise<DocsPage> {
    const read = await this.#read(options.refresh === true);
    const doc = read.bodies.get(d);
    if (doc === undefined) throw new DocsNotFound(d);
    return { ...read.index, doc };
  }

  /**
   * The bundle, read once and held.
   *
   * A failure to read it is REMEMBERED rather than thrown, because a console
   * whose docs directory is missing should still show whatever the relays
   * have. Only when both are empty does it become the thing a person is told.
   */
  #bundle(): readonly BundledDoc[] {
    if (this.#bundled !== undefined) return this.#bundled;
    try {
      this.#bundled = (this.#deps.bundled ?? loadDocs)();
      this.#bundleError = undefined;
    } catch (error) {
      this.#bundled = [];
      this.#bundleError =
        error instanceof DocsError || error instanceof Error ? error.message : String(error);
    }
    return this.#bundled;
  }

  async #read(refresh: boolean): Promise<CachedRead> {
    const relays = [...new Set(this.#deps.relays())].filter((url) => url.length > 0);
    const configured = this.#deps.npub()?.trim();
    const key = JSON.stringify([configured ?? '', relays]);
    const ttl = this.#deps.ttlMs ?? DEFAULT_TTL_MS;
    const now = (this.#deps.now ?? (() => new Date()))();

    const held = this.#cached;
    if (!refresh && held !== undefined && held.key === key && now.getTime() - held.at < ttl) {
      return held;
    }

    const read = await this.#assemble(relays, configured, now);
    this.#cached = { at: now.getTime(), key, ...read };
    return this.#cached;
  }

  async #assemble(
    relays: readonly string[],
    configured: string | undefined,
    now: Date
  ): Promise<Omit<CachedRead, 'at' | 'key'>> {
    const bundle = this.#bundle();
    const bodies = new Map<string, DocArticle>(
      bundle.map((doc) => [doc.d, bundledArticle(doc)])
    );
    const orderOf = new Map(bundle.map((doc, at) => [doc.d, doc.order || at + 1]));
    const base = {
      relays,
      readAt: now.toISOString(),
    };

    const fall = (why: string): Omit<CachedRead, 'at' | 'key'> => ({
      index: {
        ...base,
        read: [],
        ...(bodies.size === 0 && this.#bundleError !== undefined
          ? {
              fallback: `${why} And the bundled pages could not be read: ${this.#bundleError}`,
            }
          : { fallback: why }),
        docs: summaries(bodies, orderOf),
      },
      bodies,
    });

    if (configured === undefined || configured.length === 0) {
      return fall(
        'These are the pages that shipped with this console. No documentation npub is ' +
          'configured, so nothing was read from a relay. Set TOON_CONSOLE_DOCS_NPUB to read ' +
          'the published articles.'
      );
    }

    let pubkey: string;
    try {
      pubkey = docsAuthorPubkey(configured);
    } catch (error) {
      return fall(
        `TOON_CONSOLE_DOCS_NPUB is not usable, so the bundled pages are being shown: ${
          error instanceof NpubError || error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const author: DocsAuthorView = { npub: docsAuthorNpub(pubkey), pubkey };
    if (relays.length === 0) {
      return {
        index: {
          ...base,
          author,
          read: [],
          fallback:
            'This network profile names no relay, so the published articles could not be ' +
            'read. These are the pages that shipped with this console.',
          docs: summaries(bodies, orderOf),
        },
        bodies,
      };
    }

    const filters: NostrFilter[] = [{ kinds: [ARTICLE_KIND], authors: [pubkey] }];
    let result: RelayReadResult;
    try {
      result = await (this.#deps.query ?? queryRelays)({ relays, filters });
    } catch (error) {
      return {
        index: {
          ...base,
          author,
          read: [],
          fallback:
            'The relays could not be reached, so these are the pages that shipped with this ' +
            `console: ${error instanceof Error ? error.message : String(error)}`,
          docs: summaries(bodies, orderOf),
        },
        bodies,
      };
    }

    // Published pages replace bundled ones by `d`, and add ones this build has
    // never heard of — a page written after this console was packaged is still
    // a page it can show.
    let published = 0;
    for (const [d, { article }] of currentArticles(result.events, pubkey)) {
      bodies.set(d, article);
      if (!orderOf.has(d)) orderOf.set(d, 1000 + orderOf.size);
      published += 1;
    }

    const answered = result.relays.filter((relay) => relay.state === 'read');
    const fallback =
      published > 0
        ? undefined
        : answered.length === 0
          ? `No relay answered (${result.relays
              .map((relay) => `${relay.url}: ${relay.reason ?? relay.state}`)
              .join('; ')}). These are the pages that shipped with this console.`
          : 'The relays answered and hold no articles for that npub yet. These are the pages ' +
            'that shipped with this console.';

    return {
      index: {
        ...base,
        author,
        read: result.relays,
        ...(fallback === undefined ? {} : { fallback }),
        docs: summaries(bodies, orderOf),
      },
      bodies,
    };
  }
}

function summaries(
  bodies: ReadonlyMap<string, DocArticle>,
  orderOf: ReadonlyMap<string, number>
): DocSummary[] {
  return [...bodies.values()]
    .map((doc) => ({
      d: doc.d,
      title: doc.title,
      summary: doc.summary,
      order: orderOf.get(doc.d) ?? 9999,
      publishedAt: doc.publishedAt,
      tags: doc.tags,
      source: doc.source,
      ...(doc.pubkey === undefined ? {} : { address: articleAddress(doc.pubkey, doc.d) }),
      ...(doc.updatedAt === undefined
        ? {}
        : { updatedAt: new Date(doc.updatedAt * 1000).toISOString() }),
    }))
    .sort((left, right) => left.order - right.order || left.d.localeCompare(right.d));
}
