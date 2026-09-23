import { tagValue, type NostrEvent } from './nostr.js';
import { queryRelays, type RelayDialer, type RelayOutcome } from './relay-pool.js';

/**
 * **Watching a Takeover happen** (TOON_Network#95, spec §7.1, ADR 0010).
 *
 * A Warm Standby takes over when the primary's Liveness has been expired on a
 * majority of the primary's Relay Set for a cadence. It announces the claim,
 * waits out the settle window, and the earliest valid claim wins. The tenant
 * is not part of that: nothing asks it, nothing waits for it, and ADR 0010
 * says why — a tenant that had to be online for a Takeover is a tenant whose
 * workload dies while they sleep.
 *
 * So the console is an OBSERVER here, and this module is the whole of that. It
 * reads the same public claims the standbys read and settles them by the same
 * rule, which buys two things a `status` call alone cannot.
 *
 * **The moment.** `status` says a Takeover settled and who won (§6.5), and
 * says nothing about WHEN. The claim does: a kind-30433 event's `created_at`
 * is the moment the winner announced, signed by the winner. That is the answer
 * to "when did this happen", and it is free — the spec prices a provider's
 * routes, never a relay's reads (§5).
 *
 * **A set that failed twice.** §7.1 step 5 has a standby that LOST watch the
 * winner as its new primary and, if that one goes silent too, announce again
 * naming the winner as `primary`. So claims accumulate in rounds, each round
 * naming the previous round's winner. `settleTakeover` below follows that
 * chain rather than reading the newest event: a claim against a primary that
 * has already been replaced "belongs to an earlier race, already settled", and
 * reading it as current would name the wrong member as the one running the
 * workload.
 *
 * What this module does NOT do is decide anything. It never announces — only a
 * standby does that, and a tenant that published a kind 30433 would be forging
 * a provider's claim — and it never treats its reading as authority over what
 * a member says about itself. When the claims and a member's `status` disagree,
 * the member's own answer about its own lease wins; this is the record of the
 * race, not the verdict on it.
 */

/** §7.1 step 2: addressable, `d` = the workload id, signed by the claimant. */
export const TAKEOVER_KIND = 30433;

export interface TakeoverClaim {
  /** The standby that announced it. Never the primary (§7.1 step 2). */
  readonly claimant: string;
  /** Its position in `standby_set`, which breaks a tie (§7.1 step 3). */
  readonly index: number;
  /** The member this claim was made against: `primary` in the content. */
  readonly primary: string;
  readonly createdAt: number;
  readonly announcedAt: string;
  readonly eventId: string;
}

export interface TakeoverReading {
  readonly state:
    /** No claim on this workload from any member of the set. */
    | 'none'
    /** At least one claim, and the chain of races settles on a winner. */
    | 'settled'
    /** No relay could be asked, so silence here means nothing. */
    | 'unread';
  readonly reason?: string | undefined;
  /** Every claim from a member of the set, earliest first. */
  readonly claims: readonly TakeoverClaim[];
  /** The member running the workload after the last settled race. */
  readonly winner?: TakeoverClaim | undefined;
  /** How many times this set has changed hands. */
  readonly rounds: number;
  readonly relays: readonly RelayOutcome[];
  readonly readAt: string;
}

export interface TakeoverQuery {
  readonly workloadId: string;
  /** The set, primary first. A claimant outside it is ignored (§7.1 step 3). */
  readonly standbySet: readonly string[];
  /**
   * Where to look: the PRIMARY's Relay Set, which is where every claim is
   * published (§7.1 step 2), plus whatever else the caller can reach. Reading
   * a relay that holds nothing costs nothing, and a relay set that has shifted
   * between rounds is exactly the case a narrower list would miss.
   */
  readonly relays: readonly string[];
  readonly dial?: RelayDialer | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Read this workload's Takeover claims and settle them.
 *
 * Nothing is trusted about the answer beyond the signature `queryRelays`
 * already checked: a claim from a signer outside the Standby Set is dropped,
 * a claim whose `d` is not this workload id is dropped, and a claim naming a
 * primary no round ever reached is left in `claims` but wins nothing.
 */
export async function readTakeover(query: TakeoverQuery): Promise<TakeoverReading> {
  const readAt = (query.now ?? (() => new Date()))().toISOString();
  const relays = [...new Set(query.relays)].filter((url) => url.length > 0);
  if (relays.length === 0 || query.standbySet.length === 0) {
    return {
      state: 'unread',
      reason:
        'No relay of this workload’s Standby Set could be named, so nothing was asked. A ' +
        'Takeover is announced on the primary’s own Relay Set (§7.1), which its Provider ' +
        'Profile is what publishes.',
      claims: [],
      rounds: 0,
      relays: [],
      readAt,
    };
  }

  const result = await queryRelays({
    relays,
    filters: [
      {
        kinds: [TAKEOVER_KIND],
        authors: [...query.standbySet],
        '#d': [query.workloadId],
        limit: 100,
      },
    ],
    ...(query.dial === undefined ? {} : { dial: query.dial }),
    ...(query.timeoutMs === undefined ? {} : { timeoutMs: query.timeoutMs }),
  });

  const answered = result.relays.some((outcome) => outcome.state === 'read');
  const claims = readClaims(result.events, query);
  if (claims.length === 0) {
    return {
      state: answered ? 'none' : 'unread',
      reason: answered
        ? undefined
        : 'No relay answered, so nothing is known about whether a Takeover happened. Silence ' +
          'from a relay is not the absence of a claim.',
      claims: [],
      rounds: 0,
      relays: result.relays,
      readAt,
    };
  }

  const settled = settleTakeover(claims, query.standbySet);
  return {
    state: 'settled',
    claims,
    ...(settled.winner === undefined ? {} : { winner: settled.winner }),
    rounds: settled.rounds,
    relays: result.relays,
    readAt,
  };
}

/** Claims from members of the set, on this workload, earliest first. */
export function readClaims(
  events: readonly NostrEvent[],
  query: Pick<TakeoverQuery, 'workloadId' | 'standbySet'>
): readonly TakeoverClaim[] {
  const claims: TakeoverClaim[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== TAKEOVER_KIND) continue;
    if (tagValue(event, 'd') !== query.workloadId) continue;
    const index = query.standbySet.indexOf(event.pubkey);
    // "Events from any other signer are ignored" (§7.1 step 3). A relay that
    // answered an `authors` filter with somebody else's event is the relay's
    // other way of lying, and it is checked here rather than assumed away.
    if (index < 0) continue;
    let content: unknown;
    try {
      content = JSON.parse(event.content);
    } catch {
      continue;
    }
    const fields = content as { workload_id?: unknown; primary?: unknown };
    if (fields.workload_id !== query.workloadId) continue;
    if (typeof fields.primary !== 'string') continue;
    // Addressable: one claim per workload per claimant. A relay serving two
    // must not make one standby look like two claimants.
    const key = `${event.pubkey}/${fields.primary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({
      claimant: event.pubkey,
      index,
      primary: fields.primary,
      createdAt: event.created_at,
      announcedAt: new Date(event.created_at * 1000).toISOString(),
      eventId: event.id,
    });
  }
  return claims.sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.index - right.index
      : left.createdAt - right.createdAt
  );
}

/**
 * Who runs the workload now, by §7.1 step 3's rule, round after round.
 *
 * One round: among the claims naming THIS round's primary, the earliest
 * `created_at` wins and a tie goes to the lower index in `standby_set`. The
 * winner becomes the primary of the next round, because a standby that lost
 * "watches the winner as its new primary" and announces against it if it goes
 * silent too (§7.1 step 5). Claims naming anybody else belong to no round and
 * decide nothing.
 *
 * The chain is walked with a guard, because these are signed events from
 * parties this console does not control: two standbys naming each other as
 * primary would otherwise be a loop, and a loop in a dashboard is a hung
 * daemon.
 */
export function settleTakeover(
  claims: readonly TakeoverClaim[],
  standbySet: readonly string[]
): { winner?: TakeoverClaim | undefined; rounds: number } {
  let against = standbySet[0];
  let winner: TakeoverClaim | undefined;
  let rounds = 0;
  const walked = new Set<string>();
  while (against !== undefined && !walked.has(against)) {
    walked.add(against);
    const round = claims.filter((claim) => claim.primary === against);
    if (round.length === 0) break;
    // `claims` is already earliest-first with ties broken by index, so the
    // first of a round is that round's winner.
    const won = round[0];
    if (won === undefined) break;
    winner = won;
    rounds += 1;
    against = won.claimant;
  }
  return { ...(winner === undefined ? {} : { winner }), rounds };
}
