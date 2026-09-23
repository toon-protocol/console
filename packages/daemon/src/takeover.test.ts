import { describe, expect, it } from 'vitest';

import {
  fakeAccount,
  fakeRelayNetwork,
  fakeRelayServer,
  store,
  type FakeAccount,
  type FakeRelayServer,
} from './chain-seed.testkit.js';
import type { NostrEvent } from './nostr.js';
import { readClaims, readTakeover, settleTakeover, TAKEOVER_KIND } from './takeover.js';

/**
 * Watching a Takeover happen (TOON_Network#95, spec §7.1, ADR 0010).
 *
 * The console is an OBSERVER of this race, never a party to it: a standby
 * decides on its own, because a Takeover that waited for the tenant to be
 * online is one that never happens while they sleep. So every case here is
 * about reading other people's signed claims correctly — and the two that
 * matter most are the ones a naive reader gets wrong.
 *
 * **The earliest claim wins, not the newest event.** §7.1 step 3 settles on
 * `created_at`, with a tie going to the lower index in `standby_set`.
 *
 * **A second failure is a second race.** A standby that LOST watches the
 * winner as its new primary and, if that one goes silent too, announces again
 * naming the winner as `primary` (§7.1 step 5). Reading the newest claim would
 * then name a member that never ran the workload.
 */

const WORKLOAD = 'f'.repeat(64);
const RELAY = 'wss://primary.relay.test';

async function claim(
  account: FakeAccount,
  input: { workloadId?: string; primary: string; createdAt: number; d?: string }
): Promise<NostrEvent> {
  return (await account.sign({
    kind: TAKEOVER_KIND,
    created_at: input.createdAt,
    tags: [
      ['d', input.d ?? input.workloadId ?? WORKLOAD],
      ['L', 'toon.network'],
    ],
    content: JSON.stringify({
      workload_id: input.workloadId ?? WORKLOAD,
      primary: input.primary,
    }),
  })) as unknown as NostrEvent;
}

describe('settling a Takeover (§7.1 step 3)', () => {
  const ordered = [
    { claimant: 'b', index: 1, primary: 'a', createdAt: 100, announcedAt: '', eventId: '1' },
    { claimant: 'c', index: 2, primary: 'a', createdAt: 100, announcedAt: '', eventId: '2' },
  ];

  it('breaks a tie by the lower index in `standby_set`', () => {
    const settled = settleTakeover(ordered, ['a', 'b', 'c']);
    expect(settled.winner?.claimant).toBe('b');
    expect(settled.rounds).toBe(1);
  });

  it('takes the earliest `created_at` over the lower index', () => {
    const settled = settleTakeover(
      [
        {
          claimant: 'c',
          index: 2,
          primary: 'a',
          createdAt: 90,
          announcedAt: '',
          eventId: '2',
        },
        {
          claimant: 'b',
          index: 1,
          primary: 'a',
          createdAt: 100,
          announcedAt: '',
          eventId: '1',
        },
      ],
      ['a', 'b', 'c']
    );
    expect(settled.winner?.claimant).toBe('c');
  });

  it('follows a SECOND race: a claim against the first winner', () => {
    const settled = settleTakeover(
      [
        {
          claimant: 'b',
          index: 1,
          primary: 'a',
          createdAt: 100,
          announcedAt: '',
          eventId: '1',
        },
        {
          claimant: 'c',
          index: 2,
          primary: 'b',
          createdAt: 900,
          announcedAt: '',
          eventId: '3',
        },
      ],
      ['a', 'b', 'c']
    );
    // `b` took it from `a`, then `c` took it from `b`. The workload is on `c`.
    expect(settled.winner?.claimant).toBe('c');
    expect(settled.rounds).toBe(2);
  });

  it('ignores a claim against a primary no round ever reached', () => {
    const settled = settleTakeover(
      [
        {
          claimant: 'c',
          index: 2,
          primary: 'z',
          createdAt: 50,
          announcedAt: '',
          eventId: '9',
        },
      ],
      ['a', 'b', 'c']
    );
    expect(settled.winner).toBeUndefined();
    expect(settled.rounds).toBe(0);
  });

  it('does not loop on two members naming each other as primary', () => {
    const settled = settleTakeover(
      [
        {
          claimant: 'b',
          index: 1,
          primary: 'a',
          createdAt: 100,
          announcedAt: '',
          eventId: '1',
        },
        {
          claimant: 'a',
          index: 0,
          primary: 'b',
          createdAt: 200,
          announcedAt: '',
          eventId: '2',
        },
        {
          claimant: 'b',
          index: 1,
          primary: 'a',
          createdAt: 300,
          announcedAt: '',
          eventId: '3',
        },
      ],
      ['a', 'b']
    );
    // These are signed events from parties this console does not control, so
    // the walk is guarded: it terminates and reports what it reached.
    expect(settled.winner?.claimant).toBe('a');
  });
});

describe('reading Takeover claims off the relays (§7.1 step 2)', () => {
  it('keeps only claims from members of the set, on this workload', async () => {
    const inSet = fakeAccount();
    const stranger = fakeAccount();
    const events = [
      await claim(inSet, { primary: 'a'.repeat(64), createdAt: 100 }),
      await claim(stranger, { primary: 'a'.repeat(64), createdAt: 90 }),
      await claim(inSet, { primary: 'a'.repeat(64), createdAt: 80, d: 'e'.repeat(64) }),
    ];

    const claims = readClaims(events, {
      workloadId: WORKLOAD,
      standbySet: ['a'.repeat(64), inSet.pubkey],
    });

    // A relay that answered an `authors` filter with somebody else's event is
    // the relay's other way of lying, and it is checked rather than assumed.
    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimant).toBe(inSet.pubkey);
    expect(claims[0]?.index).toBe(1);
  });

  it('carries the moment the winner ANNOUNCED, from its own signed event', async () => {
    const primary = fakeAccount();
    const standby = fakeAccount();
    const relay: FakeRelayServer = fakeRelayServer(RELAY);
    store(relay, await claim(standby, { primary: primary.pubkey, createdAt: 1_790_000_123 }));

    const reading = await readTakeover({
      workloadId: WORKLOAD,
      standbySet: [primary.pubkey, standby.pubkey],
      relays: [RELAY],
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });

    expect(reading.state).toBe('settled');
    expect(reading.winner?.claimant).toBe(standby.pubkey);
    expect(reading.winner?.announcedAt).toBe(new Date(1_790_000_123 * 1000).toISOString());
    expect(reading.rounds).toBe(1);
  });

  it('answers `none` when a relay answered and held no claim', async () => {
    const primary = fakeAccount();
    const standby = fakeAccount();
    const relay = fakeRelayServer(RELAY);

    const reading = await readTakeover({
      workloadId: WORKLOAD,
      standbySet: [primary.pubkey, standby.pubkey],
      relays: [RELAY],
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });

    expect(reading.state).toBe('none');
    expect(reading.winner).toBeUndefined();
  });

  it('answers `unread` when no relay answered: silence is not an absence', async () => {
    const primary = fakeAccount();
    const standby = fakeAccount();
    const relay = fakeRelayServer(RELAY, { down: true });

    const reading = await readTakeover({
      workloadId: WORKLOAD,
      standbySet: [primary.pubkey, standby.pubkey],
      relays: [RELAY],
      dial: fakeRelayNetwork([relay]),
      timeoutMs: 200,
    });

    expect(reading.state).toBe('unread');
    expect(reading.reason).toContain('not the absence of a claim');
  });

  it('answers `unread` when the set names no relay to ask', async () => {
    const reading = await readTakeover({
      workloadId: WORKLOAD,
      standbySet: ['a'.repeat(64)],
      relays: [],
    });

    expect(reading.state).toBe('unread');
    expect(reading.claims).toEqual([]);
  });
});
