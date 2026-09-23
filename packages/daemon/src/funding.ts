import { defaultRpcUrl, type ChannelStore } from '@toon-protocol/client';

import { channelStoreFor } from './channel-store.js';
import {
  CUSTODY_WARNING,
  type ChainAddress,
  type ChainSeedStatus,
  type ChainSeedStore,
  type HeldSeedView,
  type PayerKeys,
} from './chain-seed.js';
import type { ConnectorHealth, SettlementView } from './connector-health.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';

/**
 * **Funding**: an account from "no money" to "a channel it can pay a provider
 * from" (TOON_Network#90).
 *
 * Four facts shape every line of this module, and three of them are
 * unwelcome.
 *
 * **The connector is the authority on the chains.** Which chains this network
 * settles on, in which token, at how many decimals, and with which address as
 * the counterparty, is read from `GET /ilp` and from nowhere else (spec §2).
 * This module derives a per-chain view by walking `settlements[]`; it has no
 * idea what Base or Solana are, and a connector reconfigured overnight changes
 * what this view shows without a release.
 *
 * **A deposit address comes from the Chain Seed.** One BIP-39 phrase, sealed
 * to the account, derived at the paths `@toon-protocol/client` owns (ADR
 * 0020). The seed is never revealed and never exported, so what this module
 * shows is an address and a derivation path — the two things a person can
 * check in another wallet — and nothing that could reconstruct the phrase.
 *
 * **Native gas is the obstacle, and it is not ours to solve.** Opening a
 * channel is an on-chain transaction, so it costs the chain's native coin —
 * ETH, SOL — which is not the token anything here is priced in and which no
 * part of TOON Network can mint. A person with a fresh Chain Seed has none on
 * either chain. The devnet faucet drips the settlement token and no gas at all
 * (it says so itself in `/api/info`), the public Solana airdrop is capped per
 * day, and an EVM testnet's faucets are gated behind accounts elsewhere. So
 * this module computes a **gas verdict per chain before anything else**, and
 * the view puts it in front of the "Open a channel" button rather than behind
 * a failed transaction. A console that let someone press that button with an
 * empty gas tank would be teaching them the same lesson at the cost of a
 * confusing error.
 *
 * **A balance that lies is worse than one that says "unknown".** Every read
 * here degrades rather than guesses: an unreachable RPC is `unknown` and never
 * zero, an open in flight is `opening` and never `failed`, and a channel this
 * console did not open is `none` — not "you have nothing", but "this console
 * holds no record of one here".
 *
 * One more property worth stating, because it was designed for and not
 * stumbled into: **refreshing this view uses no key material at all.**
 * Balances are address reads, channel state comes from the console's own
 * `channelStore`, and the payer keys are borrowed only by an open. An account
 * on a NIP-46 remote signer can therefore leave this view polling without
 * being asked to approve anything every few seconds.
 */

export type FundingState =
  /** Nobody is signed in, so there are no addresses and no channels. */
  | 'signed_out'
  /** The profile names no connector, so nothing can be asked what it settles. */
  | 'unconfigured'
  /** The connector did not answer: the chains are unknown, the addresses are not. */
  | 'connector_unreachable'
  /** No Chain Seed, so no payer address on any chain. */
  | 'no_seed'
  /** Chains known, addresses known. */
  | 'ready';

/** A quantity of one asset, exactly as the chain reported it. */
export interface Amount {
  /** Base units, as a decimal string. Never a float, never rescaled here. */
  readonly amount: string;
  readonly decimals?: number | undefined;
  readonly symbol?: string | undefined;
  /** Contract or mint. Absent for a chain's native coin. */
  readonly address?: string | undefined;
}

export type BalanceState = 'unknown' | 'read';

export interface BalanceView {
  readonly state: BalanceState;
  /** The chain's own coin — what gas is paid in. */
  readonly native?: Amount | undefined;
  /** The connector's settlement token. */
  readonly token?: Amount | undefined;
  /** Why the state is `unknown`. Never a number standing in for a failure. */
  readonly reason?: string | undefined;
  readonly readAt?: string | undefined;
}

/** Whether this address can pay for a transaction on this chain. */
export type GasVerdict = 'unknown' | 'none' | 'present';

export interface GasView {
  readonly verdict: GasVerdict;
  /** The native coin's symbol, when a balance read resolved one. */
  readonly symbol?: string | undefined;
  /** What this is, said plainly, whether or not there is a problem yet. */
  readonly headline: string;
  /** What to do about it. Built from what this network actually offers. */
  readonly detail: string;
  /** A command that asks this chain for gas, when the chain has such a thing. */
  readonly command?: string | undefined;
  /** Whether this profile's faucet gives native gas. It is almost never true. */
  readonly faucetGivesGas: boolean;
}

export type ChannelPhase =
  /** This console holds no channel with this connector on this chain. */
  | 'none'
  /** An open is in flight. NOT a failure, and never rendered as one. */
  | 'opening'
  | 'open'
  | 'closing'
  | 'settled'
  /** An open was attempted and did not land. */
  | 'failed';

export interface ChannelView {
  readonly phase: ChannelPhase;
  readonly channelId?: string | undefined;
  /** On-chain collateral at the time it was opened, base units. */
  readonly deposit?: string | undefined;
  /** The cumulative amount this console has signed claims for. */
  readonly spent?: string | undefined;
  /** `deposit - spent`, when both are known. */
  readonly available?: string | undefined;
  readonly nonce?: number | undefined;
  readonly openedAt?: string | undefined;
  /** When the in-flight open started, so a long one reads as slow, not stuck. */
  readonly startedAt?: string | undefined;
  readonly txHash?: string | undefined;
  /** Why it failed, or why what is shown is incomplete. */
  readonly reason?: string | undefined;
  /** Set when the failure was specifically "not enough native gas". */
  readonly outOfGas?: boolean | undefined;
  /**
   * `true` when this console's watermark and the channel's deposit cannot be
   * squared — the figures are shown, and they are not called a balance.
   */
  readonly watermarkUncertain?: boolean | undefined;
}

export interface ChainFundingView {
  /** The chain key, verbatim from `GET /ilp`: `evm:84532`, or `solana`. */
  readonly chain: string;
  readonly kind: 'evm' | 'solana';
  /** The connector's own settlement address: who the channel is opened WITH. */
  readonly counterparty: string;
  /** The token every channel on this chain settles in, as published. */
  readonly token: { readonly address: string; readonly decimals: number };
  /** Where to send money: the account's payer address on this chain. */
  readonly deposit: ChainAddress;
  /** Where the console read this chain, and whether it named it itself. */
  readonly rpc: { readonly url: string; readonly source: 'profile' | 'client-default' };
  readonly balances: BalanceView;
  readonly gas: GasView;
  readonly channel: ChannelView;
  /** Whether a channel can be opened right now, and what stops it if not. */
  readonly canOpen: boolean;
  readonly blockedBy?: string | undefined;
  /**
   * A starting collateral, expressed entirely in prices the CONNECTOR quoted.
   * Never a price this console computed: see the note on `quote` below.
   */
  readonly suggestedDeposit?: string | undefined;
}

/**
 * The dearest route the connector quotes, and what it costs — its own figures,
 * repeated.
 *
 * The console never recomputes a price (TOON_Network#82: the client and the
 * connector round a per-KiB charge differently, and the connector is the one
 * that decides). So a suggested deposit is stated as a multiple of a quoted
 * price, the quote it came from is named, and a route that meters by size
 * carries its `pricePerKib` unmultiplied with the warning that a packet on it
 * always costs more than the flat figure — because what it costs is the
 * connector's to say at send time.
 */
export interface QuoteView {
  readonly route: string;
  /** Base units per packet, verbatim. */
  readonly price: string;
  readonly pricePerKib?: string | undefined;
  /** How many packets `suggestedDeposit` is `price` multiplied by. */
  readonly packets: number;
}

export interface FaucetChainView {
  readonly kind: 'evm' | 'solana';
  /** What the faucet calls this chain. Its word, not ours. */
  readonly name: string;
  readonly ready: boolean;
  readonly route?: string | undefined;
  /** What it says it drips, asset by asset. */
  readonly drips: readonly { readonly asset: string; readonly amount: string }[];
  readonly cooldownHours?: string | undefined;
}

export interface FaucetView {
  readonly url: string;
  readonly state: 'unknown' | 'ready' | 'unreachable';
  readonly reason?: string | undefined;
  readonly chains: readonly FaucetChainView[];
  /**
   * Whether the faucet has native gas to give. It reports its own balances, and
   * on devnet today it reports none — which is the fact this whole view is
   * arranged around.
   */
  readonly givesGas: boolean;
  /** The last drip this console asked for, and how it went. */
  readonly lastDrip?:
    | {
        readonly chain: string;
        readonly at: string;
        readonly state: 'delivered' | 'refused';
        readonly message: string;
      }
    | undefined;
}

export interface FundingStatus {
  readonly state: FundingState;
  /**
   * Which profile this view is of — and WHICH CONNECTOR, which is not always
   * the profile's own: a spawn may be paid at a provider's connector, and a
   * channel is opened with one connector and not with a network (#92).
   */
  readonly profile: {
    readonly id: string;
    readonly label: string;
    readonly connectorUrl: string;
  };
  readonly pubkey?: string | undefined;
  /** The custody sentence ADR 0020 requires, shown before any address is. */
  readonly custody: { readonly text: string; readonly acknowledgedAt?: string | undefined };
  /**
   * Older sealed seeds holding DIFFERENT phrases. Non-zero means money may be
   * sitting at addresses nothing here derives any more (ADR 0020), and the
   * view refuses to be quiet about it.
   */
  readonly supersededSeeds: number;
  /**
   * Set while the Chain Seed behind these addresses is **not yet recoverable**
   * (TOON_Network#120).
   *
   * It is on this view and not only on the Account tab because this is the
   * screen that invites a deposit, and depositing into an address whose seed
   * one disk holds is the mistake the state exists to prevent. The seed is
   * published with a paid write once a channel exists — which is the very
   * thing this view is for — so the two belong on one screen.
   */
  readonly heldSeed?: HeldSeedView | undefined;
  readonly chains: readonly ChainFundingView[];
  readonly quote?: QuoteView | undefined;
  readonly faucet?: FaucetView | undefined;
  /** The watermark file, so a person can find their own channel state. */
  readonly channelStorePath?: string | undefined;
  readonly reason?: string | undefined;
  readonly checkedAt: string;
}

/**
 * Which connector this view is about.
 *
 * Absent means the active profile's own, which is every case #90 had. A spawn
 * paid at a provider's connector needs a channel with THAT connector, and it
 * is the same view of the same account's money (#92).
 */
export interface FundingViewOptions {
  readonly refresh?: boolean | undefined;
  readonly connectorUrl?: string | undefined;
}

export class FundingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'FundingError';
    this.code = code;
    this.status = status;
  }
}

/**
 * An open that did not land, with the one distinction worth making about it.
 *
 * "Not enough native gas" is the failure this whole ticket is arranged around,
 * and it is the chain port's to recognise — `@toon-protocol/client` has a
 * detector that flattens viem's nested `cause` chain, and a regular expression
 * here would be a worse second copy of it.
 */
export class ChainOpenError extends Error {
  readonly outOfGas: boolean;
  constructor(message: string, options: { outOfGas?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChainOpenError';
    this.outOfGas = options.outOfGas === true;
  }
}

/* -------------------------------------------------------------------------- */
/* The chain port                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything this module needs a chain (and a faucet) to do.
 *
 * A port rather than direct calls into `@toon-protocol/client`, so the whole
 * of the policy above — the gas verdict, the pending open, the unknown
 * balance — is testable without an RPC endpoint, a validator or the network.
 * `funding-chain.ts` is the one implementation that talks to real chains.
 */
export interface WalletReadRequest {
  readonly kind: 'evm' | 'solana';
  readonly chain: string;
  readonly rpcUrl: string;
  readonly owner: string;
  readonly tokenAddress: string;
}

export interface WalletReadResult {
  readonly native?: Amount | undefined;
  readonly token?: Amount | undefined;
  /** True when the chain could not be read at all. */
  readonly unreadable?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface OpenChannelRequest {
  readonly connectorUrl: string;
  readonly kind: 'evm' | 'solana';
  readonly chain: string;
  readonly rpcUrl: string;
  readonly deposit?: bigint | undefined;
  readonly keys: PayerKeys;
  readonly channelStore: ChannelStore;
}

export interface OpenedChannel {
  readonly channelId: string;
  /** `opening` when the transaction is submitted but not yet confirmed. */
  readonly status: 'opening' | 'open' | 'closed' | 'settled' | 'missing';
  readonly txHash?: string | undefined;
  readonly depositTotal?: bigint | undefined;
}

export interface DripRequest {
  readonly faucetUrl: string;
  readonly kind: 'evm' | 'solana';
  readonly address: string;
}

export interface ChainPort {
  readWallet(request: WalletReadRequest): Promise<WalletReadResult>;
  openChannel(request: OpenChannelRequest): Promise<OpenedChannel>;
  /** The faucet's own `/api/info`, parsed. Never throws: it returns a view. */
  faucetInfo(faucetUrl: string): Promise<FaucetView>;
  drip(request: DripRequest): Promise<{ delivered: boolean; message: string }>;
  /** The dearest route this connector quotes, from its own published prices. */
  quote(connectorUrl: string): Promise<QuoteView | undefined>;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export interface FundingDeps {
  readonly profile: () => NetworkProfile;
  readonly chainSeed: ChainSeedStore;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  readonly chains: ChainPort;
  readonly paths: ConsolePaths;
  /** For the tests, and for nothing else. */
  readonly now?: (() => Date) | undefined;
  /** How many packets at the connector's quoted price a suggestion is worth. */
  readonly suggestedPackets?: number | undefined;
}

/** One open, from the moment it is asked for to the moment it lands. */
interface OpenRecord {
  readonly chain: string;
  readonly startedAt: string;
  state: 'opening' | 'open' | 'failed';
  channelId?: string;
  txHash?: string;
  deposit?: bigint;
  reason?: string;
  outOfGas?: boolean;
  /** Held so a waiter can join this open rather than starting another. */
  work?: Promise<void>;
}

const DEFAULT_SUGGESTED_PACKETS = 100;

export class FundingStore {
  readonly #deps: FundingDeps;
  /** Keyed by profile, account and chain: three things an open is specific to. */
  readonly #opens = new Map<string, OpenRecord>();
  /** The last balance read per chain, so a refresh can be told from a poll. */
  readonly #balances = new Map<string, BalanceView>();
  #faucet: FaucetView | undefined;
  #lastDrip: FaucetView['lastDrip'];
  #quote: QuoteView | undefined;
  #quoteFor: string | undefined;

  constructor(deps: FundingDeps) {
    this.#deps = deps;
  }

  /**
   * The whole funding view.
   *
   * `refresh` re-reads the chains; without it the last reading is reused, so
   * the UI can poll for a pending open without hammering an RPC endpoint every
   * second.
   */
  async status(options: FundingViewOptions = {}): Promise<FundingStatus> {
    const profile = this.#target(options.connectorUrl);
    const seed = await this.#seed();
    const base = {
      profile: { id: profile.id, label: profile.label, connectorUrl: profile.connectorUrl },
      custody: {
        text: CUSTODY_WARNING,
        ...(seed.warning.acknowledgedAt === undefined
          ? {}
          : { acknowledgedAt: seed.warning.acknowledgedAt }),
      },
      supersededSeeds: seed.supersededSeeds,
      ...(seed.held === undefined ? {} : { heldSeed: seed.held }),
      checkedAt: this.#at().toISOString(),
    };

    if (seed.state === 'signed_out') {
      return {
        ...base,
        state: 'signed_out',
        chains: [],
        reason: 'No account is signed in, so there is no Chain Seed and no payer address.',
      };
    }
    if (!isConfigured(profile)) {
      return {
        ...base,
        state: 'unconfigured',
        pubkey: seed.pubkey,
        chains: [],
        reason: `${profile.label} names no connector, so nothing can be asked what it settles in.`,
      };
    }

    const health = await this.#deps.readHealth(profile);
    if (health.state !== 'ok') {
      return {
        ...base,
        state: 'connector_unreachable',
        pubkey: seed.pubkey,
        chains: [],
        reason:
          health.state === 'unreachable'
            ? `${profile.label}'s connector did not answer, so which chains it settles on is ` +
              `unknown — and an address for a chain that may not be settled on is worse than ` +
              `none. ${health.reason}`
            : health.reason,
      };
    }

    // A seed that is only HELD still has real addresses, and funding one of
    // them is the next step in #120's ordering: the channel opened with that
    // money is what pays for the seed's own publication. So this view works
    // for both, and says which it is.
    if ((seed.state !== 'ready' && seed.state !== 'not_yet_recoverable') || !seed.addresses) {
      return {
        ...base,
        state: 'no_seed',
        pubkey: seed.pubkey,
        chains: [],
        reason:
          seed.state === 'unreadable'
            ? `This account has a Chain Seed record that this signer did not open, so its payer ` +
              `addresses cannot be derived. ${seed.reason ?? ''}`.trim()
            : seed.state === 'unknown'
              ? 'This account’s relays did not answer, so whether it already has a Chain Seed ' +
                'is unknown. It is not "none": minting a second seed while the first is merely ' +
                'out of reach would split this account’s funds across two sets of addresses. ' +
                'Try again, or name a relay to look on from the Account tab.'
              : 'This account has no Chain Seed yet. Mint or import one on the Account tab, and ' +
                'its payer addresses on every chain this connector settles on appear here.',
      };
    }

    const faucet = await this.#readFaucet(profile, options);
    const quote = await this.#readQuote(profile);
    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const chains: ChainFundingView[] = [];
    for (const settlement of health.settlements) {
      chains.push(
        await this.#chainView({
          profile,
          settlement,
          seed,
          faucet,
          quote,
          store: channels.store,
          refresh: options.refresh === true,
        })
      );
    }

    return {
      ...base,
      state: 'ready',
      pubkey: seed.pubkey,
      chains,
      ...(quote === undefined ? {} : { quote }),
      ...(faucet === undefined ? {} : { faucet }),
      channelStorePath: channels.filePath,
    };
  }

  /**
   * Open a payment channel to this profile's connector on one chain.
   *
   * It returns as soon as the transaction is in flight, and the view reports
   * `opening` until it lands. That is not impatience: an EVM open is an
   * approval and a `openChannel` call, and a person watching a spinner for two
   * minutes with no way to ask what is happening is exactly the state this
   * ticket says must read as pending rather than failed.
   *
   * Asking twice while one is in flight joins the open already running. The
   * on-chain opener adopts an existing channel rather than opening a second
   * (the client's ADR 0059), so a duplicate would be harmless — but it would
   * also be two transactions' worth of gas to learn that.
   */
  async openChannel(input: {
    chain: string;
    deposit?: string;
    connectorUrl?: string;
  }): Promise<FundingStatus> {
    const profile = this.#target(input.connectorUrl);
    const view: FundingViewOptions =
      input.connectorUrl === undefined ? {} : { connectorUrl: input.connectorUrl };
    const status = await this.status(view);
    if (status.state !== 'ready') {
      throw new FundingError(
        'not_fundable',
        status.reason ?? 'Funding is not available.',
        409
      );
    }
    const chain = status.chains.find((candidate) => candidate.chain === input.chain);
    if (!chain) {
      throw new FundingError(
        'unknown_chain',
        `This connector does not settle on ${JSON.stringify(input.chain)}. It settles on ` +
          `${status.chains.map((entry) => entry.chain).join(', ') || 'nothing'}.`,
        404
      );
    }

    const key = this.#openKey(profile.connectorUrl, status.pubkey ?? '', chain.chain);
    const running = this.#opens.get(key);
    if (running?.state === 'opening') return this.status();

    if (chain.channel.phase === 'open') {
      throw new FundingError(
        'channel_exists',
        `This account already holds a channel with ${profile.label}'s connector on ` +
          `${chain.chain}. Add collateral to it rather than opening a second.`,
        409
      );
    }

    const deposit = readDeposit(input.deposit);
    const channels = channelStoreFor(this.#deps.paths, profile.id);
    const record: OpenRecord = {
      chain: chain.chain,
      startedAt: this.#at().toISOString(),
      state: 'opening',
    };
    // Registered BEFORE the work starts. The window between "the transaction
    // is submitted" and "this console knows it landed" is exactly the one the
    // view has to report as pending, so the record that makes it pending must
    // exist before anything can be awaited.
    this.#opens.set(key, record);

    // The keys are borrowed for the length of ONE open and wiped after it; the
    // Chain Seed's phrase never leaves `chain-seed.ts` (ADR 0020).
    record.work = this.#deps.chainSeed
      .usePayerKeys((keys) =>
        this.#deps.chains.openChannel({
          connectorUrl: profile.connectorUrl,
          kind: chain.kind,
          chain: chain.chain,
          rpcUrl: chain.rpc.url,
          keys,
          channelStore: channels.store,
          ...(deposit === undefined ? {} : { deposit }),
        })
      )
      .then((opened) => {
        // `opening` stays `opening`: the transaction is submitted and the
        // channel does not exist for anything reading the chain until it
        // confirms, the connector included.
        record.state = opened.status === 'opening' ? 'opening' : 'open';
        record.channelId = opened.channelId;
        if (opened.txHash !== undefined) record.txHash = opened.txHash;
        if (opened.depositTotal !== undefined) record.deposit = opened.depositTotal;
      })
      .catch((error: unknown) => {
        record.state = 'failed';
        record.reason = messageOf(error);
        if (error instanceof ChainOpenError && error.outOfGas) record.outOfGas = true;
      });

    return this.status(view);
  }

  /**
   * Wait for whatever open is in flight on this chain.
   *
   * For the tests and for `smoke-console`, which need a deterministic "and
   * then it landed". No route calls it: a person watching the view polls, and
   * an HTTP request held open for the length of a chain confirmation is the
   * thing a pending state exists to avoid.
   */
  async settled(chain: string, connectorUrl?: string): Promise<void> {
    const profile = this.#target(connectorUrl);
    const pubkey = this.#deps.chainSeed.status().pubkey ?? '';
    await this.#opens.get(this.#openKey(profile.connectorUrl, pubkey, chain))?.work;
  }

  /**
   * Ask this network's faucet for test funds.
   *
   * It gives the SETTLEMENT TOKEN and no gas — which is the point of routing it
   * through here rather than leaving it a link: the answer is folded back into
   * the same view that says, right beside it, that gas is still missing.
   */
  async drip(input: { chain: string }): Promise<FundingStatus> {
    const profile = this.#deps.profile();
    const faucetUrl = profile.faucetUrl;
    if (!faucetUrl) {
      throw new FundingError(
        'no_faucet',
        `${profile.label} has no faucet. Test funds exist on devnet and on the local sandbox's ` +
          'own chains; on any other network the money has to be real.',
        409
      );
    }
    const status = await this.status();
    const chain = status.chains.find((candidate) => candidate.chain === input.chain);
    if (!chain) {
      throw new FundingError(
        'unknown_chain',
        `This connector does not settle on ${JSON.stringify(input.chain)}.`,
        404
      );
    }
    const result = await this.#deps.chains.drip({
      faucetUrl,
      kind: chain.kind,
      address: chain.deposit.address,
    });
    this.#lastDrip = {
      chain: chain.chain,
      at: this.#at().toISOString(),
      state: result.delivered ? 'delivered' : 'refused',
      message: result.message,
    };
    // A drip that landed changes a balance, so the next view must be a fresh
    // read rather than the one taken before the money arrived.
    this.#balances.clear();
    this.#faucet = undefined;
    return this.status({ refresh: true });
  }

  /** Drop everything this account and profile cached. A sign-out, or a switch. */
  forget(): void {
    this.#opens.clear();
    this.#balances.clear();
    this.#faucet = undefined;
    this.#lastDrip = undefined;
    this.#quote = undefined;
    this.#quoteFor = undefined;
  }

  /**
   * The Chain Seed's state — having actually LOOKED for it.
   *
   * A store that has not looked yet reports `unknown`, which is not `absent`,
   * and this view must not turn the one into the other. "You have no Chain
   * Seed, go and mint one" said to an account that has had one for months —
   * because nothing had asked its relays yet — is the same class of lie as a
   * zero balance for a chain that did not answer, and it is a worse one: a
   * second seed minted on that advice is the two-seed split ADR 0020 says the
   * console must never cause.
   *
   * So a first read looks. It is one relay query per account, it publishes
   * nothing, and a look that finds nothing sets `absent` — at which point the
   * sentence about minting one is true.
   */
  async #seed(): Promise<ChainSeedStatus> {
    const held = this.#deps.chainSeed.status();
    if (held.state !== 'unknown') return held;
    try {
      return await this.#deps.chainSeed.refresh();
    } catch {
      // A relay that would not answer leaves the state `unknown`, and the
      // sentence below says so rather than claiming there is no seed.
      return this.#deps.chainSeed.status();
    }
  }

  async #chainView(input: {
    profile: NetworkProfile;
    settlement: SettlementView;
    seed: ChainSeedStatus;
    faucet: FaucetView | undefined;
    quote: QuoteView | undefined;
    store: ChannelStore;
    refresh: boolean;
  }): Promise<ChainFundingView> {
    const { profile, settlement, seed, faucet, quote, store, refresh } = input;
    const address = settlement.kind === 'evm' ? seed.addresses?.evm : seed.addresses?.solana;
    const rpc = resolveRpc(profile, settlement.kind);
    const balanceKey = `${profile.connectorUrl}|${seed.pubkey ?? ''}|${settlement.chain}`;

    let balances = this.#balances.get(balanceKey);
    if (balances === undefined || refresh) {
      balances = await this.#readBalances({
        kind: settlement.kind,
        chain: settlement.chain,
        rpcUrl: rpc.url,
        owner: address?.address ?? '',
        tokenAddress: settlement.tokenAddress,
      });
      this.#balances.set(balanceKey, balances);
    }

    const channel = this.#channelView({
      connectorUrl: profile.connectorUrl,
      pubkey: seed.pubkey ?? '',
      chain: settlement.chain,
      store,
    });
    const gas = gasView({
      chain: settlement,
      balances,
      faucet,
      rpcUrl: rpc.url,
      address: address?.address ?? '',
    });
    const blocked = whatBlocksAnOpen(gas, channel);

    return {
      chain: settlement.chain,
      kind: settlement.kind,
      counterparty: settlement.settlementAddress,
      token: { address: settlement.tokenAddress, decimals: settlement.decimals },
      deposit: address ?? { address: '', path: '' },
      rpc,
      balances,
      gas,
      channel,
      canOpen: blocked === undefined,
      ...(blocked === undefined ? {} : { blockedBy: blocked }),
      ...(quote === undefined
        ? {}
        : { suggestedDeposit: (BigInt(quote.price) * BigInt(quote.packets)).toString() }),
    };
  }

  async #readBalances(request: WalletReadRequest): Promise<BalanceView> {
    if (request.owner === '') {
      return { state: 'unknown', reason: 'No address to read on this chain.' };
    }
    try {
      const result = await this.#deps.chains.readWallet(request);
      if (result.unreadable === true) {
        return {
          state: 'unknown',
          reason:
            `${request.rpcUrl} did not answer, so this chain's balances are unknown. ` +
            `${tidy(result.error)}`.trim(),
        };
      }
      return {
        state: 'read',
        ...(result.native === undefined ? {} : { native: result.native }),
        ...(result.token === undefined ? {} : { token: result.token }),
        readAt: this.#at().toISOString(),
      };
    } catch (error) {
      // Nothing here ever becomes a zero. A chain that could not be read is a
      // chain nobody has been told anything about.
      return { state: 'unknown', reason: messageOf(error) };
    }
  }

  /**
   * The channel, from the console's own store and from any open in flight.
   *
   * No key and no chain read: the bindings file records which channel this
   * identity holds with which connector on which chain, and the watermark file
   * records what has been signed against it. That is enough for every figure
   * shown, and it is why this view can poll.
   */
  #channelView(input: {
    connectorUrl: string;
    pubkey: string;
    chain: string;
    store: ChannelStore;
  }): ChannelView {
    const running = this.#opens.get(
      this.#openKey(input.connectorUrl, input.pubkey, input.chain)
    );
    if (running?.state === 'opening') {
      return {
        phase: 'opening',
        startedAt: running.startedAt,
        ...(running.channelId === undefined ? {} : { channelId: running.channelId }),
        ...(running.txHash === undefined ? {} : { txHash: running.txHash }),
        reason:
          'The opening transaction is in flight. Until it confirms, nothing reading the chain ' +
          'can see this channel — including the connector — so a claim signed now would be ' +
          'refused as naming an unknown channel. Waiting is the remedy.',
      };
    }

    const binding = findBinding(input.store, input.connectorUrl, input.chain);
    if (!binding) {
      if (running?.state === 'failed') {
        return {
          phase: 'failed',
          startedAt: running.startedAt,
          ...(running.reason === undefined ? {} : { reason: running.reason }),
          ...(running.outOfGas === true ? { outOfGas: true } : {}),
        };
      }
      return {
        phase: 'none',
        reason:
          'This console holds no channel with this connector on this chain. That is not the ' +
          'same as there being none on chain: opening adopts a channel this address already ' +
          'holds with this counterparty rather than opening a second one.',
      };
    }

    const watermark = input.store.load(binding.channelId);
    const deposit = binding.depositTotal ?? running?.deposit;
    const spent = watermark?.cumulativeAmount;
    const phase: ChannelPhase =
      watermark?.settledAt !== undefined
        ? 'settled'
        : watermark?.closedAt !== undefined
          ? 'closing'
          : 'open';

    return {
      phase,
      channelId: binding.channelId,
      ...(deposit === undefined ? {} : { deposit: deposit.toString() }),
      ...(spent === undefined ? {} : { spent: spent.toString() }),
      ...(deposit === undefined || spent === undefined
        ? {}
        : { available: (deposit - spent).toString() }),
      ...(watermark?.nonce === undefined ? {} : { nonce: watermark.nonce }),
      ...(binding.openedAt === undefined ? {} : { openedAt: binding.openedAt }),
      ...(running?.txHash === undefined ? {} : { txHash: running.txHash }),
      ...(watermark?.watermarkUncertain === true
        ? {
            watermarkUncertain: true,
            reason:
              'A claim on this channel was signed and its fate is unknown, so what has been ' +
              'spent may be higher than the figure here. The connector decides; the console ' +
              'reconciles with it before it signs another.',
          }
        : {}),
    };
  }

  async #readFaucet(
    profile: NetworkProfile,
    options: FundingViewOptions
  ): Promise<FaucetView | undefined> {
    const url = profile.faucetUrl;
    if (!url) return undefined;
    if (this.#faucet === undefined || options.refresh === true) {
      this.#faucet = await this.#deps.chains.faucetInfo(url);
    }
    const view = this.#faucet;
    return this.#lastDrip === undefined ? view : { ...view, lastDrip: this.#lastDrip };
  }

  /**
   * The connector's own price for the dearest route it publishes.
   *
   * Cached per connector because it is a description of a deployment, like the
   * self-description it comes from. It is never multiplied out into a "what a
   * spawn costs" figure here: every number shown is one the connector said.
   */
  async #readQuote(profile: NetworkProfile): Promise<QuoteView | undefined> {
    if (this.#quoteFor !== profile.connectorUrl) {
      this.#quote = await this.#deps.chains.quote(profile.connectorUrl);
      this.#quoteFor = profile.connectorUrl;
    }
    if (this.#quote === undefined) return undefined;
    return {
      ...this.#quote,
      packets: this.#deps.suggestedPackets ?? DEFAULT_SUGGESTED_PACKETS,
    };
  }

  #openKey(connectorUrl: string, pubkey: string, chain: string): string {
    return `${connectorUrl}|${pubkey}|${chain}`;
  }

  /**
   * The profile this view is of, with one field possibly replaced.
   *
   * A channel is opened with a CONNECTOR, not with a network: the settlement
   * address, the token and the chains all come from that connector's own
   * `GET /ilp`. Everything else — which chains this console can reach, where
   * its channel state lives, whether there is a faucet — stays the active
   * profile's. So a connector override is exactly one substituted field, and
   * the rest of the funding machinery does not need to know it happened (#92).
   */
  #target(connectorUrl?: string): NetworkProfile {
    const profile = this.#deps.profile();
    return connectorUrl === undefined || connectorUrl === profile.connectorUrl
      ? profile
      : { ...profile, connectorUrl };
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which RPC endpoint this chain is read through, and who chose it.
 *
 * The source is reported because "unknown balance" and "unknown balance at an
 * endpoint you did not pick" are different problems with different fixes.
 */
export function resolveRpc(
  profile: NetworkProfile,
  kind: 'evm' | 'solana'
): { url: string; source: 'profile' | 'client-default' } {
  const named = profile.rpc[kind];
  if (named !== undefined && named !== '') return { url: named, source: 'profile' };
  // `@toon-protocol/client` is the one place this console may learn a public
  // RPC endpoint from. Copying its devnet preset into this repository would be
  // the second declaration of one fact that `profiles.ts` exists to avoid.
  return { url: defaultRpcUrl(kind), source: 'client-default' };
}

/**
 * The gas verdict, and the sentence that goes with it.
 *
 * Deliberately built here rather than in the UI. It is a consequence of what
 * the chains and the faucet reported, not a piece of copy: a network whose
 * faucet starts giving gas changes this text without anyone editing a screen,
 * and a chain that cannot be read says "unknown" rather than alarming somebody
 * whose RPC endpoint merely blinked.
 */
export function gasView(input: {
  chain: SettlementView;
  balances: BalanceView;
  faucet: FaucetView | undefined;
  rpcUrl: string;
  address: string;
}): GasView {
  const { chain, balances, faucet, rpcUrl, address } = input;
  const native = balances.native;
  const symbol = native?.symbol;
  const coin = symbol ?? 'the chain’s native coin';
  const faucetGivesGas = faucet?.givesGas === true;

  const headline =
    `Opening a payment channel is a transaction on ${chain.chain}, so it costs ${coin} — ` +
    `the chain's own coin, which is not the token this network is priced in and which no ` +
    `part of TOON Network can give you.`;

  if (balances.state === 'unknown') {
    return {
      verdict: 'unknown',
      ...(symbol === undefined ? {} : { symbol }),
      headline,
      detail:
        `${rpcUrl} did not answer, so whether this address can pay for a transaction is ` +
        `unknown. It is not zero and it is not enough — it is unknown, and the console will ` +
        `not guess. ${balances.reason ?? ''}`.trim(),
      faucetGivesGas,
    };
  }

  const empty = native === undefined || native.amount === '0';
  const detail = empty
    ? [
        `This address holds no ${coin}, so an open would be refused by the chain before it ` +
          `cost anything.`,
        faucetSentence(faucet, coin),
        howToGetGas(chain.kind, address, rpcUrl, coin),
      ].join(' ')
    : `This address holds ${native.amount} ${coin} in base units. That is what an open will ` +
      `be paid for with; the chain decides whether it is enough, and a refused transaction ` +
      `costs nothing.`;

  return {
    verdict: empty ? 'none' : 'present',
    ...(symbol === undefined ? {} : { symbol }),
    headline,
    detail,
    ...(chain.kind === 'solana' && address !== ''
      ? { command: `solana airdrop 1 ${address} --url ${rpcUrl}` }
      : {}),
    faucetGivesGas,
  };
}

/** What this network's own faucet does and does not do, in its own words. */
function faucetSentence(faucet: FaucetView | undefined, coin: string): string {
  if (faucet === undefined) {
    return 'This network has no faucet.';
  }
  if (faucet.state === 'unreachable') {
    return (
      `This network's faucet at ${faucet.url} did not answer, and it drips the settlement ` +
      `token rather than ${coin} in any case.`
    );
  }
  if (faucet.givesGas) {
    return `This network's faucet says it has ${coin} to give; ask it for some.`;
  }
  return (
    `This network's faucet gives the settlement token and reports no ${coin} to give, so it ` +
    `cannot unblock this.`
  );
}

/** The one honest next step per chain family, built from what is in hand. */
function howToGetGas(
  kind: 'evm' | 'solana',
  address: string,
  rpcUrl: string,
  coin: string
): string {
  if (kind === 'solana') {
    return (
      `Ask the cluster itself: \`solana airdrop 1 ${address} --url ${rpcUrl}\`. A public ` +
      `devnet caps that per day and answers 429 Too Many Requests once the cap is reached, ` +
      `and there is nothing to do about a 429 but wait or bring ${coin} from elsewhere. A ` +
      `local validator has no cap.`
    );
  }
  return (
    `There is no faucet on this chain that will hand it over without an account somewhere ` +
    `else. The way that always works is to send a little ${coin} to the address above from a ` +
    `wallet that already holds some — the same address, on the same chain.`
  );
}

/** Why the Open button is not offered, or `undefined` when it is. */
function whatBlocksAnOpen(gas: GasView, channel: ChannelView): string | undefined {
  if (channel.phase === 'opening') return 'An open is already in flight on this chain.';
  if (channel.phase === 'open') {
    return 'This console already holds a channel with this connector on this chain.';
  }
  if (gas.verdict === 'none') {
    return `No ${gas.symbol ?? 'native coin'} at this address: the transaction cannot be paid for.`;
  }
  if (gas.verdict === 'unknown') {
    return 'This chain could not be read, so whether an open can be paid for is unknown.';
  }
  return undefined;
}

/** The peer→channel binding this connector and chain, out of the console's store. */
function findBinding(
  store: ChannelStore,
  connectorUrl: string,
  chain: string
): { channelId: string; depositTotal?: bigint; openedAt?: string } | undefined {
  const bindings = store.listBindings?.() ?? [];
  // The client keys a binding `<connector>|<chain>|<settlement contract>`. The
  // first two fields are facts this console holds; the third is the library's
  // to spell, so it is matched by prefix rather than reconstructed. A key shape
  // that changes costs a `none` — "no channel recorded here" — and never a
  // wrong channel.
  const wanted = bindings.filter(
    (entry) =>
      entry.binding.supersededAt === undefined &&
      entry.key.split('|')[1] === chain &&
      sameConnector(entry.key.split('|')[0] ?? '', connectorUrl)
  );
  const found = wanted.at(-1)?.binding;
  if (!found) return undefined;
  return {
    channelId: found.channelId,
    ...(found.depositTotal === undefined ? {} : { depositTotal: found.depositTotal }),
    ...(found.openedAt === undefined ? {} : { openedAt: found.openedAt }),
  };
}

/** `https://node.example` and `https://node.example/ilp` are the same node. */
function sameConnector(a: string, b: string): boolean {
  const base = (url: string) => url.replace(/\/+$/u, '').replace(/\/ilp$/u, '');
  return base(a) === base(b);
}

/** A deposit arrives as a decimal string of base units, or not at all. */
function readDeposit(value: string | undefined): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new FundingError(
      'invalid_deposit',
      'A deposit is a whole number of the token’s base units, as a decimal string. It is not ' +
        'a decimal fraction here, because the number of decimals is the connector’s to state ' +
        'and rounding it in two places is how a figure stops matching.'
    );
  }
  const deposit = BigInt(value);
  if (deposit <= 0n) {
    throw new FundingError('invalid_deposit', 'A channel opens with collateral above zero.');
  }
  return deposit;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A chain library's error, cut down to what a person can act on.
 *
 * viem reports an unreachable endpoint as a several-line report with the
 * request body and its own version number in it — useful in a terminal, and a
 * wall of text in a sentence on a screen. What survives here is the first line
 * and the `Details:` line, which together say what went wrong; the rest is
 * dropped rather than paraphrased, so nothing is invented and nothing is
 * claimed that the library did not say.
 *
 * The `Request body:` line is dropped for a second reason: it is the one line
 * in that report that echoes an argument back, and nothing derived from a key
 * belongs in a reason string that will be logged and shown.
 */
export function tidy(error: string | undefined): string {
  if (error === undefined) return '';
  const lines = error
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const first = lines[0] ?? '';
  const details = lines.find((line) => line.startsWith('Details:'));
  const text = details === undefined || details === first ? first : `${first} ${details}`;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}
