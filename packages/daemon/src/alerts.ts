import { execFile, type ExecFileException } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { WorkloadPort } from './api.js';
import { accountAlertsPath, type ConsolePaths } from './paths.js';
import type { DashboardView, LeaseEnding, WorkloadCard } from './workload.js';

/**
 * **The three things worth interrupting somebody for** (TOON_Network#99, ADR
 * 0019, the milestone's user story 19).
 *
 * Runway under twenty-four hours, a Takeover, and an Eviction. Everything else
 * the console knows is something a person can go and look at; these three are
 * things that happen while nobody is looking and cost something if they are
 * missed — a workload that dies for want of a top-up, a Standby that took over
 * without anyone noticing, a provider that ended a lease.
 *
 * Three rules shape this file.
 *
 * **An alert is read off the card, never computed again.** Every field used
 * below is one `workload-card.tsx` renders, and the wording is the card's
 * wording. Runway in particular is arithmetic over a channel balance, a
 * connector's quote and an expiry (`workload.ts`'s `#runway`), and a second
 * implementation of it here would be the one that drifts — so there is none:
 * `card.runway.seconds` is the figure, or there is no alert.
 *
 * **Once per event, not once per poll.** The dashboard is polled every thirty
 * seconds by an open window and every five minutes by the daemon itself, and
 * an Eviction is just as true on the hundredth poll as on the first. So each
 * alert has a KEY that identifies the event rather than the observation, and a
 * key that has been sent is not sent again. The keys are chosen so that a
 * genuinely new event is a new key: a Takeover by a different Standby is a
 * different key, and a runway that recovers above the threshold and falls back
 * under it FORGETS its key on the way up, so the second fall notifies again.
 *
 * **What was sent survives a restart.** The keys are written beside the
 * account's other state, because a daemon that restarted every night would
 * otherwise re-announce the same Eviction every morning.
 */

/** Under this much runway, somebody is told. The milestone's figure. */
export const RUNWAY_ALERT_SECONDS = 86_400;

export type AlertKind = 'runway' | 'takeover' | 'eviction';

export interface DesktopAlert {
  readonly workloadId: string;
  readonly kind: AlertKind;
  /** What makes this one event. The same key is never sent twice. */
  readonly key: string;
  readonly headline: string;
  readonly body: string;
  readonly urgency: 'low' | 'normal' | 'critical';
  /** A Nerd Font glyph for the toast. Omarchy's own notifications carry one. */
  readonly glyph: string;
}

export interface CardReview {
  /** Events this card is evidence of. */
  readonly fire: readonly DesktopAlert[];
  /** Keys this card is evidence AGAINST: the situation has recovered. */
  readonly clear: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* What a card is evidence of                                                 */
/* -------------------------------------------------------------------------- */

export function runwayKey(workloadId: string): string {
  return `runway:${workloadId}`;
}

export function takeoverKey(workloadId: string, winner: string): string {
  return `takeover:${workloadId}:${winner}`;
}

export function evictionKey(workloadId: string): string {
  return `eviction:${workloadId}`;
}

/**
 * One card, reviewed.
 *
 * Pure, and given nothing but the card — which is the point: what a person is
 * notified about and what they see on the dashboard cannot disagree, because
 * they are the same object.
 */
export function reviewCard(card: WorkloadCard): CardReview {
  const fire: DesktopAlert[] = [];
  const clear: string[] = [];
  const id = card.workloadId;
  const short = shortId(id);
  const ended = endingOf(card);

  if (ended === 'eviction') {
    fire.push({
      workloadId: id,
      kind: 'eviction',
      key: evictionKey(id),
      headline: 'Workload evicted',
      body:
        `${short} — its provider ended it, and must publish an Eviction Notice ` +
        `saying why (spec §6.7).`,
      urgency: 'critical',
      glyph: '󰅚',
    });
  }

  const takeover = card.status.kind === 'read' ? card.status.takeover : undefined;
  if (takeover !== undefined) {
    fire.push({
      workloadId: id,
      kind: 'takeover',
      key: takeoverKey(id, takeover.winner),
      headline: 'Takeover settled',
      body: `${short} — ${shortId(takeover.winner)}… runs this workload now ` + `(spec §7.1).`,
      urgency: 'normal',
      glyph: '󰓡',
    });
  }

  // A lease that has ended has no runway to warn about, and warning about one
  // would bury the ending it just reported.
  const runway = card.runway;
  if (ended !== undefined) {
    clear.push(runwayKey(id));
  } else if (runway.state === 'computed' && runway.seconds !== undefined) {
    if (runway.seconds < RUNWAY_ALERT_SECONDS) {
      fire.push({
        workloadId: id,
        kind: 'runway',
        key: runwayKey(id),
        headline: 'Runway under 24 hours',
        body:
          `${short} — runway ${duration(runway.seconds)}` +
          (runway.until === undefined
            ? ''
            : `, to about ${new Date(runway.until).toLocaleString()}`) +
          '. Extend it, or put more into the channel that pays for it.',
        urgency: 'critical',
        glyph: '󰥔',
      });
    } else {
      // Recovered — usually because somebody extended, or topped up. Forget
      // the key so the NEXT fall below the line is announced.
      clear.push(runwayKey(id));
    }
  } else if (runway.state === 'unbounded') {
    clear.push(runwayKey(id));
  }
  // `unknown` clears nothing: not knowing the runway is not evidence that it
  // recovered, and clearing on it would re-announce the same shortage.

  return { fire, clear };
}

/** The ending this card shows, from the provider now or from what was kept. */
function endingOf(card: WorkloadCard): LeaseEnding | undefined {
  if (card.status.kind === 'read' && card.status.life.phase === 'ended') {
    return card.status.life.ending;
  }
  return card.endedAs;
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

/**
 * Seconds as something a person reads.
 *
 * The same rule as `workload-card.tsx`'s `duration`, so a toast and the card
 * behind it say the same number of hours. It is a dozen lines of arithmetic
 * rather than a shared module because the two live on opposite sides of the
 * daemon/browser line that ADR 0019 draws — the UI cannot import from here.
 */
export function duration(seconds: number): string {
  if (seconds <= 0) return 'none';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/* -------------------------------------------------------------------------- */
/* What has already been said                                                 */
/* -------------------------------------------------------------------------- */

export interface AlertStore {
  sent(pubkey: string, key: string): boolean;
  record(pubkey: string, key: string): void;
  forget(pubkey: string, key: string): void;
}

interface AlertFile {
  readonly v: 1;
  readonly pubkey: string;
  readonly sent: Record<string, string>;
}

export class FileAlertStore implements AlertStore {
  readonly #paths: ConsolePaths;
  readonly #now: () => Date;

  constructor(paths: ConsolePaths, now: () => Date = () => new Date()) {
    this.#paths = paths;
    this.#now = now;
  }

  sent(pubkey: string, key: string): boolean {
    return this.#load(pubkey)?.sent[key] !== undefined;
  }

  record(pubkey: string, key: string): void {
    const file = this.#load(pubkey) ?? { v: 1 as const, pubkey, sent: {} };
    this.#save({
      ...file,
      sent: { ...file.sent, [key]: this.#now().toISOString() },
    });
  }

  forget(pubkey: string, key: string): void {
    const file = this.#load(pubkey);
    if (file === undefined || file.sent[key] === undefined) return;
    const sent = Object.fromEntries(
      Object.entries(file.sent).filter(([held]) => held !== key)
    );
    this.#save({ ...file, sent });
  }

  #load(pubkey: string): AlertFile | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(accountAlertsPath(this.#paths, pubkey), 'utf8'));
    } catch {
      return undefined;
    }
    const file = parsed as Partial<AlertFile>;
    if (file.v !== 1 || file.pubkey !== pubkey || typeof file.sent !== 'object')
      return undefined;
    const sent: Record<string, string> = {};
    for (const [key, at] of Object.entries(file.sent ?? {})) {
      if (typeof at === 'string') sent[key] = at;
    }
    return { v: 1, pubkey, sent };
  }

  #save(file: AlertFile): void {
    const path = accountAlertsPath(this.#paths, file.pubkey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

/** For tests, and for a daemon that would rather forget on restart. */
export class InMemoryAlertStore implements AlertStore {
  readonly #held = new Set<string>();

  sent(pubkey: string, key: string): boolean {
    return this.#held.has(`${pubkey}/${key}`);
  }

  record(pubkey: string, key: string): void {
    this.#held.add(`${pubkey}/${key}`);
  }

  forget(pubkey: string, key: string): void {
    this.#held.delete(`${pubkey}/${key}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Saying it                                                                  */
/* -------------------------------------------------------------------------- */

export interface NotificationPort {
  send(alert: DesktopAlert): Promise<void>;
}

/**
 * Omarchy's own notifications (`omarchy-notification-send`).
 *
 * Never `notify-send`: Omarchy's wrapper calls the D-Bus method with each value
 * as one typed parameter, so a summary or a body can never be re-read as an
 * option or a hint. Everything here is this console's own text anyway, but the
 * workload id inside it is not — it comes from a vault record — and that is
 * exactly the argument that must stay an argument.
 *
 * On a desktop without it, sending is a no-op and the console is otherwise
 * unchanged (ADR 0019): the dashboard still shows every fact a toast would
 * have carried.
 */
export class OmarchyNotificationPort implements NotificationPort {
  readonly #command: string;
  #missing = false;

  constructor(command = 'omarchy-notification-send') {
    this.#command = command;
  }

  async send(alert: DesktopAlert): Promise<void> {
    if (this.#missing) return;
    const args = [
      '--app-name',
      'toon-console',
      '-u',
      alert.urgency,
      '-g',
      alert.glyph,
      alert.headline,
      alert.body,
    ];
    await new Promise<void>((done) => {
      execFile(this.#command, args, (error: ExecFileException | null) => {
        // ENOENT is "this is not an Omarchy desktop", which is a supported
        // shape and not a failure. Anything else is one toast that did not
        // appear, and the dashboard still carries the fact.
        if (error?.code === 'ENOENT') this.#missing = true;
        done();
      });
    });
  }
}

/** For tests, and for anything that wants to see what would have been sent. */
export class RecordingNotificationPort implements NotificationPort {
  readonly sent: DesktopAlert[] = [];

  async send(alert: DesktopAlert): Promise<void> {
    this.sent.push(alert);
  }
}

/* -------------------------------------------------------------------------- */
/* The notifier                                                               */
/* -------------------------------------------------------------------------- */

export interface DesktopNotifierDeps {
  readonly store: AlertStore;
  readonly port: NotificationPort;
}

export class DesktopNotifier {
  readonly #deps: DesktopNotifierDeps;

  constructor(deps: DesktopNotifierDeps) {
    this.#deps = deps;
  }

  /**
   * Review a dashboard and send whatever it is new evidence of.
   *
   * Returns what was SENT, which is what the tests assert on: the same
   * dashboard reviewed twice sends the first time and nothing the second.
   *
   * A signed-out dashboard has no account to key anything by, and carries no
   * cards, so it is nothing to review.
   */
  async review(view: DashboardView): Promise<readonly DesktopAlert[]> {
    const pubkey = view.pubkey;
    if (pubkey === undefined) return [];

    const sent: DesktopAlert[] = [];
    for (const card of view.cards) {
      const { fire, clear } = reviewCard(card);
      for (const key of clear) this.#deps.store.forget(pubkey, key);
      for (const alert of fire) {
        if (this.#deps.store.sent(pubkey, alert.key)) continue;
        // Recorded BEFORE the send, so a notification daemon that hangs or
        // dies costs one missed toast rather than one per poll forever.
        this.#deps.store.record(pubkey, alert.key);
        await this.#deps.port.send(alert);
        sent.push(alert);
      }
    }
    return sent;
  }
}

/**
 * The dashboard, reviewed every time it is built.
 *
 * A decorator rather than a call inside `WorkloadStore`, so that the module
 * that talks to providers knows nothing about desktops. Every dashboard the
 * window asks for — and the one the daemon's own timer asks for while no
 * window is open — passes through here.
 *
 * Only `dashboard()` is reviewed and not `card()`: a card carries no account
 * to key an alert by, and the window that refreshes one card is the window
 * that polls the whole dashboard thirty seconds later.
 *
 * Every other method forwards its arguments **whole**. A decorator that drops
 * one is worse than no decorator: `terminate` names which member of a Standby
 * Set to end (§7), and a wrapper that forgot it would end the primary every
 * time — silently, irreversibly and with no refund (§6.6). `alerts.test.ts`
 * is the test that says so.
 */
export function notifying(port: WorkloadPort, notifier: DesktopNotifier): WorkloadPort {
  return {
    async dashboard(options) {
      const view = await port.dashboard(options);
      await notifier.review(view);
      return view;
    },
    card: (workloadId, options) => port.card(workloadId, options),
    extend: (workloadId, options) => port.extend(workloadId, options),
    terminate: (workloadId, options) => port.terminate(workloadId, options),
    forget: (workloadId) => port.forget(workloadId),
  };
}
