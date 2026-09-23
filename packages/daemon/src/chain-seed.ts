import {
  deriveFullIdentity,
  evmDerivationPath,
  generateMnemonic,
  validateMnemonic,
} from '@toon-protocol/client';
import { supersedes, tagValue, type NostrEvent } from './nostr.js';
import {
  NO_RELAY_LIST,
  normalizeRelayUrl,
  readRelayListOf,
  relayListTemplate,
  type RelayList,
  type RelayMode,
} from './relay-list.js';
import { queryRelays, type RelayDialer } from './relay-pool.js';
import {
  RelayWriteError,
  type RelayWriteOutcome,
  type RelayWriteReceipt,
  type RelayWriteTargets,
  type RelayWriter,
} from './relay-write.js';
import { SealingError, type AccountSigning } from './signer.js';
import type { ChainSeedCache, CachedChainSeed } from './chain-seed-cache.js';

/**
 * The **Chain Seed**: one BIP-39 phrase, sealed to the account that owns it.
 *
 * ADR 0020 made this ruling and this module is the whole of it. An account's
 * payer keys on every settlement chain come from ONE random mnemonic, which is
 * NIP-44-sealed to the account's own Nostr key and published as a NIP-78
 * app-data record (kind 30078, `d` = `toon-console/chain-seed`) on the
 * account's own relays. The Nostr key is not the seed and does not derive it:
 * a remote signer's signatures and ciphertexts are randomized, so nothing
 * deterministic can be squeezed out of one, and an account that follows
 * Nostr's own custody advice must not be the account this console cannot
 * serve. What the Nostr key does is UNLOCK the seed, anywhere the account can
 * sign. That is what makes a fresh machine recoverable, and it is also why
 * whoever holds the Nostr key holds the funds — the sentence the console makes
 * a person read once before it mints anything.
 *
 * Three things follow from that, and they shape every method here.
 *
 * **The plaintext lives for one call.** A mnemonic exists inside `#seal` and
 * inside `#open`, and nowhere else: not in a field, not in the cache, not in
 * a log line, and above all not in an answer to the API. `status()` is built
 * from addresses and event metadata, so there is no code path from an HTTP
 * request to the words. The console therefore never shows a person their seed
 * — recovery is through the Nostr key, which is the ADR's whole design, and a
 * "reveal" button would be a second, weaker custody story bolted onto it.
 *
 * **A seed that no relay holds is NOT YET RECOVERABLE, and says so.** This is
 * the ordering TOON_Network#120 settled, and it replaces #89's rule that a
 * record which was never published is never cached. A Chain Seed cannot pay
 * for its own publication: a relay write is a paid TOON packet, paying takes a
 * payment channel, and the payer key the channel is opened with is derived
 * FROM the seed. So the order is: mint and hold it here, in a state that says
 * plainly it is not yet recoverable; fund a payer address and open a channel
 * (TOON_Network#90); publish the sealed record as a paid write; and only then
 * call the seed recoverable anywhere the account can sign.
 *
 * Between the first step and the third the seed exists on one disk. The
 * console keeps saying so — `state` is `not_yet_recoverable`, `held` carries
 * the sentence and the steps, and there is no `record`, because there is no
 * published record to describe. What #89 was right about is kept: the local
 * copy is never allowed to *pass* for a published one, which is why the
 * distinction is a named state rather than an absent field.
 *
 * **A second seed is worse than no seed.** Minting over an existing record
 * would strand whatever the first one's addresses hold, and no one would
 * notice until a balance went missing. Every mint and every import therefore
 * reads the relays first and refuses if a seed is already there.
 */

/** NIP-78 app data. */
export const CHAIN_SEED_KIND = 30078;
/** The `d` tag. One record per account; NIP-01 replacement keeps it single. */
export const CHAIN_SEED_D = 'toon-console/chain-seed';
/** The BIP-44 account index the console uses. One account, one payer key. */
export const ACCOUNT_INDEX = 0;

/**
 * The sentence ADR 0020 requires the console to say, once, before an account
 * seals a seed. It is here and not in the UI because it is a consequence of
 * the decision, not a piece of copy: the UI renders whatever this says.
 */
export const CUSTODY_WARNING =
  'Whoever holds this account’s Nostr key holds its funds. The Chain Seed is sealed to that ' +
  'key, so anyone who can sign as this account can unseal it, derive these addresses and spend ' +
  'what they hold. Losing the Nostr key loses the funds with it: nothing in TOON Network, and ' +
  'no one running it, can recover them for you.';

/**
 * What a held seed is, said once and said the same way everywhere.
 *
 * The words matter and the ticket chose them: **not yet recoverable**. Not
 * "pending", not "draft", not "unsynced" — each of those reads like a detail
 * of the console's bookkeeping, and this is a statement about whether the
 * money survives this machine.
 */
export const NOT_YET_RECOVERABLE =
  'This Chain Seed is NOT YET RECOVERABLE. It is sealed on this machine and on nothing else: ' +
  'no relay holds it, so if this disk is lost before the record is published, everything these ' +
  'addresses hold is lost with it — including anything deposited in the meantime. Publishing ' +
  'the record is a paid TOON packet, and a seed cannot pay for its own publication, because ' +
  'the payer key that pays is derived from the seed itself.';

/** The way out of it, in the order it has to happen (TOON_Network#120). */
export const RECOVERABILITY_STEPS: readonly string[] = [
  'Send the chain’s own coin — ETH, SOL — to the payer address below, so a transaction can be paid for.',
  'Fund that address with the settlement token, from this network’s faucet on devnet.',
  'Open a payment channel with this network’s connector, on the Funds tab.',
  'Publish the Chain Seed record. It is one paid write, at the price the connector quotes.',
];

export type ChainSeedState =
  /** No account is signed in, so there is nothing to unseal anything with. */
  | 'signed_out'
  /** Not looked for yet. */
  | 'unknown'
  /** Looked for and not found: this account has no Chain Seed anywhere. */
  | 'absent'
  /**
   * Minted or imported, sealed, and on this disk ALONE. The addresses are
   * real and may be funded; the seed behind them is not recoverable anywhere
   * else until the sealed record is published as a paid write (#120).
   */
  | 'not_yet_recoverable'
  /** Published and opened. The addresses are real and the seed follows the account. */
  | 'ready'
  /** A record exists that this signer will not open. */
  | 'unreadable';

export type SeedOrigin = 'minted' | 'imported';

export interface ChainAddress {
  readonly address: string;
  /** The BIP-44 path it was derived at, shown so it can be checked elsewhere. */
  readonly path: string;
}

export interface ChainAddresses {
  readonly evm: ChainAddress;
  readonly solana: ChainAddress;
}

/**
 * The account's payer keys, for as long as one call needs them.
 *
 * The only thing derived from a Chain Seed that leaves this module besides an
 * address, and the narrowest such thing there is: opening a payment channel is
 * a transaction, a transaction needs a signature, and a signature needs a key.
 * What does NOT leave is the mnemonic — `usePayerKeys` unseals it, derives
 * these two keys inside one call frame, and drops it there. A caller that held
 * the phrase could derive any account index and any other chain forever; a
 * caller that holds these has exactly what it was lent, and the bytes are
 * zeroed the moment its work returns.
 *
 * ADR 0020's ruling stands either way: there is no route, and no return value
 * anywhere in this console, that yields the phrase itself.
 */
export interface PayerKeys {
  readonly evm: { readonly privateKey: Uint8Array; readonly address: string };
  readonly solana: { readonly secretKey: Uint8Array; readonly publicKey: string };
}

export interface SeedRecordView {
  readonly eventId: string;
  readonly publishedAt: string;
  /** Where this console got the record it is showing. */
  readonly source: 'cache' | 'relays';
  /** Relays confirmed to hold it, from the last read or publish. */
  readonly relays: readonly string[];
}

/**
 * NIP-65, which since #120 says where a seed is LOOKED FOR and no longer where
 * it is written. A write goes on the one relay the console can buy a paid
 * packet to — see `ChainSeedStatus.writes` — and reads still ask every relay
 * this account named, because reading is free.
 */
export interface RelayListView {
  readonly state: 'unknown' | 'none' | 'present';
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly publishedAt?: string | undefined;
}

/**
 * A seed that exists on one disk, in the console's own words.
 *
 * It is a VIEW and not a flag because the console has to keep saying it, in
 * full, until the paid write lands: an account funding an address whose seed
 * nothing else holds is one lost laptop away from losing the money, and the
 * only defence is that nobody can miss which state they are in.
 */
export interface HeldSeedView {
  /** When this console minted or imported it. */
  readonly since: string;
  readonly origin: SeedOrigin;
  /** The sentence, verbatim. The UI renders this rather than writing its own. */
  readonly text: string;
  /** What has to happen before it is recoverable, in order. */
  readonly steps: readonly string[];
  /** Why the last attempt to publish it did not land, when one was made. */
  readonly lastAttempt?: string | undefined;
}

export interface PublishReport {
  readonly at: string;
  readonly what: 'chain-seed' | 'relay-list';
  readonly relays: readonly RelayWriteOutcome[];
  readonly accepted: readonly string[];
  /** What this write cost, in base units of the settlement token. */
  readonly cost?: string | undefined;
  /** The paid route it was bought on, and where it was paid for. */
  readonly destination?: string | undefined;
  readonly payAt?: string | undefined;
  readonly chain?: string | undefined;
}

export interface ChainSeedStatus {
  readonly state: ChainSeedState;
  readonly pubkey?: string | undefined;
  readonly addresses?: ChainAddresses | undefined;
  readonly origin?: SeedOrigin | undefined;
  /** The PUBLISHED record. Absent while a seed is only held (#120). */
  readonly record?: SeedRecordView | undefined;
  /** Set exactly when `state` is `not_yet_recoverable`. */
  readonly held?: HeldSeedView | undefined;
  readonly relayList: RelayListView;
  /** Where a paid write would go right now, what it costs, and what stops it. */
  readonly writes: RelayWriteTargets;
  readonly warning: { readonly text: string; readonly acknowledgedAt?: string | undefined };
  /** Older records seen that held a DIFFERENT seed. Never quietly zero. */
  readonly supersededSeeds: number;
  readonly lastPublish?: PublishReport | undefined;
  readonly reason?: string | undefined;
  readonly checkedAt: string;
}

export class ChainSeedError extends Error {
  readonly code: string;
  readonly status: number;
  /** Per-relay detail, when the fault was a paid write. */
  readonly relays?: readonly RelayWriteOutcome[];
  constructor(
    code: string,
    message: string,
    status = 400,
    relays?: readonly RelayWriteOutcome[]
  ) {
    super(message);
    this.name = 'ChainSeedError';
    this.code = code;
    this.status = status;
    if (relays) this.relays = relays;
  }
}

/**
 * What this module needs from a signer, and no more: sign, seal, unseal.
 * Narrower than `ConsoleSigner` on purpose — the Chain Seed has no business
 * with a signer's lifecycle, and must not be able to sign an account out.
 */
export type ChainSeedSigner = AccountSigning;

export interface ChainSeedDeps {
  /** The signed-in account's signer, or `undefined` when nobody is signed in. */
  readonly signer: () => ChainSeedSigner | undefined;
  /** The active network profile's relays: the seed for NIP-65 discovery. */
  readonly seedRelays: () => readonly string[];
  readonly cache: ChainSeedCache;
  /**
   * The console's one writer (#120). A thunk because the writer borrows this
   * store's payer keys, so the two know about each other and one of them has
   * to be told late.
   */
  readonly writer: () => RelayWriter;
  /** The read seam, so the real NIP-01 read runs in tests without a socket. */
  readonly dial?: RelayDialer | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

/** What the sealed content holds. Never leaves this module unsealed. */
interface SealedSeed {
  readonly v: 1;
  readonly mnemonic: string;
  readonly origin: SeedOrigin;
  /** When the seed was first sealed, so a re-publish keeps its birthday. */
  readonly created_at: string;
}

/** The opened record, held for as long as a session lasts. No mnemonic in it. */
interface OpenSeed {
  readonly addresses: ChainAddresses;
  readonly origin: SeedOrigin;
  readonly event: NostrEvent;
  readonly source: 'cache' | 'relays';
  readonly relays: readonly string[];
  /** `false` while this seed is held on one disk and nowhere else (#120). */
  readonly published: boolean;
  /** When this console sealed it, for the held view's `since`. */
  readonly heldSince?: string | undefined;
}

export class ChainSeedStore {
  readonly #deps: ChainSeedDeps;
  /** Per account pubkey: a sign-out must not leave another account's state. */
  #forPubkey: string | undefined;
  #open: OpenSeed | undefined;
  #looked = false;
  #relayList: RelayList | undefined;
  #supersededSeeds = 0;
  #lastPublish: PublishReport | undefined;
  #reason: string | undefined;
  /** The last answer from the writer, so `status()` can stay synchronous. */
  #writes: RelayWriteTargets = UNREAD_TARGETS;
  /** Why the last publish of a held seed did not land. */
  #lastAttempt: string | undefined;

  constructor(deps: ChainSeedDeps) {
    this.#deps = deps;
  }

  /**
   * What the UI shows. Addresses and event metadata only — by construction
   * there is no field here a mnemonic could be reached through.
   */
  status(): ChainSeedStatus {
    const signer = this.#signerOrReset();
    const checkedAt = this.#at().toISOString();
    if (!signer) {
      return {
        state: 'signed_out',
        relayList: relayListView(undefined),
        writes: this.#writes,
        warning: { text: CUSTODY_WARNING },
        supersededSeeds: 0,
        checkedAt,
      };
    }
    const acknowledgedAt = this.#deps.cache.read(signer.pubkey)?.warningAcknowledgedAt;
    const open = this.#open;
    return {
      state: this.#state(),
      pubkey: signer.pubkey,
      ...(open ? { addresses: open.addresses, origin: open.origin } : {}),
      // A `record` describes a PUBLISHED record. A held seed has none, and
      // giving it one — with a `publishedAt` taken from an event nothing has
      // seen — is exactly the confusion this state exists to prevent.
      ...(open?.published
        ? {
            record: {
              eventId: open.event.id,
              publishedAt: new Date(open.event.created_at * 1000).toISOString(),
              source: open.source,
              relays: open.relays,
            },
          }
        : {}),
      ...(open && !open.published
        ? {
            held: {
              since: open.heldSince ?? new Date(open.event.created_at * 1000).toISOString(),
              origin: open.origin,
              text: NOT_YET_RECOVERABLE,
              steps: RECOVERABILITY_STEPS,
              ...(this.#lastAttempt === undefined ? {} : { lastAttempt: this.#lastAttempt }),
            },
          }
        : {}),
      relayList: relayListView(this.#relayList),
      writes: this.#writes,
      warning: {
        text: CUSTODY_WARNING,
        ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
      },
      supersededSeeds: this.#supersededSeeds,
      ...(this.#lastPublish ? { lastPublish: this.#lastPublish } : {}),
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      checkedAt,
    };
  }

  /**
   * Look for this account's seed: the cache first, then its relays.
   *
   * The whole of the recovery criterion. On a fresh data directory the cache
   * is empty, the relays answer, and the same addresses come back — which is
   * what makes signing in on another machine worth doing at all.
   *
   * Reads are free (spec §5 prices a provider's routes, never a relay's
   * reads), so this asks every relay the account named, read and write alike,
   * plus the network profile's. A seed found on one of them is a seed found.
   *
   * `relays` is the escape hatch for the case that breaks the chain: a network
   * profile whose only relay is a TOON relay, which carries no account's
   * NIP-65 list because it charges for writes. A fresh machine there has
   * nowhere to start looking, and the honest fix is to let a person say where
   * — one relay URL, read-only, remembered afterwards so it only has to be
   * typed once. It publishes nothing, so it is safe to try with a guess.
   */
  async refresh(options: { relays?: readonly string[] } = {}): Promise<ChainSeedStatus> {
    const signer = this.#require();
    this.#reason = undefined;
    const hints = (options.relays ?? []).map((url) => {
      const relay = normalizeRelayUrl(url);
      if (relay === undefined) {
        throw new ChainSeedError(
          'invalid_relay_url',
          `\`${String(url)}\` is not a relay URL. A relay is \`wss://host\` or \`ws://host\`.`
        );
      }
      return relay;
    });

    const cached = this.#deps.cache.read(signer.pubkey);
    this.#relayList = await this.#readRelayList(signer.pubkey, cached, hints);
    this.#writes = await this.#deps.writer().targets();

    const fromRelays = await this.#readRecords(signer.pubkey, hints);
    const candidates = [
      ...(cached?.event
        ? [
            {
              event: cached.event,
              source: 'cache' as const,
              relays: [],
              published: cached.published !== false,
            },
          ]
        : []),
      ...fromRelays,
    ];
    this.#looked = true;

    // A hint that turned something up is worth keeping; one that turned up
    // nothing is a guess, and a cache of guesses is a slower read every time.
    if (hints.length > 0 && (candidates.length > 0 || this.#relayList.entries.length > 0)) {
      this.#deps.cache.rememberRelays(signer.pubkey, hints);
    }

    if (candidates.length === 0) {
      this.#open = undefined;
      this.#supersededSeeds = 0;
      return this.status();
    }

    // NIP-01's replacement rule decides which record is current, not whichever
    // relay answered first and not the cache by virtue of being local. One
    // exception, and it is how a held seed stops being held: when the cache
    // and a relay hold the SAME event, the relay's copy is the one that proves
    // it was published — by this console or by another machine of the same
    // account.
    const current = candidates.reduce((held, candidate) => {
      if (candidate.event.id === held.event.id) {
        return candidate.published && !held.published ? candidate : held;
      }
      return supersedes(candidate.event, held.event) ? candidate : held;
    });

    const opened = await this.#openSeed(signer, current.event).catch((error: unknown) => {
      if (error instanceof SealingError) {
        this.#open = undefined;
        this.#reason = error.message;
        return undefined;
      }
      throw error;
    });
    if (!opened) return this.status();

    this.#open = {
      ...opened,
      event: current.event,
      source: current.source,
      relays: current.relays,
      // A record a relay answered with IS published, whatever the cache
      // thought: that is the only way a held seed's state can be cleared by
      // somebody else's console, and it is the right way.
      published: current.published,
      ...(current.published
        ? {}
        : { heldSince: new Date(current.event.created_at * 1000).toISOString() }),
    };
    this.#supersededSeeds = await this.#countOtherSeeds(signer, candidates, {
      event: current.event,
      addresses: opened.addresses,
    });

    // Only now: a record that opened is one worth keeping a copy of, and one
    // that did not would overwrite a cache that still works.
    if (current.source === 'relays') {
      this.#deps.cache.writeEvent(signer.pubkey, {
        event: current.event,
        relays: current.relays,
        published: true,
      });
    }
    return this.status();
  }

  /**
   * Mint a random BIP-39 Chain Seed, seal it, and HOLD it.
   *
   * It is not published here and it cannot be: publishing is a paid packet,
   * paying takes a channel, and the channel is opened with a key derived from
   * these very words (TOON_Network#120). What comes back says
   * `not_yet_recoverable` and carries the addresses to fund, which is the only
   * order these steps can happen in.
   */
  async mint(): Promise<ChainSeedStatus> {
    const signer = this.#require();
    this.#requireAcknowledged(signer.pubkey);
    await this.#refuseIfSeedExists(signer, 'Minting a second one would strand it.');
    return this.#sealAndHold(signer, generateMnemonic(), 'minted');
  }

  /**
   * Import an existing BIP-39 mnemonic as this account's Chain Seed.
   *
   * ADR 0020 keeps this as the one way an account's chain keys can be made to
   * match another wallet's: a NIP-06 phrase typed into MetaMask or Phantom
   * derives the same addresses at the same paths, so an account that already
   * has funds somewhere can bring them rather than start again.
   */
  async importMnemonic(words: string): Promise<ChainSeedStatus> {
    const signer = this.#require();
    this.#requireAcknowledged(signer.pubkey);
    const mnemonic = normalizeMnemonic(words);
    if (!validateMnemonic(mnemonic)) {
      throw new ChainSeedError(
        'invalid_mnemonic',
        'Those are not valid BIP-39 words. Check the spelling and the word count (12 or 24); ' +
          'the last word is a checksum, so one wrong letter fails the whole phrase.'
      );
    }
    const existing = await this.#refuseIfSeedExists(
      signer,
      'Importing over it would strand it.',
      mnemonic
    );
    // Importing the phrase the account already has is not a mistake; it is
    // somebody checking. Say so rather than publishing it a second time.
    if (existing === 'same') return this.status();
    return this.#sealAndHold(signer, mnemonic, 'imported');
  }

  /**
   * Publish the held record: one paid write, and the end of the temporary
   * state.
   *
   * The third step of #120's ordering, and the only thing that clears
   * `not_yet_recoverable`. It publishes what was sealed at mint time — the
   * same bytes, not a re-seal — so the record a relay ends up holding is the
   * one this console has been describing all along.
   *
   * A write that does not land leaves everything exactly as it was: still
   * held, still saying so, with the reason attached. Nothing is re-minted and
   * nothing is dropped, because the words are already the ones the account's
   * addresses were derived from and may already hold money.
   */
  async publish(): Promise<ChainSeedStatus> {
    const signer = this.#require();
    const open = this.#open;
    if (!open) {
      throw new ChainSeedError(
        this.#state() === 'unreadable' ? 'seed_unreadable' : 'no_seed',
        this.#state() === 'unreadable'
          ? `This account has a Chain Seed record that this signer did not open, so there is ` +
              `nothing here to publish. ${this.#reason ?? ''}`.trim()
          : 'This account has no Chain Seed yet, so there is nothing to publish. Mint or ' +
              'import one first.',
        409
      );
    }
    if (open.published) return this.status();

    try {
      const receipt = await this.#deps.writer().write({
        event: open.event,
        what: 'This account’s Chain Seed record',
      });
      this.#lastPublish = reportOf('chain-seed', receipt);
      this.#lastAttempt = undefined;
      this.#deps.cache.writeEvent(signer.pubkey, {
        event: open.event,
        relays: receipt.relays,
        published: true,
      });
      this.#deps.cache.rememberRelays(signer.pubkey, receipt.relays);
      this.#open = { ...open, source: 'relays', relays: receipt.relays, published: true };
      this.#writes = await this.#deps.writer().targets();
      return this.status();
    } catch (error) {
      if (error instanceof RelayWriteError) {
        this.#lastAttempt = error.message;
        this.#writes = await this.#deps.writer().targets();
        throw new ChainSeedError(
          error.code,
          `${error.message} The Chain Seed is still NOT YET RECOVERABLE: it is sealed on this ` +
            `machine and on no relay, and nothing about it has changed.`,
          error.status,
          error.writes
        );
      }
      throw error;
    }
  }

  /**
   * Lend this account's payer keys to `use`, and zero them afterwards.
   *
   * The funding path's one door into the seed (TOON_Network#90). It requires a
   * seed that is already OPEN — `refresh` has run and this signer unsealed the
   * record — so there is no route here that mints, imports or publishes
   * anything: asking for a key cannot become a way to create one.
   *
   * The mnemonic is unsealed, derived from and dropped inside this call. The
   * two keys live for exactly as long as `use` takes, and are wiped whether it
   * returns or throws.
   *
   * @throws {ChainSeedError} when nobody is signed in, or the account has no
   *   readable Chain Seed to derive from.
   */
  async usePayerKeys<T>(use: (keys: PayerKeys) => Promise<T>): Promise<T> {
    const signer = this.#require();
    const open = this.#open;
    if (!open) {
      throw new ChainSeedError(
        this.#state() === 'unreadable' ? 'seed_unreadable' : 'no_seed',
        this.#state() === 'unreadable'
          ? `This account has a Chain Seed record, but this signer did not open it, so no payer ` +
              `key can be derived. ${this.#reason ?? ''}`.trim()
          : 'This account has no Chain Seed yet, so it has no payer key on any chain. Mint or ' +
              'import one first.',
        409
      );
    }
    const identity = deriveFullIdentity(await this.#mnemonicOf(signer, open.event), {
      accountIndex: ACCOUNT_INDEX,
    });
    try {
      return await use(identity);
    } finally {
      identity.evm.privateKey.fill(0);
      identity.solana.secretKey.fill(0);
    }
  }

  /** The once-only warning, taken as read. Per account, and it persists. */
  acknowledgeWarning(): ChainSeedStatus {
    const signer = this.#require();
    this.#deps.cache.acknowledgeWarning(signer.pubkey, this.#at());
    return this.status();
  }

  /**
   * Publish a NIP-65 relay list for this account: one more paid write.
   *
   * What it is FOR changed with #120. It was the way out of a seam — an
   * account with no list had nowhere free to put a sealed seed — and that seam
   * is closed: records go to the TOON relay, paid for. What a list still does
   * is tell every other Nostr client where this account is to be found, and
   * tell this console where to look on a machine that has never seen it. So it
   * is offered rather than required, and it goes where every write goes, which
   * is not necessarily a relay it names: the list is a statement ABOUT relays,
   * not a thing that has to live on each of them.
   */
  async publishRelayList(
    entries: readonly { url: string; mode?: RelayMode }[]
  ): Promise<ChainSeedStatus> {
    const signer = this.#require();
    const template = relayListTemplate(entries, this.#seconds());
    const signed = (await signer.sign(template)) as unknown as NostrEvent;
    try {
      const receipt = await this.#deps.writer().write({
        event: signed,
        what: 'This account’s NIP-65 relay list',
      });
      this.#lastPublish = reportOf('relay-list', receipt);
      // Remember where it went, and where it says to look: the next read on a
      // fresh machine seeds from the profile's relay, and an account's own
      // relays are worth asking too.
      this.#deps.cache.rememberRelays(signer.pubkey, [
        ...receipt.relays,
        ...template.tags.flatMap((tag) => (tag[0] === 'r' && tag[1] ? [tag[1]] : [])),
      ]);
      return await this.refresh();
    } catch (error) {
      if (error instanceof RelayWriteError) {
        throw new ChainSeedError(
          error.code === 'write_refused' || error.code === 'write_unconfirmed'
            ? 'relay_list_not_published'
            : error.code,
          error.message,
          error.status,
          error.writes
        );
      }
      throw error;
    }
  }

  /**
   * The relays this account's own NIP-65 list says to WRITE to, as they are
   * known right now.
   *
   * The writer asks for these (#121): an Account's records go to every relay
   * in its write list the console can pay, not only to the profile's. It is
   * synchronous and it dials nothing — it answers with what the last `refresh`
   * found, and with nothing before one has run. That is deliberate: a
   * `targets()` call happens on every status, and making it read a relay list
   * would put a socket round trip behind every view. An empty answer means the
   * profile's relay alone, which is exactly #120's behaviour.
   */
  writeRelays(): readonly string[] {
    return this.#relayList?.write ?? [];
  }

  /** Forget this session's opened seed — a sign-out, not a deletion. */
  forget(): void {
    this.#forPubkey = undefined;
    this.#open = undefined;
    this.#looked = false;
    this.#relayList = undefined;
    this.#supersededSeeds = 0;
    this.#lastPublish = undefined;
    this.#reason = undefined;
  }

  #state(): ChainSeedState {
    if (this.#open) return this.#open.published ? 'ready' : 'not_yet_recoverable';
    if (this.#reason !== undefined) return 'unreadable';
    return this.#looked ? 'absent' : 'unknown';
  }

  /**
   * Seal, sign, and hold — the first step of #120's ordering.
   *
   * The mnemonic exists in this call frame and in the ciphertext, and nowhere
   * else: what is cached is the sealed event, marked `published: false`, which
   * is what makes the state a named one rather than a silent copy. The
   * addresses are derived and returned because funding one of them is the very
   * next step, and there is no way round that — the payer key that will pay
   * for the publication is derived from these words.
   */
  async #sealAndHold(
    signer: ChainSeedSigner,
    mnemonic: string,
    origin: SeedOrigin
  ): Promise<ChainSeedStatus> {
    const sealedAt = this.#at().toISOString();
    const sealed: SealedSeed = { v: 1, mnemonic, origin, created_at: sealedAt };
    const content = await signer.sealToSelf(JSON.stringify(sealed));
    const signedEvent = (await signer.sign({
      kind: CHAIN_SEED_KIND,
      created_at: this.#seconds(),
      // `d` is public and says only that this account keeps a console record.
      // The relay learns that much and nothing else (ADR 0020).
      tags: [['d', CHAIN_SEED_D]],
      content,
    })) as unknown as NostrEvent;

    const addresses = deriveAddresses(mnemonic);
    this.#deps.cache.writeEvent(signer.pubkey, { event: signedEvent, published: false });
    this.#open = {
      addresses,
      origin,
      event: signedEvent,
      source: 'cache',
      relays: [],
      published: false,
      heldSince: sealedAt,
    };
    this.#looked = true;
    this.#reason = undefined;
    this.#lastAttempt = undefined;
    this.#supersededSeeds = 0;
    this.#writes = await this.#deps.writer().targets();
    return this.status();
  }

  async #readRelayList(
    pubkey: string,
    cached: CachedChainSeed | undefined,
    hints: readonly string[]
  ): Promise<RelayList> {
    // Relays the cached record was last seen on are worth asking too: an
    // account whose list moved still has its old relays holding the record.
    const seeds = [...hints, ...this.#deps.seedRelays(), ...(cached?.relays ?? [])];
    if (seeds.length === 0) return NO_RELAY_LIST;
    return readRelayListOf(pubkey, seeds, {
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
  }

  async #readRecords(
    pubkey: string,
    hints: readonly string[]
  ): Promise<{ event: NostrEvent; source: 'relays'; relays: string[]; published: true }[]> {
    const relays = [
      ...new Set([
        ...hints,
        ...(this.#relayList?.read ?? []),
        ...(this.#relayList?.write ?? []),
        ...this.#deps.seedRelays(),
        ...(this.#deps.cache.read(pubkey)?.relays ?? []),
      ]),
    ].filter((url) => url.length > 0);
    if (relays.length === 0) return [];
    const result = await queryRelays({
      relays,
      filters: [
        { kinds: [CHAIN_SEED_KIND], authors: [pubkey], '#d': [CHAIN_SEED_D], limit: 8 },
      ],
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
    const answered = result.relays.filter((outcome) => outcome.events > 0).map((o) => o.url);
    // `queryRelays` has already re-derived every id and checked every
    // signature; the `d` and author checks here are the relay's OTHER way of
    // lying, which is to answer a filter with something that does not match.
    return result.events
      .filter(
        (event) =>
          event.kind === CHAIN_SEED_KIND &&
          event.pubkey === pubkey &&
          tagValue(event, 'd') === CHAIN_SEED_D
      )
      .map((event) => ({
        event,
        source: 'relays' as const,
        relays: answered,
        published: true as const,
      }));
  }

  /**
   * How many of the other records held a DIFFERENT seed.
   *
   * Two machines that both minted before either published leave two records,
   * and NIP-01 replacement quietly picks one. The funds in the loser's
   * addresses do not disappear, but nothing would ever mention them again — so
   * the count is surfaced rather than swallowed, and a non-zero one is a thing
   * for a person to look into before they deposit anything.
   */
  async #countOtherSeeds(
    signer: ChainSeedSigner,
    candidates: readonly { event: NostrEvent }[],
    current: { event: NostrEvent; addresses: ChainAddresses }
  ): Promise<number> {
    const seen = new Set<string>([current.addresses.evm.address]);
    for (const candidate of candidates) {
      if (candidate.event.id === current.event.id) continue;
      if (candidate.event.content === current.event.content) continue;
      const opened = await this.#openSeed(signer, candidate.event).catch(() => undefined);
      if (opened) seen.add(opened.addresses.evm.address);
    }
    return seen.size - 1;
  }

  /**
   * Unseal one record and derive from it.
   *
   * The only place a mnemonic exists on the read path, and it is a local
   * inside this method: what comes back is addresses.
   */
  async #openSeed(
    signer: ChainSeedSigner,
    event: NostrEvent
  ): Promise<{ addresses: ChainAddresses; origin: SeedOrigin }> {
    const record = await this.#unseal(signer, event);
    return {
      addresses: deriveAddresses(record.mnemonic),
      origin: record.origin,
    };
  }

  /**
   * The mnemonic in one record, for one caller's call frame.
   *
   * Private, and the only two callers are `#openSeed` (which turns it straight
   * into addresses) and `usePayerKeys` (which turns it straight into keys).
   * Neither hands it any further.
   */
  async #mnemonicOf(signer: ChainSeedSigner, event: NostrEvent): Promise<string> {
    return (await this.#unseal(signer, event)).mnemonic;
  }

  async #unseal(
    signer: ChainSeedSigner,
    event: NostrEvent
  ): Promise<{ mnemonic: string; origin: SeedOrigin }> {
    const plaintext = await signer.unsealFromSelf(event.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new SealingError(
        'seed_unreadable',
        'That Chain Seed record opened, but what was inside it is not this console’s format.'
      );
    }
    const record = parsed as Partial<SealedSeed>;
    const mnemonic =
      typeof record.mnemonic === 'string' ? normalizeMnemonic(record.mnemonic) : '';
    if (!validateMnemonic(mnemonic)) {
      throw new SealingError(
        'seed_unreadable',
        'That Chain Seed record does not hold valid BIP-39 words.'
      );
    }
    return { mnemonic, origin: record.origin === 'imported' ? 'imported' : 'minted' };
  }

  /**
   * @returns `'same'` when the account already holds exactly `mnemonic`.
   * @throws {ChainSeedError} when it holds a different one.
   */
  async #refuseIfSeedExists(
    signer: ChainSeedSigner,
    consequence: string,
    mnemonic?: string
  ): Promise<'none' | 'same'> {
    await this.refresh();
    const open = this.#open;
    if (!open) {
      if (this.#state() === 'unreadable') {
        throw new ChainSeedError(
          'seed_unreadable',
          `This account already has a Chain Seed record, but this signer did not open it. ` +
            `${consequence} ${this.#reason ?? ''}`.trim(),
          409
        );
      }
      return 'none';
    }
    if (
      mnemonic !== undefined &&
      deriveAddresses(mnemonic).evm.address === open.addresses.evm.address
    ) {
      return 'same';
    }
    throw new ChainSeedError(
      'seed_exists',
      `This account already has a Chain Seed, published ${new Date(
        open.event.created_at * 1000
      )
        .toISOString()
        .slice(
          0,
          10
        )} and holding ${open.addresses.evm.address} on EVM. ${consequence} Sign in with the ` +
        'account this seed belongs to, or use a different account.',
      409
    );
  }

  #requireAcknowledged(pubkey: string): void {
    if (this.#deps.cache.read(pubkey)?.warningAcknowledgedAt === undefined) {
      throw new ChainSeedError('warning_not_acknowledged', CUSTODY_WARNING, 409);
    }
  }

  #require(): ChainSeedSigner {
    const signer = this.#signerOrReset();
    if (!signer) {
      throw new ChainSeedError(
        'not_signed_in',
        'No account is signed in, so there is no key to seal a Chain Seed to.',
        409
      );
    }
    return signer;
  }

  /** Drop everything the moment the signed-in account changes. */
  #signerOrReset(): ChainSeedSigner | undefined {
    const signer = this.#deps.signer();
    if (signer?.pubkey !== this.#forPubkey) {
      this.forget();
      this.#forPubkey = signer?.pubkey;
    }
    return signer;
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }

  #seconds(): number {
    return Math.floor(this.#at().getTime() / 1000);
  }
}

/**
 * The addresses, from `@toon-protocol/client`'s own derivation.
 *
 * Not reimplemented here, and that is a rule rather than a convenience: the
 * client derives EVM at `m/44'/60'/0'/0/i` and Solana at `m/44'/501'/i'/0'`,
 * a second copy of either would be a second chance to get a path wrong, and a
 * wrong path is funds sent to an address nothing will ever derive again.
 *
 * The private keys come back with the addresses and are zeroed before this
 * returns. Nothing outside this function has ever held them; #90 will derive
 * its own when it has a transaction to sign.
 */
export function deriveAddresses(
  mnemonic: string,
  accountIndex = ACCOUNT_INDEX
): ChainAddresses {
  const identity = deriveFullIdentity(mnemonic, { accountIndex });
  try {
    return {
      evm: {
        address: identity.evm.address,
        path: evmDerivationPath('standard', accountIndex),
      },
      solana: {
        address: identity.solana.publicKey,
        path: `m/44'/501'/${accountIndex}'/0'`,
      },
    };
  } finally {
    identity.evm.privateKey.fill(0);
    identity.solana.secretKey.fill(0);
  }
}

/** BIP-39 words as the checksum expects them: lower case, single-spaced. */
export function normalizeMnemonic(words: string): string {
  return words.trim().toLowerCase().split(/\s+/u).join(' ');
}

function relayListView(list: RelayList | undefined): RelayListView {
  return {
    state: list === undefined ? 'unknown' : list.entries.length > 0 ? 'present' : 'none',
    read: list?.read ?? [],
    write: list?.write ?? [],
    ...(list?.publishedAt === undefined ? {} : { publishedAt: list.publishedAt }),
  };
}

/** One paid write, as the status reports it. The cost is never recomputed. */
function reportOf(what: PublishReport['what'], receipt: RelayWriteReceipt): PublishReport {
  return {
    at: receipt.at,
    what,
    relays: receipt.writes,
    accepted: receipt.relays,
    ...(receipt.cost === undefined ? {} : { cost: receipt.cost }),
    destination: receipt.destination,
    payAt: receipt.payAt,
    chain: receipt.chain,
  };
}

/** Before the writer has been asked anything. Never mistaken for "ready". */
const UNREAD_TARGETS: RelayWriteTargets = {
  relays: [],
  plan: [],
  ready: false,
  blockedBy: 'Nothing has asked this network’s connector what a relay write costs yet.',
};
