import type { EventTemplate } from 'nostr-tools/core';

import {
  articleAddress,
  articleFromEvent,
  articleTemplate,
  currentArticles,
  docsAuthorNpub,
  type DocArticle,
} from './docs-article.js';
import type { BundledDoc } from './docs-content.js';
import type { NostrEvent } from './nostr.js';
import type { RelayWriteReceipt, RelayWriter } from './relay-write.js';

/**
 * Publishing the docs as NIP-23 articles (TOON_Network#102).
 *
 * The rule this is written to is the network's, and it is the same one #120
 * settled for the console's own records: **every write to a relay is a paid
 * TOON packet**, bought through `@toon-protocol/client` against an open
 * payment channel. There is no plain-websocket branch here, no `--free` flag,
 * and no second code path to forget. The writer is `PaidRelayWriter` — the
 * console's one writer — and the provider's `tools/publisher` has been doing
 * the identical thing for its Profile and its Listings since Milestone 1.
 *
 * Two consequences shape everything below.
 *
 * **A publication costs money, so it plans first.** Every page is compared
 * against the article currently on the relays, and an unchanged page is NOT
 * re-sent. Seven pages at 1 µUSDC each is nothing; a script that re-publishes
 * all seven on every commit, forever, is a habit, and habits are what get
 * expensive. `--force` is there for the day a relay lost one.
 *
 * **A refused paid request is still billed** (ADR 0003, TOON_Network#115), so
 * nothing unverifiable leaves: the writer re-hashes and re-checks the
 * signature of every event before it pays to send it.
 *
 * And the acceptance criterion that gives this file its shape: re-publishing
 * an edited page must REPLACE it, not duplicate it. Kind 30023 is addressable,
 * so a relay keeps one event per `(kind, pubkey, d)`. This never generates a
 * `d`: it is the page's file-name slug, stable across every edit, and
 * `verifyPublication` is what proves the relay agreed.
 */

/** What would happen to one page, and why. */
export interface DocPlanEntry {
  readonly d: string;
  readonly title: string;
  /** `30023:<pubkey>:<d>` — the address this publication replaces. */
  readonly address: string;
  readonly state: 'new' | 'changed' | 'unchanged';
  /** One sentence a person reads before agreeing to spend. */
  readonly reason: string;
}

export interface DocsPlan {
  readonly pubkey: string;
  readonly entries: readonly DocPlanEntry[];
  /** The pages that would be written. */
  readonly writes: readonly DocPlanEntry[];
}

/** What one page's publication did. */
export interface DocPublishOutcome {
  readonly d: string;
  readonly state: 'written' | 'skipped' | 'failed';
  readonly address: string;
  readonly eventId?: string | undefined;
  /** Base units of the settlement token, verbatim from the claim. */
  readonly cost?: string | undefined;
  readonly reason?: string | undefined;
}

export interface DocsPublishReport {
  readonly pubkey: string;
  readonly npub: string;
  readonly at: string;
  readonly outcomes: readonly DocPublishOutcome[];
  /** Base units, summed from the claims. Never recomputed from a price. */
  readonly cost: string;
  readonly written: number;
  readonly skipped: number;
  readonly failed: number;
  readonly receipts: readonly RelayWriteReceipt[];
}

export interface DocsPublishDeps {
  /** The docs npub, as 32 hex bytes. Whose articles these are. */
  readonly pubkey: string;
  /** Signs as that key. A `ConsoleSigner`, a bunker, a bare key. */
  readonly sign: (template: EventTemplate) => Promise<NostrEvent>;
  /** The paid writer. In the CLI this is a `PaidRelayWriter`. */
  readonly writer: RelayWriter;
  /** Everything the relays hold for this author, for planning and verifying. */
  readonly readArticles: () => Promise<readonly NostrEvent[]>;
  readonly now?: (() => Date) | undefined;
}

export interface DocsPublishOptions {
  /** Only these `d` slugs. Empty or absent means every page. */
  readonly only?: readonly string[] | undefined;
  /** Re-publish a page whose article already matches the repository. */
  readonly force?: boolean | undefined;
}

/**
 * What a publication WOULD do, spending nothing.
 *
 * Kept apart from doing it so the CLI's `--dry-run` is the same decision and
 * not a second one, and so that "would this write anything?" is answerable in
 * a test with no relay, no connector and no channel.
 */
export function planPublication(
  docs: readonly BundledDoc[],
  current: ReadonlyMap<string, DocArticle>,
  pubkey: string,
  options: DocsPublishOptions = {}
): DocsPlan {
  const only = new Set(options.only ?? []);
  const entries = docs
    .filter((doc) => only.size === 0 || only.has(doc.d))
    .map((doc): DocPlanEntry => {
      const address = articleAddress(pubkey, doc.d);
      const held = current.get(doc.d);
      if (held === undefined) {
        return {
          d: doc.d,
          title: doc.title,
          address,
          state: 'new',
          reason: 'No article at that address yet.',
        };
      }
      const difference = firstDifference(doc, held);
      if (difference === undefined) {
        return {
          d: doc.d,
          title: doc.title,
          address,
          state: 'unchanged',
          reason: options.force
            ? 'Unchanged, but --force was given.'
            : 'The published article already matches this repository.',
        };
      }
      return { d: doc.d, title: doc.title, address, state: 'changed', reason: difference };
    });

  return {
    pubkey,
    entries,
    writes: entries.filter((entry) => entry.state !== 'unchanged' || options.force === true),
  };
}

/**
 * The first thing that differs, as a sentence — or `undefined` when nothing
 * does.
 *
 * A boolean would have been enough to decide whether to spend, but not enough
 * to answer "why is it about to spend": the commonest cause of a surprise
 * re-publication is a trailing whitespace change, and naming the field is how
 * that gets noticed in one look instead of three.
 */
export function firstDifference(doc: BundledDoc, held: DocArticle): string | undefined {
  if (held.title !== doc.title) return `Title: “${held.title}” → “${doc.title}”.`;
  if (held.summary !== doc.summary) return 'The summary changed.';
  if (held.tags.join(',') !== doc.tags.join(',')) return 'The topic tags changed.';
  if (held.markdown !== doc.markdown) return 'The body changed.';
  return undefined;
}

/**
 * Publish. **This spends money**: one paid relay write per page written.
 *
 * Serialized, one page at a time, and not by accident: a channel claim carries
 * a strictly increasing nonce, so two packets in flight on one channel race
 * each other. The provider's publisher serializes for the same reason.
 *
 * A page that fails does not stop the rest. Seven independent articles have
 * seven independent fates, and a run that gave up on the first refusal would
 * leave a half-published set with no report of which half.
 */
export async function publishDocs(
  docs: readonly BundledDoc[],
  deps: DocsPublishDeps,
  options: DocsPublishOptions = {}
): Promise<DocsPublishReport> {
  const events = await deps.readArticles();
  const pubkey = deps.pubkey;

  const held = new Map(
    [...currentArticles(events, pubkey)].map(([d, entry]) => [d, entry.article])
  );
  const plan = planPublication(docs, held, pubkey, options);
  const planned = new Set(plan.writes.map((entry) => entry.d));
  const at = (deps.now ?? (() => new Date()))();

  const outcomes: DocPublishOutcome[] = [];
  const receipts: RelayWriteReceipt[] = [];
  let cost = 0n;

  for (const entry of plan.entries) {
    if (!planned.has(entry.d)) {
      outcomes.push({
        d: entry.d,
        state: 'skipped',
        address: entry.address,
        reason: entry.reason,
      });
      continue;
    }
    const doc = docs.find((candidate) => candidate.d === entry.d);
    if (doc === undefined) continue;

    // Seconds, and strictly after the article it replaces: NIP-01 keeps the
    // event with the later `created_at`, so a clock that came back a second
    // slow would publish a "new" article the relay correctly ignores.
    const previous = held.get(entry.d)?.updatedAt ?? 0;
    const createdAt = Math.max(Math.floor(at.getTime() / 1000), previous + 1);

    let event: NostrEvent;
    try {
      event = await deps.sign(articleTemplate(doc, createdAt));
    } catch (error) {
      outcomes.push({
        d: entry.d,
        state: 'failed',
        address: entry.address,
        reason: `Signing failed, so nothing was sent or billed: ${messageOf(error)}`,
      });
      continue;
    }

    try {
      const receipt = await deps.writer.write({
        event,
        what: `the “${doc.title}” documentation article (${entry.address})`,
      });
      receipts.push(receipt);
      if (receipt.cost !== undefined) cost += safeBigInt(receipt.cost);
      outcomes.push({
        d: entry.d,
        state: 'written',
        address: entry.address,
        eventId: event.id,
        ...(receipt.cost === undefined ? {} : { cost: receipt.cost }),
        reason: entry.reason,
      });
    } catch (error) {
      // The writer's own message already says whether it was billed. Repeating
      // that decision here would be a second, staler copy of ADR 0003.
      outcomes.push({
        d: entry.d,
        state: 'failed',
        address: entry.address,
        eventId: event.id,
        reason: messageOf(error),
      });
    }
  }

  return {
    pubkey,
    npub: docsAuthorNpub(pubkey),
    at: at.toISOString(),
    outcomes,
    cost: cost.toString(),
    written: outcomes.filter((outcome) => outcome.state === 'written').length,
    skipped: outcomes.filter((outcome) => outcome.state === 'skipped').length,
    failed: outcomes.filter((outcome) => outcome.state === 'failed').length,
    receipts,
  };
}

/** What a re-read of the relays says about one page. */
export interface DocVerification {
  readonly d: string;
  readonly address: string;
  /** Every event the relays hold at that address, current and stale. */
  readonly events: number;
  /** Whether the CURRENT one is this repository's copy. */
  readonly matches: boolean;
  readonly eventId?: string | undefined;
  readonly problem?: string | undefined;
}

/**
 * Read the articles back and say whether a re-publication REPLACED.
 *
 * This is the acceptance criterion, made checkable. `events` is the count at
 * one address across every relay asked: one address holding two current
 * articles would mean the `d` tag was not doing its job, and that is precisely
 * the duplication the criterion forbids. `matches` says the current one is
 * this repository's text, so "it replaced" cannot be satisfied by replacing it
 * with something else.
 *
 * A relay that has not yet dropped the superseded copy is not a failure and
 * must not be reported as one — NIP-01 lets it serve both for a while — which
 * is why `events` is reported beside `matches` rather than asserted on.
 */
export function verifyPublication(
  docs: readonly BundledDoc[],
  events: readonly NostrEvent[],
  pubkey: string
): readonly DocVerification[] {
  const current = currentArticles(events, pubkey);
  const atAddress = new Map<string, number>();
  for (const event of events) {
    if (event.pubkey !== pubkey) continue;
    const article = articleFromEvent(event);
    if (article === undefined) continue;
    const address = articleAddress(pubkey, article.d);
    atAddress.set(address, (atAddress.get(address) ?? 0) + 1);
  }

  return docs.map((doc): DocVerification => {
    const address = articleAddress(pubkey, doc.d);
    const held = current.get(doc.d);
    if (held === undefined) {
      return {
        d: doc.d,
        address,
        events: 0,
        matches: false,
        problem: 'No article at that address on any relay asked.',
      };
    }
    const difference = firstDifference(doc, held.article);
    return {
      d: doc.d,
      address,
      events: atAddress.get(address) ?? 0,
      matches: difference === undefined,
      eventId: held.event.id,
      ...(difference === undefined
        ? {}
        : { problem: `The published article is not this repository's copy. ${difference}` }),
    };
  });
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
