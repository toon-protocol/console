import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DesktopNotifier,
  FileAlertStore,
  InMemoryAlertStore,
  notifying,
  RecordingNotificationPort,
  reviewCard,
  RUNWAY_ALERT_SECONDS,
} from './alerts.js';
import type { ConsolePaths } from './paths.js';
import type {
  DashboardView,
  LeaseLife,
  RunwayView,
  WorkloadCard,
  WorkloadStatus,
} from './workload.js';

/**
 * Once per event, not once per poll (TOON_Network#99).
 *
 * Every case here is the same dashboard seen twice, which is what a console
 * that polls every thirty seconds actually does all day.
 */

const PUBKEY = 'a'.repeat(64);

/**
 * A card, as far as an alert is concerned.
 *
 * `reviewCard` reads the workload id, the status, the runway and the ending —
 * the four things the card on screen shows — and nothing else, so the lease
 * record and the provider behind them are stubbed rather than built. The cast
 * is load-bearing in one direction only: if the review ever starts reading
 * something else, this fixture stops compiling.
 */
function card(
  overrides: {
    workloadId?: string;
    status?: WorkloadStatus;
    runway?: Partial<RunwayView>;
    endedAs?: WorkloadCard['endedAs'];
  } = {}
): WorkloadCard {
  const runway: RunwayView = {
    state: 'computed',
    listingPrice: 1000,
    leaseIntervalSeconds: 3600,
    seconds: 172_800,
    until: '2026-09-25T00:00:00.000Z',
    readAt: '2026-09-23T00:00:00.000Z',
    ...overrides.runway,
  };
  return {
    workloadId: overrides.workloadId ?? 'w'.repeat(32),
    lease: {} as WorkloadCard['lease'],
    provider: {} as WorkloadCard['provider'],
    status: overrides.status ?? running(),
    runway,
    extend: { ok: true, problems: [] },
    // A set of one: a standalone lease is a Standby Set with no Warm Standby
    // in it, and the review reads neither field (spec §7).
    members: [],
    set: { members: 1, warm: false },
    ...(overrides.endedAs === undefined ? {} : { endedAs: overrides.endedAs }),
  };
}

function running(takeover?: { winner: string }): WorkloadStatus {
  return {
    kind: 'read',
    life: { phase: 'running' },
    readAt: '2026-09-23T00:00:00.000Z',
    ...(takeover === undefined ? {} : { takeover }),
  };
}

function ended(ending: Extract<LeaseLife, { phase: 'ended' }>['ending']): WorkloadStatus {
  return {
    kind: 'read',
    life: { phase: 'ended', ending },
    readAt: '2026-09-23T00:00:00.000Z',
  };
}

function dashboard(...cards: WorkloadCard[]): DashboardView {
  return {
    state: 'ready',
    pubkey: PUBKEY,
    profileId: 'sandbox',
    cards,
    unreadable: 0,
    checkedAt: '2026-09-23T00:00:00.000Z',
  };
}

function notifier() {
  const port = new RecordingNotificationPort();
  return { port, notifier: new DesktopNotifier({ store: new InMemoryAlertStore(), port }) };
}

describe('reviewCard', () => {
  it('reports a runway under a day, and not one over it', () => {
    expect(
      reviewCard(card({ runway: { seconds: RUNWAY_ALERT_SECONDS - 1 } })).fire.map(
        (a) => a.kind
      )
    ).toEqual(['runway']);
    expect(
      reviewCard(card({ runway: { seconds: RUNWAY_ALERT_SECONDS } })).fire.map((a) => a.kind)
    ).toEqual([]);
  });

  it('says nothing about a runway it could not work out', () => {
    // Not knowing is not the same as being fine, and it is certainly not the
    // same as being short: neither an alert nor a clearance.
    const review = reviewCard(
      card({ runway: { state: 'unknown', reason: 'no channel', seconds: undefined } })
    );
    expect(review.fire).toEqual([]);
    expect(review.clear).toEqual([]);
  });

  it('reads the figure off the card rather than working one out', () => {
    const [alert] = reviewCard(card({ runway: { seconds: 5 * 3600 } })).fire;
    expect(alert?.body).toContain('5 h 0 min');
  });

  it('says nothing about the runway of a lease that has ended', () => {
    const review = reviewCard(card({ status: ended('expiry'), runway: { seconds: 60 } }));
    expect(review.fire).toEqual([]);
    expect(review.clear).toHaveLength(1);
  });

  it('names the Standby that took over, so a second Takeover is a new event', () => {
    const first = reviewCard(card({ status: running({ winner: 'b'.repeat(64) }) })).fire[0];
    const second = reviewCard(card({ status: running({ winner: 'c'.repeat(64) }) })).fire[0];

    expect(first?.kind).toBe('takeover');
    expect(first?.key).not.toBe(second?.key);
  });

  it('reports an ending this console kept, not only one the provider still tells', () => {
    // A terminated or evicted lease is swept, and `status` then answers
    // `unknown_workload` — the ending survives in the card, so it survives here.
    const review = reviewCard(
      card({
        status: { kind: 'refused', code: 'unknown_workload', message: 'no', readAt: 'now' },
        endedAs: 'eviction',
      })
    );
    expect(review.fire.map((a) => a.kind)).toEqual(['eviction']);
  });
});

describe('DesktopNotifier', () => {
  it('sends each event once, however often the dashboard is polled', async () => {
    const { port, notifier: watcher } = notifier();
    const view = dashboard(
      card({
        workloadId: 'runs-out',
        runway: { seconds: 3600 },
        status: running({ winner: 'b'.repeat(64) }),
      }),
      card({ workloadId: 'evicted', status: ended('eviction') })
    );

    expect(await watcher.review(view)).toHaveLength(3);
    for (let poll = 0; poll < 5; poll += 1) {
      expect(await watcher.review(view)).toEqual([]);
    }
    expect(port.sent.map((alert) => alert.kind).sort()).toEqual([
      'eviction',
      'runway',
      'takeover',
    ]);
  });

  it('announces a second shortage after the first was put right', async () => {
    const { notifier: watcher } = notifier();
    const short = dashboard(card({ runway: { seconds: 3600 } }));
    const extended = dashboard(card({ runway: { seconds: 200_000 } }));

    expect(await watcher.review(short)).toHaveLength(1);
    expect(await watcher.review(short)).toEqual([]);
    // Somebody extended. The card says so, and the next fall below the line is
    // news again.
    expect(await watcher.review(extended)).toEqual([]);
    expect(await watcher.review(short)).toHaveLength(1);
  });

  it('reviews nothing when nobody is signed in', async () => {
    const { notifier: watcher } = notifier();
    const out: DashboardView = {
      state: 'signed_out',
      profileId: 'sandbox',
      cards: [],
      unreadable: 0,
      checkedAt: 'now',
    };
    expect(await watcher.review(out)).toEqual([]);
  });

  it('does not repeat itself after a restart', async () => {
    const data = mkdtempSync(join(tmpdir(), 'toon-alerts-'));
    homes.push(data);
    const paths: ConsolePaths = { data, config: data, runtime: data };
    const view = dashboard(card({ status: ended('eviction') }));

    const first = new DesktopNotifier({
      store: new FileAlertStore(paths),
      port: new RecordingNotificationPort(),
    });
    expect(await first.review(view)).toHaveLength(1);

    // A different daemon, a different process, the same account.
    const second = new DesktopNotifier({
      store: new FileAlertStore(paths),
      port: new RecordingNotificationPort(),
    });
    expect(await second.review(view)).toEqual([]);
  });
});

describe('notifying', () => {
  it('reviews every dashboard the console builds, and passes the rest through', async () => {
    const { port, notifier: watcher } = notifier();
    const view = dashboard(card({ status: ended('eviction') }));
    let dashboards = 0;
    const wrapped = notifying(
      {
        dashboard: async () => {
          dashboards += 1;
          return view;
        },
        card: async () => view.cards[0]!,
        extend: async () => {
          throw new Error('not used');
        },
        terminate: async () => {
          throw new Error('not used');
        },
      },
      watcher
    );

    await wrapped.dashboard({ refresh: true });
    await wrapped.dashboard({ refresh: true });
    await wrapped.card('anything');

    expect(dashboards).toBe(2);
    expect(port.sent).toHaveLength(1);
  });
});

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
