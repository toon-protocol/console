import { HEX_32 } from './spawn-content.js';

/**
 * **The Standby Set**: one workload id, several providers, one Root Secret
 * (TOON_Network#95, spec §7).
 *
 * This file holds the two things about a set that are neither a packet nor a
 * screen: what makes a set well formed, and what keeping one alive costs. Both
 * are pure, so both are checkable without a provider, a relay or a channel —
 * which matters because getting either wrong is expensive in a way that no
 * retry undoes.
 *
 * **A Standby Set is one spawn CONTENT bought several times (§7).** The same
 * `workload_id` and the same `standby_set` go to every member, each in a
 * request of its own that names only that member, presents only that member's
 * Continuation Token, and arrives on the route its role is sold on: the
 * primary's on `.spawn` at `price`, each Warm Standby's on `.standby` at
 * `standby_price`. Nothing in the content singles a member out. A member's
 * role is its POSITION in the list together with the route its request was
 * paid on (§6.2 step 3), and that is why `checkStandbySet` below refuses a
 * repeated provider outright: a list that names one provider twice gives it
 * two positions and so two roles, which is `invalid_request` at the provider
 * — after being billed (ADR 0003).
 *
 * **One Root Secret per WORKLOAD, not per member (§6.1.1).** Every member's
 * Continuation Token derives from that one secret under that member's own
 * public key, so the tokens differ by construction and no member of a set can
 * read, extend or terminate another member's lease. That is the whole reason
 * the Lease Vault keeps one record per workload naming the set, rather than
 * one record per member holding the same secret twice.
 *
 * **A reservation is a lease (§7).** It is `Reserved` from the spawn, holds a
 * capacity slot, is swept on expiry like any other, and is paid on its OWN
 * route: `.standby.extend` at `standby_price`. Paying it on `.extend` is
 * refused `not_running` and billed at the running price, and paying a running
 * lease on `.standby.extend` is refused `not_standby` and billed at the
 * standby price (§6.3). So `routeOpFor` below reads the member's live state —
 * free — and picks the route from it, rather than from what the member was at
 * spawn time.
 *
 * **Runway is the SET's, not the primary's.** A set that protects a workload
 * only protects it while every member is paid: a reservation that lapses is a
 * Warm Standby that is not there when the primary goes silent. So the figure
 * a person needs is bounded by the member that runs out first, and the money
 * has to be counted per CHANNEL — two members at two connectors do not draw on
 * one balance, and two members at the same connector do. `setRunway` below is
 * that sum, and like #93's it answers `unknown` with a reason rather than
 * putting a zero where a missing half should be.
 */

/** §6.7's lease states, as far as the route a member is paid on cares. */
export type MemberPhase = 'provisioning' | 'reserved' | 'running' | 'stopped' | 'ended';

/** The two routes that add a Lease Interval to a member (§5, §6.3). */
export type ExtendOp = 'extend' | 'standby.extend';

/**
 * Which route buys this member another interval, from what it is doing now.
 *
 * §6.3 wants the lease in the opposite state on each route, so this is the
 * whole rule: a Reserved Warm Standby is paid on `.standby.extend`, and
 * anything else that is still a lease — a standalone, a primary, a primary
 * that stopped itself under §7.1, a standby that won a Takeover — is paid on
 * `.extend`. A lease that has ended is paid on neither; §6.3 answers `expired`
 * on both, and bills for it.
 */
export function routeOpFor(phase: MemberPhase): ExtendOp | undefined {
  if (phase === 'ended') return undefined;
  return phase === 'reserved' ? 'standby.extend' : 'extend';
}

export interface StandbySetProblem {
  /** The member the problem is about, when it is about one. */
  readonly member?: string | undefined;
  readonly message: string;
}

/**
 * Everything §6.2 step 3 and §7 would refuse a Standby Set for, found for
 * nothing.
 *
 * Checked here because every one of these refusals is `invalid_request` at a
 * provider that has already been paid: the spawn is mis-addressed, the tenant
 * must correct it rather than retry it, and it is still billed. A set of three
 * gets that wrong three times over.
 */
export function checkStandbySet(members: readonly string[]): readonly string[] {
  const problems: string[] = [];
  if (members.length < 2) {
    problems.push(
      'A Standby Set is a primary lease and at least one Warm Standby (§7). A spawn with no ' +
        'standby is a standalone lease and carries no `standby_set` at all — §6.2 branches on ' +
        'the field being PRESENT, so an empty one is not a way to say "none".'
    );
  }
  for (const member of members) {
    if (!HEX_32.test(member)) {
      problems.push(
        `${JSON.stringify(member.slice(0, 24))} is not a provider’s public key: 64 lowercase ` +
          'hex characters, exactly as its Profile publishes it. The key is spelled into the ' +
          'Continuation Token’s derivation, so any other spelling derives a token that ' +
          'provider does not hold (§6.1.1).'
      );
    }
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member)) {
      problems.push(
        `${member.slice(0, 12)}… is named twice. A \`standby_set\` lists each provider once: a ` +
          'repeat gives one provider two positions and so two roles, which is ' +
          '`invalid_request` at every member — and billed (§6.2 step 3).'
      );
    }
    seen.add(member);
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* What keeping the set alive costs                                           */
/* -------------------------------------------------------------------------- */

/** One member's half of the sum, as the dashboard worked it out. */
export interface RunwayMember {
  readonly pubkey: string;
  readonly index: number;
  /** Seconds this member is already paid for, from its own `expires_at`. */
  readonly paidSeconds?: number | undefined;
  /** What one interval costs it, base units, at the connector that collects. */
  readonly pricePerInterval?: string | undefined;
  /** Which route that price is for: a reservation is not extended like a lease. */
  readonly op?: ExtendOp | undefined;
  readonly leaseIntervalSeconds: number;
  /** The channel that would pay, as `payAt|chain|channelId`. */
  readonly channelKey?: string | undefined;
  /** What that channel has left. Members sharing a channel share this figure. */
  readonly available?: string | undefined;
  /** Set when this member contributes nothing countable, and says why. */
  readonly unknown?: string | undefined;
  /** A member whose lease has ended costs nothing and buys nothing. */
  readonly ended?: boolean | undefined;
}

export interface SetRunway {
  readonly state: 'computed' | 'unbounded' | 'unknown';
  readonly reason?: string | undefined;
  /** What ONE round of extensions for the whole set costs, base units. */
  readonly pricePerInterval?: string | undefined;
  /** Whole rounds the channels buy. Never a fraction: §6.3 sells whole intervals. */
  readonly rounds?: number | undefined;
  /** Seconds the whole set stays a set: the member that runs out first. */
  readonly seconds?: number | undefined;
  /** Which member that is. A set is only as alive as its shortest member. */
  readonly boundBy?: string | undefined;
  readonly members: readonly RunwayMember[];
}

/**
 * How long the money keeps the WHOLE SET alive.
 *
 * Three rules, and each one is a thing a simpler sum would get wrong.
 *
 * 1. **Money is counted per channel.** Two members at two connectors draw on
 *    two balances; two members at one connector draw on one, and a round that
 *    buys both has to fit in it. So members are grouped by the channel that
 *    would pay, and each group buys whole rounds out of its own balance.
 * 2. **A round is whole.** §6.3 sells whole Lease Intervals and ADR 0003
 *    refunds nothing, so a group that can afford two of its three members'
 *    extensions can afford NO round: the third member lapses and the set stops
 *    being a set. `floor` over the group's whole price, never per member.
 * 3. **The set is as alive as its shortest member.** A reservation that lapses
 *    is a Warm Standby that is not there when the primary goes silent, so the
 *    figure is the MINIMUM over members, not the primary's and not an average.
 *    `boundBy` names the member the figure came from, because that is the one
 *    to top up.
 *
 * A member whose lease has ENDED is left out of the sum entirely: it costs
 * nothing, buys nothing and cannot be extended (§6.3 answers `expired`). A set
 * whose every member has ended has no runway at all, which the caller reports
 * as such rather than as a zero.
 */
export function setRunway(members: readonly RunwayMember[]): SetRunway {
  const live = members.filter((member) => member.ended !== true);
  if (live.length === 0) {
    return {
      state: 'unknown',
      reason:
        'Every member of this Standby Set has ended, so the set has no runway. Money in the ' +
        'channels is still yours; it is simply not keeping this workload alive any more.',
      members,
    };
  }

  const missing = live.find((member) => member.unknown !== undefined);
  if (missing !== undefined) {
    return {
      state: 'unknown',
      reason: `${missing.pubkey.slice(0, 12)}… (index ${missing.index}) ${missing.unknown}`,
      members,
    };
  }

  let total = 0n;
  for (const member of live) {
    if (member.pricePerInterval === undefined) {
      return {
        state: 'unknown',
        reason:
          `No connector this console can reach prices ${member.pubkey.slice(0, 12)}…'s ` +
          `\`.${member.op ?? 'extend'}\` route right now, so what another interval would cost ` +
          `it is unknown — and a runway counted against a price nobody quoted would be a guess.`,
        members,
      };
    }
    try {
      total += BigInt(member.pricePerInterval);
    } catch {
      return {
        state: 'unknown',
        reason:
          `${member.pubkey.slice(0, 12)}… was quoted ${member.pricePerInterval}, which is not ` +
          `an amount this console can count in.`,
        members,
      };
    }
  }

  const price = total.toString();
  if (total === 0n) {
    return {
      state: 'unbounded',
      reason:
        'Every route that keeps this Standby Set alive costs nothing where it would be paid, ' +
        'so funds do not bound it at all. Each member still ends at its own expiry unless ' +
        'something extends it.',
      pricePerInterval: price,
      members,
    };
  }

  // Rule 1 and rule 2: whole rounds, out of each channel's own balance.
  const groups = new Map<string, { price: bigint; available?: bigint | undefined }>();
  for (const member of live) {
    const key = member.channelKey ?? `unbound:${member.pubkey}`;
    const held = groups.get(key) ?? { price: 0n, available: undefined };
    let available = held.available;
    if (member.available !== undefined) {
      try {
        const read = BigInt(member.available);
        available = available === undefined ? read : available < read ? available : read;
      } catch {
        available = undefined;
      }
    }
    groups.set(key, {
      price: held.price + BigInt(member.pricePerInterval ?? '0'),
      ...(available === undefined ? {} : { available }),
    });
  }

  let rounds: number | undefined;
  for (const [key, group] of groups) {
    if (group.available === undefined) {
      const member = live.find(
        (entry) => (entry.channelKey ?? `unbound:${entry.pubkey}`) === key
      );
      return {
        state: 'unknown',
        reason:
          `What the channel paying for ${member?.pubkey.slice(0, 12) ?? 'a member'}… has left ` +
          `could not be read, so a runway for this Standby Set would be a guess.`,
        pricePerInterval: price,
        members,
      };
    }
    if (group.price === 0n) continue;
    const affordable = Number(group.available <= 0n ? 0n : group.available / group.price);
    rounds = rounds === undefined ? affordable : Math.min(rounds, affordable);
  }
  const wholeRounds = rounds ?? 0;

  let seconds: number | undefined;
  let boundBy: string | undefined;
  for (const member of live) {
    if (member.paidSeconds === undefined) {
      return {
        state: 'unknown',
        reason:
          `Nothing has said when ${member.pubkey.slice(0, 12)}…'s lease expires: it has not ` +
          `been asked, or did not answer. Those funds buy ${wholeRounds} more round(s) for the ` +
          `whole set, but a runway also needs the time already paid for.`,
        pricePerInterval: price,
        rounds: wholeRounds,
        members,
      };
    }
    const own = member.paidSeconds + wholeRounds * member.leaseIntervalSeconds;
    if (seconds === undefined || own < seconds) {
      seconds = own;
      boundBy = member.pubkey;
    }
  }

  return {
    state: 'computed',
    pricePerInterval: price,
    rounds: wholeRounds,
    ...(seconds === undefined ? {} : { seconds }),
    ...(boundBy === undefined ? {} : { boundBy }),
    members,
  };
}
