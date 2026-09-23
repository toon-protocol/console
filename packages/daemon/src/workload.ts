import type { ChannelStore } from '@toon-protocol/client';

import { channelAvailable, channelStoreFor, findChannelBinding } from './channel-store.js';
import type { ChainSeedStore } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { mintRequestId } from './continuation.js';
import type { DirectoryResult, ProviderView } from './directory.js';
import { resolveRpc } from './funding.js';
import {
  isHiddenServiceUrl,
  REQUEST_TTL_S,
  routeCarries,
  type PacketOutcome,
  type ProviderPort,
} from './lease.js';
import {
  LeaseVaultError,
  type LeaseAccess,
  type LeaseMemberView,
  type LeaseVault,
  type LeaseView,
} from './lease-vault.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { HEX_32 } from './spawn-content.js';
import {
  routeOpFor,
  setRunway,
  type ExtendOp,
  type MemberPhase,
  type RunwayMember,
} from './standby-set.js';
import type { TakeoverReading } from './takeover.js';
import type { WorkloadMemberNote, WorkloadNote, WorkloadNoteStore } from './workload-cache.js';

/**
 * **The dashboard**: what a lease is doing, how long the money keeps it doing
 * it, and the three things a person can do about it (TOON_Network#93, spec
 * §6.3, §6.5, §6.6, §6.7).
 *
 * `lease.ts` buys a lease and stops caring. This is the module a person lives
 * in afterwards, and four facts shape every line of it.
 *
 * **`status` and `terminate` are free routes and `extend` is not (§5).** So
 * the card refreshes itself as often as it likes and an extension happens only
 * when somebody — or a budget somebody set — decides to spend. "Free" is the
 * PROVIDER's price, though, not the network's: a connector that merely
 * forwards charges its own fee to carry, which on this machine's sandbox hub
 * is 100 base units for the same `status` the provider itself prices at zero.
 * So a free route is bought where it is free — see `#plan` — and when no
 * zero-priced path exists the price is named rather than quietly paid.
 *
 * **A refused paid request is billed (ADR 0003, TOON_Network#115).** Every
 * check that can be made before a packet leaves is made here: that this
 * account holds the lease's Root Secret at all, that the provider is still a
 * member of its Standby Set, that the Listing still exists AT THE LEASE'S
 * VERSION (§6.3 refuses `wrong_listing_version`, after billing), that the
 * lease has not already ended (`expired`, after billing), and that the role is
 * one `.extend` serves (a Reserved standby is `not_running`, after billing).
 * `extend` is the one route here where getting it wrong costs an interval, and
 * it is the one that checks the most.
 *
 * **`extend` takes its content BARE.** `{ "workload_id": "…" }` and nothing
 * else — no Lease Request, no `request_id`, no Continuation Token, because any
 * payer may extend any lease (§6.3, ADR 0005). `status` and `terminate` take
 * the full §6.1 Lease Request and MUST present the lease's token. Wrapping the
 * extension like its neighbours is `invalid_request` at full price, which is
 * why the three bodies are built by three named functions rather than one
 * clever one.
 *
 * **Expiry, Termination and Eviction are three different endings** (§6.7,
 * CONTEXT.md). Nothing here flattens them into "gone": the provider's own word
 * is carried through to the card, and a word this build does not know is kept
 * verbatim beside `unstated` rather than guessed at.
 *
 * And the one that decides how this reads when things go wrong: **a provider
 * that has gone silent is not an error.** A packet whose fate nobody reported
 * is `silent`, a provider that answered a refusal is `refused`, and a console
 * that could not send at all is `unread`. They are three different things to
 * be told, and only the last one is this console's fault.
 */

/* -------------------------------------------------------------------------- */
/* What a lease is doing                                                      */
/* -------------------------------------------------------------------------- */

/** §6.7's endings. `unstated` is a refusal that said only "it has ended". */
export type LeaseEnding = 'expiry' | 'termination' | 'eviction' | 'unstated';

/**
 * §6.7's lease state, as the wire spells it: a string for a state with nothing
 * to say, and a one-key object for one that has an ending.
 */
export type LeaseLife =
  | { readonly phase: 'provisioning' | 'reserved' | 'running' | 'stopped' }
  | {
      readonly phase: 'ended';
      readonly ending: LeaseEnding;
      /** The provider's own word, when it is not one of §6.7's three. */
      readonly word?: string | undefined;
    };

export interface TakeoverView {
  /** The member of the Standby Set that runs the workload now (§7.1). */
  readonly winner: string;
}

/**
 * A Takeover, as the dashboard reports it (§7.1, ADR 0010).
 *
 * Two independent sources, and they answer different halves of the question.
 * A member's `status` says a Takeover settled and who won (§6.5), and says
 * nothing about when. The winner's own kind-30433 claim says when, signed, and
 * is free to read. So the report carries both and names which one each fact
 * came from, rather than presenting a guess as a timestamp.
 *
 * `firstSeenAt` is this console's own observation and is labelled as such: it
 * is what a person has when no claim could be read, and it is never passed off
 * as the moment the Takeover happened.
 */
export interface TakeoverReport {
  /** The member running the workload now. */
  readonly winner: string;
  /** The member it was taken from: `standby_set[0]`, or an earlier winner. */
  readonly from?: string | undefined;
  /** How many times this workload has changed hands. */
  readonly rounds?: number | undefined;
  /** When the winner ANNOUNCED its claim — the event's own `created_at`. */
  readonly announcedAt?: string | undefined;
  /** When THIS CONSOLE first saw it. Not the moment it happened. */
  readonly firstSeenAt: string;
  /** Which of the two said so first. */
  readonly seenBy: 'status' | 'claim';
  /** Every claim the race left behind, earliest first (§7.1 step 3). */
  readonly claims?: readonly TakeoverClaimView[];
}

export interface TakeoverClaimView {
  readonly claimant: string;
  readonly index: number;
  readonly primary: string;
  readonly announcedAt: string;
}

/**
 * One member of the Standby Set, as a card shows it (§7).
 *
 * The three facts a person needs about a member are what it is doing, what
 * keeps it doing that, and whether it is the one the workload is on right now.
 * `selfStopped` is the fourth and it exists because two very different things
 * look alike at a glance: a primary that stopped its own workload under §7.1
 * still HOLDS a paid lease and can be extended at the running price, while a
 * lease that ended by Expiry is over and cannot be restarted at all.
 */
export interface WorkloadMemberView {
  readonly pubkey: string;
  readonly index: number;
  /** Its position in the set, which a Takeover never changes (§6.7). */
  readonly role: 'standalone' | 'primary' | 'standby';
  readonly provider: {
    readonly ilpAddress: string;
    readonly connectorUrl: string;
    readonly hidden: boolean;
    readonly liveness?: string | undefined;
    readonly inDirectory: boolean;
  };
  readonly listing: LeaseView['listing'];
  /** What this member last said about the lease. */
  readonly status: WorkloadStatus;
  /**
   * Which route adds an interval here, and everything that would refuse one.
   *
   * `op` is read from what the member is doing NOW, not from what it was
   * bought as: §6.3 wants the lease in the opposite state on each route, so a
   * Reserved standby is `standby.extend` and a standby that won a Takeover is
   * `extend`, at the running price, from the moment it won (§7.1 step 4).
   */
  readonly extend: {
    readonly ok: boolean;
    readonly op: ExtendOp;
    readonly problems: readonly string[];
    readonly route?: OpRouteView | undefined;
  };
  /** True when this member is the one the workload is running on. */
  readonly runningNow: boolean;
  /** A primary that stopped its own workload under §7.1's self-stop rule. */
  readonly selfStopped: boolean;
  /** What the vault record says this member's spawn did. */
  readonly vaultState: LeaseMemberView['state'];
  readonly failedBecause?: string | undefined;
  /** False when the record names this member but not where to reach it. */
  readonly known: boolean;
}

/** The Standby Set as a whole, summarised on the card (§7). */
export interface StandbySetView {
  readonly members: number;
  /** True for a set with a Warm Standby in it; false for a standalone lease. */
  readonly warm: boolean;
  /** What ONE round of extensions for the whole set costs, base units. */
  readonly pricePerInterval?: string | undefined;
  /** Why that figure is missing, when it is. */
  readonly reason?: string | undefined;
  /** The member the workload is running on, when anything says which. */
  readonly runningMember?: string | undefined;
  readonly takeover?: TakeoverReport | undefined;
  /** Why no claim could be read, when the relays could not be asked. */
  readonly takeoverUnread?: string | undefined;
}

/**
 * What the provider said, in the four kinds a card must tell apart.
 *
 * `silent` and `refused` are the pair that matters. A provider that has gone
 * quiet has told us nothing about the lease — it may be running perfectly —
 * while a provider that answered `unknown_workload` has told us something
 * definite. Rendering the first as an error would have a person terminating
 * and respawning a workload that was never in trouble.
 */
export type WorkloadStatus =
  | {
      readonly kind: 'read';
      readonly life: LeaseLife;
      readonly role?: string | undefined;
      readonly expiresAt?: number | undefined;
      readonly access?: LeaseAccess | undefined;
      /** Echoed as the spawn gave it, never resolved (§6.5). */
      readonly template?: string | undefined;
      readonly takeover?: TakeoverView | undefined;
      /** What this read cost. Absent on a route the provider prices at zero. */
      readonly cost?: string | undefined;
      readonly readAt: string;
    }
  | {
      /** No answer came back. The lease may be perfectly fine. */
      readonly kind: 'silent';
      readonly reason: string;
      readonly cost?: string | undefined;
      readonly readAt: string;
    }
  | {
      /** The provider answered, and its answer was a refusal (§5). */
      readonly kind: 'refused';
      readonly code: string;
      readonly message: string;
      readonly cost?: string | undefined;
      readonly readAt: string;
    }
  | {
      /** This console could not ask. Nothing was sent and nothing was paid. */
      readonly kind: 'unread';
      readonly reason: string;
      readonly readAt: string;
    };

/* -------------------------------------------------------------------------- */
/* Runway                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How long current funds keep this workload alive.
 *
 * Two halves, and each can be missing on its own: the time already **paid
 * for** (to the lease's `expires_at`) and the time the channel could still
 * **buy** (whole Lease Intervals at what an extension costs). A runway is the
 * sum, and `state` is `computed` only when both halves are known — never a
 * zero standing in for "we could not tell", because this is the figure a
 * person decides whether to top up on.
 *
 * **The price is the paying connector's, not the Listing's.** Those are two
 * different numbers in two different units: a Listing prices an interval in
 * µUSDC, while a channel's balance is in base units of whatever token that
 * connector settles in — 18 decimals on one node of this machine's sandbox and
 * 6 on the next — and a connector that forwards adds its own fee on top
 * (TOON_Network#82: the connector decides what a packet costs, and nothing
 * here recomputes one). So the arithmetic is done in the units the channel is
 * denominated in, against the quote for THIS lease's `.extend` route at the
 * connector that would collect, and the Listing's own figure is carried
 * alongside as what the Listing says.
 */
export type RunwayState =
  /** Both halves known. */
  | 'computed'
  /** The extension route costs nothing, so funds do not bound this lease. */
  | 'unbounded'
  /** Something needed is missing, and `reason` says which. */
  | 'unknown';

export interface RunwayView {
  readonly state: RunwayState;
  /** Which half is missing, in words. Set whenever `state` is not `computed`. */
  readonly reason?: string | undefined;
  /** µUSDC per Lease Interval, as the Listing priced it (§4.2). */
  readonly listingPrice: number;
  readonly leaseIntervalSeconds: number;
  /** What one extension costs where it would be paid. The connector's figure. */
  readonly pricePerInterval?: string | undefined;
  /** Where that figure and the balance below both come from. */
  readonly payAt?: string | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
  /** The channel's collateral less what this console has signed claims for. */
  readonly available?: string | undefined;
  /** Whole intervals those funds buy. Never a fraction: §6.3 sells whole ones. */
  readonly affordableIntervals?: number | undefined;
  /** Seconds already paid for, from `expires_at`. Negative is reported as 0. */
  readonly paidSeconds?: number | undefined;
  readonly paidUntil?: string | undefined;
  /** Where the expiry came from: the provider now, or the vault record. */
  readonly expirySource?: 'provider' | 'vault' | undefined;
  /** The whole runway: paid time plus what the funds could buy. */
  readonly seconds?: number | undefined;
  readonly until?: string | undefined;
  /**
   * What one ROUND of extensions for the whole Standby Set costs, base units.
   *
   * A set is only alive while every member is paid — a lapsed reservation is a
   * Warm Standby that is not there when the primary goes silent — so the
   * figure above is the SET's, bounded by the member that runs out first. For
   * a standalone lease this equals `pricePerInterval` and `boundBy` is that
   * one provider, which is how the same arithmetic serves both.
   */
  readonly setPricePerInterval?: string | undefined;
  /** Whole rounds the channels buy for the whole set. */
  readonly rounds?: number | undefined;
  /** The member whose time runs out first. That is the one to top up. */
  readonly boundBy?: string | undefined;
  /** Each member's half of the sum, so the figure is checkable. */
  readonly memberRunways?: readonly RunwayMember[] | undefined;
  readonly readAt: string;
}

/* -------------------------------------------------------------------------- */
/* A card                                                                     */
/* -------------------------------------------------------------------------- */

/** Where a packet for this lease would go, and what it would cost. */
export interface OpRouteView {
  readonly route: string;
  readonly payAt: string;
  readonly via: 'profile-connector' | 'provider-connector';
  readonly reason: string;
  /** Base units per packet, verbatim from the connector that quoted it. */
  readonly price?: string | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
}

export interface WorkloadCard {
  readonly workloadId: string;
  readonly lease: LeaseView;
  readonly provider: {
    readonly pubkey: string;
    readonly ilpAddress: string;
    readonly connectorUrl: string;
    readonly hidden: boolean;
    /** The provider's published Liveness (§4.3), when the directory was read. */
    readonly liveness?: string | undefined;
    /** Whether a current Profile for it was on the relays just read. */
    readonly inDirectory: boolean;
  };
  readonly status: WorkloadStatus;
  readonly runway: RunwayView;
  /** What an extension would cost and everything that would refuse one. */
  readonly extend: {
    readonly ok: boolean;
    readonly problems: readonly string[];
    readonly route?: OpRouteView | undefined;
  };
  /** Every member of the Standby Set, primary first (§7). Never empty. */
  readonly members: readonly WorkloadMemberView[];
  readonly set: StandbySetView;
  readonly autoExtend?: AutoExtendView | undefined;
  /** The last ending this console saw, kept across restarts. */
  readonly endedAs?: LeaseEnding | undefined;
}

/**
 * The budget half of a card, as the dashboard shows it.
 *
 * `auto-extend.ts` owns the rules; this is the shape they are reported in, and
 * it lives here so that a card is one object rather than two joined in the
 * window.
 */
export interface AutoExtendView {
  readonly armed: boolean;
  /** The whole this console may spend on extensions for this lease, base units. */
  readonly budget: string;
  readonly spent: string;
  readonly remaining: string;
  readonly extensions: number;
  /** The price the account agreed to. A dearer one disarms rather than pays. */
  readonly agreedPrice: string;
  /** How close to expiry an extension is bought. */
  readonly leadSeconds: number;
  readonly armedAt: string;
  readonly lastRun?:
    | {
        readonly at: string;
        readonly outcome: 'extended' | 'waited' | 'stopped';
        readonly reason: string;
        readonly cost?: string | undefined;
        /** Which members of the Standby Set that run bought an interval for. */
        readonly members?: readonly string[] | undefined;
      }
    | undefined;
  /** Set once the budget turned itself off, with the sentence that did it. */
  readonly stoppedBecause?: string | undefined;
}

export interface DashboardView {
  readonly state: 'signed_out' | 'unknown' | 'ready';
  readonly pubkey?: string | undefined;
  readonly profileId: string;
  readonly cards: readonly WorkloadCard[];
  /** Vault records this signer could not open. Never silently zero. */
  readonly unreadable: number;
  readonly checkedAt: string;
}

/* -------------------------------------------------------------------------- */
/* What an action answers                                                     */
/* -------------------------------------------------------------------------- */

export interface ExtendResult {
  /** `false` when nothing was sent. Then `problems` says why, and nothing was paid. */
  readonly sent: boolean;
  readonly problems: readonly string[];
  readonly route?: OpRouteView | undefined;
  /** Which member of the Standby Set this bought an interval for (§7). */
  readonly member: string;
  /** Which route it was bought on: a reservation is not extended like a lease. */
  readonly op: ExtendOp;
  /** What this extension cost, in base units. Present on a refusal too (§5). */
  readonly cost?: string | undefined;
  /** The lease's new `expires_at`, as the provider answered it (§6.3). */
  readonly expiresAt?: number | undefined;
  /** The provider's own refusal code, when it refused. */
  readonly providerError?: string | undefined;
  readonly message?: string | undefined;
  readonly card: WorkloadCard;
}

export interface TerminateResult {
  readonly sent: boolean;
  readonly problems: readonly string[];
  readonly route?: OpRouteView | undefined;
  /** Which member of the Standby Set was ended. Terminating one ends one (§7). */
  readonly member: string;
  readonly cost?: string | undefined;
  /** The ending the provider named. `termination` on a terminate that worked. */
  readonly ended?: LeaseEnding | undefined;
  readonly providerError?: string | undefined;
  readonly message?: string | undefined;
  readonly card: WorkloadCard;
}

export class WorkloadError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WorkloadError';
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface WorkloadStoreDeps {
  readonly profile: () => NetworkProfile;
  readonly vault: LeaseVault;
  readonly chainSeed: ChainSeedStore;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  readonly readDirectory: (profile: NetworkProfile) => Promise<DirectoryResult>;
  readonly provider: ProviderPort;
  readonly paths: ConsolePaths;
  readonly notes: WorkloadNoteStore;
  /** The budgets, when they are wired. A dashboard reads fine without them. */
  readonly autoExtend?: (() => AutoExtendReader) | undefined;
  /**
   * Reading the Takeover claims a Standby Set left on its relays (§7.1).
   *
   * Optional, and a card without it still reports a Takeover — a member's own
   * `status` says one settled and who won (§6.5). What this adds is WHEN,
   * because only the winner's kind-30433 claim carries that, and it is free.
   */
  readonly readTakeover?: (query: {
    workloadId: string;
    standbySet: readonly string[];
    relays: readonly string[];
  }) => Promise<TakeoverReading>;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The half of `auto-extend.ts` a card needs. Narrow, so the cycle is not one. */
export interface AutoExtendReader {
  view(pubkey: string, workloadId: string): AutoExtendView | undefined;
}

export class WorkloadStore {
  readonly #deps: WorkloadStoreDeps;

  constructor(deps: WorkloadStoreDeps) {
    this.#deps = deps;
  }

  /**
   * Every workload this account holds, as a card each.
   *
   * `refresh` asks each provider for its lease's state, which is free at the
   * provider and may not be free through a hop — so it is a decision a caller
   * makes rather than something that happens because a window was opened. A
   * dashboard without it is built from the last answers, which is what
   * `workload-cache.ts` keeps.
   */
  async dashboard(options: { refresh?: boolean } = {}): Promise<DashboardView> {
    const vault = await this.#vault();
    const checkedAt = this.#at().toISOString();
    const profileId = this.#deps.profile().id;
    if (vault.state === 'signed_out' || vault.pubkey === undefined) {
      return {
        state: 'signed_out',
        profileId,
        cards: [],
        unreadable: 0,
        checkedAt,
      };
    }

    const cards: WorkloadCard[] = [];
    for (const lease of vault.leases) {
      cards.push(await this.#card(lease, options.refresh === true));
    }
    return {
      state: vault.state,
      pubkey: vault.pubkey,
      profileId,
      cards,
      unreadable: vault.unreadable,
      checkedAt,
    };
  }

  /** One card. `refresh` asks the provider; without it the last answer stands. */
  async card(workloadId: string, options: { refresh?: boolean } = {}): Promise<WorkloadCard> {
    return this.#card(this.#lease(workloadId), options.refresh === true);
  }

  /**
   * Ask a member what this lease is doing (§6.5). Free at the provider.
   *
   * It presents that member's own Continuation Token, derived from the one
   * Root Secret under that member's public key and borrowed from the vault for
   * the length of this one packet (§6.1.1). A Gateway Grant would also be
   * admitted here (§6.5.1) and is #97's business, not this module's.
   *
   * `member` names which of the Standby Set to ask; without it, the primary.
   */
  async readStatus(
    workloadId: string,
    options: { member?: string | undefined } = {}
  ): Promise<WorkloadStatus> {
    const lease = this.#lease(workloadId);
    return this.#readStatus(lease, this.#member(lease, options.member));
  }

  /**
   * **Buy one Lease Interval** for one member of the set (§6.3, §7). Spends.
   *
   * Everything checkable is checked first and the packet is not sent if any of
   * it fails, because §6.3's refusals — `expired`, `not_running`,
   * `not_standby`, `wrong_listing_version`, `unknown_workload` — are all
   * billed at the route's full price. The last check is a live `status`, which
   * is free and is the only thing that can say whether this lease is still
   * there to extend AND which of the two extension routes it is on now.
   *
   * **Which route is read, never assumed.** A Reserved Warm Standby is paid on
   * `.standby.extend` at `standby_price`; a standalone lease, a primary, a
   * primary that stopped itself and a standby that WON a Takeover are all paid
   * on `.extend` at the running price (§6.3, §7.1 step 4). Getting that wrong
   * costs an interval at the other route's price and buys nothing.
   *
   * The body is BARE: `{ "workload_id": "…" }`. Any payer may extend any
   * lease, so there is no Lease Request here and no token to present
   * (ADR 0005).
   */
  async extend(
    workloadId: string,
    options: {
      maxPrice?: string | undefined;
      chain?: string | undefined;
      member?: string | undefined;
    } = {}
  ): Promise<ExtendResult> {
    const lease = this.#lease(workloadId);
    const member = this.#member(lease, options.member);
    const problems: string[] = [];
    // The free read FIRST, because it decides which route is even asked for.
    const status = await this.#readStatus(lease, member);
    const op = this.#extendOp(status, member);
    const planned = await this.#plan(lease, member, op, problems, options.chain);
    this.#checkExtendable(status, op, problems);

    if (planned !== undefined && options.maxPrice !== undefined) {
      const quoted = planned.price;
      if (quoted === undefined) {
        problems.push(
          `The connector at ${planned.payAt} did not quote a price for ${planned.route}, so ` +
            `this extension cannot be held to the ${options.maxPrice} base units it was ` +
            `limited to.`
        );
      } else if (compareAmounts(quoted, options.maxPrice) > 0) {
        problems.push(
          `One interval on ${planned.route} now costs ${quoted} base units at ` +
            `${planned.payAt}, above the ${options.maxPrice} this extension was limited to. ` +
            `A price change is a new Listing version (ADR 0009), so this is a different offer ` +
            `from the one that was agreed to — nothing was sent.`
        );
      }
    }

    const who = { member: member.pubkey, op };
    if (planned === undefined || problems.length > 0) {
      return {
        sent: false,
        problems,
        ...who,
        ...(planned === undefined ? {} : { route: viewOf(planned) }),
        card: await this.#cardWith(lease, new Map([[member.pubkey, status]])),
      };
    }

    const outcome = await this.#send(planned, { workload_id: lease.workloadId });
    const read = readAnswer(outcome);
    const cost = costOf(outcome);

    if (outcome.kind === 'unknown') {
      // The extension may or may not have been bought. Saying so beats both
      // "it failed" (a second one would then buy a second interval nobody
      // asked for) and "it worked".
      return {
        sent: true,
        problems: [],
        ...who,
        route: viewOf(planned),
        message:
          `The extension was sent and nothing came back: ${outcome.message} Whether the ` +
          `interval was bought is unknown. Ask for this lease's status — that is free — ` +
          `before extending again.`,
        card: await this.#refreshedCard(lease, member),
      };
    }

    if (read.error !== undefined) {
      return {
        sent: true,
        problems: [],
        ...who,
        route: viewOf(planned),
        ...(cost === undefined ? {} : { cost }),
        providerError: read.error,
        message:
          `${read.message ?? `The provider refused this extension: ${read.error}.`}` +
          (cost === undefined
            ? ''
            : ` It was billed ${cost} base units anyway — a paid route bills for an answer, ` +
              `and a refusal is one (ADR 0003, spec §5).`),
        card: await this.#refreshedCard(lease, member),
      };
    }

    // §6.3 answers `{ workload_id, expires_at }`, and that is the lease's new
    // expiry from the party that decides it — so the card moves on it rather
    // than on a second `status`. Free is not the same as costless: every
    // packet is a packet, and this one would tell us what we were just told.
    const expiresAt = read.expiresAt;
    const moved: WorkloadStatus =
      expiresAt === undefined || status.kind !== 'read'
        ? status
        : { ...status, expiresAt, readAt: this.#at().toISOString() };
    this.#note(lease, member, {
      status: moved,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return {
      sent: true,
      problems: [],
      ...who,
      route: viewOf(planned),
      ...(cost === undefined ? {} : { cost }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      card: await this.#cardWith(lease, new Map([[member.pubkey, moved]])),
    };
  }

  /**
   * End ONE member's lease now (§6.6). Free at the provider, no refund.
   *
   * It presents that member's own Continuation Token: a Gateway Grant is not
   * enough here and never will be (§6.5.1). The answer carries the ending, so
   * the card says **Termination** — not "expired", not "gone" — and the ending
   * is written down locally so it survives a restart and the provider's own
   * sweep, after which `status` answers `unknown_workload`.
   *
   * **One member, not the set.** A Termination releases the lease it names:
   * the primary's workload, or a Warm Standby's reservation (§7). Ending a
   * whole Standby Set is ending each member, one free request each, and this
   * console asks for each one rather than deciding on a person's behalf that
   * every member should go — a set whose primary is terminated still has
   * standbys holding paid capacity, and that is a thing somebody may mean.
   */
  async terminate(
    workloadId: string,
    options: { member?: string | undefined } = {}
  ): Promise<TerminateResult> {
    const lease = this.#lease(workloadId);
    const member = this.#member(lease, options.member);
    const problems: string[] = [];
    const planned = await this.#plan(lease, member, 'terminate', problems);
    if (planned === undefined || problems.length > 0) {
      return {
        sent: false,
        problems,
        member: member.pubkey,
        ...(planned === undefined ? {} : { route: viewOf(planned) }),
        card: await this.#card(lease, false),
      };
    }

    const body = await this.#leaseRequest(lease, member, 'terminate', {
      workload_id: lease.workloadId,
    });
    const outcome = await this.#send(planned, body);
    const cost = costOf(outcome);

    if (outcome.kind === 'unknown') {
      return {
        sent: true,
        problems: [],
        member: member.pubkey,
        route: viewOf(planned),
        message:
          `The termination was sent and nothing came back: ${outcome.message} Whether the ` +
          `workload was destroyed is unknown. Ask for this lease's status, which is free.`,
        card: await this.#refreshedCard(lease, member),
      };
    }

    const read = readAnswer(outcome);
    if (read.error !== undefined) {
      return {
        sent: true,
        problems: [],
        member: member.pubkey,
        route: viewOf(planned),
        ...(cost === undefined ? {} : { cost }),
        providerError: read.error,
        message: read.message ?? `The provider refused this termination: ${read.error}.`,
        card: await this.#refreshedCard(lease, member),
      };
    }

    // §6.6 answers `{ workload_id, state: { ended: "termination" } }`, so a
    // tenant needs no second call to see that its lease is over.
    const life = read.life;
    const ended = life?.phase === 'ended' ? life.ending : undefined;
    this.#note(lease, member, {
      endedAs: ended ?? 'termination',
      status: {
        kind: 'read',
        life: life ?? { phase: 'ended', ending: 'termination' },
        readAt: this.#at().toISOString(),
      },
    });
    return {
      sent: true,
      problems: [],
      member: member.pubkey,
      route: viewOf(planned),
      ...(cost === undefined ? {} : { cost }),
      ended: ended ?? 'termination',
      card: await this.#card(lease, false),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Cards                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * One card, asking every member of the Standby Set or none of them.
   *
   * `refresh` asks EACH member, because a set's whole point is that the answer
   * differs between them: after a Takeover the primary answers `stopped` with
   * no access and a standby answers `running` with it, and a card built from
   * the primary alone would say the workload was off. Each of those reads is
   * free at its own provider (§5) and is bought where it is free (`#plan`), so
   * a set of three costs three free packets and not three fees.
   */
  async #card(lease: LeaseView, refresh: boolean): Promise<WorkloadCard> {
    const statuses = new Map<string, WorkloadStatus>();
    if (refresh) {
      for (const member of lease.members) {
        statuses.set(member.pubkey, await this.#readStatus(lease, member));
      }
    }
    return this.#cardWith(lease, statuses);
  }

  /** A card with one member just re-read, and the rest from what was known. */
  async #refreshedCard(lease: LeaseView, member: LeaseMemberView): Promise<WorkloadCard> {
    return this.#cardWith(
      lease,
      new Map([[member.pubkey, await this.#readStatus(lease, member)]])
    );
  }

  async #cardWith(
    lease: LeaseView,
    fresh: ReadonlyMap<string, WorkloadStatus>
  ): Promise<WorkloadCard> {
    const note = this.#noteFor(lease.workloadId);
    const found = await this.#directory();
    const budget = this.#deps.autoExtend?.();
    const pubkey = this.#deps.vault.status().pubkey;

    const members: WorkloadMemberView[] = [];
    const runways: RunwayMember[] = [];
    const plans = new Map<string, OpPlan | undefined>();
    for (const member of lease.members) {
      const status = fresh.get(member.pubkey) ?? this.#lastStatus(lease, member);
      const op = this.#extendOp(status, member);
      const problems: string[] = [];
      const plan = await this.#plan(lease, member, op, problems);
      this.#checkExtendable(status, op, problems);
      plans.set(member.pubkey, plan);
      const profile = found?.get(member.pubkey);
      const phase = phaseOf(status);
      members.push({
        pubkey: member.pubkey,
        index: member.index,
        role: member.role,
        provider: {
          ilpAddress: profile?.profile.ilpAddress ?? member.provider.ilp_address,
          connectorUrl: profile?.profile.connectorUrl ?? member.provider.connector_url,
          hidden: profile?.profile.hidden ?? member.provider.hidden === true,
          ...(profile === undefined ? {} : { liveness: profile.liveness.state }),
          inDirectory: profile !== undefined,
        },
        listing: member.listing,
        status,
        extend: {
          ok: problems.length === 0 && plan !== undefined,
          op,
          problems,
          ...(plan === undefined ? {} : { route: viewOf(plan) }),
        },
        runningNow: phase === 'running',
        // §6.7: `stopped` is reached by a primary and by nothing else, and
        // only §7.1's self-stop rule puts a lease there. It is NOT an ending:
        // the lease is paid to its `expires_at`, `.extend` still adds an
        // interval at the running price, and the sweep still ends it.
        selfStopped: phase === 'stopped',
        vaultState: member.state,
        ...(member.failedBecause === undefined ? {} : { failedBecause: member.failedBecause }),
        known: member.known,
      });
      runways.push(this.#memberRunway(member, status, plan, op));
    }

    const primary = members[0];
    const primaryMember = lease.members[0];
    const status = primary?.status ?? {
      kind: 'unread' as const,
      reason: 'This lease names no member this console can ask about.',
      readAt: this.#at().toISOString(),
    };
    const takeover = await this.#takeover(lease, members, found, note);

    return {
      workloadId: lease.workloadId,
      lease,
      provider: {
        pubkey: lease.provider.pubkey,
        ilpAddress: primary?.provider.ilpAddress ?? lease.provider.ilp_address,
        connectorUrl: primary?.provider.connectorUrl ?? lease.provider.connector_url,
        hidden: primary?.provider.hidden ?? lease.provider.hidden === true,
        ...(primary?.provider.liveness === undefined
          ? {}
          : { liveness: primary.provider.liveness }),
        inDirectory: primary?.provider.inDirectory ?? false,
      },
      status,
      runway: this.#runway(
        lease,
        status,
        primaryMember === undefined ? undefined : plans.get(primaryMember.pubkey),
        runways
      ),
      extend: {
        ok: primary?.extend.ok ?? false,
        problems: primary?.extend.problems ?? [],
        ...(primary?.extend.route === undefined ? {} : { route: primary.extend.route }),
      },
      members,
      set: setViewOf(members, takeover),
      ...(budget === undefined || pubkey === undefined
        ? {}
        : optional('autoExtend', budget.view(pubkey, lease.workloadId))),
      ...(note?.endedAs === undefined ? {} : { endedAs: note.endedAs }),
    };
  }

  /**
   * Whether a Takeover has happened, from the two things that can say so.
   *
   * A member's own `status` is the authority on its own lease (§6.5), so a
   * `takeover.winner` from any member settles WHO. The claims on the relays
   * settle WHEN, and only they can: a kind-30433 event carries the moment the
   * winner announced, signed by the winner (§7.1 step 2). The two are read
   * together and the report says which said what.
   *
   * The moment this console first saw it is written down, so that "when" does
   * not become "just now" every time the daemon restarts — and it is labelled
   * as this console's observation rather than dressed up as the event's.
   */
  async #takeover(
    lease: LeaseView,
    members: readonly WorkloadMemberView[],
    found: ReadonlyMap<string, ProviderView> | undefined,
    note: WorkloadNote | undefined
  ): Promise<{ report?: TakeoverReport | undefined; unread?: string | undefined }> {
    if (lease.members.length < 2) return {};
    const said = members
      .map((member) => (member.status.kind === 'read' ? member.status.takeover : undefined))
      .find((view) => view !== undefined);
    const seenAt = this.#at().toISOString();

    let reading: TakeoverReading | undefined;
    if (this.#deps.readTakeover !== undefined) {
      // The primary's Relay Set is where every claim is published (§7.1), and
      // its Provider Profile is what names it. Every member's is asked as
      // well: a read costs nothing, and a set whose relays have shifted
      // between rounds is exactly the case a narrower list would miss.
      const relays = [
        ...lease.members.flatMap((member) => found?.get(member.pubkey)?.profile.relays ?? []),
        this.#deps.profile().relayUrl,
      ];
      reading = await this.#deps
        .readTakeover({
          workloadId: lease.workloadId,
          standbySet: lease.members.map((member) => member.pubkey),
          relays,
        })
        .catch(() => undefined);
    }

    const claim = reading?.winner;
    const winner = claim?.claimant ?? said?.winner;
    if (winner === undefined) {
      return reading?.state === 'unread'
        ? {
            unread: reading.reason ?? 'The Takeover claims on these relays could not be read.',
          }
        : {};
    }

    const held = note?.takeover;
    const firstSeenAt = held?.winner === winner ? held.firstSeenAt : seenAt;
    const report: TakeoverReport = {
      winner,
      seenBy: claim === undefined ? 'status' : 'claim',
      firstSeenAt,
      ...(claim === undefined
        ? {}
        : {
            from: claim.primary,
            announcedAt: claim.announcedAt,
            rounds: reading?.rounds ?? 1,
          }),
      ...(reading?.claims === undefined || reading.claims.length === 0
        ? {}
        : {
            claims: reading.claims.map((entry) => ({
              claimant: entry.claimant,
              index: entry.index,
              primary: entry.primary,
              announcedAt: entry.announcedAt,
            })),
          }),
    };
    if (held?.winner !== winner || held.announcedAt !== report.announcedAt) {
      this.#noteWorkload(lease.workloadId, { takeover: report });
    }
    return { report };
  }

  /**
   * One member's half of the set's runway.
   *
   * It is the same two halves #93 counts for a lease — time already paid for,
   * and time the channel could still buy — with the route decided by what the
   * member IS: a Reserved standby is priced on `.standby.extend`, and the sum
   * that keeps a set alive is the sum of what each member is actually charged.
   */
  #memberRunway(
    member: LeaseMemberView,
    status: WorkloadStatus,
    plan: OpPlan | undefined,
    op: ExtendOp
  ): RunwayMember {
    const base = {
      pubkey: member.pubkey,
      index: member.index,
      leaseIntervalSeconds: member.listing.lease_interval_s,
      op,
    };
    const phase = phaseOf(status);
    if (phase === 'ended') return { ...base, ended: true };

    const expiry =
      status.kind === 'read' && status.expiresAt !== undefined
        ? status.expiresAt
        : member.expiresAt;
    const paidSeconds =
      expiry === undefined ? undefined : Math.max(0, expiry - this.#seconds());

    if (plan === undefined) {
      return {
        ...base,
        unknown:
          `has no route this console can price right now, so what keeping it costs is ` +
          `unknown — and a runway counted against a price nobody quoted would be a guess.`,
      };
    }
    return {
      ...base,
      ...(paidSeconds === undefined ? {} : { paidSeconds }),
      ...(plan.price === undefined ? {} : { pricePerInterval: plan.price }),
      ...(plan.channelId === undefined
        ? {}
        : { channelKey: `${plan.payAt}|${plan.chain ?? ''}|${plan.channelId}` }),
      ...(plan.available === undefined ? {} : { available: plan.available.toString() }),
    };
  }

  /**
   * The runway, in the units the channel is denominated in — for the whole
   * Standby Set.
   *
   * Both halves are read rather than assumed, and either may be missing: an
   * expiry this console has never been told, or a channel it cannot find. What
   * it must never do is put a zero where one of them should be.
   *
   * **It is the set's, not the primary's.** A set protects a workload only
   * while EVERY member is paid — a reservation that lapses is a Warm Standby
   * that is not there when the primary goes silent — so the headline figure is
   * `standby-set.ts`'s sum, bounded by the member that runs out first. For a
   * standalone lease that sum is this one lease's, so the same arithmetic
   * serves both and there is no second one to drift. What stays the primary's
   * is the detail beside it: its price, its channel, its expiry.
   */
  #runway(
    lease: LeaseView,
    status: WorkloadStatus,
    plan: OpPlan | undefined,
    members: readonly RunwayMember[]
  ): RunwayView {
    const readAt = this.#at().toISOString();
    const set = setRunway(members);
    const base = {
      listingPrice: lease.listing.price,
      leaseIntervalSeconds: lease.listing.lease_interval_s,
      memberRunways: members,
      ...(set.pricePerInterval === undefined
        ? {}
        : { setPricePerInterval: set.pricePerInterval }),
      ...(set.rounds === undefined ? {} : { rounds: set.rounds }),
      ...(set.boundBy === undefined ? {} : { boundBy: set.boundBy }),
      readAt,
    };

    const expiry =
      status.kind === 'read' && status.expiresAt !== undefined
        ? { at: status.expiresAt, source: 'provider' as const }
        : lease.expiresAt !== undefined
          ? { at: lease.expiresAt, source: 'vault' as const }
          : undefined;
    const paidSeconds =
      expiry === undefined ? undefined : Math.max(0, expiry.at - this.#seconds());

    const ended = status.kind === 'read' && status.life.phase === 'ended';
    if (ended) {
      return {
        ...base,
        state: 'unknown',
        reason:
          'This lease has ended, so it has no runway. Money in the channel is still yours; it ' +
          'is simply not keeping this workload alive any more.',
        ...(expiry === undefined
          ? {}
          : {
              ...optional('paidUntil', isoOf(expiry.at)),
              expirySource: expiry.source,
              paidSeconds: 0,
            }),
      };
    }

    const money = {
      ...(plan?.payAt === undefined ? {} : { payAt: plan.payAt }),
      ...(plan?.price === undefined ? {} : { pricePerInterval: plan.price }),
      ...(plan?.chain === undefined ? {} : { chain: plan.chain }),
      ...(plan?.channelId === undefined ? {} : { channelId: plan.channelId }),
      ...(plan?.available === undefined ? {} : { available: plan.available.toString() }),
    };
    const paid = {
      ...(paidSeconds === undefined ? {} : { paidSeconds }),
      ...(expiry === undefined
        ? {}
        : { ...optional('paidUntil', isoOf(expiry.at)), expirySource: expiry.source }),
    };

    if (plan === undefined || plan.price === undefined) {
      return {
        ...base,
        ...money,
        ...paid,
        state: 'unknown',
        reason:
          'No connector this console can reach prices this lease’s `.extend` route right now, ' +
          'so what another interval would cost is unknown — and a runway counted against a ' +
          'price nobody quoted would be a guess.',
      };
    }

    let price: bigint;
    try {
      price = BigInt(plan.price);
    } catch {
      return {
        ...base,
        ...money,
        ...paid,
        state: 'unknown',
        reason: `The connector at ${plan.payAt} quoted ${plan.price} for this lease’s extension, which is not an amount this console can count in.`,
      };
    }

    if (price === 0n) {
      return {
        ...base,
        ...money,
        ...paid,
        state: 'unbounded',
        reason:
          `An extension on ${plan.route} costs nothing at ${plan.payAt}, so funds do not bound ` +
          `this lease at all. It still ends at its expiry unless something extends it.`,
      };
    }

    if (plan.available === undefined) {
      return {
        ...base,
        ...money,
        ...paid,
        state: 'unknown',
        reason:
          plan.channelId === undefined
            ? `This account holds no payment channel with the connector at ${plan.payAt}, so ` +
              `there is nothing an extension could be paid from and no runway to count. Open ` +
              `one from the Funds tab.`
            : `What channel ${plan.channelId.slice(0, 12)}… has left could not be read — its ` +
              `collateral or what has been signed against it is unknown — so a runway would be ` +
              `a guess.`,
      };
    }

    const affordableIntervals = Number(plan.available <= 0n ? 0n : plan.available / price);
    if (paidSeconds === undefined) {
      return {
        ...base,
        ...money,
        ...paid,
        affordableIntervals,
        state: 'unknown',
        reason:
          'Nothing has said when this lease expires: the provider has not been asked, or did ' +
          'not answer. Those funds buy ' +
          `${affordableIntervals} more interval(s), but a runway also needs the time already ` +
          'paid for.',
      };
    }

    // The primary's own arithmetic is kept as the detail; the headline is the
    // SET's, which for a set of one is the same number by construction.
    if (set.state !== 'computed' || set.seconds === undefined) {
      return {
        ...base,
        ...money,
        ...paid,
        affordableIntervals,
        state: set.state,
        ...optional('reason', set.reason),
      };
    }
    const seconds = set.seconds;
    return {
      ...base,
      ...money,
      ...paid,
      state: 'computed',
      affordableIntervals,
      seconds,
      ...optional('until', isoOf(this.#seconds() + seconds)),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Talking to the provider                                                  */
  /* ------------------------------------------------------------------------ */

  async #readStatus(lease: LeaseView, member: LeaseMemberView): Promise<WorkloadStatus> {
    const readAt = this.#at().toISOString();
    const problems: string[] = [];
    const planned = await this.#plan(lease, member, 'status', problems);
    if (planned === undefined) {
      const status: WorkloadStatus = { kind: 'unread', reason: problems.join(' '), readAt };
      this.#note(lease, member, { status });
      return status;
    }

    let body: unknown;
    try {
      body = await this.#leaseRequest(lease, member, 'status', {
        workload_id: lease.workloadId,
      });
    } catch (error) {
      const status: WorkloadStatus = {
        kind: 'unread',
        reason:
          error instanceof LeaseVaultError
            ? error.message
            : `This lease's Continuation Token could not be derived: ${messageOf(error)}`,
        readAt,
      };
      this.#note(lease, member, { status });
      return status;
    }

    const outcome = await this.#send(planned, body);
    const status = this.#statusOf(outcome, planned, readAt);
    this.#note(lease, member, {
      status,
      ...(status.kind === 'read' && status.life.phase === 'ended'
        ? { endedAs: status.life.ending }
        : {}),
      ...(status.kind === 'read' && status.expiresAt !== undefined
        ? { expiresAt: status.expiresAt }
        : {}),
    });
    return status;
  }

  #statusOf(outcome: PacketOutcome, plan: OpPlan, readAt: string): WorkloadStatus {
    const cost = costOf(outcome);
    if (outcome.kind === 'unknown') {
      return {
        kind: 'silent',
        reason:
          `${plan.payAt} took the packet and nothing came back: ${outcome.message} That says ` +
          `nothing about the lease — it may be running perfectly — only that this provider is ` +
          `not answering right now.`,
        readAt,
      };
    }
    if (outcome.kind === 'refused') {
      // A reject from the far end, or from a hop, never reached the provider
      // app. That is silence with a reason, not a statement about the lease.
      return {
        kind: 'silent',
        reason: `${
          outcome.refusedBy === 'edge'
            ? `The connector this console pays at refused the packet before routing it`
            : outcome.refusedBy === 'path'
              ? 'A hop on the way refused the packet'
              : `The connector that terminates ${plan.route} refused the packet`
        } (${outcome.code}): ${outcome.message} Nothing reached the provider, so nothing is known about the lease.`,
        ...(cost === undefined ? {} : { cost }),
        readAt,
      };
    }

    const read = readAnswer(outcome);
    if (read.error !== undefined) {
      return {
        kind: 'refused',
        code: read.error,
        message: read.message ?? `The provider answered ${read.error}.`,
        ...(cost === undefined ? {} : { cost }),
        readAt,
      };
    }
    if (read.life === undefined) {
      return {
        kind: 'silent',
        reason:
          `${plan.payAt} answered HTTP ${outcome.status}, but the body says nothing this ` +
          `console recognises as a lease state (§6.7).`,
        ...(cost === undefined ? {} : { cost }),
        readAt,
      };
    }
    return {
      kind: 'read',
      life: read.life,
      ...optional('role', read.role),
      ...optional('expiresAt', read.expiresAt),
      ...optional('access', read.access),
      ...optional('template', read.template),
      ...optional('takeover', read.takeover),
      ...(cost === undefined ? {} : { cost }),
      readAt,
    };
  }

  /**
   * §6.1's Lease Request, with THIS MEMBER's token borrowed for one packet.
   *
   * The token is derived per provider from the one Root Secret (§6.1.1), so
   * every member of a Standby Set holds a different one and the request has to
   * name the member it is for twice over: in `provider`, which §6.1.2 step 1
   * checks, and in the derivation, which step 4 compares. Presenting one
   * member's token to another is `not_tenant` — and on a paid route that
   * refusal is billed.
   */
  async #leaseRequest(
    lease: LeaseView,
    member: LeaseMemberView,
    op: 'status' | 'terminate',
    content: Record<string, unknown>
  ): Promise<unknown> {
    return this.#deps.vault.withContinuation(lease.workloadId, member.pubkey, (continuation) =>
      Promise.resolve({
        request: {
          request_id: mintRequestId(),
          op,
          provider: member.pubkey,
          expiration: this.#seconds() + REQUEST_TTL_S,
          continuation,
          content,
        },
      })
    );
  }

  async #send(plan: OpPlan, body: unknown): Promise<PacketOutcome> {
    return this.#deps.chainSeed.usePayerKeys((keys) =>
      this.#deps.provider.send({
        payAt: plan.payAt,
        sealTo: plan.sealTo,
        route: plan.route,
        body,
        chainKind: plan.chainKind,
        rpcUrl: plan.rpcUrl,
        keys,
        channelStore: plan.channelStore,
        ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
      })
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Planning one packet                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Where this op's packet goes, who collects, and from which channel.
   *
   * The rule differs from a spawn's in one place and it is deliberate. A spawn
   * prefers the tenant's own connector when it carries the prefix (ADR 0005);
   * here, **a route the provider prices at zero is bought where it is zero**,
   * because §5 makes `status` and `terminate` free and a forwarding hop's fee
   * would quietly make them not. Everything else follows the spawn: the
   * tenant's connector when it carries, the provider's own otherwise, and
   * never a channel opened as a side effect.
   *
   * `extend` additionally needs the Listing to still exist AT THIS LEASE'S
   * VERSION, because §6.3 refuses any other version — and bills for it.
   * `status` and `terminate` do not need the directory at all: the vault
   * record says where the provider is and which key to seal to, so a lease can
   * be read and stopped on a day the relays are unreachable.
   */
  async #plan(
    lease: LeaseView,
    member: LeaseMemberView,
    op: 'status' | 'terminate' | ExtendOp,
    problems: string[],
    wanted?: string | undefined
  ): Promise<OpPlan | undefined> {
    const profile = this.#deps.profile();
    if (lease.profileId !== profile.id) {
      problems.push(
        `This lease was bought on ${lease.profileId} and the console is on ${profile.id}. ` +
          `Switch networks to act on it: its channel, its connector and its provider are all ` +
          `that network's.`
      );
      return undefined;
    }

    // The payer keys come from the Chain Seed, and a store that has not
    // LOOKED for one yet reports `unknown` — which is not `absent`. Asking
    // here is what makes a freshly started daemon show cards instead of
    // failing every packet with "this account has no Chain Seed": the same
    // care `lease.ts` and `funding.ts` take, for the same reason (ADR 0020).
    const seed = await this.#seed();
    if (seed.state !== 'ready' && seed.state !== 'not_yet_recoverable') {
      problems.push(
        seed.state === 'signed_out'
          ? 'No account is signed in, so there is no key to pay with and no lease to act on.'
          : (seed.reason ??
              'This account has no readable Chain Seed, so it has no payer key on any chain — ' +
                'and every packet, free route included, is signed by one. Mint or import one on ' +
                'the Account tab.')
      );
      return undefined;
    }

    const directory = await this.#directory();
    const view = directory?.get(member.pubkey);
    const found = view === undefined ? undefined : { provider: view };
    const ilpAddress = found?.provider.profile.ilpAddress ?? member.provider.ilp_address;
    const sealTo =
      found?.provider.profile.connectorSealKey ?? member.provider.connector_seal_key;
    const providerConnector =
      found?.provider.profile.connectorUrl ?? member.provider.connector_url;
    if (ilpAddress.length === 0) {
      problems.push(
        `${member.pubkey.slice(0, 12)}… is a member of this workload's Standby Set, and ` +
          `neither this account's vault record nor ${profile.label}'s relays say where it is. ` +
          `Nothing can be addressed to it until its Provider Profile is readable (§4.1).`
      );
      return undefined;
    }

    let route: string;
    if (op === 'extend' || op === 'standby.extend') {
      if (found === undefined) {
        problems.push(
          `No current Profile for this provider was on ${profile.label}'s relays, so neither ` +
            `its route nor whether it still sells ${JSON.stringify(member.listing.name)} at ` +
            `v${member.listing.version} can be read. An extension on a retired version is ` +
            `refused \`wrong_listing_version\` — and billed — so none was sent (spec §6.3).`
        );
        return undefined;
      }
      const listing = found.provider.listings.find(
        (candidate) => candidate.name === member.listing.name
      );
      if (listing === undefined) {
        problems.push(
          `This provider no longer publishes a Listing named ` +
            `${JSON.stringify(member.listing.name)}. It sells ` +
            `${found.provider.listings.map((entry) => entry.name).join(', ') || 'nothing'}. ` +
            `An extension has to name this lease's own listing and version (§6.3).`
        );
        return undefined;
      }
      if (listing.version !== member.listing.version) {
        problems.push(
          `This lease was bought on ${listing.name} v${member.listing.version} and the provider ` +
            `now publishes v${listing.version}. §6.3 requires the lease's own version on the ` +
            `route, and a version change is a price or resource change (ADR 0009) — so an ` +
            `extension here is either refused \`wrong_listing_version\` at full price, or it ` +
            `is a different offer from the one this lease was bought at. Nothing was sent.`
        );
        return undefined;
      }
      if (op === 'standby.extend' && listing.standbyPrice === undefined) {
        // §5: the two standby routes exist for exactly the listings whose
        // Listing event carries `standby_price`, and a connector MUST NOT
        // terminate one the provider did not price. A reservation on a tier
        // that has stopped pricing standbys has nowhere to be paid.
        problems.push(
          `${listing.name} v${listing.version} no longer prices a Warm Standby, so this ` +
            `provider's connector terminates no \`.standby.extend\` route at all (§4.2, §5). ` +
            `This reservation cannot be extended where it was bought; it ends at its expiry ` +
            `unless the tier prices standbys again.`
        );
        return undefined;
      }
      route = `${ilpAddress}.${listing.name}.v${listing.version}.${op}`;
    } else {
      route = `${ilpAddress}.${op}`;
    }

    const candidates: { url: string; via: OpRouteView['via'] }[] = [];
    if (isConfigured(profile)) {
      candidates.push({ url: profile.connectorUrl, via: 'profile-connector' });
    }
    if (providerConnector.length > 0) {
      candidates.push({ url: providerConnector, via: 'provider-connector' });
    }
    if (candidates.length === 0) {
      problems.push(
        `Neither ${profile.label} nor this lease's own record names a connector, so there is ` +
          `nowhere to send ${route}.`
      );
      return undefined;
    }

    const priced: {
      url: string;
      via: OpRouteView['via'];
      price: string;
      health: Extract<ConnectorHealth, { state: 'ok' }>;
    }[] = [];
    const refusals: string[] = [];
    for (const candidate of candidates) {
      if (isHiddenServiceUrl(candidate.url)) {
        refusals.push(
          `${candidate.url} is a hidden service, and reaching one needs a running Anyone ` +
            `Protocol daemon to proxy through. The console does not start one yet ` +
            `(TOON_Network#96, spec §10).`
        );
        continue;
      }
      const health = await this.#deps.readHealth({ ...profile, connectorUrl: candidate.url });
      if (health.state !== 'ok') {
        refusals.push(
          `The connector at ${candidate.url} did not answer${
            health.state === 'unreachable' ? `: ${health.reason}` : '.'
          }`
        );
        continue;
      }
      const quoted = health.routes.find((published) =>
        routeCarries(published.prefix, route)
      )?.price;
      if (quoted === undefined) {
        refusals.push(
          `The connector at ${candidate.url} prices no route carrying ${route}, so it cannot ` +
            `carry this packet.`
        );
        continue;
      }
      priced.push({ ...candidate, price: quoted, health });
    }

    if (priced.length === 0) {
      problems.push(
        `There is no connector this console can reach that carries ${route}. ` +
          refusals.join(' ')
      );
      return undefined;
    }

    // A free route is bought where it is free (§5). Otherwise the tenant's own
    // connector when it carries the prefix (ADR 0005), and the provider's own
    // — which always terminates its own routes — when it does not.
    const free = priced.find((candidate) => candidate.price === '0');
    const chosen =
      free ?? priced.find((candidate) => candidate.via === 'profile-connector') ?? priced[0];
    if (chosen === undefined) return undefined;

    const reason =
      chosen === free
        ? `${chosen.url} prices ${route} at nothing, so this packet is bought where it is free ` +
          `(spec §5). A connector that merely forwards charges its own fee to carry it.`
        : chosen.via === 'profile-connector'
          ? `${profile.label}'s own connector publishes a route that carries ${route}, so the ` +
            `packet is paid there and forwarded (ADR 0005).`
          : `${profile.label}'s connector publishes no route carrying ${route}, so the packet ` +
            `is paid at the provider's own connector, which terminates it (spec §4.1, §5).`;

    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const plan: Omit<OpPlan, 'chainKind' | 'rpcUrl'> & {
      chainKind?: 'evm' | 'solana';
      rpcUrl?: string;
    } = {
      route,
      payAt: chosen.url,
      via: chosen.via,
      reason,
      price: chosen.price,
      sealTo,
      channelStore: channels.store,
    };

    // The chain a lease was BOUGHT on comes first, and it is not a preference.
    // A connector forwarding to a provider's has to convert, and it refuses a
    // packet whose amount converts to nothing at the rate it declares — at
    // full price. On this machine's sandbox the hub's peer settles in Solana
    // while the same account also holds an EVM channel there, so an extension
    // that picked "the first chain with a channel" would be refused and billed
    // for a lease the spawn had paid for perfectly well.
    const settlements = orderChains(chosen.health.settlements, wanted ?? lease.paidChain);
    for (const settlement of settlements) {
      const binding = findChannelBinding(channels.store, chosen.url, settlement.chain);
      if (!binding) continue;
      return {
        ...plan,
        chain: settlement.chain,
        channelId: binding.channelId,
        chainKind: settlement.kind,
        rpcUrl: resolveRpc(profile, settlement.kind).url,
        ...optional('available', channelAvailable(channels.store, binding)),
      } as OpPlan;
    }

    const first = settlements[0];
    if (chosen.price !== '0') {
      // A paid route with nothing to pay from. Said here, before a packet, and
      // with somewhere to go about it.
      problems.push(
        `One packet on ${route} costs ${chosen.price} base units at ${chosen.url}, and this ` +
          `account holds no payment channel there. Open one on ` +
          `${chosen.health.settlements.map((entry) => entry.chain).join(' or ') || 'its settlement chain'}` +
          ` from the Funds tab — nothing here opens one for you, because opening locks ` +
          `collateral on chain and costs the chain's own gas.`
      );
    }
    return {
      ...plan,
      chainKind: first?.kind ?? 'evm',
      rpcUrl: resolveRpc(profile, first?.kind ?? 'evm').url,
    } as OpPlan;
  }

  /**
   * Which of §6.3's two extension routes this member is on RIGHT NOW.
   *
   * Read from the live state and never from what the member was bought as: a
   * Warm Standby that won a Takeover is Running from that moment and is paid
   * at the running price on `.extend` (§7.1 step 4), while its sibling that
   * lost is still Reserved and still paid on `.standby.extend`. When nothing
   * could be read, the member's position in the set is the honest guess — and
   * `#checkExtendable` refuses to send anything anyway.
   */
  #extendOp(status: WorkloadStatus, member: LeaseMemberView): ExtendOp {
    const phase = phaseOf(status);
    if (phase !== undefined) return routeOpFor(phase) ?? 'extend';
    return member.role === 'standby' ? 'standby.extend' : 'extend';
  }

  /**
   * Everything §6.3 would refuse an extension for that a free `status` already
   * told us — checked here so the packet is never sent.
   *
   * The two routes refuse each other's leases, each at its own price. A
   * Reserved Warm Standby on `.extend` is `not_running`, billed at the running
   * price; a running lease on `.standby.extend` is `not_standby`, billed at
   * the standby price. `#extendOp` above chooses between them from the live
   * state, so reaching either of these is a state that changed under us — and
   * the answer is still to send nothing.
   */
  #checkExtendable(status: WorkloadStatus, op: ExtendOp, problems: string[]): void {
    const what = op === 'standby.extend' ? 'reservation' : 'extension';
    if (status.kind === 'unread') {
      problems.push(
        `This lease's state could not be read, and an ${what} is only worth buying for a ` +
          `lease that is still there: §6.3 refuses an ended one \`expired\` and bills for the ` +
          `refusal. ${status.reason}`
      );
      return;
    }
    if (status.kind === 'silent') {
      problems.push(
        `This provider is not answering, so whether this lease is still running is unknown. ` +
          `Nothing was sent: an ${what} buys an interval on a lease that may have ended, and ` +
          `§6.3 bills for the \`expired\` that would come back. ${status.reason}`
      );
      return;
    }
    if (status.kind === 'refused') {
      problems.push(
        `The provider answered \`${status.code}\` when asked about this lease, so an ${what} ` +
          `would be refused too — and billed (ADR 0003). ${status.message}`
      );
      return;
    }
    if (status.life.phase === 'ended') {
      problems.push(
        `This lease has ended (${endingWords(status.life)}). §6.3 refuses an extension on an ` +
          `ended lease as \`expired\` and bills for the answer, and there is no way to restart ` +
          `one — a new workload is a new spawn.`
      );
      return;
    }
    if (status.life.phase === 'reserved' && op !== 'standby.extend') {
      problems.push(
        `This lease is a Warm Standby reservation, and a reservation is extended on ` +
          `\`.standby.extend\` at the standby price, never on \`.extend\` — which refuses it ` +
          `\`not_running\` and bills at the running price (§6.3).`
      );
      return;
    }
    if (status.life.phase !== 'reserved' && op === 'standby.extend') {
      problems.push(
        `This lease is ${status.life.phase}, not a reservation, so it is extended on ` +
          `\`.extend\` at the running price. §6.3 refuses a running lease of any role on ` +
          `\`.standby.extend\` as \`not_standby\` — and bills at the standby price. A Warm ` +
          `Standby that won a Takeover is one of these: winning buys no time, and from then ` +
          `on it needs a full-price extension (§7.1 step 4).`
      );
    }
  }

  /* ------------------------------------------------------------------------ */

  /**
   * The CURRENT Profile of every provider, by pubkey, when the relays answered.
   *
   * By pubkey and read once per card, because a Standby Set asks about several
   * providers at a time: a lookup per member would read the directory once per
   * member, which on a set of three is three relay reads for one answer.
   */
  async #directory(): Promise<ReadonlyMap<string, ProviderView> | undefined> {
    const directory = await this.#deps
      .readDirectory(this.#deps.profile())
      .catch(() => undefined);
    if (directory === undefined || directory.state !== 'ok') return undefined;
    return new Map(directory.providers.map((provider) => [provider.pubkey, provider]));
  }

  /**
   * Which member of the Standby Set an action is for.
   *
   * Without a name, the primary — `standby_set[0]`, which for a standalone
   * lease is the only member there is. A name that is not in the set is
   * refused rather than addressed: the vault holds no token for it (§6.1.1),
   * so a packet sent there would be `not_tenant`, and on a paid route that
   * refusal is billed.
   */
  #member(lease: LeaseView, wanted: string | undefined): LeaseMemberView {
    const first = lease.members[0];
    if (wanted === undefined) {
      if (first === undefined) {
        throw new WorkloadError(
          'no_members',
          `This account's record for workload ${lease.workloadId} names no provider, so there ` +
            `is nothing to address.`,
          404
        );
      }
      return first;
    }
    const member = lease.members.find((candidate) => candidate.pubkey === wanted);
    if (member === undefined) {
      throw new WorkloadError(
        'not_a_member',
        `${wanted.slice(0, 12)}… is not a member of this workload's Standby Set. It holds ` +
          `${lease.members.map((entry) => entry.pubkey.slice(0, 12)).join(', ')}… — and a ` +
          `Continuation Token is derived per provider (§6.1.1), so a request to anyone else ` +
          `is \`not_tenant\`, billed on a paid route.`,
        404
      );
    }
    return member;
  }

  /**
   * The vault — having actually LOOKED at this account's relays, once.
   *
   * `unknown` means nothing has read them yet, which is not the same as "this
   * account has no workloads", and a dashboard that showed an empty page for
   * the second would be the worst answer this screen can give. Reading a relay
   * is free (spec §5 prices a provider's routes, never a relay's reads), so
   * looking costs nothing but the wait.
   */
  async #vault() {
    const held = this.#deps.vault.status();
    if (held.state !== 'unknown') return held;
    try {
      return await this.#deps.vault.refresh();
    } catch {
      return this.#deps.vault.status();
    }
  }

  /**
   * The Chain Seed's state — having actually LOOKED for it.
   *
   * `unknown` is not `absent`, and a console that told somebody they had no
   * Chain Seed because nothing had asked their relays yet would be refusing to
   * show them workloads they are paying for.
   */
  async #seed() {
    const held = this.#deps.chainSeed.status();
    if (held.state !== 'unknown') return held;
    try {
      return await this.#deps.chainSeed.refresh();
    } catch {
      return this.#deps.chainSeed.status();
    }
  }

  #lease(workloadId: string): LeaseView {
    if (!HEX_32.test(workloadId)) {
      throw new WorkloadError(
        'invalid_workload_id',
        'A workload id is 32 bytes as 64 lowercase hex characters (spec §6.2).'
      );
    }
    const lease = this.#deps.vault.find(workloadId);
    if (lease === undefined) {
      throw new WorkloadError(
        'unknown_workload',
        `This account holds no lease with workload id ${workloadId}. Read the vault from its ` +
          `relays; a lease whose Root Secret is nowhere cannot be read, extended or stopped by ` +
          `anyone (spec §6.1.1).`,
        404
      );
    }
    return lease;
  }

  #noteFor(workloadId: string): WorkloadNote | undefined {
    const pubkey = this.#deps.vault.status().pubkey;
    return pubkey === undefined ? undefined : this.#deps.notes.read(pubkey, workloadId);
  }

  /** The last thing THIS MEMBER said, or "nobody has asked it yet". */
  #lastStatus(lease: LeaseView, member: LeaseMemberView): WorkloadStatus {
    const note = this.#noteFor(lease.workloadId);
    const held =
      member.index === 0
        ? (note?.members?.[member.pubkey]?.status ?? note?.status)
        : note?.members?.[member.pubkey]?.status;
    return (
      held ?? {
        kind: 'unread' as const,
        reason:
          'This member has not been asked about yet. Asking is free at the provider (§6.5).',
        readAt: this.#at().toISOString(),
      }
    );
  }

  /**
   * Write down what a member said.
   *
   * The PRIMARY's answer is written twice over: once under its own key and
   * once in the note's own top-level fields, which are where every console
   * before Standby Sets looked and where the card's headline still reads from.
   * Keeping them in step is cheaper than a migration, and a note is a cache of
   * a free read — losing it costs one refresh.
   */
  #note(lease: LeaseView, member: LeaseMemberView, note: Partial<WorkloadMemberNote>): void {
    const pubkey = this.#deps.vault.status().pubkey;
    if (pubkey === undefined) return;
    this.#deps.notes.write(pubkey, lease.workloadId, {
      members: { [member.pubkey]: note },
      ...(member.index === 0 ? note : {}),
    });
  }

  /** A note about the workload rather than about one of its members. */
  #noteWorkload(workloadId: string, note: Partial<WorkloadNote>): void {
    const pubkey = this.#deps.vault.status().pubkey;
    if (pubkey === undefined) return;
    this.#deps.notes.write(pubkey, workloadId, note);
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  #seconds(): number {
    return Math.floor(this.#at().getTime() / 1000);
  }
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

interface OpPlan {
  readonly route: string;
  readonly payAt: string;
  readonly via: OpRouteView['via'];
  readonly reason: string;
  readonly price?: string | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
  readonly available?: bigint | undefined;
  readonly sealTo: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly channelStore: ChannelStore;
}

/** §6.7's state, reduced to what the routes and the card branch on. */
export function phaseOf(status: WorkloadStatus): MemberPhase | undefined {
  if (status.kind !== 'read') return undefined;
  return status.life.phase === 'ended' ? 'ended' : status.life.phase;
}

/** The set's summary line: how many, what a round costs, who is running it. */
function setViewOf(
  members: readonly WorkloadMemberView[],
  takeover: { report?: TakeoverReport | undefined; unread?: string | undefined }
): StandbySetView {
  const running = members.find((member) => member.runningNow);
  let total = 0n;
  let priced = true;
  for (const member of members) {
    const price = member.extend.route?.price;
    if (member.status.kind === 'read' && member.status.life.phase === 'ended') continue;
    if (price === undefined) {
      priced = false;
      break;
    }
    try {
      total += BigInt(price);
    } catch {
      priced = false;
      break;
    }
  }
  return {
    members: members.length,
    warm: members.length > 1,
    ...(priced ? { pricePerInterval: total.toString() } : {}),
    ...(priced
      ? {}
      : {
          reason:
            'At least one member of this set has no route this console can price right now, ' +
            'so what one round of extensions costs is unknown.',
        }),
    ...(running === undefined
      ? takeover.report === undefined
        ? {}
        : { runningMember: takeover.report.winner }
      : { runningMember: running.pubkey }),
    ...(takeover.report === undefined ? {} : { takeover: takeover.report }),
    ...(takeover.unread === undefined ? {} : { takeoverUnread: takeover.unread }),
  };
}

function viewOf(plan: OpPlan): OpRouteView {
  return {
    route: plan.route,
    payAt: plan.payAt,
    via: plan.via,
    reason: plan.reason,
    ...optional('price', plan.price),
    ...optional('chain', plan.chain),
    ...optional('channelId', plan.channelId),
  };
}

/** A provider's answer on any of the three routes, read defensively. */
export function readAnswer(outcome: PacketOutcome): {
  workloadId?: string;
  role?: string;
  life?: LeaseLife;
  expiresAt?: number;
  access?: LeaseAccess;
  template?: string;
  takeover?: TakeoverView;
  error?: string;
  message?: string;
} {
  if (outcome.kind !== 'answered') return {};
  const body = outcome.body;
  if (typeof body !== 'object' || body === null) {
    return outcome.status === 200
      ? {}
      : { error: `http_${outcome.status}`, message: outcome.text.slice(0, 400) };
  }
  const answer = body as Record<string, unknown>;
  const error = typeof answer.error === 'string' ? answer.error : undefined;
  const takeover = asRecord(answer.takeover);
  const access = answer.access;
  return {
    ...(typeof answer.workload_id === 'string' ? { workloadId: answer.workload_id } : {}),
    ...(typeof answer.role === 'string' ? { role: answer.role } : {}),
    ...optional('life', readLife(answer.state)),
    ...(Number.isInteger(answer.expires_at) ? { expiresAt: answer.expires_at as number } : {}),
    ...(typeof access === 'object' && access !== null
      ? { access: access as LeaseAccess }
      : {}),
    ...(typeof answer.template === 'string' ? { template: answer.template } : {}),
    ...(typeof takeover?.winner === 'string' ? { takeover: { winner: takeover.winner } } : {}),
    ...(error === undefined
      ? outcome.status === 200
        ? {}
        : { error: `http_${outcome.status}` }
      : { error }),
    ...(typeof answer.message === 'string' ? { message: answer.message } : {}),
  };
}

/**
 * §6.7's `state`, off the wire.
 *
 * An ending this build does not know is kept — as `unstated`, with the
 * provider's own word beside it — rather than refused or guessed at. That is
 * the same courtesy §6.7 requires of an Eviction Notice's `reason`, and for
 * the same reason: a later version of the spec may add one, and a console that
 * called it "running" would be lying about a dead workload.
 */
export function readLife(raw: unknown): LeaseLife | undefined {
  if (typeof raw === 'string') {
    return raw === 'provisioning' ||
      raw === 'reserved' ||
      raw === 'running' ||
      raw === 'stopped'
      ? { phase: raw }
      : undefined;
  }
  const ended = asRecord(raw)?.ended;
  if (typeof ended !== 'string') return undefined;
  if (ended === 'expiry' || ended === 'termination' || ended === 'eviction') {
    return { phase: 'ended', ending: ended };
  }
  return { phase: 'ended', ending: 'unstated', word: ended };
}

/** How an ending is said in a sentence, without blurring the three. */
export function endingWords(life: Extract<LeaseLife, { phase: 'ended' }>): string {
  switch (life.ending) {
    case 'expiry':
      return 'Expiry: no payment bought another Lease Interval';
    case 'termination':
      return 'Termination: its tenant ended it';
    case 'eviction':
      return 'Eviction: its provider ended it, and must publish an Eviction Notice';
    default:
      return life.word === undefined
        ? 'the provider did not say which ending'
        : `the provider called it ${JSON.stringify(life.word)}, which this console does not know`;
  }
}

function costOf(outcome: PacketOutcome): string | undefined {
  return outcome.kind === 'unknown' ? undefined : outcome.cost;
}

/** Decimal base units, compared as numbers rather than as strings. */
export function compareAmounts(left: string, right: string): number {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  } catch {
    return Number.NaN;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A unix second as an ISO instant, or nothing at all.
 *
 * `undefined` rather than a throw for a moment no calendar has, because one
 * arrives honestly: a channel holding 1e17 base units against a route priced
 * at four figures really does buy more intervals than there are milliseconds
 * in the ECMAScript date range, and a dashboard must not fall over on an
 * account that is well funded. The seconds are still reported; only the date
 * is missing, which is the part that has no meaning.
 */
function isoOf(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * The chains this connector settles on, with the one this lease is paid on
 * first.
 *
 * A reorder and never a filter: naming a chain this account holds no channel
 * on must degrade to "some other chain, and here is which", not to "no channel
 * at all".
 */
function orderChains<T extends { chain: string }>(
  settlements: readonly T[],
  wanted: string | undefined
): readonly T[] {
  if (wanted === undefined) return settlements;
  return [...settlements].sort((left, right) =>
    left.chain === wanted ? -1 : right.chain === wanted ? 1 : 0
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `exactOptionalPropertyTypes` means an absent field and `undefined` differ. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
