import { mintRequestId } from './continuation.js';
import { REQUEST_TTL_S, type PacketOutcome } from './lease.js';
import {
  LeaseVaultError,
  type LeaseMemberView,
  type LeaseVault,
  type LeaseView,
} from './lease-vault.js';
import type { RelayWriteTargets } from './relay-write.js';
import { HEX_32 } from './spawn-content.js';
import {
  readAnswer,
  type MemberOpPlan,
  type MemberOpPort,
  type OpRouteView,
} from './workload.js';

/**
 * **Rotation**: replacing a lease's Continuation Token at every member of its
 * Standby Set (TOON_Network#96, spec §6.8, ADR 0018, ADR 0021).
 *
 * Rotation is how an account cuts off a leaked token **without losing the
 * workload**. It is not a revocation list and not a re-key: the provider
 * stores exactly one token per lease, so naming another one in its place ends
 * the old token and every Gateway Grant derived from it at the same instant,
 * with nothing kept per gateway and no grace period (ADR 0018). The workload
 * keeps running; its role, state, `expires_at`, `access` and Standby Set are
 * untouched.
 *
 * Six facts shape this module, and each one is a thing a simpler loop would
 * get wrong.
 *
 * **A fresh Root Secret, not a fresh token.** §6.8 recommends minting a new
 * root and deriving each member's `next` from it, so that the rotation retires
 * the old ROOT as well — if that is what leaked, it derives nothing that works
 * afterwards. The provider cannot tell how `next` was made and does not check,
 * which is precisely why doing it properly is the tenant's job. `lease-vault.ts`
 * mints it; nothing here ever sees it.
 *
 * **The vault record is written BEFORE the first request, and holds both roots
 * until every member confirms** (ADR 0021). A crash between a member accepting
 * `next` and this console writing that down would otherwise lose the only
 * secret that now reads that member — the lease would be paid, running and
 * unreachable. So `beginRotation` is a paid relay write that must land before
 * anything is sent, exactly as a spawn's record is.
 *
 * **Member by member, and a member that cannot be reached does not block the
 * rest** (§6.8, §7). One request per member, naming only that member and
 * presenting only that member's token. A set rotated at some members and not
 * others breaks no invariant: the tokens were always per member, and the vault
 * reads each member with whichever root holds it. What is left is *resumable*,
 * and resuming is the same call again.
 *
 * **A lost answer is recovered by READING, not by retrying** (ADR 0018's
 * Consequences). Sending the same rotate again is `stale_request`, and a new
 * one presenting the old token after the first took effect is `not_tenant`. So
 * when the answer does not come back — or comes back `not_tenant`, which is
 * what an earlier run's lost answer looks like — this asks `status` presenting
 * `next`: acceptance means the rotation took effect, and `not_tenant` means it
 * did not and the old token still holds. Nothing is retried blindly.
 *
 * **`unavailable` is a refusal, not a success and not a lost answer**
 * (TOON_Network#78). The provider could not persist, so nothing changed and
 * the OLD token still works — in memory and on disk alike. It is reported as
 * retryable, and the retry is a fresh rotate presenting the same token and
 * naming the same `next`, not a `status` probe.
 *
 * **`rotate` is free at the provider, and a hop may charge** (§5). So the
 * packet is bought where it is free, which is `workload.ts`'s rule (#93) and
 * is borrowed rather than restated — and because a malformed paid request is
 * still billed (#115), everything checkable is checked before anything leaves:
 * the workload id's shape, that this account holds the Root Secret at all,
 * that the member is in the set, that `next` is not the token the member
 * already holds, and that some connector carries the route.
 *
 * What is NOT here: a grant. A Gateway Grant presented on `rotate` is refused
 * — step 4 does not branch on this route (§6.8, §6.5.1) — so only the lease's
 * own token rotates it and a gateway can never take a lease from its tenant.
 * This console could not send one if it tried: the request is built inside
 * `vault.withRotation`, which hands out the lease's own tokens and nothing
 * else.
 */

/* -------------------------------------------------------------------------- */
/* What a rotation would do                                                   */
/* -------------------------------------------------------------------------- */

/** One member of the set, as a rotation sees it. */
export interface RotationMemberView {
  readonly pubkey: string;
  readonly index: number;
  readonly role: LeaseMemberView['role'];
  /** True once this member holds a token of the new Root Secret. */
  readonly confirmed: boolean;
  /** False when nothing could be addressed to this member right now. */
  readonly ok: boolean;
  /** Why not, when it is not. A member that cannot be reached blocks nobody. */
  readonly problems: readonly string[];
  /** Where its `rotate` would go, who collects, and what they charge. */
  readonly route?: OpRouteView | undefined;
  /** Left out of the rotation: this member's own spawn was refused (§6.2). */
  readonly skipped?: boolean | undefined;
}

/**
 * A rotation's state, and what the next one would cost. Sends no packet of its
 * own beyond asking connectors what they carry, which is free.
 */
export interface RotationView {
  readonly workloadId: string;
  /** True when a rotation is part-way through: some members hold the new token. */
  readonly underWay: boolean;
  /** False when nothing could be rotated at all, and `problems` says why. */
  readonly ok: boolean;
  /** Wrong with the LEASE rather than with one member. */
  readonly problems: readonly string[];
  readonly members: readonly RotationMemberView[];
  /** How many members hold a token of the new root, out of how many. */
  readonly confirmed: number;
  readonly of: number;
  readonly startedAt?: string | undefined;
  /** When the last rotation finished. */
  readonly rotatedAt?: string | undefined;
  /** Where the vault record would be written, what it costs, what stops it. */
  readonly vault: RelayWriteTargets;
  /** A local-only lease writes no relay record, and this rotation costs nothing. */
  readonly localOnly: boolean;
}

/* -------------------------------------------------------------------------- */
/* What a rotation did                                                        */
/* -------------------------------------------------------------------------- */

export interface RotationMemberResult {
  readonly pubkey: string;
  readonly index: number;
  readonly role: LeaseMemberView['role'];
  /** False when nothing left this console for this member, and nothing was paid. */
  readonly sent: boolean;
  /** True when this member now holds a token of the new Root Secret. */
  readonly rotated: boolean;
  /**
   * The rotate's answer was lost or `not_tenant`, and a `status` presenting
   * `next` was accepted — so the rotation had taken effect after all (§6.8).
   */
  readonly recovered?: boolean | undefined;
  /** This member had already confirmed before this run: nothing was sent. */
  readonly already?: boolean | undefined;
  /**
   * Worth asking again, with nothing changed: the provider could not persist
   * (`unavailable`), or nobody answered. Never set on a refusal that says the
   * request itself was wrong.
   */
  readonly retryable?: boolean | undefined;
  readonly route?: OpRouteView | undefined;
  /** What this member's packets cost, base units. A refusal is billed too (§5). */
  readonly cost?: string | undefined;
  readonly providerError?: string | undefined;
  readonly message?: string | undefined;
  readonly problems?: readonly string[] | undefined;
}

export interface RotationResult {
  readonly workloadId: string;
  /**
   * False when the vault record could not be written, so **nothing was sent**
   * and the lease still holds only its old Root Secret.
   */
  readonly started: boolean;
  /** True only when EVERY member confirmed, which is when the old root is dropped. */
  readonly rotated: boolean;
  readonly problems: readonly string[];
  readonly members: readonly RotationMemberResult[];
  readonly confirmed: number;
  readonly of: number;
  /** What the packets to the providers cost, base units. */
  readonly cost?: string | undefined;
  /** What the vault writes cost, base units (TOON_Network#120). */
  readonly vaultCost?: string | undefined;
  /** Set when a confirmation could not be published, with what that means. */
  readonly vaultBehind?: string | undefined;
  readonly view: RotationView;
}

export class RotationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RotationError';
    this.code = code;
    this.status = status;
  }
}

export interface RotationStoreDeps {
  readonly vault: LeaseVault;
  /** The planning and sending `workload.ts` already owns (#93, #98). */
  readonly ops: MemberOpPort;
  readonly now?: (() => Date) | undefined;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export class RotationStore {
  readonly #deps: RotationStoreDeps;

  constructor(deps: RotationStoreDeps) {
    this.#deps = deps;
  }

  /**
   * What a rotation would do, and how far the last one got. Spends nothing.
   *
   * It asks each member's connectors what they carry — free, and no lease
   * packet — so that the price of a rotation a hop would charge for is on
   * screen before anybody presses anything (§5, TOON_Network#115).
   */
  async view(workloadId: string): Promise<RotationView> {
    const lease = this.#lease(workloadId);
    const problems: string[] = [];
    const planned = await this.#planSet(lease, problems);
    return this.#viewOf(lease, planned, problems);
  }

  /**
   * Rotate this lease's Continuation Token across its whole Standby Set —
   * starting a rotation, or finishing the one the vault record carries.
   *
   * The order is ADR 0021's and it is not negotiable: mint, record, then ask.
   * The record holds both Root Secrets until the last member confirms, and
   * only then is the old one dropped.
   *
   * @throws {RotationError} when this account holds no such lease.
   */
  async rotate(workloadId: string): Promise<RotationResult> {
    const lease = this.#lease(workloadId);
    const problems: string[] = [];
    // Planned BEFORE anything is written or sent: a rotation that could reach
    // nobody should not buy a relay write to say it started.
    const planned = await this.#planSet(lease, problems);
    const reachable = [...planned.values()].filter((entry) => entry.plan !== undefined);
    if (reachable.length === 0) {
      problems.push(
        `No member of this workload's Standby Set can be reached right now, so nothing was ` +
          `sent and no Root Secret was minted. A rotation that reached nobody would still ` +
          `have cost a relay write to record (ADR 0021).`
      );
      return this.#stopped(lease, planned, problems);
    }

    // The members the rotation is FOR. A member whose own spawn was
    // definitively refused holds no lease and never held a token, so nothing
    // derived from the old root works there and waiting for it to confirm
    // would keep the old root alive for ever (§6.2, ADR 0003).
    const members = lease.members
      .filter((member) => member.state !== 'failed')
      .map((member) => member.pubkey);
    if (members.length === 0) {
      problems.push(
        `Every member of this workload's Standby Set was refused its spawn, so this account ` +
          `holds no lease to rotate. The Root Secret was never presented anywhere.`
      );
      return this.#stopped(lease, planned, problems);
    }

    let vaultCost: string | undefined;
    try {
      const begun = await this.#paid(() =>
        this.#deps.vault.beginRotation(lease.workloadId, { members })
      );
      vaultCost = add(vaultCost, begun.cost);
    } catch (error) {
      problems.push(
        error instanceof LeaseVaultError
          ? `${error.message} NOTHING was sent: a rotation whose new Root Secret is not ` +
              `recorded first could leave a member holding a token this account cannot derive ` +
              `(ADR 0021, spec §6.8).`
          : `This rotation's new Root Secret could not be recorded, so nothing was sent: ` +
              `${messageOf(error)}`
      );
      return this.#stopped(lease, planned, problems, vaultCost);
    }

    // Re-read: `beginRotation` published a record, and which members it names
    // as confirmed is what decides who is asked below.
    const started = this.#lease(workloadId);
    const rotation = started.rotation;
    const outcomes: RotationMemberResult[] = [];
    let cost: string | undefined;
    let vaultBehind: string | undefined;

    for (const member of started.members) {
      if (rotation !== undefined && !rotation.members.includes(member.pubkey)) continue;
      if (rotation !== undefined && rotation.confirmed.includes(member.pubkey)) {
        outcomes.push({
          pubkey: member.pubkey,
          index: member.index,
          role: member.role,
          sent: false,
          rotated: true,
          already: true,
          message:
            `This member confirmed the new token in an earlier run, so nothing was sent to ` +
            `it. Rotating it again would present a token it no longer holds (\`not_tenant\`).`,
        });
        continue;
      }
      const entry = planned.get(member.pubkey);
      const outcome = await this.#rotateMember(started, member, entry);
      cost = add(cost, outcome.cost);
      outcomes.push(outcome);
      if (!outcome.rotated) continue;
      // Written down member by member, so a run that stops here resumes after
      // it rather than before it.
      const confirmed = await this.#paid(() =>
        this.#deps.vault.confirmRotation(started.workloadId, member.pubkey)
      );
      vaultCost = add(vaultCost, confirmed.cost);
      if (!confirmed.result.confirmed && vaultBehind === undefined) {
        vaultBehind =
          `${member.pubkey.slice(0, 12)}… holds the new token, but this account's relays ` +
          `could not be told: ${confirmed.result.reason ?? 'the write did not land'}. ` +
          `Nothing is lost — the record on the relays still carries BOTH root secrets — but ` +
          `a console signing in fresh would ask this member to rotate again, find it ` +
          `\`not_tenant\`, and settle it with a free \`status\` (spec §6.8).`;
      }
    }

    const after = this.#lease(workloadId);
    const done = after.rotation === undefined && after.rotatedAt !== undefined;
    return {
      workloadId,
      started: true,
      rotated: done || outcomes.every((outcome) => outcome.rotated),
      problems,
      members: outcomes,
      confirmed: outcomes.filter((outcome) => outcome.rotated).length,
      of: outcomes.length,
      ...(cost === undefined ? {} : { cost }),
      ...(vaultCost === undefined ? {} : { vaultCost }),
      ...(vaultBehind === undefined ? {} : { vaultBehind }),
      view: await this.#viewOf(after, planned, []),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* One member                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Rotate one member, and find out whether it took.
   *
   * The three answers that are NOT "rotated" are told apart here, because they
   * mean three different things to a person:
   *
   * - **`unavailable`**: the provider could not persist. Nothing changed, the
   *   old token still works, and the same request should be sent again
   *   (§6.8, TOON_Network#78). It is retryable and it is **not** a success.
   * - **a lost answer, or `not_tenant`**: whether the rotation took effect is
   *   not known, and asking again cannot settle it — a replay is
   *   `stale_request` and the old token is now `not_tenant`. So `status` is
   *   asked presenting `next`, and its acceptance is the answer (ADR 0018).
   * - **any other refusal** (`expired`, `unknown_workload`, `invalid_request`,
   *   `stale_request`): the request or the lease is wrong in a way that asking
   *   again will not change.
   */
  async #rotateMember(
    lease: LeaseView,
    member: LeaseMemberView,
    entry: { plan?: MemberOpPlan | undefined; problems: readonly string[] } | undefined
  ): Promise<RotationMemberResult> {
    const who = { pubkey: member.pubkey, index: member.index, role: member.role };
    const plan = entry?.plan;
    if (plan === undefined) {
      return {
        ...who,
        sent: false,
        rotated: false,
        retryable: true,
        problems: entry?.problems ?? ['Nothing could be addressed to this member.'],
        message:
          `Nothing was sent to this member, and the rest of the set was rotated anyway: a ` +
          `member that cannot be reached does not block the others (spec §6.8). Run the ` +
          `rotation again when it answers, and it will be finished from where it stopped.`,
      };
    }

    let body: unknown;
    try {
      body = await this.#rotateBody(lease, member);
    } catch (error) {
      return {
        ...who,
        sent: false,
        rotated: false,
        route: this.#deps.ops.view(plan),
        message:
          error instanceof LeaseVaultError
            ? error.message
            : `This member's rotate request could not be built, so nothing was sent: ` +
              `${messageOf(error)}`,
      };
    }
    if (body === SAME_TOKEN) {
      return {
        ...who,
        sent: false,
        rotated: true,
        already: true,
        message:
          `This member already holds a token of the new Root Secret, so nothing was sent. ` +
          `§6.8 refuses a rotate whose \`next\` is the token the lease already holds, as ` +
          `\`invalid_request\` — a no-op must never look like a success.`,
      };
    }

    const route = this.#deps.ops.view(plan);
    const outcome = await this.#deps.ops.send(plan, body);
    const cost = costOf(outcome);
    const read = readAnswer(outcome);

    if (outcome.kind === 'answered' && read.error === undefined) {
      if (rotatedTrue(outcome) && read.workloadId === lease.workloadId) {
        return {
          ...who,
          sent: true,
          rotated: true,
          route,
          ...(cost === undefined ? {} : { cost }),
          message:
            `Rotated. From this moment the old token is \`not_tenant\` at this provider, and ` +
            `every Gateway Grant derived from it is \`bad_grant\` — there is no grace period ` +
            `and nothing is kept per gateway (spec §6.8, ADR 0018).`,
        };
      }
      // Not the answer §6.8 gives. Whatever it was, `status` settles which
      // token holds this lease now.
    } else if (read.error === 'unavailable') {
      return {
        ...who,
        sent: true,
        rotated: false,
        retryable: true,
        route,
        ...(cost === undefined ? {} : { cost }),
        providerError: 'unavailable',
        message:
          `${read.message ?? 'The provider could not persist this rotation.'} NOTHING ` +
          `changed: the old token still works, in memory and on disk alike, and this is a ` +
          `refusal rather than a lost answer — so the answer is to rotate again with the ` +
          `same \`next\`, not to ask \`status\` (spec §6.8, TOON_Network#78).`,
      };
    } else if (outcome.kind === 'answered' && read.error !== 'not_tenant') {
      return {
        ...who,
        sent: true,
        rotated: false,
        route,
        ...(cost === undefined ? {} : { cost }),
        ...(read.error === undefined ? {} : { providerError: read.error }),
        message: refusalWords(read.error, read.message),
      };
    }

    // A lost answer, a packet nobody routed, or `not_tenant` — which is what
    // an earlier run's lost answer looks like. Read, do not retry (ADR 0018).
    const probe = await this.#probe(lease, member);
    const total = add(cost, probe.cost);
    if (probe.holds) {
      return {
        ...who,
        sent: true,
        rotated: true,
        recovered: true,
        route,
        ...(total === undefined ? {} : { cost: total }),
        message:
          `The rotate's answer did not come back (${saidBy(outcome, read)}), and a \`status\` ` +
          `presenting the new token was accepted — so the rotation HAD taken effect. A rotate ` +
          `is never retried to find that out: the same request again is \`stale_request\`, ` +
          `and a new one presenting the old token is \`not_tenant\` (spec §6.8, ADR 0018).`,
      };
    }
    return {
      ...who,
      sent: true,
      rotated: false,
      retryable: true,
      route,
      ...(total === undefined ? {} : { cost: total }),
      ...(read.error === undefined ? {} : { providerError: read.error }),
      message:
        `The rotate said ${saidBy(outcome, read)}, and a \`status\` presenting the new token ` +
        `said ${probe.said} — ` +
        (probe.notTenant
          ? `so the rotation did NOT take effect and the old token still holds this lease. ` +
            `Run the rotation again: this account still holds both root secrets.`
          : `so which token holds this lease is not known yet. Nothing was lost — both root ` +
            `secrets are in this account's vault record — and running the rotation again ` +
            `settles it.`),
    };
  }

  /**
   * §6.8's rotate request, built inside the vault (spec §6.1).
   *
   * Both tokens are derived inside `withRotation` and neither survives it. The
   * content is exactly `{ workload_id, next }` — a field this spec does not
   * name is `invalid_request`, and on a route a hop charges for that refusal
   * is billed (ADR 0004, TOON_Network#115).
   */
  async #rotateBody(lease: LeaseView, member: LeaseMemberView): Promise<unknown> {
    return this.#deps.vault.withRotation<unknown>(
      lease.workloadId,
      member.pubkey,
      (tokens) => {
        // §6.8 step 6: `next` may not be the token the lease already holds — a
        // no-op must never look like a success. Caught here rather than paid for.
        if (tokens.next === tokens.current) return Promise.resolve(SAME_TOKEN);
        return Promise.resolve({
          request: {
            request_id: mintRequestId(),
            op: 'rotate',
            provider: member.pubkey,
            expiration: this.#seconds() + REQUEST_TTL_S,
            continuation: tokens.current,
            content: { workload_id: lease.workloadId, next: tokens.next },
          },
        });
      }
    );
  }

  /**
   * "Does the new token hold this lease?" — §6.8's recovery, in one free read.
   *
   * It goes to the same member, on that member's own `status` route, planned
   * the same way the rotate was: a Hidden Provider's probe rides the circuit
   * its rotate rode, because both are planned by `workload.ts` from the same
   * record.
   */
  async #probe(
    lease: LeaseView,
    member: LeaseMemberView
  ): Promise<{ holds: boolean; notTenant: boolean; said: string; cost?: string | undefined }> {
    const problems: string[] = [];
    const plan = await this.#deps.ops.plan(lease, member, 'status', problems);
    if (plan === undefined) {
      return {
        holds: false,
        notTenant: false,
        said: `nothing — it could not be asked (${problems.join(' ')})`,
      };
    }
    let body: unknown;
    try {
      body = await this.#deps.vault.withRotation(lease.workloadId, member.pubkey, (tokens) =>
        Promise.resolve({
          request: {
            request_id: mintRequestId(),
            op: 'status',
            provider: member.pubkey,
            expiration: this.#seconds() + REQUEST_TTL_S,
            // The NEW token. Acceptance is the whole answer (ADR 0018).
            continuation: tokens.next,
            content: { workload_id: lease.workloadId },
          },
        })
      );
    } catch (error) {
      return { holds: false, notTenant: false, said: `nothing: ${messageOf(error)}` };
    }
    const outcome = await this.#deps.ops.send(plan, body);
    const cost = costOf(outcome);
    const read = readAnswer(outcome);
    if (outcome.kind === 'answered' && read.error === undefined) {
      return {
        holds: read.workloadId === lease.workloadId,
        notTenant: false,
        said:
          read.workloadId === lease.workloadId
            ? 'this lease'
            : 'an answer about another workload',
        ...(cost === undefined ? {} : { cost }),
      };
    }
    return {
      holds: false,
      notTenant: read.error === 'not_tenant',
      said: saidBy(outcome, read),
      ...(cost === undefined ? {} : { cost }),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Planning the set                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * Where each member's `rotate` would go — asked once, and reused for the
   * packet that follows, so the price shown is the price paid.
   */
  async #planSet(
    lease: LeaseView,
    problems: string[]
  ): Promise<Map<string, { plan?: MemberOpPlan | undefined; problems: readonly string[] }>> {
    const planned = new Map<
      string,
      { plan?: MemberOpPlan | undefined; problems: readonly string[] }
    >();
    if (!HEX_32.test(lease.workloadId)) {
      problems.push(
        `${JSON.stringify(lease.workloadId.slice(0, 24))} is not a workload id: 32 bytes as ` +
          `64 lowercase hex characters (spec §6.1). Nothing was sent.`
      );
      return planned;
    }
    for (const member of lease.members) {
      if (member.state === 'failed') {
        planned.set(member.pubkey, {
          problems: [
            `This member's own spawn was refused, so it holds no lease and never held a ` +
              `token of this Root Secret. It is left out of the rotation rather than kept ` +
              `waiting for a confirmation that can never come.`,
          ],
        });
        continue;
      }
      const memberProblems: string[] = [];
      const plan = await this.#deps.ops.plan(lease, member, 'rotate', memberProblems);
      planned.set(member.pubkey, {
        ...(plan === undefined ? {} : { plan }),
        problems: memberProblems,
      });
    }
    return planned;
  }

  async #viewOf(
    lease: LeaseView,
    planned: ReadonlyMap<
      string,
      { plan?: MemberOpPlan | undefined; problems: readonly string[] }
    >,
    problems: readonly string[]
  ): Promise<RotationView> {
    const rotation = lease.rotation;
    const members: RotationMemberView[] = lease.members.map((member) => {
      const entry = planned.get(member.pubkey);
      const skipped = member.state === 'failed';
      return {
        pubkey: member.pubkey,
        index: member.index,
        role: member.role,
        confirmed: rotation?.confirmed.includes(member.pubkey) ?? false,
        ok: entry?.plan !== undefined,
        problems: entry?.problems ?? [],
        ...(entry?.plan === undefined ? {} : { route: this.#deps.ops.view(entry.plan) }),
        ...(skipped ? { skipped: true } : {}),
      };
    });
    const counted = members.filter((member) => member.skipped !== true);
    return {
      workloadId: lease.workloadId,
      underWay: rotation !== undefined,
      ok: members.some((member) => member.ok),
      problems,
      members,
      confirmed: counted.filter((member) => member.confirmed).length,
      of: counted.length,
      ...(rotation === undefined ? {} : { startedAt: rotation.startedAt }),
      ...(lease.rotatedAt === undefined ? {} : { rotatedAt: lease.rotatedAt }),
      vault: await this.#deps.vault.targets(),
      localOnly: lease.localOnly,
    };
  }

  /** A rotation that never started: nothing sent, nothing rotated. */
  async #stopped(
    lease: LeaseView,
    planned: ReadonlyMap<
      string,
      { plan?: MemberOpPlan | undefined; problems: readonly string[] }
    >,
    problems: readonly string[],
    vaultCost?: string | undefined
  ): Promise<RotationResult> {
    const view = await this.#viewOf(lease, planned, problems);
    return {
      workloadId: lease.workloadId,
      started: false,
      rotated: false,
      problems,
      members: [],
      confirmed: view.confirmed,
      of: view.of,
      ...(vaultCost === undefined ? {} : { vaultCost }),
      view,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Plumbing                                                                 */
  /* ------------------------------------------------------------------------ */

  /** One vault write, and what it cost (TOON_Network#120). */
  async #paid<T>(run: () => Promise<T>): Promise<{ result: T; cost?: string | undefined }> {
    const before = this.#deps.vault.status().lastPublish;
    const result = await run();
    const after = this.#deps.vault.status().lastPublish;
    const cost = after !== undefined && after !== before ? after.cost : undefined;
    return { result, ...(cost === undefined ? {} : { cost }) };
  }

  #lease(workloadId: string): LeaseView {
    const lease = this.#deps.vault.find(workloadId);
    if (lease === undefined) {
      throw new RotationError(
        'unknown_lease',
        `This account holds no vault record for workload ${workloadId}, so it holds no Root ` +
          `Secret for it and can rotate nothing. Read the vault from this account's relays ` +
          `first (spec §6.1.1, ADR 0021).`,
        404
      );
    }
    return lease;
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  #seconds(): number {
    return Math.floor(this.#at().getTime() / 1000);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading answers                                                            */
/* -------------------------------------------------------------------------- */

/** The sentinel for "this member already holds `next`", so nothing is sent. */
const SAME_TOKEN = Symbol('already rotated');

/** §6.8's answer: `{ workload_id, rotated: true }`, and no token in it. */
function rotatedTrue(outcome: PacketOutcome): boolean {
  if (
    outcome.kind !== 'answered' ||
    typeof outcome.body !== 'object' ||
    outcome.body === null
  ) {
    return false;
  }
  return (outcome.body as Record<string, unknown>).rotated === true;
}

function costOf(outcome: PacketOutcome): string | undefined {
  return outcome.kind === 'unknown' ? undefined : outcome.cost;
}

/** What an answer said, in a line that carries no token. */
function saidBy(outcome: PacketOutcome, read: ReturnType<typeof readAnswer>): string {
  if (outcome.kind === 'unknown') return `nothing (${outcome.message})`;
  if (outcome.kind === 'refused') {
    return `nothing — the packet was refused by the ${outcome.refusedBy} (${outcome.code}: ${outcome.message})`;
  }
  return read.error === undefined ? `HTTP ${outcome.status}` : `\`${read.error}\``;
}

/** §6.8's refusals, said as what they mean for the lease. */
function refusalWords(error: string | undefined, message: string | undefined): string {
  const said = message ?? '';
  switch (error) {
    case 'expired':
      return (
        `This member's lease has ended, so there is no token to rotate (spec §6.8 step 5). ` +
        `The tenant learns the lease is gone rather than that its token is wrong. ${said}`
      );
    case 'unknown_workload':
      return `This provider holds no lease under this workload id (spec §6.8 step 3). ${said}`;
    case 'invalid_request':
      return (
        `The provider refused the request's shape: \`invalid_request\`. A rotate's content is ` +
        `exactly \`{ workload_id, next }\` with \`next\` 64 lowercase hex, and \`next\` may ` +
        `not be the token the lease already holds (spec §6.8 steps 2 and 6). ${said}`
      );
    case 'stale_request':
      return (
        `The provider refused the request's window or its \`request_id\`: \`stale_request\`. ` +
        `A rotate is never re-sent to find out whether it worked — the same request again is ` +
        `exactly this refusal (spec §6.8). ${said}`
      );
    default:
      return `The provider refused this rotation${error === undefined ? '' : `: \`${error}\``}. ${said}`;
  }
}

/** Two decimal amounts, added. `undefined` when neither side reported one. */
function add(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  try {
    return (BigInt(left) + BigInt(right)).toString();
  } catch {
    return left;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
