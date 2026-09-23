import type { ChannelStore, GasStationReceipt } from '@toon-protocol/client';

import { channelAvailable, channelStoreFor, findChannelBinding } from './channel-store.js';
import type { ChainSeedStore, PayerKeys } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import type { FundingStatus } from './funding.js';
import { buildLamportTransfer } from './gas-transfer.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import { routePriceFor } from './relay-write.js';

/**
 * **Buying the next chain's gas with the chain that is already paid for**
 * (TOON_Network#119).
 *
 * #90 established the wall and left it standing: opening a payment channel is
 * an on-chain transaction, it costs the chain's own coin, TOON Network settles
 * in a token and mints no coin, and no faucet in this network gives any. A
 * person with a fresh Chain Seed is outside the network on every chain at
 * once, and the funding view's job was to say so before a transaction failed
 * rather than after.
 *
 * The fleet already contained half an answer. `toon-protocol/gas-station` is a
 * TOON app that spends its own native token on somebody else's transaction and
 * sells that as a NIP-90 job — and it is *paid over a payment channel*. Which
 * is the whole shape of this module: **a claim signed against a channel on one
 * chain costs no gas on any chain**, so an account holding one funded channel
 * can buy native gas for a chain it cannot transact on at all.
 *
 * Five facts shape every line here, and two of them are unwelcome.
 *
 * **The first channel on the first chain still has no route through this, and
 * this module says so in those words.** Paying a gas station needs an open
 * channel; opening one needs gas; so the very first one has to come from
 * outside. {@link GasStationStatus.firstChannel} is that sentence, and it is
 * present exactly when no chain has a channel — never softened, never dropped
 * because a button would look better without it.
 *
 * **Only the Solana job delivers gas to an address, and it is not an
 * oversight.** A kind:5096 job is co-signed by the station as fee payer, and
 * its gate permits one `System::Transfer` whose source is that fee payer,
 * counted against the station's own rent allowance — the lane a zero-SOL
 * client's rent already travels on the ANT path. The EVM job, kind:5098, is a
 * different thing entirely: it relays an ERC-2771 forward request, its `to`
 * must be the configured `TokenNetwork`, its `value` cap is zero and its
 * selector whitelist is deposit / close / settle. It will not send ETH to
 * anybody, on purpose — an EVM gas station that did would be a faucet, drained
 * in one request. So a chain this console cannot buy gas for is reported with
 * that reason verbatim rather than with a button that would be refused.
 *
 * **The connector's price is the price (TOON_Network#82).** Nothing here
 * multiplies or rounds one. The route price shown before a purchase is the
 * figure whoever quotes the route published; the cost reported after it is
 * what came back on the claim; and the job itself is priced by the STATION, in
 * its own quote, which is shown before the execute is paid for.
 *
 * **A refused paid request is still billed (ADR 0003, TOON_Network#115).** So
 * every packet is checked before it leaves — {@link checkGasJob} is this
 * module's `checkLeaseBody`, and it throws rather than returning, because
 * nothing a person types chooses a job's param shape. And a station that
 * declines to spend has NOT failed: `status: 'failed'` with a machine-readable
 * `reason` is a successful job with a receipt, it cost what a receipt costs,
 * and this module reports the reason and the cost rather than calling it an
 * error.
 *
 * **It never opens a channel.** Like `relay-write.ts`, and for the same
 * reason: an open locks collateral on chain and pays that chain's gas. A gas
 * purchase with nowhere to pay from is reported as one, with the chain that
 * would have to be funded named.
 */

/* -------------------------------------------------------------------------- */
/* The job port                                                               */
/* -------------------------------------------------------------------------- */

/** One paid NIP-90 job, as the port needs it sent. */
export interface GasJobPacket {
  /** The connector edge whose channel pays for this packet. */
  readonly payAt: string;
  /** The paid ILP destination — a door the gas station's connector terminates. */
  readonly destination: string;
  /**
   * The terminating connector's own sealing key, when {@link payAt} FORWARDS
   * {@link destination} rather than terminating it.
   *
   * The same rule as a forwarded relay write (#121): a payload is sealed to
   * the connector that terminates it, and no hop may name that key on its
   * behalf. Here the key is read from the gas station connector's own
   * `GET /ilp`, which is the node itself speaking.
   */
  readonly sealTo?: string | undefined;
  readonly kind: number;
  /** The job's `['param', key, value]` tags. An absent value is omitted. */
  readonly params: Record<string, string | undefined>;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly keys: PayerKeys;
  readonly channelStore: ChannelStore;
  readonly timeoutMs?: number | undefined;
}

/**
 * What came back, in the three kinds a caller must tell apart.
 *
 * The same three as a relay write's and a spawn's. `receipt` and `refused` are
 * DEFINITIVE; `unknown` is a packet whose fate nobody reported, and a purchase
 * whose execute is `unknown` must not be called delivered and must not be
 * called lost either — the transaction may well have landed, and the way to
 * find out is to retry with the same idempotency key.
 */
export type GasJobOutcome =
  | {
      readonly kind: 'receipt';
      readonly receipt: GasStationReceipt;
      readonly cost?: string | undefined;
      readonly channelId?: string | undefined;
    }
  | {
      readonly kind: 'refused';
      /** An ILP reject code, or the app's own `F00` / `T00`. */
      readonly code: string;
      readonly message: string;
      readonly cost?: string | undefined;
    }
  | { readonly kind: 'unknown'; readonly message: string };

export interface GasJobPort {
  send(packet: GasJobPacket): Promise<GasJobOutcome>;
}

/* -------------------------------------------------------------------------- */
/* The guard                                                                  */
/* -------------------------------------------------------------------------- */

/** A job this console refused to send. Thrown BEFORE the packet, which is the point. */
export class GasJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GasJobError';
  }
}

/**
 * The check every gas job passes before it leaves — this module's
 * `checkLeaseBody` (TOON_Network#115, ADR 0003).
 *
 * A connector collects a paid route's price before the app reads a byte of the
 * body, so a job missing a param the station requires is `F00` *after* the
 * route's full price has been spent, with no refund. The station publishes the
 * required params per phase in its own `/describe`, and these are those two
 * lists: `phase` and optionally a draft for a quote; `phase`, `transaction`,
 * `quoteId` and `idempotencyKey` for an execute.
 *
 * It throws, like `checkLeaseBody` and `carriageRefusal`, because nothing a
 * person types chooses a param shape: a mismatch here is a bug in this
 * repository, and returning it would invite a caller to send anyway.
 */
export function checkGasJob<T extends Record<string, string | undefined>>(
  phase: 'quote' | 'execute',
  params: T
): T {
  const missing = (REQUIRED[phase] as readonly string[]).filter(
    (name) => params[name] === undefined || params[name] === ''
  );
  if (missing.length > 0) {
    throw new GasJobError(
      `A kind:5096 ${phase} names ${REQUIRED[phase].join(', ')}, and this one is missing ` +
        `${missing.join(', ')}. A gas station answers an incomplete job F00 AFTER the route's ` +
        `full price has been collected (ADR 0003), so nothing was sent.`
    );
  }
  if (params['phase'] !== phase) {
    throw new GasJobError(
      `A ${phase} job carries ['param','phase','${phase}'] and this one carries ` +
        `${JSON.stringify(params['phase'])}. A phase-scoped door refuses the wrong phase F00 ` +
        `at that door's full price, and gets nothing. Nothing was sent.`
    );
  }
  return params;
}

const REQUIRED = {
  quote: ['phase'],
  execute: ['phase', 'transaction', 'quoteId', 'idempotencyKey'],
} as const;

/* -------------------------------------------------------------------------- */
/* What a caller sees                                                         */
/* -------------------------------------------------------------------------- */

export type GasBuyVerdict =
  /** A quote can be bought right now, and the plan says what it costs. */
  | 'buyable'
  /** This chain can already pay for a transaction. Nothing to buy. */
  | 'not_blocked'
  /**
   * No job this console can drive puts native gas at an address on this chain.
   * The reason names which job and why — it is a property of the station, not
   * a gap here.
   */
  | 'unsupported'
  /** This profile names no gas station, so there is nothing to ask. */
  | 'no_station'
  | 'station_unreachable'
  /** Nothing the station terminates can be paid for from where this console sits. */
  | 'no_route'
  /** No channel anywhere to sign a claim against. The first-channel case. */
  | 'no_channel'
  /** A channel, but less left in it than one packet costs. */
  | 'unaffordable';

/** Which channel would pay, and at which edge. */
export interface GasPayer {
  /** The chain whose channel signs the claim. Never the chain being bought for. */
  readonly chain: string;
  readonly channelId: string;
  /** `deposit - spent`, when both are known. Never a zero standing in for unknown. */
  readonly available?: string | undefined;
  /** The connector edge the packet is paid at, as that connector names itself. */
  readonly payAt: string;
  /** Whether that edge TERMINATES the door, or forwards it to the station's own. */
  readonly via: 'station-connector' | 'forwarded';
}

export interface GasBuyChain {
  /** The chain that is blocked, verbatim from `GET /ilp`. */
  readonly chain: string;
  readonly kind: 'evm' | 'solana';
  /** Where bought gas would land: this account's own address on that chain. */
  readonly recipient: string;
  readonly verdict: GasBuyVerdict;
  /** Said plainly, whether or not there is anything to do about it. */
  readonly reason: string;
  readonly payer?: GasPayer | undefined;
  /** The door a job would go through, and what the route quoted for it. */
  readonly destination?: string | undefined;
  readonly price?: string | undefined;
  /** How many lamports this console would ask the station to move. */
  readonly lamports?: string | undefined;
}

export interface GasStationView {
  /** Where the station's connector is, as this console was configured to reach it. */
  readonly connectorUrl: string;
  /** What that connector calls itself — what a channel with it is bound under (#126). */
  readonly selfEndpoint?: string | undefined;
  /** The doors it terminates, verbatim. */
  readonly doors: readonly string[];
  readonly reachable: boolean;
  readonly reason?: string | undefined;
}

export interface GasStationStatus {
  readonly state: 'signed_out' | 'unconfigured' | 'no_station' | 'ready';
  readonly station?: GasStationView | undefined;
  readonly chains: readonly GasBuyChain[];
  /**
   * The sentence #119 refuses to let this feature drown out, present exactly
   * when this account holds no channel anywhere.
   *
   * A gas station is paid over a channel. So it unblocks every chain after the
   * first and none before it, and a console that let a "buy gas" button imply
   * otherwise would be selling a way in that does not exist.
   */
  readonly firstChannel?: string | undefined;
  readonly reason?: string | undefined;
  readonly checkedAt: string;
}

/** A station's quote, held between the screen that shows it and the purchase. */
export interface GasQuote {
  readonly chain: string;
  readonly quoteId: string;
  /** The address the transaction must name as fee payer: the station's own. */
  readonly feePayer: string;
  /** Where the lamports land. */
  readonly recipient: string;
  /** What this console asked the station to move. */
  readonly lamports: string;
  /** The station's own ceiling for this job, from its quote. */
  readonly maxLamports: string;
  /**
   * The blockhash the executed transaction must carry, base58, as the station
   * named it. It refuses anything else (`blockhash_mismatch`).
   */
  readonly recentBlockhash: string;
  /** ms epoch, as the station sent it: quote TTL and blockhash validity, merged. */
  readonly expiresAt: number;
  readonly destination: string;
  readonly payAt: string;
  /** What the route quoted, before it was bought. Never recomputed (#82). */
  readonly price: string;
  /** What this quote packet actually cost, from the claim. */
  readonly cost?: string | undefined;
  /** Every packet this quote took, including the doors that refused it. */
  readonly attempts: readonly GasAttempt[];
}

/** One packet, and what it cost — refusals included, because they are billed. */
export interface GasAttempt {
  readonly destination: string;
  readonly phase: 'quote' | 'execute';
  readonly outcome: 'receipt' | 'refused' | 'unknown';
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly cost?: string | undefined;
}

export interface GasPurchase {
  readonly chain: string;
  readonly state:
    /** The station co-signed and broadcast it, and named the signature. */
    | 'delivered'
    /** The station applied its rules and declined. A receipt, and it was billed. */
    | 'refused'
    /** Nobody reported this packet's fate. It may still have landed. */
    | 'unknown';
  readonly signature?: string | undefined;
  readonly slot?: string | undefined;
  /** What was asked for. What arrived is what the chain says; refresh and look. */
  readonly lamports?: string | undefined;
  readonly recipient: string;
  /** The station's own closed vocabulary — branch on this, never on `detail`. */
  readonly reason?: string | undefined;
  readonly detail?: string | undefined;
  /** Every packet this purchase paid for, quote included. */
  readonly attempts: readonly GasAttempt[];
  /** Quote and execute summed, refusals included. TOON bills for an answer. */
  readonly cost?: string | undefined;
  readonly at: string;
}

export class GasStationError extends Error {
  readonly code: string;
  readonly status: number;
  /** What was paid for on the way to this failure. Never dropped. */
  readonly attempts: readonly GasAttempt[];
  constructor(
    code: string,
    message: string,
    status = 409,
    attempts: readonly GasAttempt[] = []
  ) {
    super(message);
    this.name = 'GasStationError';
    this.code = code;
    this.status = status;
    this.attempts = attempts;
  }
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface GasStationDeps {
  readonly profile: () => NetworkProfile;
  /** The funding view: the chains, their gas verdicts and their addresses. */
  readonly funding: () => Promise<FundingStatus>;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  /** Any connector by URL — the gas station's is never the profile's. */
  readonly readHealthAt: (connectorUrl: string) => Promise<ConnectorHealth>;
  readonly chainSeed: ChainSeedStore;
  readonly paths: ConsolePaths;
  readonly port: GasJobPort;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  /** How many lamports one purchase asks for. For the tests, and for a caller. */
  readonly lamports?: bigint | undefined;
}

/**
 * How many lamports a purchase asks the station to move, when nobody says.
 *
 * An ASK, not a fact about any chain: what a station will actually pay is its
 * own, and its quote says so. This is the largest figure a stock deployment's
 * rent allowance admits, so one packet buys as much as one packet can; a
 * station configured lower refuses and names its own allowance, which is a
 * sentence worth reading rather than a number worth guessing at.
 */
export const DEFAULT_PURCHASE_LAMPORTS = 10_000_000n;

/** The NIP-90 job that pays Solana gas. The EVM one, 5098, sends nobody funds. */
const SOLANA_GAS_KIND = 5096;

export class GasStationStore {
  readonly #deps: GasStationDeps;
  /** Doors learned to refuse a phase, so a second purchase does not pay to relearn. */
  readonly #refuses = new Map<string, Set<string>>();
  /** The quotes shown but not yet acted on, by chain. */
  readonly #quotes = new Map<string, GasQuote>();
  /**
   * Each station's own fee payer, learned from its first quote of the session.
   *
   * A draft must name it as account 0, and nothing publishes it, so the first
   * quote is bought to find it out. Remembering it is what keeps every later
   * purchase to two packets rather than three.
   */
  readonly #feePayers = new Map<string, string>();

  constructor(deps: GasStationDeps) {
    this.#deps = deps;
  }

  /**
   * What could be bought, for which chain, from which channel, at what price.
   *
   * Reads and nothing else: the funding view, two connectors' self-descriptions
   * and this console's own channel store. No key is borrowed and no packet is
   * sent, so a window can poll this beside the funding view it belongs to.
   */
  async status(): Promise<GasStationStatus> {
    const profile = this.#deps.profile();
    const at = this.#at().toISOString();
    const funding = await this.#deps.funding();

    if (funding.state === 'signed_out') {
      return { state: 'signed_out', chains: [], reason: funding.reason ?? '', checkedAt: at };
    }
    if (!isConfigured(profile) || funding.state !== 'ready') {
      return {
        state: 'unconfigured',
        chains: [],
        reason:
          funding.reason ??
          `${profile.label} names no connector, so which chains it settles on is unknown.`,
        checkedAt: at,
      };
    }

    const stationUrl = profile.gasConnectorUrl;
    if (stationUrl === '') {
      return {
        state: 'no_station',
        chains: [],
        reason:
          `${profile.label} names no gas station. A gas station is a separate TOON app ` +
          `behind a connector of its own, exactly as a Workload Gateway is, so a profile ` +
          `that names none has nothing to ask what it would charge to pay a stranger's gas.`,
        checkedAt: at,
      };
    }

    const station = await this.#deps.readHealthAt(stationUrl);
    const own = await this.#deps.readHealth(profile);
    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const view: GasStationView =
      station.state === 'ok'
        ? {
            connectorUrl: stationUrl,
            selfEndpoint: station.selfEndpoint,
            doors: station.ilpAddresses,
            reachable: true,
          }
        : {
            connectorUrl: stationUrl,
            doors: [],
            reachable: false,
            reason: station.reason,
          };

    const payer = this.#payer(funding, station, own, channels.store);
    const chains = funding.chains.map((chain) =>
      this.#chainPlan({ chain, funding, station, own, payer })
    );

    return {
      state: 'ready',
      station: view,
      chains,
      ...(payer.kind === 'no_channel' ? { firstChannel: FIRST_CHANNEL(profile) } : {}),
      checkedAt: at,
    };
  }

  /**
   * Buy a quote: what the station will do, what it will cost, and the
   * blockhash the transaction must carry — without spending a lamport of its
   * float.
   *
   * It is the two-quote ceremony `@toon-protocol/client`'s own ANT spawn
   * makes, and for the same two reasons. A draft must name the station's fee
   * payer as account 0 or it is `fee_payer_mismatch`, and that address is a
   * fact only the station has — so the first quote of a session goes WITHOUT a
   * draft, purely to learn it, and is remembered afterwards. And a quote
   * carrying the draft is what makes the second one worth paying for: the
   * station runs its whole policy gate against those bytes and prices
   * `maxLamports` from an actual simulation, so an amount over its rent
   * allowance or a float it cannot cover is learned HERE rather than on the
   * execute — and a quote priced without a draft would cap the job at the
   * station's default allowance and refuse the transfer as
   * `delta_cap_exceeded`.
   */
  async quote(input: { chain: string; lamports?: string }): Promise<GasQuote> {
    const lamports = readLamports(input.lamports) ?? this.#lamports();
    const plan = await this.#buyable(input.chain);
    const attempts: GasAttempt[] = [];

    let feePayer = this.#feePayers.get(plan.payer.payAt);
    if (feePayer === undefined) {
      const first = this.#readQuote(
        await this.#job({ plan, phase: 'quote', params: { phase: 'quote' }, attempts }),
        attempts
      );
      feePayer = first.feePayer;
      this.#feePayers.set(plan.payer.payAt, feePayer);
    }

    const draft = buildLamportTransfer({
      feePayer,
      recipient: plan.chain.recipient,
      lamports,
    });
    const answer = await this.#job({
      plan,
      phase: 'quote',
      params: { phase: 'quote', transaction: draft },
      attempts,
    });
    const receipt = this.#readQuote(answer, attempts);

    const quote: GasQuote = {
      chain: plan.chain.chain,
      quoteId: receipt.quoteId,
      feePayer: receipt.feePayer,
      recipient: plan.chain.recipient,
      lamports: lamports.toString(),
      maxLamports: receipt.maxLamports,
      recentBlockhash: receipt.recentBlockhash,
      expiresAt: receipt.expiresAt,
      destination: answer.destination,
      payAt: plan.payer.payAt,
      price: plan.chain.price ?? '',
      ...(answer.cost === undefined ? {} : { cost: answer.cost }),
      attempts,
    };
    this.#quotes.set(plan.chain.chain, quote);
    return quote;
  }

  /**
   * A quote receipt, or the refusal that is not one.
   *
   * A station that declines has NOT failed — it was asked a question, applied
   * its rules and answered — so the reason is its own word, carried out of
   * here as the error's code for a caller to branch on. It cost a packet
   * either way, and the attempts say so.
   */
  #readQuote(answer: JobAnswer, attempts: readonly GasAttempt[]) {
    const receipt = answer.receipt;
    if (receipt.job !== 'gas-station') {
      throw new GasStationError(
        'unexpected_receipt',
        `The gas station answered a kind:${SOLANA_GAS_KIND} quote with something that is not ` +
          `a gas-station receipt. Nothing further was sent; the packet was still billed.`,
        502,
        attempts
      );
    }
    if (receipt.status === 'failed') {
      throw new GasStationError(
        receipt.reason,
        `The gas station declined to quote this: ${receipt.detail} It answered, so the packet ` +
          `was billed (ADR 0003) — nothing was bought and no transaction exists.`,
        409,
        attempts
      );
    }
    if (receipt.phase !== 'quote') {
      throw new GasStationError(
        'unexpected_receipt',
        `A quote was answered with a ${receipt.phase} receipt. Nothing further was sent.`,
        502,
        attempts
      );
    }
    return receipt;
  }

  /**
   * Pay the station to co-sign and broadcast, and let the lamports land.
   *
   * The quote is the one that was SHOWN: the transaction is rebuilt against
   * its fee payer and its blockhash, and the job names its `quoteId`. A quote
   * that has passed its deadline is refused here, free, rather than sent — the
   * station would answer `quote_expired` and bill for saying so.
   */
  async buy(input: { chain: string; quoteId: string }): Promise<GasPurchase> {
    const held = this.#quotes.get(input.chain);
    if (held === undefined || held.quoteId !== input.quoteId) {
      throw new GasStationError(
        'unknown_quote',
        `This console is not holding a gas station quote ${JSON.stringify(input.quoteId)} for ` +
          `${input.chain}. A purchase pays for the quote it showed, so that the figure on the ` +
          `screen is the one that was agreed to. Ask for a quote and buy that one. Nothing ` +
          `was sent and nothing was billed.`,
        409
      );
    }
    const now = this.#at().getTime();
    if (held.expiresAt <= now) {
      this.#quotes.delete(input.chain);
      throw new GasStationError(
        'quote_expired',
        `That quote expired ${Math.round((now - held.expiresAt) / 1000)}s ago. A gas station ` +
          `merges its quote's deadline with the validity of the blockhash it named, because a ` +
          `transaction built on an expired blockhash cannot be broadcast anyway. Quote again. ` +
          `Nothing was sent and nothing was billed for this attempt.`,
        409
      );
    }

    const plan = await this.#buyable(input.chain);
    const attempts: GasAttempt[] = [];
    // Built against the quote's own fee payer and its own blockhash, because
    // the station refuses anything else — `fee_payer_mismatch` for the first
    // and `blockhash_mismatch` for the second. No signature is added: the fee
    // payer is the transaction's ONLY required signer, so the one slot on the
    // wire is the station's to fill and this console holds no key it belongs
    // to. That is also what lets gas be bought for an address whose private
    // half never leaves `chain-seed.ts`.
    const transaction = buildLamportTransfer({
      feePayer: held.feePayer,
      recipient: held.recipient,
      lamports: BigInt(held.lamports),
      recentBlockhash: held.recentBlockhash,
    });

    const answer = await this.#job({
      plan,
      phase: 'execute',
      params: {
        phase: 'execute',
        transaction,
        quoteId: held.quoteId,
        // Any unique string, and it is what makes a retry safe: a
        // confirmation timeout does not mean the transaction failed, so the
        // same key returns the original result rather than broadcasting
        // twice. Keyed by the quote, which is what a retry is retrying.
        idempotencyKey: `toon-console/${held.chain}/${held.quoteId}`,
      },
      attempts,
    });

    this.#quotes.delete(input.chain);
    const receipt = answer.receipt;
    const cost = sumOf([...held.attempts, ...attempts].map((entry) => entry.cost));
    const base = {
      chain: held.chain,
      recipient: held.recipient,
      attempts: [...held.attempts, ...attempts],
      ...(cost === undefined ? {} : { cost }),
      at: this.#at().toISOString(),
    };

    if (receipt.job !== 'gas-station' || receipt.status === 'failed') {
      const failed = receipt.job === 'gas-station' && receipt.status === 'failed';
      return {
        ...base,
        state: 'refused',
        reason: failed ? receipt.reason : 'unexpected_receipt',
        detail: failed
          ? receipt.detail
          : 'The gas station answered with something that is not a gas-station receipt.',
      };
    }
    if (receipt.phase !== 'execute') {
      return {
        ...base,
        state: 'refused',
        reason: 'unexpected_receipt',
        detail: `The execute was answered with a ${receipt.phase} receipt.`,
      };
    }

    return {
      ...base,
      state: 'delivered',
      signature: receipt.signature,
      ...(receipt.slot === null ? {} : { slot: receipt.slot }),
      lamports: held.lamports,
    };
  }

  /** Drop everything this account and profile cached. A sign-out, or a switch. */
  forget(): void {
    this.#quotes.clear();
    this.#refuses.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Planning                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Which channel pays for a gas job, and at which edge.
   *
   * The insight the whole ticket rests on: **a claim costs no gas on any
   * chain**. So the channel that pays need not be — and by construction is
   * not — on the chain being bought for. Any open channel with enough left in
   * it will do, at either the station's own connector or at one that forwards
   * to it.
   *
   * A channel with the STATION's connector is preferred when there is one,
   * because that edge terminates every door the station publishes; a forward
   * reaches only the doors the hub happens to carry, and on a network where
   * the hub carries one of three that is the difference between quoting and
   * not.
   */
  #payer(
    funding: FundingStatus,
    station: ConnectorHealth,
    own: ConnectorHealth,
    store: ChannelStore
  ): PayerChoice {
    const stationId = station.state === 'ok' ? station.selfEndpoint : undefined;
    const ownId = own.state === 'ok' ? own.selfEndpoint : undefined;
    // The station's own edge first, then this profile's. Each is looked up by
    // what the CONNECTOR says about itself, never by the URL this console
    // dialled: a channel opened while reaching a connector under one spelling
    // of its host has to be found again under another (TOON_Network#126).
    const edges = [
      ...(stationId === undefined
        ? []
        : [{ id: stationId, via: 'station-connector' as const }]),
      ...(ownId === undefined || ownId === stationId
        ? []
        : [{ id: ownId, via: 'forwarded' as const }]),
    ];

    const found: { payer: GasPayer; available: bigint | undefined }[] = [];
    for (const edge of edges) {
      for (const chain of funding.chains) {
        const binding = findChannelBinding(store, edge.id, chain.chain);
        if (!binding) continue;
        const available = channelAvailable(store, binding);
        found.push({
          payer: {
            chain: chain.chain,
            channelId: binding.channelId,
            ...(available === undefined ? {} : { available: available.toString() }),
            payAt: edge.id,
            via: edge.via,
          },
          available,
        });
      }
    }
    if (found.length === 0) return { kind: 'no_channel' };
    // A channel whose remaining collateral is KNOWN and non-zero beats one
    // whose watermark could not be squared, and the edge order above breaks
    // the rest. An unknown figure is never read as zero — it just does not win
    // a tie.
    const best =
      found.find((entry) => entry.available !== undefined && entry.available > 0n) ?? found[0];
    if (best === undefined) return { kind: 'no_channel' };
    return {
      kind: 'ready',
      payer: best.payer,
      ...(best.available === undefined ? {} : { available: best.available }),
    };
  }

  /** One chain's verdict: what it would take to unblock it, or why nothing will. */
  #chainPlan(input: {
    chain: FundingStatus['chains'][number];
    funding: FundingStatus;
    station: ConnectorHealth;
    own: ConnectorHealth;
    payer: PayerChoice;
  }): GasBuyChain {
    const { chain, station, own, payer } = input;
    const base = {
      chain: chain.chain,
      kind: chain.kind,
      recipient: chain.deposit.address,
    };

    if (chain.gas.verdict === 'present') {
      return {
        ...base,
        verdict: 'not_blocked',
        reason:
          `This address can already pay for a transaction on ${chain.chain}, so there is ` +
          `nothing to buy.`,
      };
    }
    if (chain.kind !== 'solana') {
      return {
        ...base,
        verdict: 'unsupported',
        reason:
          `A gas station will not sell native ${chain.gas.symbol ?? 'coin'} on ${chain.chain}, ` +
          `and that is a decision rather than a gap. Its EVM job (kind:5098) relays a call you ` +
          `signed and pays the gas for it — its \`to\` must be the connector's own ` +
          `TokenNetwork, its native \`value\` cap is zero, and it will only relay a deposit, a ` +
          `close or a settle. An EVM gas station that sent coin to an address that asked would ` +
          `be a faucet, and would be emptied by the first caller. So this chain's coin still ` +
          `has to come from a wallet that holds some.`,
      };
    }
    if (station.state !== 'ok') {
      return {
        ...base,
        verdict: 'station_unreachable',
        reason:
          `The gas station's connector did not answer, so what it charges and what it would ` +
          `do are unknown — and a job sent to a connector that may not be there is a packet ` +
          `paid for and lost. ${station.reason}`,
      };
    }
    if (payer.kind !== 'ready') {
      return {
        ...base,
        verdict: 'no_channel',
        reason:
          `A gas station is paid over a payment channel, and this account holds none. That is ` +
          `the one thing buying gas cannot solve: the FIRST channel on the FIRST chain has to ` +
          `be opened with coin that came from outside this network.`,
      };
    }

    const doors = this.#doors(station, own, payer.payer);
    const door = doors[0];
    if (door === undefined) {
      return {
        ...base,
        verdict: 'no_route',
        payer: payer.payer,
        reason:
          `Nothing the gas station's connector terminates can be paid for from the channel ` +
          `this account holds at ${payer.payer.payAt}. The station publishes ` +
          `${station.ilpAddresses.join(', ') || 'no address at all'}; that edge quotes a price ` +
          `for none of them. A channel with the station's own connector reaches every door it ` +
          `publishes.`,
      };
    }

    const lamports = this.#lamports();
    const affordable = payer.available === undefined || payer.available >= BigInt(door.price);
    if (!affordable) {
      return {
        ...base,
        verdict: 'unaffordable',
        payer: payer.payer,
        destination: door.destination,
        price: door.price,
        reason:
          `One packet on ${door.destination} costs ${door.price} base units and this ` +
          `account's channel on ${payer.payer.chain} has ${payer.available} left. A purchase ` +
          `is two packets — a quote and an execute — so add collateral to that channel first.`,
      };
    }

    return {
      ...base,
      verdict: 'buyable',
      payer: payer.payer,
      destination: door.destination,
      price: door.price,
      lamports: lamports.toString(),
      reason:
        `This console can buy ${lamports} lamports of ${chain.gas.symbol ?? 'gas'} for this ` +
        `address, paid from the channel it already holds on ${payer.payer.chain} — a claim ` +
        `signed against a channel costs no gas on any chain, which is the whole of why this ` +
        `works. One packet on ${door.destination} costs ${door.price} base units, quoted by ` +
        `the connector, and a purchase is two: the quote you will be shown, and the execute.`,
    };
  }

  /**
   * The doors a job could go through, best first.
   *
   * A door is an ILP address the gas station's connector TERMINATES and the
   * paying edge quotes a price for — the same pair of facts a forwarded relay
   * write needs (#121), read the same way and from the same two documents.
   *
   * Which door admits which phase is the one thing neither document publishes.
   * A connector's `GET /ilp` prices a prefix and never says which handler path
   * it terminates at, so a phase-scoped door is indistinguishable from an
   * any-phase one until a packet is refused at it. The order here is a
   * heuristic with a stated reason — an operator opens `<addr>.quote` BESIDE
   * `<addr>`, so a phase-scoped door is a child of the general one — and the
   * fallback is not a guess: a door that refuses a phase is remembered, the
   * next is tried, and every packet that was paid for on the way is reported.
   */
  #doors(
    station: Extract<ConnectorHealth, { state: 'ok' }>,
    own: ConnectorHealth,
    payer: GasPayer
  ): readonly GasDoor[] {
    const quotes: (address: string) => string | undefined =
      payer.via === 'station-connector'
        ? (address) => routePriceFor(station, address)
        : own.state === 'ok'
          ? (address) => routePriceFor(own, address)
          : () => undefined;

    return station.ilpAddresses.flatMap((address) => {
      const price = quotes(address);
      if (price === undefined) return [];
      return [
        {
          destination: address,
          price,
          // Sealed past the hop exactly when the paying edge forwards the
          // door rather than terminating it. No hop may name the terminating
          // connector's key on its behalf, so it is read from the station's
          // own document (#121, spec §13.1).
          ...(payer.via === 'forwarded' && station.edgeSealKey !== undefined
            ? { sealTo: station.edgeSealKey }
            : {}),
        },
      ];
    });
  }

  /** The plan a purchase needs, or the refusal that says why there is none. */
  async #buyable(chain: string): Promise<BuyPlan> {
    const status = await this.status();
    const planned = status.chains.find((entry) => entry.chain === chain);
    if (planned === undefined) {
      throw new GasStationError(
        'unknown_chain',
        `This connector does not settle on ${JSON.stringify(chain)}. It settles on ` +
          `${status.chains.map((entry) => entry.chain).join(', ') || 'nothing'}.`,
        404
      );
    }
    if (planned.verdict !== 'buyable' || planned.payer === undefined) {
      throw new GasStationError(
        planned.verdict,
        `${planned.reason} Nothing was sent and nothing was billed.`,
        planned.verdict === 'station_unreachable' ? 502 : 409
      );
    }

    const profile = this.#deps.profile();
    const station = await this.#deps.readHealthAt(profile.gasConnectorUrl);
    const own = await this.#deps.readHealth(profile);
    if (station.state !== 'ok') {
      throw new GasStationError(
        'station_unreachable',
        `The gas station's connector stopped answering between planning this purchase and ` +
          `sending it. ${station.reason} Nothing was sent.`,
        502
      );
    }
    const payChain = (await this.#deps.funding()).chains.find(
      (entry) => entry.chain === planned.payer?.chain
    );
    if (payChain === undefined) {
      throw new GasStationError(
        'no_channel',
        `The channel that would pay for this is on ${planned.payer.chain}, and this connector ` +
          `no longer settles there. Nothing was sent.`,
        409
      );
    }

    return {
      chain: planned,
      payer: planned.payer,
      doors: this.#doors(station, own, planned.payer),
      payChain: { chain: payChain.chain, kind: payChain.kind, rpcUrl: payChain.rpc.url },
    };
  }

  /**
   * Send one job, trying each door until one admits the phase.
   *
   * A door that refuses the phase refuses it as `F00`, a transport reject —
   * no handler runs and no gas moves, and the connector charges for the
   * refusal anyway, because in TOON a reject is an answer (ADR 0003). So every
   * attempt is recorded with what it cost, the refusing door is remembered so
   * the next purchase does not pay to relearn it, and a caller that ran out of
   * doors is told what each one said.
   */
  async #job(input: {
    plan: BuyPlan;
    phase: 'quote' | 'execute';
    params: Record<string, string | undefined>;
    attempts: GasAttempt[];
  }): Promise<JobAnswer> {
    const { plan, phase, attempts } = input;
    const params = checkGasJob(phase, input.params);
    const profile = this.#deps.profile();
    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const known = this.#refuses.get(phase) ?? new Set<string>();
    const doors = plan.doors
      .filter((door) => !known.has(door.destination))
      .sort(byDoorPreference(phase));
    if (doors.length === 0) {
      throw new GasStationError(
        'no_door',
        `Every door the gas station's connector publishes has already refused a ${phase} from ` +
          `this console (${plan.doors.map((door) => door.destination).join(', ') || 'none'}). ` +
          `A connector prices a route and never says which handler path it terminates at, so ` +
          `which door takes which phase is learned from a refusal — and this console has ` +
          `learned them all. Nothing further was sent.`,
        502,
        attempts
      );
    }

    // One borrow of the payer keys for the whole attempt sequence: the
    // mnemonic is unsealed and derived from once and wiped when this returns
    // (ADR 0020).
    return this.#deps.chainSeed.usePayerKeys(async (keys: PayerKeys) => {
      let last: GasAttempt | undefined;
      for (const door of doors) {
        const outcome = await this.#deps.port.send({
          payAt: plan.payer.payAt,
          destination: door.destination,
          ...(door.sealTo === undefined ? {} : { sealTo: door.sealTo }),
          kind: SOLANA_GAS_KIND,
          params,
          chainKind: plan.payChain.kind,
          rpcUrl: plan.payChain.rpcUrl,
          keys,
          channelStore: channels.store,
          ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
        });
        const attempt: GasAttempt = {
          destination: door.destination,
          phase,
          outcome: outcome.kind === 'receipt' ? 'receipt' : outcome.kind,
          ...(outcome.kind === 'refused' ? { code: outcome.code } : {}),
          ...(outcome.kind === 'receipt' ? {} : { message: outcome.message }),
          ...('cost' in outcome && outcome.cost !== undefined ? { cost: outcome.cost } : {}),
        };
        attempts.push(attempt);
        last = attempt;

        if (outcome.kind === 'receipt') {
          return {
            receipt: outcome.receipt,
            destination: door.destination,
            ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
          };
        }
        if (outcome.kind === 'unknown') {
          throw new GasStationError(
            'job_unconfirmed',
            `The ${phase} packet's fate was not reported: ${outcome.message} Whether the gas ` +
              `station ran the job is genuinely unknown, and it must not be called either ` +
              `done or undone.`,
            504,
            attempts
          );
        }
        // A phase-scoped door refusing the other phase is `F00` and nothing
        // ran. Anything else is a refusal this console should not paper over
        // by paying at the next door.
        if (outcome.code !== 'F00') break;
        known.add(door.destination);
        this.#refuses.set(phase, known);
      }

      throw new GasStationError(
        last?.code ?? 'job_refused',
        `The ${phase} was refused: ${last?.message ?? 'no door answered'}. ` +
          (sumOf(attempts.map((entry) => entry.cost)) === undefined
            ? 'Nothing was billed.'
            : `It was still billed ${sumOf(attempts.map((entry) => entry.cost))} base units in ` +
              `total: TOON bills for an answer, and a refusal is one (ADR 0003).`),
        502,
        attempts
      );
    });
  }

  #lamports(): bigint {
    return this.#deps.lamports ?? DEFAULT_PURCHASE_LAMPORTS;
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

interface JobAnswer {
  readonly receipt: GasStationReceipt;
  readonly destination: string;
  readonly cost?: string | undefined;
}

type PayerChoice =
  | {
      readonly kind: 'ready';
      readonly payer: GasPayer;
      readonly available?: bigint | undefined;
    }
  | { readonly kind: 'no_channel' };

/** One door, as the two connectors' documents jointly describe it. */
interface GasDoor {
  readonly destination: string;
  readonly price: string;
  readonly sealTo?: string | undefined;
}

interface BuyPlan {
  readonly chain: GasBuyChain;
  readonly payer: GasPayer;
  readonly doors: readonly GasDoor[];
  readonly payChain: { chain: string; kind: 'evm' | 'solana'; rpcUrl: string };
}

/**
 * Which door to try first, and why it is an order rather than an answer.
 *
 * An operator who separates the phases opens `<addr>.quote` BESIDE `<addr>`:
 * a phase-scoped door is a SPECIALIZATION of the general one, and the general
 * one is where the execute goes, because that is the door priced at what a job
 * can cost the float. So a quote tries the deepest address first and an
 * execute tries the shallowest, and each is most likely to hit its own door on
 * the first packet. Ties break on the cheaper price and then on the address,
 * so the order is total and a run is reproducible.
 *
 * It is a heuristic because a connector publishes a route's prefix and its
 * price and never its handler path, so nothing on the wire says which door
 * takes which phase. What makes the heuristic safe is that being wrong is
 * DETECTED — `F00`, nothing ran — rather than silently wrong, that it is
 * LEARNED rather than repeated, and that the cost of being wrong is reported.
 */
export function byDoorPreference(
  phase: 'quote' | 'execute'
): (left: GasDoor, right: GasDoor) => number {
  return (left, right) => {
    const deeper = right.destination.split('.').length - left.destination.split('.').length;
    if (deeper !== 0) return phase === 'quote' ? deeper : -deeper;
    const price = BigInt(left.price) - BigInt(right.price);
    if (price !== 0n) return price < 0n ? -1 : 1;
    return left.destination.localeCompare(right.destination);
  };
}

/** The sentence #119 will not let a button drown out. */
const FIRST_CHANNEL = (profile: NetworkProfile): string =>
  `The FIRST channel on the FIRST chain has no route through this, and buying gas cannot give ` +
  `it one. A gas station is paid over a payment channel, and this account holds none anywhere; ` +
  `opening one is a transaction on a chain, which costs that chain's own coin, which nothing ` +
  `in TOON Network can mint. So one chain has to be funded from outside ${profile.label} — an ` +
  `airdrop where a cluster allows one, or coin sent from a wallet that already holds some. ` +
  `After that, and only after that, this console can buy the rest.`;

/** A lamport figure arrives as a decimal string of whole lamports, or not at all. */
export function readLamports(value: string | undefined): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new GasStationError(
      'invalid_lamports',
      'An amount of gas to buy is a whole number of lamports, as a decimal string. It is not ' +
        'a fraction of a coin here, because the station prices the job in lamports and ' +
        'rounding a coin into them in two places is how a figure stops matching.',
      400
    );
  }
  const lamports = BigInt(value);
  if (lamports <= 0n) {
    throw new GasStationError('invalid_lamports', 'A purchase buys more than nothing.', 400);
  }
  return lamports;
}

/** Base-unit strings summed, or `undefined` when nothing reported a cost. */
function sumOf(values: readonly (string | undefined)[]): string | undefined {
  let total: bigint | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    try {
      total = (total ?? 0n) + BigInt(value);
    } catch {
      continue;
    }
  }
  return total?.toString();
}
