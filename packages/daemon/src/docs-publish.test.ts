import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { articleAddress, currentArticles } from './docs-article.js';
import type { BundledDoc } from './docs-content.js';
import {
  firstDifference,
  planPublication,
  publishDocs,
  verifyPublication,
} from './docs-publish.js';
import { verifyEvent, type NostrEvent } from './nostr.js';
import {
  RelayWriteError,
  type RelayWriteReceipt,
  type RelayWriteRequest,
  type RelayWriteTargets,
  type RelayWriter,
} from './relay-write.js';

/**
 * The ticket's hardest acceptance criterion, made a test: **re-publishing an
 * edited page must replace it, not duplicate it**.
 *
 * Two relays are faked, because the criterion is true in two different ways
 * and a test against only one of them would pass while the console was wrong.
 *
 * - `ReplacingRelay` does what NIP-01 tells a relay to do with an addressable
 *   event: keep one per `(kind, pubkey, d)`, drop the older. It proves the
 *   relay ends up holding ONE article per page.
 * - `HoardingRelay` keeps every event it is ever sent — which a real relay is
 *   allowed to do for a while, and which a lagging one does. It proves the
 *   CONSOLE still shows exactly one article per page, so a reader never sees
 *   two versions of a page whatever the relay does.
 *
 * Neither of them is a network, and that is the point of `RelayWriter` being a
 * port: everything here is the publication's decisions, with no connector, no
 * payment channel and nothing to spend.
 */

const DOCS: BundledDoc[] = [
  {
    d: 'concepts',
    title: 'Concepts',
    summary: 'The words.',
    order: 1,
    publishedAt: '2026-09-23',
    tags: ['toon-network'],
    markdown: '# Concepts\n\nProvider, Tenant, Lease.',
  },
  {
    d: 'funding',
    title: 'Funding',
    summary: 'The money.',
    order: 2,
    publishedAt: '2026-09-23',
    tags: ['toon-network'],
    markdown: '# Funding\n\nNo faucet gives you native gas.',
  },
];

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

/** A relay that applies NIP-01's replacement rule, as a relay is meant to. */
class ReplacingRelay {
  readonly held = new Map<string, NostrEvent>();
  /** Every write it was ever asked for, refusals included. */
  writes = 0;

  accept(event: NostrEvent): void {
    this.writes += 1;
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
    const key = `${event.kind}:${event.pubkey}:${d}`;
    const previous = this.held.get(key);
    if (previous !== undefined && previous.created_at > event.created_at) return;
    this.held.set(key, event);
  }

  events(): NostrEvent[] {
    return [...this.held.values()];
  }
}

/** A relay that has not dropped the superseded copies yet. */
class HoardingRelay {
  readonly all: NostrEvent[] = [];
  accept(event: NostrEvent): void {
    this.all.push(event);
  }
  events(): NostrEvent[] {
    return [...this.all];
  }
}

interface FakeRelay {
  accept(event: NostrEvent): void;
  events(): NostrEvent[];
}

/** The paid writer, with the paying taken out and the receipt left in. */
function writerFor(relay: FakeRelay, options: { refuse?: Set<string> } = {}): RelayWriter {
  return {
    targets: (): Promise<RelayWriteTargets> =>
      Promise.resolve({
        relays: ['ws://relay.test'],
        plan: [
          {
            url: 'ws://relay.test',
            ready: true,
            destination: 'g.toon.relay',
            price: '1',
            via: 'document',
          },
        ],
        destination: 'g.toon.relay',
        price: '1',
        totalPrice: '1',
        ready: true,
      }),
    write: (request: RelayWriteRequest): Promise<RelayWriteReceipt> => {
      const event = request.event as NostrEvent;
      // The real writer re-hashes and re-checks before it pays, because a
      // refused paid request is still billed (ADR 0003). If this fake accepted
      // an event the real one would refuse, the test would be proving nothing.
      if (!verifyEvent(event)) {
        return Promise.reject(new RelayWriteError('invalid_event', 'not a signed event', 400));
      }
      const d = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
      if (options.refuse?.has(d)) {
        return Promise.reject(
          new RelayWriteError('write_refused', `${d} refused. It was still billed 1.`, 502)
        );
      }
      relay.accept(event);
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
}

function depsFor(relay: FakeRelay, writer = writerFor(relay), at = new Date('2026-09-23')) {
  return {
    pubkey,
    sign: (template: EventTemplate) =>
      Promise.resolve(finalizeEvent(template, secretKey) as unknown as NostrEvent),
    writer,
    readArticles: () => Promise.resolve(relay.events()),
    now: () => at,
  };
}

describe('planning, before anything is spent', () => {
  it('calls every page new when the relays hold nothing', () => {
    const plan = planPublication(DOCS, new Map(), pubkey);
    expect(plan.entries.map((entry) => entry.state)).toEqual(['new', 'new']);
    expect(plan.writes).toHaveLength(2);
  });

  it('names the address each publication would replace', () => {
    expect(planPublication(DOCS, new Map(), pubkey).entries[0]?.address).toBe(
      articleAddress(pubkey, 'concepts')
    );
  });

  it('says which field changed, so a whitespace edit is visible in one look', () => {
    const held = { ...DOCS[0]!, source: 'relays' as const };
    expect(firstDifference(DOCS[0]!, held)).toBeUndefined();
    expect(firstDifference({ ...DOCS[0]!, title: 'Other' }, held)).toMatch(/Title/u);
    expect(firstDifference({ ...DOCS[0]!, markdown: 'x' }, held)).toBe('The body changed.');
  });

  it('only writes the page that changed', () => {
    const held = new Map(DOCS.map((doc) => [doc.d, { ...doc, source: 'relays' as const }]));
    const edited = [DOCS[0]!, { ...DOCS[1]!, markdown: 'new text' }];
    const plan = planPublication(edited, held, pubkey);
    expect(plan.writes.map((entry) => entry.d)).toEqual(['funding']);
  });

  it('writes an unchanged page only when forced', () => {
    const held = new Map(DOCS.map((doc) => [doc.d, { ...doc, source: 'relays' as const }]));
    expect(planPublication(DOCS, held, pubkey).writes).toHaveLength(0);
    expect(planPublication(DOCS, held, pubkey, { force: true }).writes).toHaveLength(2);
  });

  it('honours --only', () => {
    const plan = planPublication(DOCS, new Map(), pubkey, { only: ['funding'] });
    expect(plan.entries.map((entry) => entry.d)).toEqual(['funding']);
  });
});

describe('publishing to a relay that replaces', () => {
  let relay: ReplacingRelay;
  beforeEach(() => {
    relay = new ReplacingRelay();
  });

  it('writes every page the first time and says what each cost', async () => {
    const report = await publishDocs(DOCS, depsFor(relay));
    expect(report.written).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.cost).toBe('2');
    expect(relay.held.size).toBe(2);
  });

  it('spends nothing on a second run with nothing edited', async () => {
    await publishDocs(DOCS, depsFor(relay));
    const again = await publishDocs(DOCS, depsFor(relay, undefined, new Date('2026-09-24')));
    expect(again.written).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.cost).toBe('0');
    expect(relay.writes).toBe(2);
  });

  it('REPLACES an edited page rather than adding a second one', async () => {
    await publishDocs(DOCS, depsFor(relay));
    const edited = [DOCS[0]!, { ...DOCS[1]!, markdown: '# Funding\n\nRewritten.' }];
    const second = await publishDocs(
      edited,
      depsFor(relay, undefined, new Date('2026-09-24'))
    );

    expect(second.written).toBe(1);
    // The relay holds two events, not three: one per page, forever.
    expect(relay.held.size).toBe(2);
    expect(relay.writes).toBe(3);

    const checks = verifyPublication(edited, relay.events(), pubkey);
    expect(checks.every((check) => check.matches)).toBe(true);
    expect(checks.map((check) => check.events)).toEqual([1, 1]);
    expect(relay.held.get(`30023:${pubkey}:funding`)?.content).toBe('# Funding\n\nRewritten.');
  });

  it('never lets a slow clock publish an article the relay would ignore', async () => {
    await publishDocs(DOCS, depsFor(relay, undefined, new Date('2026-09-23T12:00:00Z')));
    const before = relay.held.get(`30023:${pubkey}:concepts`)!;
    const edited = [{ ...DOCS[0]!, markdown: 'rewritten' }, DOCS[1]!];
    // The clock came back an hour. NIP-01 keeps the event with the later
    // `created_at`, so a naive `Date.now()` would publish a "new" article that
    // every relay in the network correctly discards.
    await publishDocs(edited, depsFor(relay, undefined, new Date('2026-09-23T11:00:00Z')));
    const after = relay.held.get(`30023:${pubkey}:concepts`)!;
    expect(after.created_at).toBeGreaterThan(before.created_at);
    expect(after.content).toBe('rewritten');
  });

  it('keeps going past a refusal and reports which page failed', async () => {
    const report = await publishDocs(
      DOCS,
      depsFor(relay, writerFor(relay, { refuse: new Set(['concepts']) }))
    );
    expect(report.failed).toBe(1);
    expect(report.written).toBe(1);
    expect(report.outcomes.find((outcome) => outcome.d === 'concepts')?.reason).toMatch(
      /still billed/u
    );
    expect(relay.held.size).toBe(1);
  });
});

describe('publishing to a relay that has not dropped the old copy', () => {
  it('still shows exactly one article per page', async () => {
    const relay = new HoardingRelay();
    await publishDocs(DOCS, depsFor(relay));
    const edited = [DOCS[0]!, { ...DOCS[1]!, markdown: 'rewritten' }];
    await publishDocs(edited, depsFor(relay, undefined, new Date('2026-09-24')));

    // The relay is serving three events. A reader sees two pages.
    expect(relay.all).toHaveLength(3);
    const current = currentArticles(relay.events(), pubkey);
    expect(current.size).toBe(2);
    expect(current.get('funding')?.article.markdown).toBe('rewritten');

    // `verifyPublication` reports the extra copy without calling it a failure:
    // NIP-01 lets a relay serve a superseded event for a while.
    const checks = verifyPublication(edited, relay.events(), pubkey);
    expect(checks.every((check) => check.matches)).toBe(true);
    expect(checks.find((check) => check.d === 'funding')?.events).toBe(2);
  });
});

describe('verifying', () => {
  it('fails when the published article is somebody else’s text', () => {
    const relay = new ReplacingRelay();
    relay.accept(
      finalizeEvent(
        {
          kind: 30023,
          created_at: 1,
          content: 'not the repository copy',
          tags: [
            ['d', 'concepts'],
            ['title', 'Concepts'],
            ['summary', 'The words.'],
          ],
        },
        secretKey
      ) as unknown as NostrEvent
    );
    const checks = verifyPublication([DOCS[0]!], relay.events(), pubkey);
    expect(checks[0]?.matches).toBe(false);
    expect(checks[0]?.problem).toMatch(/not this repository's copy/u);
  });

  it('fails when nothing is at the address at all', () => {
    const checks = verifyPublication(DOCS, [], pubkey);
    expect(checks.every((check) => !check.matches)).toBe(true);
    expect(checks[0]?.events).toBe(0);
  });
});
