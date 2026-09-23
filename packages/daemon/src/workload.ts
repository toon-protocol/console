import type { ChannelStore } from '@toon-protocol/client';

import { channelAvailable, channelStoreFor, findChannelBinding } from './channel-store.js';
import type { ChainSeedStore } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { mintRequestId } from './continuation.js';
import type { DirectoryResult, ProviderView } from './directory.js';
import { resolveRpc } from './funding.js';
import {
  HiddenTransportError,
  isHiddenServiceUrl,
  proxyRpcFor,
  type HiddenTransportPort,
} from './hidden-transport.js';
import {
  REQUEST_TTL_S,
  routeCarries,
  type PacketOutcome,
  type ProviderPort,
} from './lease.js';
import {
  LeaseVaultError,
  type LeaseAccess,
  type LeaseVault,
  type LeaseView,
} from './lease-vault.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { HEX_32 } from './spawn-content.js';
import type { WorkloadNote, WorkloadNoteStore } from './workload-cache.js';

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
  /**
   * This packet rides an Anyone Protocol circuit, because the connector it is
   * paid at is a Hidden Provider's `.anyone` address (§10). The proxy's own
   * port is not repeated here; `/api/health` names it once.
   */
  readonly overAnon?: boolean | undefined;
  /** Whether the chain RPC rides the same circuit (ADR 0008's third leg). */
  readonly rpcOverAnon?: boolean | undefined;
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
    /**
     * Why a provider that declares itself hidden is not (spec §10, ADR 0008).
     *
     * `hidden` is a self-assertion that nobody outside can verify — but two of
     * its conditions are visible from HERE, and a tenant reading them is
     * entitled to be told. A Profile that carries a `host`, or a lease whose
     * access names something other than a per-lease `.anyone` address, is a
     * clearnet provider with an onion front door. The lease still works and
     * the console still shows what it needs to reach it; what it does not do
     * is keep calling it hidden without comment.
     */
    readonly notHidden?: string | undefined;
  };
  readonly status: WorkloadStatus;
  readonly runway: RunwayView;
  /** What an extension would cost and everything that would refuse one. */
  readonly extend: {
    readonly ok: boolean;
    readonly problems: readonly string[];
    readonly route?: OpRouteView | undefined;
  };
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
  /**
   * The Anyone Protocol carriage (#98, spec §10). A lease on a Hidden Provider
   * is statused, extended and terminated over a circuit, and without one every
   * op on such a lease says so rather than dialling anything.
   */
  readonly hidden?: HiddenTransportPort | undefined;
  readonly paths: ConsolePaths;
  readonly notes: WorkloadNoteStore;
  /** The budgets, when they are wired. A dashboard reads fine without them. */
  readonly autoExtend?: (() => AutoExtendReader) | undefined;
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
   * Ask the provider what this lease is doing (§6.5). Free at the provider.
   *
   * It presents the lease's own Continuation Token, borrowed from the vault
   * for the length of this one packet. A Gateway Grant would also be admitted
   * here (§6.5.1) and is #97's business, not this module's.
   */
  async readStatus(workloadId: string): Promise<WorkloadStatus> {
    return this.#readStatus(this.#lease(workloadId));
  }

  /**
   * **Buy one Lease Interval** for a running lease (§6.3). This spends money.
   *
   * Everything checkable is checked first and the packet is not sent if any of
   * it fails, because §6.3's refusals — `expired`, `not_running`,
   * `wrong_listing_version`, `unknown_workload` — are all billed at the full
   * interval price. The last check is a live `status`, which is free and is
   * the only thing that can say whether this lease is still there to extend.
   *
   * The body is BARE: `{ "workload_id": "…" }`. Any payer may extend any
   * lease, so there is no Lease Request here and no token to present
   * (ADR 0005).
   */
  async extend(
    workloadId: string,
    options: { maxPrice?: string | undefined; chain?: string | undefined } = {}
  ): Promise<ExtendResult> {
    const lease = this.#lease(workloadId);
    const problems: string[] = [];
    const planned = await this.#plan(lease, 'extend', problems, options.chain);
    const status = await this.#readStatus(lease);
    this.#checkExtendable(status, problems);

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

    if (planned === undefined || problems.length > 0) {
      return {
        sent: false,
        problems,
        ...(planned === undefined ? {} : { route: viewOf(planned) }),
        card: await this.#cardWith(lease, status),
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
        route: viewOf(planned),
        message:
          `The extension was sent and nothing came back: ${outcome.message} Whether the ` +
          `interval was bought is unknown. Ask for this lease's status — that is free — ` +
          `before extending again.`,
        card: await this.#cardWith(lease, await this.#readStatus(lease)),
      };
    }

    if (read.error !== undefined) {
      return {
        sent: true,
        problems: [],
        route: viewOf(planned),
        ...(cost === undefined ? {} : { cost }),
        providerError: read.error,
        message:
          `${read.message ?? `The provider refused this extension: ${read.error}.`}` +
          (cost === undefined
            ? ''
            : ` It was billed ${cost} base units anyway — a paid route bills for an answer, ` +
              `and a refusal is one (ADR 0003, spec §5).`),
        card: await this.#cardWith(lease, await this.#readStatus(lease)),
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
    this.#note(lease.workloadId, {
      status: moved,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return {
      sent: true,
      problems: [],
      route: viewOf(planned),
      ...(cost === undefined ? {} : { cost }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      card: await this.#cardWith(lease, moved),
    };
  }

  /**
   * End this lease now (§6.6). Free at the provider, and there is no refund.
   *
   * It presents the lease's own Continuation Token: a Gateway Grant is not
   * enough here and never will be (§6.5.1). The answer carries the ending, so
   * the card says **Termination** — not "expired", not "gone" — and the ending
   * is written down locally so it survives a restart and the provider's own
   * sweep, after which `status` answers `unknown_workload`.
   */
  async terminate(workloadId: string): Promise<TerminateResult> {
    const lease = this.#lease(workloadId);
    const problems: string[] = [];
    const planned = await this.#plan(lease, 'terminate', problems);
    if (planned === undefined || problems.length > 0) {
      return {
        sent: false,
        problems,
        ...(planned === undefined ? {} : { route: viewOf(planned) }),
        card: await this.#card(lease, false),
      };
    }

    const body = await this.#leaseRequest(lease, planned, 'terminate', {
      workload_id: lease.workloadId,
    });
    const outcome = await this.#send(planned, body);
    const cost = costOf(outcome);

    if (outcome.kind === 'unknown') {
      return {
        sent: true,
        problems: [],
        route: viewOf(planned),
        message:
          `The termination was sent and nothing came back: ${outcome.message} Whether the ` +
          `workload was destroyed is unknown. Ask for this lease's status, which is free.`,
        card: await this.#cardWith(lease, await this.#readStatus(lease)),
      };
    }

    const read = readAnswer(outcome);
    if (read.error !== undefined) {
      return {
        sent: true,
        problems: [],
        route: viewOf(planned),
        ...(cost === undefined ? {} : { cost }),
        providerError: read.error,
        message: read.message ?? `The provider refused this termination: ${read.error}.`,
        card: await this.#cardWith(lease, await this.#readStatus(lease)),
      };
    }

    // §6.6 answers `{ workload_id, state: { ended: "termination" } }`, so a
    // tenant needs no second call to see that its lease is over.
    const life = read.life;
    const ended = life?.phase === 'ended' ? life.ending : undefined;
    this.#note(lease.workloadId, {
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
      route: viewOf(planned),
      ...(cost === undefined ? {} : { cost }),
      ended: ended ?? 'termination',
      card: await this.#card(lease, false),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Cards                                                                    */
  /* ------------------------------------------------------------------------ */

  async #card(lease: LeaseView, refresh: boolean): Promise<WorkloadCard> {
    const status = refresh
      ? await this.#readStatus(lease)
      : (this.#noteFor(lease.workloadId)?.status ?? {
          kind: 'unread' as const,
          reason:
            'This lease has not been asked about yet. Asking is free at the provider (§6.5).',
          readAt: this.#at().toISOString(),
        });
    return this.#cardWith(lease, status);
  }

  async #cardWith(lease: LeaseView, status: WorkloadStatus): Promise<WorkloadCard> {
    const problems: string[] = [];
    const plan = await this.#plan(lease, 'extend', problems);
    this.#checkExtendable(status, problems);
    const note = this.#noteFor(lease.workloadId);
    const found = await this.#provider(lease);
    const budget = this.#deps.autoExtend?.();
    const pubkey = this.#deps.vault.status().pubkey;

    return {
      workloadId: lease.workloadId,
      lease,
      provider: {
        pubkey: lease.provider.pubkey,
        ilpAddress: found?.provider.profile.ilpAddress ?? lease.provider.ilp_address,
        connectorUrl: found?.provider.profile.connectorUrl ?? lease.provider.connector_url,
        hidden: found?.provider.profile.hidden ?? lease.provider.hidden === true,
        ...(found === undefined ? {} : { liveness: found.provider.liveness.state }),
        inDirectory: found !== undefined,
        ...optional(
          'notHidden',
          hiddenContradiction(
            found?.provider.profile.hidden ?? lease.provider.hidden === true,
            found?.provider.profile.connectorUrl ?? lease.provider.connector_url,
            status.kind === 'read' ? status.access : lease.access
          )
        ),
      },
      status,
      runway: this.#runway(lease, status, plan),
      extend: {
        ok: problems.length === 0 && plan !== undefined,
        problems,
        ...(plan === undefined ? {} : { route: viewOf(plan) }),
      },
      ...(budget === undefined || pubkey === undefined
        ? {}
        : optional('autoExtend', budget.view(pubkey, lease.workloadId))),
      ...(note?.endedAs === undefined ? {} : { endedAs: note.endedAs }),
    };
  }

  /**
   * The runway, in the units the channel is denominated in.
   *
   * Both halves are read rather than assumed, and either may be missing: an
   * expiry this console has never been told, or a channel it cannot find. What
   * it must never do is put a zero where one of them should be.
   */
  #runway(lease: LeaseView, status: WorkloadStatus, plan: OpPlan | undefined): RunwayView {
    const readAt = this.#at().toISOString();
    const base = {
      listingPrice: lease.listing.price,
      leaseIntervalSeconds: lease.listing.lease_interval_s,
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

    const seconds = paidSeconds + affordableIntervals * lease.listing.lease_interval_s;
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

  async #readStatus(lease: LeaseView): Promise<WorkloadStatus> {
    const readAt = this.#at().toISOString();
    const problems: string[] = [];
    const planned = await this.#plan(lease, 'status', problems);
    if (planned === undefined) {
      const status: WorkloadStatus = { kind: 'unread', reason: problems.join(' '), readAt };
      this.#note(lease.workloadId, { status });
      return status;
    }

    let body: unknown;
    try {
      body = await this.#leaseRequest(lease, planned, 'status', {
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
      this.#note(lease.workloadId, { status });
      return status;
    }

    const outcome = await this.#send(planned, body);
    const status = this.#statusOf(outcome, planned, readAt);
    this.#note(lease.workloadId, {
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

  /** §6.1's Lease Request, with the lease's own token borrowed for one packet. */
  async #leaseRequest(
    lease: LeaseView,
    plan: OpPlan,
    op: 'status' | 'terminate',
    content: Record<string, unknown>
  ): Promise<unknown> {
    return this.#deps.vault.withContinuation(
      lease.workloadId,
      lease.provider.pubkey,
      (continuation) =>
        Promise.resolve({
          request: {
            request_id: mintRequestId(),
            op,
            provider: lease.provider.pubkey,
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
        ...(plan.socksProxy === undefined ? {} : { socksProxy: plan.socksProxy }),
        ...(plan.proxyRpc === undefined ? {} : { proxyRpc: plan.proxyRpc }),
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
    op: 'status' | 'terminate' | 'extend',
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

    const found = await this.#provider(lease);
    const ilpAddress = found?.provider.profile.ilpAddress ?? lease.provider.ilp_address;
    const sealTo =
      found?.provider.profile.connectorSealKey ?? lease.provider.connector_seal_key;
    const providerConnector =
      found?.provider.profile.connectorUrl ?? lease.provider.connector_url;

    let route: string;
    if (op === 'extend') {
      if (found === undefined) {
        problems.push(
          `No current Profile for this provider was on ${profile.label}'s relays, so neither ` +
            `its route nor whether it still sells ${JSON.stringify(lease.listing.name)} at ` +
            `v${lease.listing.version} can be read. An extension on a retired version is ` +
            `refused \`wrong_listing_version\` — and billed — so none was sent (spec §6.3).`
        );
        return undefined;
      }
      const listing = found.provider.listings.find(
        (candidate) => candidate.name === lease.listing.name
      );
      if (listing === undefined) {
        problems.push(
          `This provider no longer publishes a Listing named ` +
            `${JSON.stringify(lease.listing.name)}. It sells ` +
            `${found.provider.listings.map((entry) => entry.name).join(', ') || 'nothing'}. ` +
            `An extension has to name this lease's own listing and version (§6.3).`
        );
        return undefined;
      }
      if (listing.version !== lease.listing.version) {
        problems.push(
          `This lease was bought on ${listing.name} v${lease.listing.version} and the provider ` +
            `now publishes v${listing.version}. §6.3 requires the lease's own version on the ` +
            `route, and a version change is a price or resource change (ADR 0009) — so an ` +
            `extension here is either refused \`wrong_listing_version\` at full price, or it ` +
            `is a different offer from the one this lease was bought at. Nothing was sent.`
        );
        return undefined;
      }
      route = `${ilpAddress}.${listing.name}.v${listing.version}.extend`;
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
      socksProxy?: string | undefined;
    }[] = [];
    const refusals: string[] = [];
    for (const candidate of candidates) {
      // A `.anyone` connector is a Hidden Provider's, and it is reached over a
      // circuit or not at all (spec §10, ADR 0008). Resolved BEFORE the health
      // read, because the health read is itself a dial: `readHealth` carries
      // this console's own address to whatever it asks. A carriage that will
      // not open takes this candidate out of the running with a reason — it
      // never demotes it to a direct dial. See `hidden-transport.ts`.
      let socksProxy: string | undefined;
      if (isHiddenServiceUrl(candidate.url)) {
        const carriage = this.#deps.hidden;
        if (carriage === undefined) {
          refusals.push(
            `${candidate.url} is a Hidden Provider's connector, reachable only over an Anyone ` +
              `Protocol circuit, and this build has no carriage for one (spec §10).`
          );
          continue;
        }
        try {
          socksProxy = (await carriage.open()).socksProxy;
        } catch (error) {
          refusals.push(
            error instanceof HiddenTransportError
              ? error.message
              : `The Anyone Protocol carriage could not be opened: ${
                  error instanceof Error ? error.message : String(error)
                }`
          );
          continue;
        }
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
      priced.push({ ...candidate, price: quoted, health, socksProxy });
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
      ...(chosen.socksProxy === undefined ? {} : { socksProxy: chosen.socksProxy }),
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
      const rpcUrl = resolveRpc(profile, settlement.kind).url;
      return {
        ...plan,
        chain: settlement.chain,
        channelId: binding.channelId,
        chainKind: settlement.kind,
        rpcUrl,
        // The chain rides the circuit beside the packets unless it is already
        // private, where `anon` would build no circuit at all.
        ...(chosen.socksProxy === undefined ? {} : { proxyRpc: await proxyRpcFor(rpcUrl) }),
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
    const fallbackRpc = resolveRpc(profile, first?.kind ?? 'evm').url;
    return {
      ...plan,
      chainKind: first?.kind ?? 'evm',
      rpcUrl: fallbackRpc,
      ...(chosen.socksProxy === undefined ? {} : { proxyRpc: await proxyRpcFor(fallbackRpc) }),
    } as OpPlan;
  }

  /**
   * Everything §6.3 would refuse an extension for that a free `status` already
   * told us — checked here so the packet is never sent.
   */
  #checkExtendable(status: WorkloadStatus, problems: string[]): void {
    if (status.kind === 'unread') {
      problems.push(
        `This lease's state could not be read, and an extension is only worth buying for a ` +
          `lease that is still there: §6.3 refuses an ended one \`expired\` and bills for the ` +
          `refusal. ${status.reason}`
      );
      return;
    }
    if (status.kind === 'silent') {
      problems.push(
        `This provider is not answering, so whether this lease is still running is unknown. ` +
          `Nothing was sent: an extension buys an interval on a lease that may have ended, and ` +
          `§6.3 bills for the \`expired\` that would come back. ${status.reason}`
      );
      return;
    }
    if (status.kind === 'refused') {
      problems.push(
        `The provider answered \`${status.code}\` when asked about this lease, so an extension ` +
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
    if (status.life.phase === 'reserved') {
      problems.push(
        `This lease is a Warm Standby reservation, and a reservation is extended on ` +
          `\`.standby.extend\` at the standby price, never on \`.extend\` — which refuses it ` +
          `\`not_running\` and bills at the running price (§6.3). Warm Standbys are ` +
          `TOON_Network#95.`
      );
    }
  }

  /* ------------------------------------------------------------------------ */

  /** The provider's CURRENT Profile, when the directory could be read. */
  async #provider(lease: LeaseView): Promise<{ provider: ProviderView } | undefined> {
    const directory = await this.#deps
      .readDirectory(this.#deps.profile())
      .catch(() => undefined);
    if (directory === undefined || directory.state !== 'ok') return undefined;
    const provider = directory.providers.find(
      (candidate) => candidate.pubkey === lease.provider.pubkey
    );
    return provider === undefined ? undefined : { provider };
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

  #note(workloadId: string, note: Partial<WorkloadNote>): void {
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
  /** Set only when this packet rides a circuit to a `.anyone` connector (§10). */
  readonly socksProxy?: string | undefined;
  readonly proxyRpc?: boolean | undefined;
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
    ...(plan.socksProxy === undefined
      ? {}
      : { overAnon: true, rpcOverAnon: plan.proxyRpc === true }),
  };
}

/**
 * What this console can see that contradicts `hidden: true` (spec §10).
 *
 * Three of ADR 0008's five conditions are invisible from a tenant's side —
 * workload egress, the settlement RPC, and whether the provider also answers
 * somewhere else. Two are not: the connector it publishes, and the address a
 * lease answers on. Those are checked here, and nothing else is guessed at.
 */
export function hiddenContradiction(
  hidden: boolean,
  connectorUrl: string,
  access: LeaseAccess | undefined
): string | undefined {
  if (!hidden) return undefined;
  if (connectorUrl.length > 0 && !isHiddenServiceUrl(connectorUrl)) {
    return (
      `This provider declares itself hidden, but the connector its Profile publishes ` +
      `(${connectorUrl}) is a clearnet address. §10 requires a Hidden Provider's connector ` +
      `to be reachable only at an \`.anyone\` address, so it is not hidden in any sense this ` +
      `console can honour.`
    );
  }
  const host = access?.host;
  if (host !== undefined && host.length > 0 && !host.endsWith('.anyone')) {
    return (
      `This provider declares itself hidden, but this lease answers at ${host} rather than a ` +
      `per-lease \`.anyone\` address (§10). Its location is not hidden from you, and this ` +
      `console makes no claim that it is hidden from anybody else.`
    );
  }
  return undefined;
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
