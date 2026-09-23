import { continuationFor, mintRootSecret } from './continuation.js';
import type { LeaseVaultCache } from './lease-vault-cache.js';
import { supersedes, tagValue, type NostrEvent } from './nostr.js';
import { NO_RELAY_LIST, readRelayListOf, type RelayList } from './relay-list.js';
import { queryRelays, type RelayDialer } from './relay-pool.js';
import {
  RelayWriteError,
  type RelayWriteOutcome,
  type RelayWriteReceipt,
  type RelayWriteTargets,
  type RelayWriter,
} from './relay-write.js';
import { SealingError, type AccountSigning } from './signer.js';
import { HEX_32, type SpawnImage, type SpawnPort } from './spawn-content.js';

/**
 * The **Lease Vault** (ADR 0021).
 *
 * One NIP-78 app-data event per lease — kind 30078, `d` =
 * `toon-console/lease/<workload id>` — with its contents NIP-44-sealed to the
 * account itself and published as a **paid TOON packet** on the account's
 * relay, with a local cache. An account that signs in on a new machine gets
 * its leases back, because the one thing that cannot be recovered any other
 * way is in them: the lease's **Root Secret**. Lose it and the lease is lost —
 * not merely inaccessible, lost, because nothing in the protocol can produce
 * the Continuation Token again (spec §6.1.1).
 *
 * Four rules shape this module.
 *
 * **Every write here is bought.** The record, its confirmation, its retraction
 * and the NIP-09 deletion beside it all go through `relay-write.ts`, which is
 * the console's one writer (TOON_Network#120). A vault write costs what the
 * connector quotes for a relay write — one µUSDC on devnet's relay, against a
 * lease that costs an interval — and the cost of each is reported, because a
 * person is entitled to know what their record-keeping costs them.
 *
 * **The record is written BEFORE the spawn is sent.** That ordering is the
 * whole point of the vault. The dangerous window is between minting a Root
 * Secret and learning what the provider did with it: a spawn that succeeds and
 * whose answer is then lost — a dropped socket, a killed daemon — has bought a
 * running workload whose secret exists nowhere. Publishing first closes that
 * window. It costs one relay write against a lease that may never start, which
 * `retract` below cleans up, and that is the cheaper side of the trade by a
 * wide margin.
 *
 * **A record that no relay took is not a vault record.** `publish` refuses
 * rather than caching quietly, and the spawn it was for is then never sent. A
 * console that pretended otherwise would be telling a person their lease
 * follows them when it does not, and the lie would surface on the day the disk
 * died. The one exception is a lease marked **local only** — which since #120
 * is a privacy choice and nothing else: an account with a channel can always
 * vault a lease, so choosing not to is choosing to keep the workload id off
 * even its own relay (ADR 0021), at the price of one disk holding the secret.
 *
 * **Nothing here ever hands a Root Secret out.** `list()` returns views with
 * no secret in them; the secret goes in through `publish` and comes out only
 * inside `#unseal`, which is private. There is no API route to a Root Secret,
 * and there must never be one.
 *
 * **A Rotation is recorded before it is asked for, and holds both roots until
 * it is done** (TOON_Network#96, spec §6.8, ADR 0018, ADR 0021). The new Root
 * Secret is minted and written into this record before the first `rotate`
 * request leaves, and the old one stays beside it until every member has
 * confirmed — because the members that have not are still read with it. Which
 * of the two a member is read with is decided per member, in `rootFor` below,
 * so a partially rotated Standby Set is a valid state here exactly as it is at
 * the providers (§6.8).
 *
 * **One record per WORKLOAD, not per member.** ADR 0021 says one event per
 * lease, and a lease's Root Secret is minted per lease (spec §6.1.1) — but a
 * Standby Set shares one Root Secret across its members, deriving a different
 * token for each. So the addressable unit that matches what is stored is the
 * workload id, and the record names the whole Standby Set. That keeps #95's
 * standbys a field in this record rather than a second record holding the same
 * secret twice.
 */

/** NIP-78 app data, the same kind the Chain Seed uses (ADR 0021). */
export const LEASE_VAULT_KIND = 30078;

/** The `d` tag prefix. One record per lease, kept single by NIP-01 replacement. */
export const LEASE_VAULT_D_PREFIX = 'toon-console/lease/';

/** NIP-09: how a retracted record asks its relays to drop it. */
export const DELETION_KIND = 5;

export function leaseVaultD(workloadId: string): string {
  return `${LEASE_VAULT_D_PREFIX}${workloadId}`;
}

/**
 * Where a lease is in its life, as the vault knows it.
 *
 * `spawning` is a record written before its spawn was sent and not yet
 * confirmed — either the answer has not come back, or it never did. It is not
 * an error state: a lease may really be running behind one, which is why the
 * console shows it and asks rather than deleting it.
 */
export type LeaseVaultState = 'spawning' | 'live' | 'retracted';

/**
 * A lease's ports and image are the SPAWN's own, verbatim.
 *
 * Re-exported from `spawn-content.ts` rather than restated, because a vault
 * record that described an image in its own words would be a second
 * description of the thing the provider was actually sent — and the two would
 * drift the first time §6.2 grew a field.
 */
export type LeasePort = SpawnPort;
export type LeaseImage = SpawnImage;

/** The access details a provider answered with (§6.2). */
export interface LeaseAccess {
  readonly host: string;
  readonly ssh_port?: number | undefined;
  readonly ports?: readonly { container_port: number; host_port: number }[] | undefined;
}

/**
 * What one member's own spawn did, as the vault records it.
 *
 * `spawning` is a member whose packet has not come back; `failed` is one that
 * was definitively refused. A failed member is kept rather than dropped,
 * because the account PAID for that refusal (ADR 0003) and because a set that
 * silently lost a member would look like a set that never had one.
 */
export type MemberState = 'spawning' | 'live' | 'failed';

/**
 * One member of a **Standby Set** (spec §7), as the vault records it.
 *
 * A Standby Set is one workload id bought from several providers, and this is
 * what the console needs to talk to each of them afterwards: where its
 * connector is, which key to seal to, and which Listing at which version its
 * lease was bought on — because a member's own tier decides its `.extend` and
 * `.standby.extend` routes, and no two providers have to price alike.
 *
 * What is NOT here is a secret. There is one Root Secret per WORKLOAD
 * (§6.1.1), held once on the record above; each member's Continuation Token is
 * derived from it under that member's own public key, so no member can act as
 * the tenant against another and nothing per member needs storing.
 */
export interface VaultedMember {
  readonly pubkey: string;
  /** Its position in `standby_set`. Index 0 is the primary (§7). */
  readonly index: number;
  readonly ilp_address: string;
  readonly connector_url: string;
  readonly connector_seal_key: string;
  readonly hidden?: boolean | undefined;
  readonly listing: VaultedLease['listing'];
  /** The connector this member's own spawn was PAID at. */
  readonly paid_at: string;
  /** The settlement chain it was paid on; an extension must use the same. */
  readonly paid_chain?: string | undefined;
  readonly state: MemberState;
  /** Why a member is `failed`, in the provider's own words. No secret. */
  readonly failed_because?: string | undefined;
  /** What the member answered: `primary`, `standby` or `standalone` (§6.2). */
  readonly role?: string | undefined;
  readonly expires_at?: number | undefined;
  readonly access?: LeaseAccess | undefined;
}

/**
 * What one sealed record holds.
 *
 * Everything needed to act on the lease again from a machine that has only the
 * account's Nostr key: the secret, who the provider is, where its connector
 * is, and which route the lease was bought on. The relay learns none of it —
 * the whole object is one NIP-44 ciphertext — and the `d` tag says only that
 * this account keeps a console lease record.
 */
/**
 * A **Rotation** under way, as the record carries it (spec §6.8, ADR 0018).
 *
 * The record holds **both** Root Secrets from the moment a rotation starts
 * until every member has confirmed, and that is not belt and braces: it is the
 * only arrangement in which no member is unreadable at any instant. A member
 * that has confirmed is read with the new root and a member that has not is
 * read with the old one, so a set rotated at some members and not others — a
 * valid state (§6.8) — is a set every member of which this account can still
 * read, extend and stop.
 *
 * The order is ADR 0021's: this is written **before** the first `rotate`
 * leaves. A crash between a member accepting `next` and this being written
 * would otherwise lose the only secret that now reads that member.
 */
export interface VaultedRotation {
  /** The NEW Root Secret. 64 lowercase hex. It never leaves this module. */
  readonly root_secret: string;
  /** The members the rotation was started for, in `standby_set`'s order. */
  readonly members: readonly string[];
  /** Those that have confirmed `next`. Always a subset of `members`. */
  readonly confirmed: readonly string[];
  readonly started_at: string;
}

export interface VaultedLease {
  readonly v: 1;
  readonly state: LeaseVaultState;
  readonly workload_id: string;
  /**
   * THE secret. 64 lowercase hex. It never leaves this module unsealed.
   *
   * While a Rotation is under way this stays the OLD root, because the members
   * that have not confirmed are still read with it. It becomes the new one in
   * the same write that drops `rotation`, once every member has confirmed
   * (§6.8).
   */
  readonly root_secret: string;
  /**
   * A Rotation part-way through, or absent because none is (§6.8, ADR 0021).
   *
   * Its presence is what makes a partially rotated set resumable from any
   * machine this account signs in on: the new root is on the account's own
   * relays from before the first request, so a console that died mid-rotation
   * — or a different machine entirely — finishes what it started rather than
   * starting again with a third root secret.
   */
  readonly rotation?: VaultedRotation | undefined;
  /** When the last Rotation finished. A moment, not a secret. */
  readonly rotated_at?: string | undefined;
  /** Every member of the Standby Set, primary first. One member is standalone. */
  readonly standby_set: readonly string[];
  /**
   * Where each member of the set is, and what its lease was bought on (§7).
   *
   * Absent on a record written before Standby Sets could be bought
   * (TOON_Network#95), and on nothing else: a record with one member has one
   * entry here, saying exactly what `provider` and `listing` below say. The
   * two are kept in step rather than one replacing the other, so an older
   * console reading this record still finds the lease it knows how to act on
   * at `provider`, and a newer one finds the whole set here.
   */
  readonly members?: readonly VaultedMember[] | undefined;
  readonly provider: {
    readonly pubkey: string;
    readonly ilp_address: string;
    readonly connector_url: string;
    readonly connector_seal_key: string;
    readonly hidden?: boolean | undefined;
  };
  /** The connector the spawn was PAID at, which may not be the provider's. */
  readonly paid_at: string;
  /**
   * The settlement chain the spawn was paid on, as the connector names it.
   *
   * Recorded because an EXTENSION has to be paid the same way, and which chain
   * that is cannot be worked out afterwards: an account may hold channels with
   * one connector on two chains, and a connector forwarding to a provider's
   * refuses a packet whose amount converts to nothing at the rate it declares
   * — at full price (TOON_Network#93, found on this machine's sandbox, where
   * the hub's peer settles in Solana and the same account also holds an EVM
   * channel there). Absent on a record written before this field existed; the
   * dashboard then falls back to the first chain it holds a channel on and
   * says which it chose.
   */
  readonly paid_chain?: string | undefined;
  readonly listing: {
    readonly name: string;
    readonly version: number;
    readonly address: string;
    readonly lease_interval_s: number;
    /** µUSDC for one Lease Interval, as the Listing priced it. */
    readonly price: number;
  };
  /** The network profile this lease was bought on. */
  readonly profile_id: string;
  readonly image: LeaseImage;
  readonly ports: readonly LeasePort[];
  readonly env_keys: readonly string[];
  /** The Template this spawn's values came from, when one did (§8.3, #94). */
  readonly template?: string | undefined;
  readonly created_at: string;
  /**
   * Marked local only: this record was never published anywhere (ADR 0021).
   *
   * A PRIVACY choice since #120, and nothing else. It used to double as the
   * way out for an account that could not pay for a relay write; an account
   * with a channel can always vault a lease now, so choosing local-only is
   * choosing to keep this workload id off even the account's own relay, and
   * accepting that one disk holds the Root Secret.
   */
  readonly local_only?: boolean | undefined;
  readonly role?: string | undefined;
  readonly expires_at?: number | undefined;
  readonly access?: LeaseAccess | undefined;
  /** Why a record is `retracted`, in words. Carries no secret. */
  readonly retracted_because?: string | undefined;
}

/**
 * One member of a Standby Set, as everything outside this module sees it.
 *
 * Always present, and always one entry per name in `standbySet`, whether or
 * not the record says where that member is: a set whose second member is a
 * pubkey and nothing else is still a set with two members, and hiding the one
 * this console cannot reach would be the wrong answer to "who else holds this
 * workload". `known` is what says which kind it is.
 */
export interface LeaseMemberView {
  readonly pubkey: string;
  /** Its position in the set. Index 0 is the primary (§7). */
  readonly index: number;
  /**
   * Its position in words, which a Takeover never changes (§6.7): a standby
   * that won still answers `role: "standby"`. `standalone` is the role of the
   * only member of a set of one — a lease with no Warm Standby at all.
   */
  readonly role: 'standalone' | 'primary' | 'standby';
  readonly provider: VaultedLease['provider'];
  readonly listing: VaultedLease['listing'];
  readonly paidAt: string;
  readonly paidChain?: string | undefined;
  readonly state: MemberState;
  readonly failedBecause?: string | undefined;
  /** What this member answered about itself at spawn: `primary`, `standby`… */
  readonly answeredRole?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly access?: LeaseAccess | undefined;
  /** False when the record names this member but not where to reach it. */
  readonly known: boolean;
}

/**
 * A Rotation under way, as everything outside this module sees it (§6.8).
 *
 * Which members have confirmed and which have not, and no secret: the two
 * Root Secrets it is about stay inside this module, exactly as the one a
 * lease normally has does.
 */
export interface LeaseRotationView {
  /** The members the rotation was started for, primary first. */
  readonly members: readonly string[];
  /** Those holding a token of the NEW root already. */
  readonly confirmed: readonly string[];
  /** Those still holding a token of the old one. Rotating again finishes them. */
  readonly pending: readonly string[];
  readonly startedAt: string;
}

/**
 * One lease, as everything outside this module sees it.
 *
 * Note what is missing and always will be: `root_secret`. The type has no such
 * field, so no route can return one by forgetting to strip it — and that holds
 * for a rotation's second root as much as for the first.
 */
export interface LeaseView {
  readonly workloadId: string;
  readonly state: LeaseVaultState;
  readonly standbySet: readonly string[];
  /** One per name in `standbySet`, primary first (§7). Never empty. */
  readonly members: readonly LeaseMemberView[];
  readonly provider: VaultedLease['provider'];
  readonly paidAt: string;
  /** The chain the spawn was paid on, when the record names one. */
  readonly paidChain?: string | undefined;
  readonly listing: VaultedLease['listing'];
  readonly profileId: string;
  readonly image: LeaseImage;
  readonly ports: readonly LeasePort[];
  readonly envKeys: readonly string[];
  readonly template?: string | undefined;
  readonly createdAt: string;
  readonly localOnly: boolean;
  readonly role?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly access?: LeaseAccess | undefined;
  /** Set while a Rotation is part-way through this lease's Standby Set (§6.8). */
  readonly rotation?: LeaseRotationView | undefined;
  /** When the last Rotation finished, when one has. */
  readonly rotatedAt?: string | undefined;
  readonly retractedBecause?: string | undefined;
  /** Where this console got the record it is showing. */
  readonly source: 'cache' | 'relays';
  /** Relays confirmed to hold it. Empty for a local-only lease. */
  readonly relays: readonly string[];
  readonly recordId: string;
}

export interface VaultPublishReport {
  readonly at: string;
  readonly workloadId: string;
  readonly what: 'stage' | 'confirm' | 'retract';
  readonly relays: readonly RelayWriteOutcome[];
  readonly accepted: readonly string[];
  /** What these writes cost, in base units of the settlement token. */
  readonly cost?: string | undefined;
  readonly destination?: string | undefined;
  readonly payAt?: string | undefined;
  readonly chain?: string | undefined;
}

export interface LeaseVaultStatus {
  readonly state: 'signed_out' | 'unknown' | 'ready';
  readonly pubkey?: string | undefined;
  readonly leases: readonly LeaseView[];
  /** Where a vault record would go right now, what it costs, and what stops it. */
  readonly writes: RelayWriteTargets;
  /** Records found that this signer could not open. Never silently zero. */
  readonly unreadable: number;
  readonly lastPublish?: VaultPublishReport | undefined;
  readonly checkedAt: string;
}

export class LeaseVaultError extends Error {
  readonly code: string;
  readonly status: number;
  readonly relays?: readonly RelayWriteOutcome[];
  constructor(
    code: string,
    message: string,
    status = 400,
    relays?: readonly RelayWriteOutcome[]
  ) {
    super(message);
    this.name = 'LeaseVaultError';
    this.code = code;
    this.status = status;
    if (relays) this.relays = relays;
  }
}

export interface LeaseVaultDeps {
  /** The signed-in account's signer, or `undefined` when nobody is signed in. */
  readonly signer: () => AccountSigning | undefined;
  /** The active network profile's relays: the seed for NIP-65 discovery. */
  readonly seedRelays: () => readonly string[];
  readonly cache: LeaseVaultCache;
  /** The console's one writer (#120). Every write below goes through it. */
  readonly writer: RelayWriter;
  readonly dial?: RelayDialer | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

interface OpenLease {
  readonly record: VaultedLease;
  readonly event: NostrEvent;
  readonly source: 'cache' | 'relays';
  readonly relays: readonly string[];
  readonly published: boolean;
}

export class LeaseVault {
  readonly #deps: LeaseVaultDeps;
  /** Per account pubkey: signing out must not leave another account's leases. */
  #forPubkey: string | undefined;
  #open = new Map<string, OpenLease>();
  #looked = false;
  #relayList: RelayList | undefined;
  #unreadable = 0;
  #lastPublish: VaultPublishReport | undefined;
  /** The last answer from the writer, so `status()` can stay synchronous. */
  #writes: RelayWriteTargets = UNREAD_TARGETS;

  constructor(deps: LeaseVaultDeps) {
    this.#deps = deps;
  }

  status(): LeaseVaultStatus {
    const signer = this.#signerOrReset();
    const checkedAt = this.#at().toISOString();
    if (!signer) {
      return {
        state: 'signed_out',
        leases: [],
        writes: this.#writes,
        unreadable: 0,
        checkedAt,
      };
    }
    return {
      state: this.#looked ? 'ready' : 'unknown',
      pubkey: signer.pubkey,
      leases: this.list(),
      writes: this.#writes,
      unreadable: this.#unreadable,
      ...(this.#lastPublish ? { lastPublish: this.#lastPublish } : {}),
      checkedAt,
    };
  }

  /** Every lease this account holds, newest first. Never with a secret in it. */
  list(): readonly LeaseView[] {
    return [...this.#open.values()]
      .filter((held) => held.record.state !== 'retracted')
      .map(toView)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  find(workloadId: string): LeaseView | undefined {
    const held = this.#open.get(leaseVaultD(workloadId));
    return held && held.record.state !== 'retracted' ? toView(held) : undefined;
  }

  /**
   * Read this account's vault: the cache first, then its relays.
   *
   * The whole of the recovery criterion. On a fresh data directory the cache
   * is empty, the account's relays answer, and every lease it has ever bought
   * — except the ones it marked local only — comes back with its Root Secret
   * intact.
   *
   * Reads are free (spec §5 prices a provider's routes, never a relay's
   * reads), so this asks every relay the account named, read and write alike,
   * plus the network profile's and anything the cache remembers.
   */
  async refresh(): Promise<LeaseVaultStatus> {
    const signer = this.#require();
    this.#relayList = await this.#readRelayList(signer.pubkey);
    this.#writes = await this.#deps.writer.targets();

    const cached = this.#deps.cache.read(signer.pubkey);
    const candidates = new Map<string, { event: NostrEvent; source: 'cache' | 'relays' }[]>();
    for (const [d, entry] of cached) {
      candidates.set(d, [{ event: entry.event, source: 'cache' }]);
    }

    const { events, answered } = await this.#readRecords(signer.pubkey);
    for (const event of events) {
      const d = tagValue(event, 'd');
      if (d === undefined) continue;
      candidates.set(d, [...(candidates.get(d) ?? []), { event, source: 'relays' }]);
    }

    const open = new Map<string, OpenLease>();
    let unreadable = 0;
    for (const [d, found] of candidates) {
      // NIP-01's replacement rule decides which copy is current, not whichever
      // relay answered first and not the cache by virtue of being local.
      const current = found.reduce((held, candidate) =>
        supersedes(candidate.event, held.event) ? candidate : held
      );
      const record = await this.#unseal(signer, current.event).catch((error: unknown) => {
        if (error instanceof SealingError) return undefined;
        throw error;
      });
      if (!record) {
        unreadable += 1;
        continue;
      }
      const published = current.source === 'relays' || (cached.get(d)?.published ?? false);
      open.set(d, {
        record,
        event: current.event,
        source: current.source,
        relays: current.source === 'relays' ? answered : (cached.get(d)?.relays ?? []),
        published,
      });
      // Only a record that opened is worth keeping a copy of; one that did not
      // would overwrite a cache entry that still works.
      if (current.source === 'relays') {
        this.#deps.cache.write(signer.pubkey, d, {
          event: current.event,
          relays: answered,
          published: true,
        });
      }
    }

    this.#open = open;
    this.#unreadable = unreadable;
    this.#looked = true;
    return this.status();
  }

  /**
   * Where a vault record would go right now, what it would cost, and what
   * stops it — having actually ASKED.
   *
   * The same shape of care as `FundingStore`'s "look for a seed before saying
   * there is none", and it is what makes a spawn's preflight honest: a person
   * is told that the Root Secret's write has nothing to pay from BEFORE they
   * fill in a form, rather than after a lease is bought and the record refused
   * (TOON_Network#115).
   */
  async targets(): Promise<RelayWriteTargets> {
    const signer = this.#signerOrReset();
    if (!signer) return UNREAD_TARGETS;
    this.#writes = await this.#deps.writer.targets();
    return this.#writes;
  }

  /**
   * Seal, sign, buy the write — and only then let the caller spend anything.
   *
   * Returns once the relay holds the record, or throws. A local-only lease
   * skips the relay and is still sealed and signed, so the file on disk is the
   * same shape and is no more readable than the relay's copy would have been;
   * it is also the one path here that costs nothing.
   *
   * @throws {LeaseVaultError} when the write did not land. Nothing is cached,
   *   and the caller must not go on to spawn: the secret would be lost on the
   *   next restart.
   */
  async publish(record: VaultedLease): Promise<LeaseView> {
    const signer = this.#require();
    if (!HEX_32.test(record.root_secret) || !HEX_32.test(record.workload_id)) {
      throw new LeaseVaultError(
        'invalid_record',
        'A lease record needs a 32-byte workload id and root secret, as 64 lowercase hex ' +
          'characters each (spec §6.1).'
      );
    }
    const d = leaseVaultD(record.workload_id);
    // A record under this `d` that holds a DIFFERENT secret is another lease
    // wearing the same workload id, and publishing over it would replace the
    // one thing that lease cannot be run without (NIP-01 replacement is by
    // `d`). A workload id is 32 random bytes, so this is never an accident: it
    // is a retry that reused one, or a caller that fixed it. Either way the
    // answer is no, and it is given before anything is paid.
    const held = this.#open.get(d);
    if (
      held !== undefined &&
      held.record.root_secret !== record.root_secret &&
      // The ONE legitimate way a lease's Root Secret changes: a Rotation
      // finishing (§6.8). The new value is the one this same record has been
      // carrying as `rotation.root_secret` since before the first `rotate`
      // left, so it is not another lease wearing this workload id — it is this
      // lease, now held by the root every member has confirmed.
      record.root_secret !== held.record.rotation?.root_secret
    ) {
      throw new LeaseVaultError(
        'lease_exists',
        `This account already holds a lease record for workload ${record.workload_id}. ` +
          'Publishing another under the same id would overwrite its Root Secret, and nothing ' +
          'could read, extend or stop that lease again (spec §6.1.1). A workload id is 32 ' +
          'random bytes: leave it out and one is chosen.',
        409
      );
    }
    const content = await signer.sealToSelf(JSON.stringify(record));
    const signed = (await signer.sign({
      kind: LEASE_VAULT_KIND,
      created_at: this.#after(this.#open.get(d)?.event),
      // `d` is public. It says that this account keeps a console lease record
      // and gives its workload id; the id is what ADR 0016 took off PUBLIC
      // relays, and ADR 0021 weighs putting it on the account's OWN relays
      // against losing every lease with one disk. Local-only is the choice for
      // an account that wants no such trail — a privacy choice, freely made,
      // not a way round a write it could not pay for (#120).
      tags: [['d', d]],
      content,
    })) as unknown as NostrEvent;

    if (record.local_only === true) {
      this.#deps.cache.write(signer.pubkey, d, { event: signed, published: false });
      return this.#hold(d, {
        record,
        event: signed,
        source: 'cache',
        relays: [],
        published: false,
      });
    }

    const what = record.state === 'live' ? ('confirm' as const) : ('stage' as const);
    const receipt = await this.#write(signed, `This lease's vault record`).catch(
      (error: unknown) => {
        if (error instanceof RelayWriteError) throw notPersisted(error);
        throw error;
      }
    );
    this.#lastPublish = reportOf(record.workload_id, what, receipt);
    this.#writes = await this.#deps.writer.targets();

    this.#deps.cache.write(signer.pubkey, d, {
      event: signed,
      relays: receipt.relays,
      published: true,
    });
    this.#deps.cache.rememberRelays(signer.pubkey, receipt.relays);
    return this.#hold(d, {
      record,
      event: signed,
      source: 'relays',
      relays: receipt.relays,
      published: true,
    });
  }

  /**
   * Fill in what the provider answered: the role, the expiry, the access.
   *
   * A replacement of the same `d`, so NIP-01 keeps one record per lease. It is
   * **best effort by design**: the secret is already safe, and a confirmation
   * that could not be published must not make a spawn that already succeeded
   * look like a failure. What is lost when it fails is convenience — #93 asks
   * the provider for the same facts with `status`.
   *
   * @returns the outcome, so a caller can say that the record is behind.
   */
  async confirm(
    workloadId: string,
    answered: {
      role?: string | undefined;
      expires_at?: number | undefined;
      access?: LeaseAccess | undefined;
    }
  ): Promise<{ confirmed: boolean; reason?: string }> {
    const held = this.#open.get(leaseVaultD(workloadId));
    if (!held)
      return { confirmed: false, reason: 'this console holds no record of that lease' };
    // The member entry for this provider moves with the record's own fields:
    // a record of one member says the same thing twice, and the two must not
    // be able to disagree (§7, TOON_Network#95).
    const members = (held.record.members ?? []).map((member) =>
      member.pubkey === held.record.provider.pubkey
        ? {
            ...member,
            state: 'live' as const,
            ...(answered.role === undefined ? {} : { role: answered.role }),
            ...(answered.expires_at === undefined ? {} : { expires_at: answered.expires_at }),
            ...(answered.access === undefined ? {} : { access: answered.access }),
          }
        : member
    );
    const record: VaultedLease = {
      ...held.record,
      state: 'live',
      ...(held.record.members === undefined ? {} : { members }),
      ...(answered.role === undefined ? {} : { role: answered.role }),
      ...(answered.expires_at === undefined ? {} : { expires_at: answered.expires_at }),
      ...(answered.access === undefined ? {} : { access: answered.access }),
    };
    try {
      await this.publish(record);
      return { confirmed: true };
    } catch (error) {
      // The in-memory view still moves on: the lease IS live, whatever the
      // relay did about saying so.
      this.#open.set(leaseVaultD(workloadId), { ...held, record });
      return {
        confirmed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fill in what EVERY member of a Standby Set answered, in one write.
   *
   * One write and not one per member, deliberately. A vault write is a paid
   * packet (TOON_Network#120) and the record is one event per workload
   * (ADR 0021, §6.1.1) — so a set of three confirmed member by member would
   * buy three writes of the same event and race NIP-01 replacement against
   * itself for no gain. Best effort, exactly like `confirm`: the Root Secret
   * is already safe, and a confirmation that could not be published must not
   * make a set that really was bought look like one that was not.
   */
  async confirmSet(
    workloadId: string,
    answered: readonly {
      pubkey: string;
      state: MemberState;
      role?: string | undefined;
      expires_at?: number | undefined;
      access?: LeaseAccess | undefined;
      failed_because?: string | undefined;
    }[]
  ): Promise<{ confirmed: boolean; reason?: string }> {
    const held = this.#open.get(leaseVaultD(workloadId));
    if (!held)
      return { confirmed: false, reason: 'this console holds no record of that lease' };
    const byPubkey = new Map(answered.map((entry) => [entry.pubkey, entry]));
    const members = (held.record.members ?? []).map((member) => {
      const entry = byPubkey.get(member.pubkey);
      if (entry === undefined) return member;
      return {
        ...member,
        state: entry.state,
        ...(entry.role === undefined ? {} : { role: entry.role }),
        ...(entry.expires_at === undefined ? {} : { expires_at: entry.expires_at }),
        ...(entry.access === undefined ? {} : { access: entry.access }),
        ...(entry.failed_because === undefined
          ? {}
          : { failed_because: entry.failed_because }),
      };
    });
    // The record's own `state`, `role`, `expires_at` and `access` describe the
    // PRIMARY, which is `standby_set[0]` and the provider the record names.
    // They are kept in step so that a console that knows nothing about sets
    // still reads this record as the lease it can act on.
    const primary = byPubkey.get(held.record.provider.pubkey);
    const record: VaultedLease = {
      ...held.record,
      members,
      ...(primary === undefined
        ? {}
        : {
            state: primary.state === 'live' ? ('live' as const) : held.record.state,
            ...(primary.role === undefined ? {} : { role: primary.role }),
            ...(primary.expires_at === undefined ? {} : { expires_at: primary.expires_at }),
            ...(primary.access === undefined ? {} : { access: primary.access }),
          }),
    };
    try {
      await this.publish(record);
      return { confirmed: true };
    } catch (error) {
      this.#open.set(leaseVaultD(workloadId), { ...held, record });
      return {
        confirmed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Take a record back, because the spawn it was written for never happened.
   *
   * Two writes, because one of them is not enough on its own. The
   * **replacement** carries a sealed tombstone under the same `d`: NIP-01
   * makes it the current record on every relay that holds the old one, whether
   * or not that relay implements anything else. The **NIP-09 deletion** then
   * asks those relays to drop it altogether, which the ones that honour
   * deletions do. Neither is required to succeed — this runs after a refusal
   * that already cost the account an interval, and failing it twice would be
   * unkind — so the local cache entry is dropped regardless and the outcome is
   * reported.
   *
   * It is called ONLY when the provider's answer is definitive: a refusal, or
   * a packet the destination rejected. A spawn whose fate is unknown keeps its
   * record, because an unknown spawn may be a running workload and a deleted
   * secret is a lease nobody can ever stop.
   */
  async retract(
    workloadId: string,
    because: string
  ): Promise<{ retracted: boolean; reason?: string }> {
    const signer = this.#signerOrReset();
    const d = leaseVaultD(workloadId);
    const held = this.#open.get(d);
    this.#open.delete(d);
    if (signer) this.#deps.cache.remove(signer.pubkey, d);
    if (!signer || !held) return { retracted: true };
    if (!held.published) return { retracted: true };

    try {
      // `rotation` is dropped rather than spread through: it holds a SECOND
      // root secret, and a tombstone that carried one would publish the very
      // thing zeroing `root_secret` exists to avoid (§6.8).
      const { rotation: _dropped, ...rest } = held.record;
      const tombstone: VaultedLease = {
        ...rest,
        state: 'retracted',
        root_secret: ZERO_SECRET,
        retracted_because: because,
      };
      const sealed = await signer.sealToSelf(JSON.stringify(tombstone));
      const replacement = (await signer.sign({
        kind: LEASE_VAULT_KIND,
        created_at: this.#after(held.event),
        tags: [['d', d]],
        content: sealed,
      })) as unknown as NostrEvent;
      // Two paid writes, and the first is the one that matters: a caller that
      // sees `retracted: true` has been told that every relay serving this `d`
      // now serves a tombstone under it.
      const first = await this.#write(replacement, 'This lease record’s retraction');
      const deletion = (await signer.sign({
        kind: DELETION_KIND,
        created_at: this.#seconds(),
        tags: [
          ['a', `${LEASE_VAULT_KIND}:${signer.pubkey}:${d}`],
          ['k', String(LEASE_VAULT_KIND)],
        ],
        content: 'the spawn this record was written for was refused',
      })) as unknown as NostrEvent;
      // Best effort, and paid for separately: a relay that honours NIP-09
      // drops the record altogether, and one that does not still serves the
      // tombstone. A deletion that cannot be bought is not worth failing a
      // retraction over.
      const second = await this.#write(deletion, 'This lease record’s deletion').catch(
        () => undefined
      );
      this.#lastPublish = {
        at: this.#at().toISOString(),
        workloadId,
        what: 'retract',
        relays: [...first.writes, ...(second?.writes ?? [])],
        accepted: [...new Set([...first.relays, ...(second?.relays ?? [])])],
        ...(totalCost([first, second]) === undefined
          ? {}
          : { cost: totalCost([first, second]) }),
        destination: first.destination,
        payAt: first.payAt,
        chain: first.chain,
      };
      return { retracted: true };
    } catch (error) {
      const writes = error instanceof RelayWriteError ? error.writes : undefined;
      if (writes !== undefined) {
        this.#lastPublish = {
          at: this.#at().toISOString(),
          workloadId,
          what: 'retract',
          relays: writes,
          accepted: [],
        };
      }
      return {
        retracted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Borrow one lease's **Continuation Token** for the length of one request.
   *
   * The only way anything outside this module reaches a value derived from a
   * Root Secret, and it is shaped as a borrow for the same reason
   * `ChainSeedStore.usePayerKeys` is: the secret is derived, used for one
   * packet, and gone when the call returns. There is no getter, and there must
   * never be one — a token that can be fetched is a token that can be logged,
   * echoed into an API answer or held in a variable that outlives the request
   * it was for (§6.1.1 forbids all three).
   *
   * The token is per PROVIDER, so the member of the Standby Set to address is
   * named by the caller. A member that is not in this lease's `standby_set` is
   * refused rather than derived for: the derivation would succeed and produce a
   * token that provider does not hold, and presenting it is `not_tenant` — on
   * `extend`, after being billed.
   *
   * **While a Rotation is under way, WHICH root this derives from is decided
   * per member** (§6.8): the new one for a member that has confirmed `next`,
   * the old one for a member that has not. So a partially rotated set stays
   * readable at every member, and everything built on this borrow follows the
   * rotation without knowing about it — a Gateway Handover after a rotation
   * derives its grants from the new tokens because `gateway.ts` derives inside
   * this call (TOON_Network#97), and a `status` on a member that has not
   * rotated yet still presents the token it holds.
   *
   * @throws {LeaseVaultError} when no account is signed in, when this account
   *   holds no such lease, or when that provider is not in its Standby Set.
   */
  async withContinuation<T>(
    workloadId: string,
    providerPubkey: string,
    use: (continuation: string) => Promise<T>
  ): Promise<T> {
    this.#require();
    const held = this.#open.get(leaseVaultD(workloadId));
    if (!held || held.record.state === 'retracted') {
      throw new LeaseVaultError(
        'unknown_lease',
        `This account holds no vault record for workload ${workloadId}, so it holds no Root ` +
          `Secret for it and can derive no Continuation Token. Read the vault from this ` +
          `account's relays first; if it is not there either, the lease cannot be read, ` +
          `extended or stopped by anyone (spec §6.1.1).`,
        404
      );
    }
    if (!held.record.standby_set.includes(providerPubkey)) {
      throw new LeaseVaultError(
        'not_a_member',
        `${providerPubkey.slice(0, 12)}… is not a member of this lease's Standby Set, so this ` +
          `lease holds no token for it. A token is derived per provider (spec §6.1.1): one ` +
          `derived for a provider that holds a different one is refused \`not_tenant\`, and on ` +
          `a paid route that refusal is billed.`,
        400
      );
    }
    return use(continuationFor(rootFor(held.record, providerPubkey), providerPubkey));
  }

  /* ------------------------------------------------------------------------ */
  /* Rotation (spec §6.8, ADR 0018, ADR 0021)                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Mint this rotation's fresh Root Secret and record it **before** anything
   * is sent — or pick up the one a previous run left.
   *
   * §6.8 recommends a fresh root for every rotation rather than a fresh token,
   * so that the rotation retires the old ROOT as well: if that is what leaked,
   * it derives nothing that works afterwards. The provider cannot tell how
   * `next` was made and does not check, which is exactly why this is the
   * tenant tooling's job.
   *
   * The write is the ordering ADR 0021 fixes: the record carries both roots
   * from before the first `rotate` leaves, so a crash between a member
   * accepting `next` and this console hearing so cannot lose the only secret
   * that now reads that member. If the write does not land, this throws and
   * **nothing is sent** — the same trade a spawn makes, for the same reason.
   *
   * A record that already carries a rotation is **resumed, never restarted**:
   * the same new root, the members already confirmed left alone. A third root
   * secret would strand every member the second one reached.
   *
   * @throws {LeaseVaultError} when there is no such lease, when the record's
   *   rotation is for a different set of members, or when the write failed.
   */
  async beginRotation(
    workloadId: string,
    options: { mint?: () => string; members?: readonly string[] } = {}
  ): Promise<LeaseView> {
    this.#require();
    const held = this.#holding(workloadId);
    const set = membersIn(held.record);
    const under = held.record.rotation;
    if (under !== undefined) {
      // A rotation under way is the RECORD's, and it is finished naming the
      // members it started with. A member left out would be read, once the
      // rest confirm, with a root secret this record no longer holds.
      if (!under.members.every((member) => set.includes(member))) {
        throw new LeaseVaultError(
          'rotation_mismatch',
          `This lease's vault record carries a Rotation naming a member that is not in its ` +
            `Standby Set. Membership never changes for a lease (spec §7), so this record ` +
            `disagrees with itself and finishing the rotation could strand a member.`,
          409
        );
      }
      // Resumed, not restarted: the same `rotation.root_secret`.
      return toView(held);
    }
    const members = options.members ?? set;
    if (members.length === 0 || !members.every((member) => set.includes(member))) {
      throw new LeaseVaultError(
        'rotation_mismatch',
        `A rotation covers members of this lease's own Standby Set, and at least one of them ` +
          `(spec §6.8, §7).`
      );
    }
    const next = (options.mint ?? mintRootSecret)();
    if (!HEX_32.test(next) || next === held.record.root_secret) {
      throw new LeaseVaultError(
        'invalid_root_secret',
        'A rotation needs a fresh 32-byte root secret, as 64 lowercase hex characters, and ' +
          'not the one this lease already holds (spec §6.1.1, §6.8).'
      );
    }
    return this.publish({
      ...held.record,
      rotation: {
        root_secret: next,
        members,
        confirmed: [],
        started_at: this.#at().toISOString(),
      },
    });
  }

  /**
   * Write down that one member now holds a token of the new root — and, when
   * it is the last one, that the old root is retired.
   *
   * Recorded member by member rather than once at the end, because a run that
   * stops here resumes after it: a member already confirmed must not be
   * rotated a second time, which would present a token it no longer holds
   * (`not_tenant`).
   *
   * **Best effort, and recoverable when it fails.** The relay's copy still
   * carries BOTH roots, so a confirmation that could not be published loses no
   * secret and strands nothing: a later run reads the member as pending, sends
   * a `rotate` it refuses `not_tenant`, asks `status` with `next` and learns
   * from the acceptance that the rotation took effect (§6.8). What a failure
   * costs is one more free round trip, which is why it is reported rather than
   * thrown.
   *
   * @throws {LeaseVaultError} when there is no such lease, no rotation under
   *   way, or that member is not in it.
   */
  async confirmRotation(
    workloadId: string,
    providerPubkey: string
  ): Promise<{ confirmed: boolean; finished: boolean; reason?: string }> {
    this.#require();
    const held = this.#holding(workloadId);
    const rotation = held.record.rotation;
    if (rotation === undefined) {
      throw new LeaseVaultError(
        'no_rotation',
        `This lease's vault record carries no Rotation, so there is nothing to confirm. A ` +
          `rotation records its new Root Secret before its first request (ADR 0021).`,
        409
      );
    }
    if (!rotation.members.includes(providerPubkey)) {
      throw new LeaseVaultError(
        'not_a_member',
        `${providerPubkey.slice(0, 12)}… is not a member of the Rotation this record carries.`
      );
    }
    const confirmed = rotation.members.filter(
      (member) => member === providerPubkey || rotation.confirmed.includes(member)
    );
    const finished = confirmed.length === rotation.members.length;
    // Every member holds a token of the new root, so the old one reads nothing
    // anywhere: it is dropped rather than kept, which is the whole of what
    // "the rotation retires the old root secret" means (§6.8).
    const { rotation: _under, ...rest } = held.record;
    const record: VaultedLease = finished
      ? { ...rest, root_secret: rotation.root_secret, rotated_at: this.#at().toISOString() }
      : { ...held.record, rotation: { ...rotation, confirmed } };
    try {
      await this.publish(record);
      return { confirmed: true, finished };
    } catch (error) {
      // The in-memory view moves on regardless: that member DOES hold a token
      // of the new root, whatever the relay did about saying so, and reading
      // it with the old one from here would be `not_tenant`.
      this.#open.set(leaseVaultD(workloadId), { ...held, record });
      return {
        confirmed: false,
        finished,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Borrow the two tokens one `rotate` request carries: the one this member
   * holds now, and the one it is being asked to hold (§6.8).
   *
   * Both derive inside this module and neither survives the call, exactly as
   * `withContinuation`'s single token does. They are borrowed together
   * because a rotate request is the one message that names both, and handing
   * them out separately would mean a caller holding a Root Secret's output
   * across two calls.
   *
   * @throws {LeaseVaultError} when there is no such lease, no rotation under
   *   way, or that member is not in it.
   */
  async withRotation<T>(
    workloadId: string,
    providerPubkey: string,
    use: (tokens: { current: string; next: string }) => Promise<T>
  ): Promise<T> {
    this.#require();
    const held = this.#holding(workloadId);
    const rotation = held.record.rotation;
    if (rotation === undefined) {
      throw new LeaseVaultError(
        'no_rotation',
        `This lease's vault record carries no Rotation, so there is no \`next\` to name. The ` +
          `new Root Secret is recorded before the first request, never derived on the way ` +
          `out (ADR 0021).`,
        409
      );
    }
    if (!rotation.members.includes(providerPubkey)) {
      throw new LeaseVaultError(
        'not_a_member',
        `${providerPubkey.slice(0, 12)}… is not a member of the Rotation this record carries, ` +
          `so this lease holds no token for it to rotate (spec §6.1.1).`
      );
    }
    return use({
      current: continuationFor(rootFor(held.record, providerPubkey), providerPubkey),
      next: continuationFor(rotation.root_secret, providerPubkey),
    });
  }

  /** Forget this session's leases — a sign-out, not a deletion. */
  forget(): void {
    this.#forPubkey = undefined;
    this.#open = new Map();
    this.#looked = false;
    this.#relayList = undefined;
    this.#unreadable = 0;
    this.#lastPublish = undefined;
    this.#writes = UNREAD_TARGETS;
  }

  #hold(d: string, entry: OpenLease): LeaseView {
    this.#open.set(d, entry);
    this.#looked = true;
    return toView(entry);
  }

  /** One paid write. There is no other kind here (TOON_Network#120). */
  async #write(event: NostrEvent, what: string): Promise<RelayWriteReceipt> {
    return this.#deps.writer.write({ event, what });
  }

  async #readRelayList(pubkey: string): Promise<RelayList> {
    const seeds = [...this.#deps.seedRelays(), ...this.#deps.cache.relays(pubkey)];
    if (seeds.length === 0) return NO_RELAY_LIST;
    return readRelayListOf(pubkey, seeds, {
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
  }

  async #readRecords(
    pubkey: string
  ): Promise<{ events: readonly NostrEvent[]; answered: string[] }> {
    const relays = [
      ...new Set([
        ...(this.#relayList?.read ?? []),
        ...(this.#relayList?.write ?? []),
        ...this.#deps.seedRelays(),
        ...this.#deps.cache.relays(pubkey),
      ]),
    ].filter((url) => url.length > 0);
    if (relays.length === 0) return { events: [], answered: [] };
    const result = await queryRelays({
      relays,
      // No `#d`: the point of this read is to find leases this machine has
      // never heard of, so the filter is the PREFIX's whole family and the
      // narrowing happens below.
      filters: [{ kinds: [LEASE_VAULT_KIND], authors: [pubkey], limit: 500 }],
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
    const answered = result.relays.filter((outcome) => outcome.events > 0).map((o) => o.url);
    // `queryRelays` re-derived every id and checked every signature already;
    // the author and `d` checks here are the relay's OTHER way of lying, which
    // is to answer a filter with something that does not match it. The Chain
    // Seed's own record shares this kind and is excluded by its `d`.
    return {
      events: result.events.filter(
        (event) =>
          event.kind === LEASE_VAULT_KIND &&
          event.pubkey === pubkey &&
          (tagValue(event, 'd') ?? '').startsWith(LEASE_VAULT_D_PREFIX)
      ),
      answered,
    };
  }

  /** Unseal one record. The only place a Root Secret exists on the read path. */
  async #unseal(signer: AccountSigning, event: NostrEvent): Promise<VaultedLease> {
    const plaintext = await signer.unsealFromSelf(event.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new SealingError(
        'lease_unreadable',
        'That lease record opened, but what was inside it is not this console’s format.'
      );
    }
    const record = parsed as Partial<VaultedLease>;
    if (record.v !== 1 || typeof record.workload_id !== 'string') {
      throw new SealingError(
        'lease_unreadable',
        'That lease record opened, but it is not a version this console reads.'
      );
    }
    return record as VaultedLease;
  }

  /** The open record for a lease this account still holds, or a refusal. */
  #holding(workloadId: string): OpenLease {
    const held = this.#open.get(leaseVaultD(workloadId));
    if (!held || held.record.state === 'retracted') {
      throw new LeaseVaultError(
        'unknown_lease',
        `This account holds no vault record for workload ${workloadId}, so it holds no Root ` +
          `Secret for it. Read the vault from this account's relays first.`,
        404
      );
    }
    return held;
  }

  #require(): AccountSigning {
    const signer = this.#signerOrReset();
    if (!signer) {
      throw new LeaseVaultError(
        'not_signed_in',
        'No account is signed in, so there is no key to seal a lease record to.',
        409
      );
    }
    return signer;
  }

  /** Drop everything the moment the signed-in account changes. */
  #signerOrReset(): AccountSigning | undefined {
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

  /**
   * A `created_at` that is guaranteed to REPLACE `previous`.
   *
   * NIP-01 breaks a tie on `created_at` by taking the LOWER event id, which is
   * effectively a coin toss on the hash — so a record replaced inside the same
   * second wins only half the time. That is not a rounding error here: a
   * confirmation, and above all a retraction, has to be the version every
   * relay serves from now on. One second into the future is the whole fix, and
   * it costs nothing: these events are addressed by their `d`, never read by
   * their timestamp.
   */
  #after(previous: NostrEvent | undefined): number {
    const now = this.#seconds();
    return previous === undefined ? now : Math.max(now, previous.created_at + 1);
  }
}

/**
 * What a tombstone carries where a Root Secret was.
 *
 * Not the secret, and not an absent field either: the record keeps its shape
 * so an older console reading it still parses it, and the one value it must
 * not carry is replaced rather than removed. A retracted lease has no lease to
 * control, so there is nothing this could have been useful for.
 */
const ZERO_SECRET = '0'.repeat(64);

/**
 * The Standby Set's members, from whatever the record actually holds.
 *
 * Three shapes arrive here and all three have to come out as one list.
 *
 * 1. A record written with `members` (TOON_Network#95): use it.
 * 2. A record written before that field existed, whose `standby_set` names one
 *    provider: that provider IS the member, and `provider`/`listing`/`paid_at`
 *    describe it.
 * 3. A record that names a member with nothing else about it — an older record
 *    of a set, or a member the console could not describe. It is listed with
 *    `known: false`, because a set with a member this console cannot reach is
 *    still a set with that member, and dropping it would understate who holds
 *    the workload.
 *
 * The order is `standby_set`'s, which is the order the protocol reads it in:
 * index 0 is the primary, and a Takeover's ties break by the lower index
 * (§7.1 step 3).
 */
function membersOf(record: VaultedLease): readonly LeaseMemberView[] {
  const set = record.standby_set.length > 0 ? record.standby_set : [record.provider.pubkey];
  const byPubkey = new Map((record.members ?? []).map((member) => [member.pubkey, member]));
  return set.map((pubkey, index) => {
    const role = roleAt(index, set.length);
    const held = byPubkey.get(pubkey);
    if (held !== undefined) {
      return {
        pubkey,
        index,
        role,
        provider: {
          pubkey,
          ilp_address: held.ilp_address,
          connector_url: held.connector_url,
          connector_seal_key: held.connector_seal_key,
          ...(held.hidden === true ? { hidden: true } : {}),
        },
        listing: held.listing,
        paidAt: held.paid_at,
        ...(held.paid_chain === undefined ? {} : { paidChain: held.paid_chain }),
        state: held.state,
        ...(held.failed_because === undefined ? {} : { failedBecause: held.failed_because }),
        ...(held.role === undefined ? {} : { answeredRole: held.role }),
        ...(held.expires_at === undefined ? {} : { expiresAt: held.expires_at }),
        ...(held.access === undefined ? {} : { access: held.access }),
        known: true,
      };
    }
    if (pubkey === record.provider.pubkey) {
      return {
        pubkey,
        index,
        role,
        provider: record.provider,
        listing: record.listing,
        paidAt: record.paid_at,
        ...(record.paid_chain === undefined ? {} : { paidChain: record.paid_chain }),
        state: record.state === 'live' ? ('live' as const) : ('spawning' as const),
        ...(record.role === undefined ? {} : { answeredRole: record.role }),
        ...(record.expires_at === undefined ? {} : { expiresAt: record.expires_at }),
        ...(record.access === undefined ? {} : { access: record.access }),
        known: true,
      };
    }
    return {
      pubkey,
      index,
      role,
      provider: {
        pubkey,
        ilp_address: '',
        connector_url: '',
        connector_seal_key: '',
      },
      listing: record.listing,
      paidAt: '',
      state: 'spawning' as const,
      known: false,
    };
  });
}

/**
 * WHICH Root Secret reads this member right now (§6.8).
 *
 * The new one once that member has confirmed `next`, the old one until then.
 * One function, used by every borrow, so that a partially rotated set cannot
 * be read one way here and another way there.
 */
function rootFor(record: VaultedLease, providerPubkey: string): string {
  const rotation = record.rotation;
  return rotation !== undefined && rotation.confirmed.includes(providerPubkey)
    ? rotation.root_secret
    : record.root_secret;
}

/** The Standby Set a record names: its own list, or the one provider it has. */
function membersIn(record: VaultedLease): readonly string[] {
  return record.standby_set.length > 0 ? record.standby_set : [record.provider.pubkey];
}

/** A rotation's progress, with neither root secret in it (§6.8). */
function rotationView(rotation: VaultedRotation): LeaseRotationView {
  return {
    members: rotation.members,
    confirmed: rotation.members.filter((member) => rotation.confirmed.includes(member)),
    pending: rotation.members.filter((member) => !rotation.confirmed.includes(member)),
    startedAt: rotation.started_at,
  };
}

/** §7: index 0 is the primary; a set of one is a standalone lease (§6.2). */
export function roleAt(index: number, members: number): LeaseMemberView['role'] {
  if (members <= 1) return 'standalone';
  return index === 0 ? 'primary' : 'standby';
}

function toView(held: OpenLease): LeaseView {
  const { record } = held;
  return {
    workloadId: record.workload_id,
    state: record.state,
    standbySet: record.standby_set,
    members: membersOf(record),
    provider: record.provider,
    paidAt: record.paid_at,
    ...(record.paid_chain === undefined ? {} : { paidChain: record.paid_chain }),
    listing: record.listing,
    profileId: record.profile_id,
    image: record.image,
    ports: record.ports,
    envKeys: record.env_keys,
    ...(record.template === undefined ? {} : { template: record.template }),
    createdAt: record.created_at,
    localOnly: record.local_only === true,
    ...(record.role === undefined ? {} : { role: record.role }),
    ...(record.expires_at === undefined ? {} : { expiresAt: record.expires_at }),
    ...(record.access === undefined ? {} : { access: record.access }),
    ...(record.rotation === undefined ? {} : { rotation: rotationView(record.rotation) }),
    ...(record.rotated_at === undefined ? {} : { rotatedAt: record.rotated_at }),
    ...(record.retracted_because === undefined
      ? {}
      : { retractedBecause: record.retracted_because }),
    source: held.source,
    relays: held.relays,
    recordId: held.event.id,
  };
}

/** Before the writer has been asked anything. Never mistaken for "ready". */
const UNREAD_TARGETS: RelayWriteTargets = {
  relays: [],
  ready: false,
  blockedBy: 'Nothing has asked this network’s connector what a relay write costs yet.',
};

/** One paid write, as the status reports it. The cost is never recomputed. */
function reportOf(
  workloadId: string,
  what: VaultPublishReport['what'],
  receipt: RelayWriteReceipt
): VaultPublishReport {
  return {
    at: receipt.at,
    workloadId,
    what,
    relays: receipt.writes,
    accepted: receipt.relays,
    ...(receipt.cost === undefined ? {} : { cost: receipt.cost }),
    destination: receipt.destination,
    payAt: receipt.payAt,
    chain: receipt.chain,
  };
}

/** What several writes cost together, when every one of them reported one. */
function totalCost(receipts: readonly (RelayWriteReceipt | undefined)[]): string | undefined {
  let sum = 0n;
  let seen = false;
  for (const receipt of receipts) {
    if (receipt?.cost === undefined) continue;
    try {
      sum += BigInt(receipt.cost);
      seen = true;
    } catch {
      return undefined;
    }
  }
  return seen ? sum.toString() : undefined;
}

/**
 * A vault write that did not land, told as what it means for the spawn.
 *
 * The write is paid for now, so the interesting refusals are a payment's
 * refusals — no channel, a rejected claim, a connector that would not route —
 * and the writer has already said which in its own words. What this adds is
 * the consequence: the spawn was not sent, so nothing else was paid, and the
 * Root Secret was dropped unused.
 */
function notPersisted(error: RelayWriteError): LeaseVaultError {
  return new LeaseVaultError(
    error.code === 'no_channel' ? 'relay_payment_required' : error.code,
    `${error.message} The spawn was NOT sent: a Root Secret that only one disk holds is not ` +
      `recoverable, and paying for a lease whose secret could vanish is worse than not ` +
      `spawning. The secret was dropped unused and no lease was bought with it. Mark this ` +
      `lease "local only" if you would rather one machine held it.`,
    error.status,
    error.writes
  );
}
