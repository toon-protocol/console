import {
  deriveFullIdentity,
  evmDerivationPath,
  generateMnemonic,
  validateMnemonic,
} from '@toon-protocol/client';
import { supersedes, tagValue, type NostrEvent } from './nostr.js';
import {
  NO_RELAY_LIST,
  readRelayListOf,
  relayListTemplate,
  type RelayList,
  type RelayMode,
} from './relay-list.js';
import {
  isPersisted,
  publishToRelays,
  queryRelays,
  type PublishOutcome,
  type RelayDialer,
} from './relay-pool.js';
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
 * **Nothing is cached until a relay has it.** The local cache holds the
 * SEALED event, exactly as published, and it is written only after some relay
 * has answered `OK … true`. A seed that existed only in `~/.local/share`
 * while the console said "recoverable on any machine" would be ADR 0020's
 * rejected option wearing its name, and the failure would surface on the day
 * the disk died. So a publish that no relay accepted throws, and the minted
 * words are dropped unused. Nothing is lost by that: no address derived from
 * them has ever been shown, let alone funded.
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

export type ChainSeedState =
  /** No account is signed in, so there is nothing to unseal anything with. */
  | 'signed_out'
  /** Not looked for yet. */
  | 'unknown'
  /** Looked for and not found: this account has no Chain Seed anywhere. */
  | 'absent'
  /** Found and opened. The addresses are real. */
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

export interface SeedRecordView {
  readonly eventId: string;
  readonly publishedAt: string;
  /** Where this console got the record it is showing. */
  readonly source: 'cache' | 'relays';
  /** Relays confirmed to hold it, from the last read or publish. */
  readonly relays: readonly string[];
}

export interface RelayListView {
  readonly state: 'unknown' | 'none' | 'present';
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly publishedAt?: string | undefined;
  /** Where a seed would be published right now, and why there. */
  readonly writeTargets: readonly string[];
  readonly writeTargetSource: 'nip65' | 'profile' | 'none';
}

export interface PublishReport {
  readonly at: string;
  readonly what: 'chain-seed' | 'relay-list';
  readonly relays: readonly PublishOutcome[];
  readonly accepted: readonly string[];
}

export interface ChainSeedStatus {
  readonly state: ChainSeedState;
  readonly pubkey?: string | undefined;
  readonly addresses?: ChainAddresses | undefined;
  readonly origin?: SeedOrigin | undefined;
  readonly record?: SeedRecordView | undefined;
  readonly relayList: RelayListView;
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
  /** Per-relay detail, when the fault was a publish. */
  readonly relays?: readonly PublishOutcome[];
  constructor(
    code: string,
    message: string,
    status = 400,
    relays?: readonly PublishOutcome[]
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
  /** One seam for both directions, so the real read and write run in tests. */
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
        relayList: relayListView(undefined, []),
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
      ...(open
        ? {
            record: {
              eventId: open.event.id,
              publishedAt: new Date(open.event.created_at * 1000).toISOString(),
              source: open.source,
              relays: open.relays,
            },
          }
        : {}),
      relayList: relayListView(this.#relayList, this.#deps.seedRelays()),
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
   */
  async refresh(): Promise<ChainSeedStatus> {
    const signer = this.#require();
    this.#reason = undefined;
    const cached = this.#deps.cache.read(signer.pubkey);
    this.#relayList = await this.#readRelayList(signer.pubkey, cached);

    const fromRelays = await this.#readRecords(signer.pubkey);
    const candidates = [
      ...(cached?.event
        ? [{ event: cached.event, source: 'cache' as const, relays: [] }]
        : []),
      ...fromRelays,
    ];
    this.#looked = true;

    if (candidates.length === 0) {
      this.#open = undefined;
      this.#supersededSeeds = 0;
      return this.status();
    }

    // NIP-01's replacement rule decides which record is current, not whichever
    // relay answered first and not the cache by virtue of being local.
    const current = candidates.reduce((held, candidate) =>
      supersedes(candidate.event, held.event) ? candidate : held
    );

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
    };
    this.#supersededSeeds = await this.#countOtherSeeds(signer, candidates, {
      event: current.event,
      addresses: opened.addresses,
    });

    // Only now: a record that opened is one worth keeping a copy of, and one
    // that did not would overwrite a cache that still works.
    if (current.source === 'relays') {
      this.#deps.cache.writeEvent(signer.pubkey, current.event, current.relays);
    }
    return this.status();
  }

  /** Mint a random BIP-39 Chain Seed, seal it, publish it. */
  async mint(): Promise<ChainSeedStatus> {
    const signer = this.#require();
    this.#requireAcknowledged(signer.pubkey);
    await this.#refuseIfSeedExists(signer, 'Minting a second one would strand it.');
    return this.#sealAndPublish(signer, generateMnemonic(), 'minted');
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
    return this.#sealAndPublish(signer, mnemonic, 'imported');
  }

  /** The once-only warning, taken as read. Per account, and it persists. */
  acknowledgeWarning(): ChainSeedStatus {
    const signer = this.#require();
    this.#deps.cache.acknowledgeWarning(signer.pubkey, this.#at());
    return this.status();
  }

  /**
   * Publish a NIP-65 relay list for an account that has none.
   *
   * The offer ADR 0020's ticket asks for, and the way out of the seam below:
   * an account with no list has nowhere of its own to put a sealed seed, and
   * the only relay the console knows about is the network profile's — which
   * charges for writes. Naming a relay here gives the seed somewhere to go.
   *
   * The list goes to the relays it names. There is no indexer constant here,
   * for the same reason there is no chain id in `profiles.ts`: a relay the
   * console picked would be a relay the account never chose.
   */
  async publishRelayList(
    entries: readonly { url: string; mode?: RelayMode }[]
  ): Promise<ChainSeedStatus> {
    const signer = this.#require();
    const template = relayListTemplate(entries, this.#seconds());
    const signed = await signer.sign(template);
    const targets = template.tags.flatMap((tag) => (tag[0] === 'r' && tag[1] ? [tag[1]] : []));
    const result = await publishToRelays({
      event: signed,
      relays: targets,
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
    this.#lastPublish = {
      at: this.#at().toISOString(),
      what: 'relay-list',
      relays: result.relays,
      accepted: result.accepted,
    };
    if (result.accepted.length === 0) {
      throw new ChainSeedError(
        'relay_list_not_published',
        `No relay accepted this account's relay list. ${describeRefusals(result.relays)}`,
        502,
        result.relays
      );
    }
    // Remember where it went. A list published to a relay nothing else names
    // would otherwise be unreadable to the very console that just wrote it:
    // the next read seeds from the network profile's relay, which has never
    // heard of it.
    this.#deps.cache.rememberRelays(signer.pubkey, result.accepted);
    return this.refresh();
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
    if (this.#open) return 'ready';
    if (this.#reason !== undefined) return 'unreadable';
    return this.#looked ? 'absent' : 'unknown';
  }

  /**
   * Seal, sign, publish, and only then cache.
   *
   * The ordering is the safety property. Between `sealToSelf` and the first
   * `OK … true` the mnemonic exists in exactly one place — this call frame —
   * and if no relay takes it, it is dropped there. That is the right outcome:
   * a seed no relay holds is not a Chain Seed, and pretending otherwise is how
   * an account funds an address it can never recover.
   */
  async #sealAndPublish(
    signer: ChainSeedSigner,
    mnemonic: string,
    origin: SeedOrigin
  ): Promise<ChainSeedStatus> {
    const targets = this.#writeTargets();
    if (targets.relays.length === 0) {
      throw new ChainSeedError(
        'no_relay',
        'There is nowhere to publish this Chain Seed. This account has published no NIP-65 ' +
          'relay list, and the active network profile names no relay either. Publish a relay ' +
          'list first, naming at least one relay this account can write to.',
        409
      );
    }

    const sealed: SealedSeed = {
      v: 1,
      mnemonic,
      origin,
      created_at: this.#at().toISOString(),
    };
    const content = await signer.sealToSelf(JSON.stringify(sealed));
    const signedEvent = await signer.sign({
      kind: CHAIN_SEED_KIND,
      created_at: this.#seconds(),
      // `d` is public and says only that this account keeps a console record.
      // The relay learns that much and nothing else (ADR 0020).
      tags: [['d', CHAIN_SEED_D]],
      content,
    });

    const result = await publishToRelays({
      event: signedEvent,
      relays: targets.relays,
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
    this.#lastPublish = {
      at: this.#at().toISOString(),
      what: 'chain-seed',
      relays: result.relays,
      accepted: result.accepted,
    };

    if (result.accepted.length === 0) {
      throw notPersisted(result.relays, targets.source);
    }

    const addresses = deriveAddresses(mnemonic);
    this.#deps.cache.writeEvent(
      signer.pubkey,
      signedEvent as unknown as NostrEvent,
      result.accepted
    );
    this.#open = {
      addresses,
      origin,
      event: signedEvent as unknown as NostrEvent,
      source: 'relays',
      relays: result.accepted,
    };
    this.#looked = true;
    this.#reason = undefined;
    this.#supersededSeeds = 0;
    return this.status();
  }

  /**
   * Where a seed goes: the account's NIP-65 WRITE relays, or the network
   * profile's relay when it has named none.
   *
   * The second case is the awkward one, and it is handled by being honest
   * about it rather than by picking a relay. The profile's relay is a TOON
   * relay; a TOON relay prices its writes at 1 µUSDC and refuses an unpaid
   * one outright. Until this account has a channel (TOON_Network#90) the write
   * will be refused, and `notPersisted` says exactly that and what to do.
   */
  #writeTargets(): { relays: readonly string[]; source: 'nip65' | 'profile' | 'none' } {
    const write = this.#relayList?.write ?? [];
    if (write.length > 0) return { relays: write, source: 'nip65' };
    const seeds = this.#deps.seedRelays().filter((url) => url.length > 0);
    return seeds.length > 0
      ? { relays: seeds, source: 'profile' }
      : { relays: [], source: 'none' };
  }

  async #readRelayList(
    pubkey: string,
    cached: CachedChainSeed | undefined
  ): Promise<RelayList> {
    // Relays the cached record was last seen on are worth asking too: an
    // account whose list moved still has its old relays holding the record.
    const seeds = [...this.#deps.seedRelays(), ...(cached?.relays ?? [])];
    if (seeds.length === 0) return NO_RELAY_LIST;
    return readRelayListOf(pubkey, seeds, {
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
  }

  async #readRecords(
    pubkey: string
  ): Promise<{ event: NostrEvent; source: 'relays'; relays: string[] }[]> {
    const relays = [
      ...new Set([
        ...(this.#relayList?.read ?? []),
        ...(this.#relayList?.write ?? []),
        ...this.#deps.seedRelays(),
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
      .map((event) => ({ event, source: 'relays' as const, relays: answered }));
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
    return {
      addresses: deriveAddresses(mnemonic),
      origin: record.origin === 'imported' ? 'imported' : 'minted',
    };
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

function relayListView(list: RelayList | undefined, seeds: readonly string[]): RelayListView {
  const write = list?.write ?? [];
  const usable = seeds.filter((url) => url.length > 0);
  const targets = write.length > 0 ? write : usable;
  const source = write.length > 0 ? 'nip65' : usable.length > 0 ? 'profile' : 'none';
  return {
    state: list === undefined ? 'unknown' : list.entries.length > 0 ? 'present' : 'none',
    read: list?.read ?? [],
    write,
    ...(list?.publishedAt === undefined ? {} : { publishedAt: list.publishedAt }),
    writeTargets: targets,
    writeTargetSource: source,
  };
}

/**
 * The paid-relay seam, spelled out for a person rather than swallowed.
 *
 * A TOON relay answers an unpaid websocket write with
 * `restricted: writes require ILP payment` — its writes cost 1 µUSDC, settled
 * through a payment channel, and this ticket opens none (TOON_Network#90
 * does). When that relay is the ONLY one available, because the account has
 * published no NIP-65 list, minting cannot persist anything. The console says
 * so, names the relay and its words, and gives the two ways out. It does not
 * cache the seed and call it done.
 */
function notPersisted(
  relays: readonly PublishOutcome[],
  source: 'nip65' | 'profile' | 'none'
): ChainSeedError {
  const paid = relays.filter(looksLikePaidWrite);
  if (paid.length > 0 && paid.length === relays.length) {
    const where =
      source === 'profile'
        ? 'This account has published no NIP-65 relay list, so the only relay the console had ' +
          'to try was the network profile’s — and that one charges for writes.'
        : 'Every relay this account writes to charges for writes.';
    return new ChainSeedError(
      'relay_payment_required',
      `The Chain Seed was NOT published, and nothing was kept locally — a seed only one disk ` +
        `holds is not recoverable, so the console would rather fail here than pretend. ` +
        `${where} ${describeRefusals(relays)} A paid write costs 1 µUSDC from a payment ` +
        `channel, and this console cannot open one yet. Publish a relay list naming a relay ` +
        `this account can write to for free, and mint again.`,
      402,
      relays
    );
  }
  return new ChainSeedError(
    'not_persisted',
    `The Chain Seed was NOT published, and nothing was kept locally. ${describeRefusals(
      relays
    )} Nothing was minted twice: try again once a relay answers.`,
    502,
    relays
  );
}

/** A refusal that is really a price. */
export function looksLikePaidWrite(outcome: PublishOutcome): boolean {
  if (outcome.state !== 'rejected') return false;
  return /pay|paid|payment|invoice|ilp|usdc|sats?\b|price/iu.test(outcome.reason ?? '');
}

function describeRefusals(relays: readonly PublishOutcome[]): string {
  if (relays.length === 0) return 'No relay was tried.';
  return relays
    .filter((outcome) => !isPersisted(outcome))
    .map(
      (outcome) => `${outcome.url} ${outcome.state}: ${outcome.reason ?? 'no reason given'}.`
    )
    .join(' ');
}
