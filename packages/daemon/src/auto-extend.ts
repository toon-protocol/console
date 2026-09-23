import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { accountAutoExtendPath, type ConsolePaths } from './paths.js';
import {
  compareAmounts,
  WorkloadError,
  type AutoExtendReader,
  type AutoExtendView,
  type ExtendResult,
  type WorkloadCard,
} from './workload.js';

/**
 * **Automatic extension, within a budget** (TOON_Network#93, spec §6.3).
 *
 * This is the one thing in the console that spends money with nobody present.
 * Everything else — a spawn, a hand extension, a relay write — happens because
 * somebody pressed something. A budget is a standing instruction to keep
 * paying a provider while its holder is asleep, so the whole module is written
 * around making that instruction narrow, visible and hard to give by accident.
 *
 * **Nine rules, and each one can stop it on its own.**
 *
 * 1. **Off until armed, per lease.** There is no global switch and no default.
 *    A lease with no policy is never extended automatically.
 * 2. **Arming is deliberate.** It takes an explicit `confirm`, a budget above
 *    zero, and the price the account is agreeing to — which must equal what
 *    the connector quotes for this lease's `.extend` route right now. An
 *    account that cannot see the price it is agreeing to cannot arm.
 * 3. **The budget is an absolute cap, in the units the channel pays in.** Not
 *    a rate, not a per-day allowance. Once what has been spent plus the next
 *    interval's price would exceed it, the policy stops itself — it never
 *    spends part of an interval and never overruns by one.
 * 4. **A price that moved stops it rather than paying it.** A price change is
 *    a new Listing version (ADR 0009), which is a different offer from the one
 *    that was agreed to.
 * 5. **Silence never buys anything.** A provider that is not answering has
 *    told us nothing about the lease; an extension bought into that is an
 *    interval on a lease that may have ended, refused `expired` and billed for
 *    (ADR 0003, TOON_Network#115).
 * 6. **A billed refusal disarms.** Whatever the provider refused for, trying
 *    again on a timer would spend the whole budget learning the same thing.
 * 7. **An extension whose fate is unknown disarms.** A second one might buy a
 *    second interval nobody asked for.
 * 8. **It only acts inside the lead window** — the last stretch before expiry
 *    — so a lease is never paid further ahead than it needs to be. ADR 0003
 *    gives no refunds, so every interval bought early is one that cannot be
 *    given back.
 * 9. **Every run is written down**, whether it spent, waited or stopped, with
 *    the sentence that decided it. The card shows the last one.
 *
 * The budget lives on THIS MACHINE (see `paths.ts`), not in the Lease Vault
 * and not on a relay. Only the machine running the daemon can carry out a
 * standing instruction to spend, so the machine that would spend is the one
 * that holds the rule; signing in elsewhere arms nothing, and a disk that dies
 * takes the instruction with it rather than leaving one running unattended.
 */

/** What a budget is spent in: base units of the token the channel settles in. */
export interface AutoExtendPolicy {
  readonly workloadId: string;
  readonly profileId: string;
  readonly armed: boolean;
  /** The whole this console may spend on extensions for this lease. */
  readonly budget: string;
  readonly spent: string;
  readonly extensions: number;
  /** The price the account agreed to. A dearer one stops rather than pays. */
  readonly agreedPrice: string;
  /** How close to expiry an extension is bought. */
  readonly leadSeconds: number;
  readonly armedAt: string;
  readonly lastRun?: AutoExtendRun | undefined;
  /** Set once this policy turned itself off, with the sentence that did it. */
  readonly stoppedBecause?: string | undefined;
}

export interface AutoExtendRun {
  readonly at: string;
  readonly outcome: 'extended' | 'waited' | 'stopped';
  readonly reason: string;
  readonly cost?: string | undefined;
  /** Which members of the Standby Set this run bought an interval for (§7). */
  readonly members?: readonly string[] | undefined;
}

export interface ArmRequest {
  readonly workloadId: string;
  readonly budget: string;
  readonly agreedPrice: string;
  readonly leadSeconds?: number | undefined;
  /** Without this the request is refused. It is the whole of the consent. */
  readonly confirm: boolean;
}

export interface TickReport {
  readonly at: string;
  readonly considered: number;
  readonly runs: readonly (AutoExtendRun & { readonly workloadId: string })[];
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

export interface AutoExtendStore {
  list(pubkey: string): readonly AutoExtendPolicy[];
  get(pubkey: string, workloadId: string): AutoExtendPolicy | undefined;
  save(pubkey: string, policy: AutoExtendPolicy): void;
  remove(pubkey: string, workloadId: string): void;
}

interface PolicyFile {
  readonly v: 1;
  readonly pubkey: string;
  readonly policies: Record<string, AutoExtendPolicy>;
}

export class FileAutoExtendStore implements AutoExtendStore {
  readonly #paths: ConsolePaths;

  constructor(paths: ConsolePaths) {
    this.#paths = paths;
  }

  list(pubkey: string): readonly AutoExtendPolicy[] {
    return Object.values(this.#load(pubkey)?.policies ?? {});
  }

  get(pubkey: string, workloadId: string): AutoExtendPolicy | undefined {
    return this.#load(pubkey)?.policies[workloadId];
  }

  save(pubkey: string, policy: AutoExtendPolicy): void {
    const file = this.#load(pubkey) ?? { v: 1 as const, pubkey, policies: {} };
    this.#save({
      ...file,
      policies: { ...file.policies, [policy.workloadId]: policy },
    });
  }

  remove(pubkey: string, workloadId: string): void {
    const file = this.#load(pubkey);
    if (file === undefined) return;
    const policies = Object.fromEntries(
      Object.entries(file.policies).filter(([id]) => id !== workloadId)
    );
    this.#save({ ...file, policies });
  }

  #load(pubkey: string): PolicyFile | undefined {
    const path = accountAutoExtendPath(this.#paths, pubkey);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
    const file = parsed as Partial<PolicyFile>;
    if (file.v !== 1 || file.pubkey !== pubkey || typeof file.policies !== 'object') {
      return undefined;
    }
    const policies: Record<string, AutoExtendPolicy> = {};
    for (const [id, policy] of Object.entries(file.policies ?? {})) {
      // A file on disk is something anything running as this user can write,
      // and what is in this one decides how much money leaves a channel. Every
      // field that bounds the spending is checked before it is believed; a
      // policy that fails is dropped, which fails CLOSED — the lease simply
      // stops extending itself.
      if (!isPolicy(policy) || policy.workloadId !== id) continue;
      policies[id] = policy;
    }
    return { v: 1, pubkey, policies };
  }

  #save(file: PolicyFile): void {
    const path = accountAutoExtendPath(this.#paths, file.pubkey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

export class InMemoryAutoExtendStore implements AutoExtendStore {
  readonly #held = new Map<string, AutoExtendPolicy>();

  list(pubkey: string): readonly AutoExtendPolicy[] {
    return [...this.#held.entries()]
      .filter(([key]) => key.startsWith(`${pubkey}/`))
      .map(([, policy]) => policy);
  }

  get(pubkey: string, workloadId: string): AutoExtendPolicy | undefined {
    return this.#held.get(`${pubkey}/${workloadId}`);
  }

  save(pubkey: string, policy: AutoExtendPolicy): void {
    this.#held.set(`${pubkey}/${policy.workloadId}`, policy);
  }

  remove(pubkey: string, workloadId: string): void {
    this.#held.delete(`${pubkey}/${workloadId}`);
  }
}

function isPolicy(value: unknown): value is AutoExtendPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const policy = value as Partial<AutoExtendPolicy>;
  return (
    typeof policy.workloadId === 'string' &&
    typeof policy.profileId === 'string' &&
    typeof policy.armed === 'boolean' &&
    isAmount(policy.budget) &&
    isAmount(policy.spent) &&
    isAmount(policy.agreedPrice) &&
    typeof policy.leadSeconds === 'number' &&
    Number.isFinite(policy.leadSeconds) &&
    policy.leadSeconds >= 0 &&
    typeof policy.extensions === 'number' &&
    typeof policy.armedAt === 'string'
  );
}

function isAmount(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/u.test(value);
}

/* -------------------------------------------------------------------------- */
/* The extender                                                               */
/* -------------------------------------------------------------------------- */

/** The half of `WorkloadStore` a budget needs. Narrow, so it is testable. */
export interface WorkloadOps {
  card(workloadId: string, options?: { refresh?: boolean }): Promise<WorkloadCard>;
  extend(
    workloadId: string,
    options?: { maxPrice?: string | undefined; member?: string | undefined }
  ): Promise<ExtendResult>;
}

export interface AutoExtenderDeps {
  readonly store: AutoExtendStore;
  readonly workloads: WorkloadOps;
  /** The signed-in account, or `undefined`. A signed-out console spends nothing. */
  readonly pubkey: () => string | undefined;
  readonly profileId: () => string;
  readonly now?: (() => Date) | undefined;
}

/** The longest an extension is bought before it is needed, whatever is asked. */
export const MAX_LEAD_SECONDS = 86_400;

export class AutoExtender implements AutoExtendReader {
  readonly #deps: AutoExtenderDeps;
  #running = false;

  constructor(deps: AutoExtenderDeps) {
    this.#deps = deps;
  }

  view(pubkey: string, workloadId: string): AutoExtendView | undefined {
    const policy = this.#deps.store.get(pubkey, workloadId);
    return policy === undefined ? undefined : viewOf(policy);
  }

  policies(): readonly AutoExtendPolicy[] {
    const pubkey = this.#deps.pubkey();
    return pubkey === undefined ? [] : this.#deps.store.list(pubkey);
  }

  /**
   * Arm a budget for one lease.
   *
   * It refuses more often than it accepts, and every refusal is one of rule 2:
   * no consent, no money, or a price the account has not actually seen. The
   * last of those is the interesting one — the request names the price it is
   * agreeing to, and this checks that figure against what the connector quotes
   * right now. A window showing a stale price therefore cannot arm a budget at
   * a price that has since moved.
   */
  async arm(request: ArmRequest): Promise<AutoExtendPolicy> {
    const pubkey = this.#require();
    if (request.confirm !== true) {
      throw new WorkloadError(
        'not_confirmed',
        'Automatic extension spends money with nobody present, so arming it takes an explicit ' +
          '`confirm: true`. Nothing was armed.',
        400
      );
    }
    if (!isAmount(request.budget) || BigInt(request.budget) <= 0n) {
      throw new WorkloadError(
        'invalid_budget',
        'A budget is a whole number of base units above zero, as a string — the same units the ' +
          'connector quotes this lease’s extension in, because that is what leaves the channel. ' +
          'Nothing was armed.',
        400
      );
    }
    if (!isAmount(request.agreedPrice)) {
      throw new WorkloadError(
        'invalid_price',
        'An arming request names the price per interval it is agreeing to, as base units. It ' +
          'is checked against the connector’s current quote, so a budget can never be armed ' +
          'against a figure nobody was shown.',
        400
      );
    }

    const card = await this.#deps.workloads.card(request.workloadId, { refresh: false });
    // The price agreed to is the SET's: one round of extensions for every
    // member that is still a lease — the primary at its listing's price and
    // each Warm Standby at its `standby_price` (§5, §7). A budget armed
    // against the primary's figure alone would quietly let the reservations
    // lapse, which is a Standby Set that has stopped protecting anything. For
    // a standalone lease the two figures are the same number.
    const quoted = card.set.pricePerInterval;
    if (quoted === undefined) {
      throw new WorkloadError(
        'no_price',
        `No connector this console can reach prices every member of this workload’s ` +
          `extension routes right now, so there is no figure to agree to and nothing to hold ` +
          `a budget against. ${card.set.reason ?? ''} Nothing was armed.`.trim(),
        409
      );
    }
    if (compareAmounts(quoted, request.agreedPrice) !== 0) {
      throw new WorkloadError(
        'price_moved',
        `One round of extensions for this workload’s ${card.set.members} member(s) costs ` +
          `${quoted} base units, not the ${request.agreedPrice} this request agreed to. Read ` +
          `the price again and arm against what it actually is. Nothing was armed.`,
        409
      );
    }
    if (compareAmounts(request.budget, quoted) < 0) {
      throw new WorkloadError(
        'budget_below_price',
        `A budget of ${request.budget} base units buys no whole round at ${quoted}, and ` +
          `§6.3 sells whole intervals only (ADR 0003). This budget would stop before it ` +
          `extended anything, so nothing was armed.`,
        400
      );
    }

    const lead = leadFor(request.leadSeconds, card.lease.listing.lease_interval_s);
    const held = this.#deps.store.get(pubkey, request.workloadId);
    const policy: AutoExtendPolicy = {
      workloadId: request.workloadId,
      profileId: this.#deps.profileId(),
      armed: true,
      budget: request.budget,
      // Re-arming keeps what has already been spent, so raising a budget that
      // stopped does not silently grant the whole of it again.
      spent: held?.spent ?? '0',
      extensions: held?.extensions ?? 0,
      agreedPrice: request.agreedPrice,
      leadSeconds: lead,
      armedAt: this.#at().toISOString(),
    };
    this.#deps.store.save(pubkey, policy);
    return policy;
  }

  /** Turn it off. What was spent stays recorded until the policy is removed. */
  disarm(workloadId: string): AutoExtendPolicy | undefined {
    const pubkey = this.#require();
    const held = this.#deps.store.get(pubkey, workloadId);
    if (held === undefined) return undefined;
    const policy: AutoExtendPolicy = {
      ...held,
      armed: false,
      stoppedBecause: 'It was turned off by hand.',
      lastRun: {
        at: this.#at().toISOString(),
        outcome: 'stopped',
        reason: 'It was turned off by hand.',
      },
    };
    this.#deps.store.save(pubkey, policy);
    return policy;
  }

  /** Forget it entirely, spending record and all. */
  forget(workloadId: string): void {
    this.#deps.store.remove(this.#require(), workloadId);
  }

  /**
   * One pass over every armed budget.
   *
   * Re-entrant only in the sense that it refuses to be: a tick that overlaps
   * the previous one could buy two intervals for the same lease, so the second
   * returns having done nothing.
   */
  async tick(): Promise<TickReport> {
    const at = this.#at().toISOString();
    const pubkey = this.#deps.pubkey();
    if (pubkey === undefined || this.#running) return { at, considered: 0, runs: [] };
    this.#running = true;
    try {
      const armed = this.#deps.store
        .list(pubkey)
        .filter((policy) => policy.armed && policy.stoppedBecause === undefined);
      const runs: (AutoExtendRun & { workloadId: string })[] = [];
      for (const policy of armed) {
        const run = await this.#run(pubkey, policy);
        runs.push({ ...run, workloadId: policy.workloadId });
      }
      return { at, considered: armed.length, runs };
    } finally {
      this.#running = false;
    }
  }

  /* ------------------------------------------------------------------------ */

  async #run(pubkey: string, policy: AutoExtendPolicy): Promise<AutoExtendRun> {
    const waited = (reason: string) => this.#record(pubkey, policy, 'waited', reason);
    const stopped = (reason: string, cost?: string) =>
      this.#record(pubkey, policy, 'stopped', reason, cost);

    if (policy.profileId !== this.#deps.profileId()) {
      return waited(
        `This budget was armed on ${policy.profileId} and the console is on ` +
          `${this.#deps.profileId()}. Nothing is spent on a network this lease is not on.`
      );
    }

    let card: WorkloadCard;
    try {
      card = await this.#deps.workloads.card(policy.workloadId, { refresh: true });
    } catch (error) {
      return waited(
        `This lease could not be looked up: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // A Standby Set is kept alive member by member, and the members do not
    // agree: after a Takeover the winner is a running lease paid at `price` on
    // `.extend` and the stood-down primary is a stopped one, while a standby
    // that lost is still a reservation paid at `standby_price` on
    // `.standby.extend` (§6.3, §7.1). So every rule below is applied to the
    // SET, and a member that cannot be extended right now does not stop the
    // others being kept alive — a lapsed reservation is a Warm Standby that is
    // not there when the primary goes silent.
    const live = card.members.filter(
      (member) => !(member.status.kind === 'read' && member.status.life.phase === 'ended')
    );
    if (live.length === 0) {
      return stopped(
        `Every member of this workload has ended, so there is nothing left to extend. What ` +
          `was spent stays recorded; the budget is off.`
      );
    }

    // Rule 4. A price that moved is a different offer — checked over the whole
    // set, because that is the figure the account agreed to.
    const setPrice = card.set.pricePerInterval;
    if (setPrice === undefined) {
      return waited(
        `Not every member of this workload has a price this time. ${card.set.reason ?? ''}`.trim()
      );
    }
    if (compareAmounts(setPrice, policy.agreedPrice) > 0) {
      return stopped(
        `One round of extensions for this workload now costs ${setPrice} base units, above ` +
          `the ${policy.agreedPrice} this budget agreed to. A price change is a new Listing ` +
          `version (ADR 0009), so this is a different offer from the one that was agreed to ` +
          `and nothing was bought.`
      );
    }

    const now = this.#seconds();
    const due: { member: (typeof live)[number]; price: string }[] = [];
    const waiting: string[] = [];
    for (const member of live) {
      const who = `${member.pubkey.slice(0, 12)}… (${member.role})`;
      // Rule 5. Silence is not a reason to buy anything.
      if (member.status.kind !== 'read') {
        waiting.push(
          member.status.kind === 'silent'
            ? `${who} is not answering, and nothing is bought on silence: an extension into it ` +
                `would be an interval on a lease that may have ended, refused \`expired\` and ` +
                `billed.`
            : member.status.kind === 'refused'
              ? `${who} answered \`${member.status.code}\` when asked about this lease.`
              : `${who}'s state could not be read. ${member.status.reason}`
        );
        continue;
      }
      if (!member.extend.ok) {
        waiting.push(
          `${who}: ${member.extend.problems[0] ?? 'nothing can be sent to it right now.'}`
        );
        continue;
      }
      const expiresAt = member.status.expiresAt;
      if (expiresAt === undefined) {
        waiting.push(
          `${who} did not say when its lease expires, so there is no way to tell whether an ` +
            `extension is due.`
        );
        continue;
      }
      const remaining = expiresAt - now;
      if (remaining > policy.leadSeconds) {
        waiting.push(
          `Not due yet: ${who} is paid for another ${remaining} s and this budget buys inside ` +
            `the last ${policy.leadSeconds} s. ADR 0003 refunds nothing, so an interval bought ` +
            `early is one that cannot be handed back.`
        );
        continue;
      }
      const price = member.extend.route?.price;
      if (price === undefined) {
        waiting.push(`${who} was quoted no price for \`.${member.extend.op}\` this time.`);
        continue;
      }
      due.push({ member, price });
    }

    if (due.length === 0) {
      return waited(waiting.join(' ') || 'Nothing in this workload is due an extension yet.');
    }

    // Rule 3. The acceptance criterion: it stops when the budget is spent, and
    // it never buys PART of a round — a round that keeps the primary and drops
    // a reservation is a set that has stopped being one.
    let round = 0n;
    for (const entry of due) round += BigInt(entry.price);
    const left = BigInt(policy.budget) - BigInt(policy.spent);
    if (round > left) {
      return stopped(
        `The budget is spent: ${policy.spent} of ${policy.budget} base units has gone on ` +
          `${policy.extensions} extension(s), and the next round — ${due.length} member(s) of ` +
          `this workload — costs ${round.toString()}. Nothing further will be bought for this ` +
          `workload until a new budget is set.`
      );
    }

    const bought: string[] = [];
    let spent = 0n;
    let bookedAll = true;
    for (const entry of due) {
      let result: ExtendResult;
      try {
        result = await this.#deps.workloads.extend(policy.workloadId, {
          maxPrice: entry.price,
          member: entry.member.pubkey,
        });
      } catch (error) {
        bookedAll = false;
        waiting.push(
          `${entry.member.pubkey.slice(0, 12)}…'s extension was not sent: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      if (!result.sent) {
        bookedAll = false;
        waiting.push(
          `${entry.member.pubkey.slice(0, 12)}…: nothing was sent and nothing was paid. ` +
            `${result.problems.join(' ')}`.trim()
        );
        continue;
      }
      // Rule 6. A refusal that was billed is not something to retry on a timer.
      if (result.providerError !== undefined) {
        return stopped(
          `${entry.member.pubkey.slice(0, 12)}… refused this extension ` +
            `(\`${result.providerError}\`), and a refusal on a paid route is billed ` +
            `(ADR 0003). This budget is off rather than spending itself learning the same ` +
            `thing every minute. ${result.message ?? ''}`.trim(),
          totalOf([...bought.map(() => undefined), result.cost], spent)
        );
      }
      // Rule 7. A packet nobody reported on must not be followed by another.
      if (result.expiresAt === undefined) {
        return stopped(
          `${entry.member.pubkey.slice(0, 12)}…'s extension was sent and its fate is unknown, ` +
            `so whether an interval was bought cannot be said. This budget is off: a second ` +
            `attempt might buy a second interval nobody asked for. ${result.message ?? ''}`.trim(),
          totalOf([result.cost], spent)
        );
      }
      bought.push(entry.member.pubkey);
      if (result.cost !== undefined && /^\d+$/u.test(result.cost)) {
        spent += BigInt(result.cost);
      } else {
        spent += BigInt(entry.price);
      }
    }

    if (bought.length === 0) {
      return waited(waiting.join(' ') || 'Nothing was bought for this workload.');
    }
    return this.#record(
      pubkey,
      policy,
      'extended',
      `${bought.length} of this workload's ${card.set.members} member(s) extended for ` +
        `${spent.toString()} base units.` +
        (bookedAll && waiting.length === 0 ? '' : ` ${waiting.join(' ')}`),
      spent.toString(),
      bought
    );
  }

  /**
   * Write down what happened, and charge the budget for it.
   *
   * The cost is added on a `stopped` run too, because a refusal is billed
   * (ADR 0003): a budget that forgot what a refusal cost would be understating
   * what it had spent.
   */
  #record(
    pubkey: string,
    policy: AutoExtendPolicy,
    outcome: AutoExtendRun['outcome'],
    reason: string,
    cost?: string,
    members?: readonly string[]
  ): AutoExtendRun {
    const run: AutoExtendRun = {
      at: this.#at().toISOString(),
      outcome,
      reason,
      ...(cost === undefined ? {} : { cost }),
      ...(members === undefined ? {} : { members }),
    };
    const spent =
      cost === undefined || !isAmount(cost)
        ? policy.spent
        : (BigInt(policy.spent) + BigInt(cost)).toString();
    this.#deps.store.save(pubkey, {
      ...policy,
      spent,
      extensions: policy.extensions + (outcome === 'extended' ? (members?.length ?? 1) : 0),
      armed: outcome === 'stopped' ? false : policy.armed,
      ...(outcome === 'stopped' ? { stoppedBecause: reason } : {}),
      lastRun: run,
    });
    return run;
  }

  #require(): string {
    const pubkey = this.#deps.pubkey();
    if (pubkey === undefined) {
      throw new WorkloadError(
        'not_signed_in',
        'No account is signed in, so there is no account whose money a budget could spend.',
        409
      );
    }
    return pubkey;
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  #seconds(): number {
    return Math.floor(this.#at().getTime() / 1000);
  }
}

/**
 * How close to expiry an extension is bought.
 *
 * Bounded at both ends on purpose. Below a tick's worth of time a budget would
 * miss its own window; above one Lease Interval it would keep the lease paid
 * further ahead than the interval it is buying, and ADR 0003 refunds nothing.
 */
export function leadFor(asked: number | undefined, leaseIntervalSeconds: number): number {
  const ceiling = Math.min(
    MAX_LEAD_SECONDS,
    Math.max(60, Math.floor(leaseIntervalSeconds || MAX_LEAD_SECONDS))
  );
  const wanted =
    asked === undefined || !Number.isFinite(asked)
      ? Math.max(60, Math.floor(ceiling / 4))
      : Math.floor(asked);
  return Math.min(ceiling, Math.max(60, wanted));
}

/** What a part-finished round has cost so far, when every part reported one. */
function totalOf(costs: readonly (string | undefined)[], already: bigint): string | undefined {
  let sum = already;
  let seen = already > 0n;
  for (const cost of costs) {
    if (cost === undefined || !/^\d+$/u.test(cost)) continue;
    sum += BigInt(cost);
    seen = true;
  }
  return seen ? sum.toString() : undefined;
}

function viewOf(policy: AutoExtendPolicy): AutoExtendView {
  const remaining = BigInt(policy.budget) - BigInt(policy.spent);
  return {
    armed: policy.armed && policy.stoppedBecause === undefined,
    budget: policy.budget,
    spent: policy.spent,
    remaining: (remaining < 0n ? 0n : remaining).toString(),
    extensions: policy.extensions,
    agreedPrice: policy.agreedPrice,
    leadSeconds: policy.leadSeconds,
    armedAt: policy.armedAt,
    ...(policy.lastRun === undefined ? {} : { lastRun: policy.lastRun }),
    ...(policy.stoppedBecause === undefined ? {} : { stoppedBecause: policy.stoppedBecause }),
  };
}
