import type { LeaseVaultCache } from './lease-vault-cache.js';
import { supersedes, tagValue, type NostrEvent } from './nostr.js';
import { NO_RELAY_LIST, readRelayListOf, type RelayList } from './relay-list.js';
import {
  isPersisted,
  publishToRelays,
  queryRelays,
  type PublishOutcome,
  type RelayDialer,
} from './relay-pool.js';
import { SealingError, type AccountSigning } from './signer.js';
import { HEX_32, type SpawnImage, type SpawnPort } from './spawn-content.js';

/**
 * The **Lease Vault** (ADR 0021).
 *
 * One NIP-78 app-data event per lease — kind 30078, `d` =
 * `toon-console/lease/<workload id>` — with its contents NIP-44-sealed to the
 * account itself and published to the account's NIP-65 **write** relays, with
 * a local cache. An account that signs in on a new machine gets its leases
 * back, because the one thing that cannot be recovered any other way is in
 * them: the lease's **Root Secret**. Lose it and the lease is lost — not
 * merely inaccessible, lost, because nothing in the protocol can produce the
 * Continuation Token again (spec §6.1.1).
 *
 * Four rules shape this module.
 *
 * **The record is written BEFORE the spawn is sent.** That ordering is the
 * whole point of the vault, and it is the one this ticket is measured against.
 * The dangerous window is between minting a Root Secret and learning what the
 * provider did with it: a spawn that succeeds and whose answer is then lost —
 * a dropped socket, a killed daemon — has bought a running workload whose
 * secret exists nowhere. Publishing first closes that window. It costs one
 * relay write against a lease that may never start, which `retract` below
 * cleans up, and that is the cheaper side of the trade by a wide margin.
 *
 * **A record that no relay took is not a vault record.** `publish` refuses
 * rather than caching quietly, exactly as the Chain Seed does, and the spawn
 * it was for is then never sent. A console that pretended otherwise would be
 * telling a person their lease follows them when it does not, and the lie
 * would surface on the day the disk died. The one exception is a lease marked
 * **local only**, where the person has said so.
 *
 * **Nothing here ever hands a Root Secret out.** `list()` returns views with
 * no secret in them; the secret goes in through `publish` and comes out only
 * inside `#unseal`, which is private. There is no API route to a Root Secret,
 * and there must never be one.
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
 * What one sealed record holds.
 *
 * Everything needed to act on the lease again from a machine that has only the
 * account's Nostr key: the secret, who the provider is, where its connector
 * is, and which route the lease was bought on. The relay learns none of it —
 * the whole object is one NIP-44 ciphertext — and the `d` tag says only that
 * this account keeps a console lease record.
 */
export interface VaultedLease {
  readonly v: 1;
  readonly state: LeaseVaultState;
  readonly workload_id: string;
  /** THE secret. 64 lowercase hex. It never leaves this module unsealed. */
  readonly root_secret: string;
  /** Every member of the Standby Set, primary first. One member is standalone. */
  readonly standby_set: readonly string[];
  readonly provider: {
    readonly pubkey: string;
    readonly ilp_address: string;
    readonly connector_url: string;
    readonly connector_seal_key: string;
    readonly hidden?: boolean | undefined;
  };
  /** The connector the spawn was PAID at, which may not be the provider's. */
  readonly paid_at: string;
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
  /** Marked local only: this record was never published anywhere (ADR 0021). */
  readonly local_only?: boolean | undefined;
  readonly role?: string | undefined;
  readonly expires_at?: number | undefined;
  readonly access?: LeaseAccess | undefined;
  /** Why a record is `retracted`, in words. Carries no secret. */
  readonly retracted_because?: string | undefined;
}

/**
 * One lease, as everything outside this module sees it.
 *
 * Note what is missing and always will be: `root_secret`. The type has no such
 * field, so no route can return one by forgetting to strip it.
 */
export interface LeaseView {
  readonly workloadId: string;
  readonly state: LeaseVaultState;
  readonly standbySet: readonly string[];
  readonly provider: VaultedLease['provider'];
  readonly paidAt: string;
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
  readonly relays: readonly PublishOutcome[];
  readonly accepted: readonly string[];
}

export interface LeaseVaultStatus {
  readonly state: 'signed_out' | 'unknown' | 'ready';
  readonly pubkey?: string | undefined;
  readonly leases: readonly LeaseView[];
  /** Where a vault record would go right now, and why there. */
  readonly writeTargets: readonly string[];
  readonly writeTargetSource: 'nip65' | 'profile' | 'none';
  /** Records found that this signer could not open. Never silently zero. */
  readonly unreadable: number;
  readonly lastPublish?: VaultPublishReport | undefined;
  readonly checkedAt: string;
}

export class LeaseVaultError extends Error {
  readonly code: string;
  readonly status: number;
  readonly relays?: readonly PublishOutcome[];
  constructor(
    code: string,
    message: string,
    status = 400,
    relays?: readonly PublishOutcome[]
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
        writeTargets: [],
        writeTargetSource: 'none',
        unreadable: 0,
        checkedAt,
      };
    }
    const targets = this.#writeTargets();
    return {
      state: this.#looked ? 'ready' : 'unknown',
      pubkey: signer.pubkey,
      leases: this.list(),
      writeTargets: targets.relays,
      writeTargetSource: targets.source,
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
   * Where a vault record would go right now — having actually LOOKED.
   *
   * The same shape of care as `FundingStore`'s "look for a seed before saying
   * there is none". A vault that has not read the account's NIP-65 list yet
   * would answer with the network profile's relay, which on every TOON network
   * is a relay that charges for writes — so a preflight would tell a person
   * their Root Secret is about to be refused, and a spawn would refuse it, for
   * an account that has a perfectly good relay of its own. One relay read,
   * cached for the session, is the whole fix.
   */
  async targets(): Promise<{
    relays: readonly string[];
    source: 'nip65' | 'profile' | 'none';
  }> {
    const signer = this.#signerOrReset();
    if (!signer) return { relays: [], source: 'none' };
    await this.#ensureRelayList(signer.pubkey);
    return this.#writeTargets();
  }

  /**
   * Seal, sign, publish — and only then let the caller spend anything.
   *
   * Returns once some relay has answered `OK … true`, or throws. A local-only
   * lease skips the relays and is still sealed and signed, so the file on disk
   * is the same shape and is no more readable than the relay's copy would have
   * been.
   *
   * @throws {LeaseVaultError} when nothing took it. Nothing is cached, and the
   *   caller must not go on to spawn: the secret would be lost on the next
   *   restart.
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
    if (held !== undefined && held.record.root_secret !== record.root_secret) {
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
      // against losing every lease with one disk. Local-only is the way out
      // for an account that wants no such trail.
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

    await this.#ensureRelayList(signer.pubkey);
    const targets = this.#writeTargets();
    if (targets.relays.length === 0) {
      throw new LeaseVaultError(
        'no_relay',
        'There is nowhere to publish this lease record. This account has published no NIP-65 ' +
          'relay list, and the active network profile names no relay either — so the Root ' +
          'Secret would exist on this disk alone, and losing the disk would lose the lease. ' +
          'Publish a relay list naming a relay this account can write to, or mark this lease ' +
          '"local only" and accept that it lives on one machine.',
        409
      );
    }

    const result = await publishToRelays({
      event: signed,
      relays: targets.relays,
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
    this.#lastPublish = {
      at: this.#at().toISOString(),
      workloadId: record.workload_id,
      what: record.state === 'live' ? 'confirm' : 'stage',
      relays: result.relays,
      accepted: result.accepted,
    };
    if (result.accepted.length === 0) throw notPersisted(result.relays, targets.source);

    this.#deps.cache.write(signer.pubkey, d, {
      event: signed,
      relays: result.accepted,
      published: true,
    });
    this.#deps.cache.rememberRelays(signer.pubkey, result.accepted);
    return this.#hold(d, {
      record,
      event: signed,
      source: 'relays',
      relays: result.accepted,
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
    const record: VaultedLease = {
      ...held.record,
      state: 'live',
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

    const relays = held.relays.length > 0 ? held.relays : this.#writeTargets().relays;
    if (relays.length === 0) return { retracted: true };

    try {
      const tombstone: VaultedLease = {
        ...held.record,
        state: 'retracted',
        root_secret: ZERO_SECRET,
        retracted_because: because,
      };
      const sealed = await signer.sealToSelf(JSON.stringify(tombstone));
      const replacement = await signer.sign({
        kind: LEASE_VAULT_KIND,
        created_at: this.#after(held.event),
        tags: [['d', d]],
        content: sealed,
      });
      const first = await this.#publishRaw(replacement, relays);
      const deletion = await signer.sign({
        kind: DELETION_KIND,
        created_at: this.#seconds(),
        tags: [
          ['a', `${LEASE_VAULT_KIND}:${signer.pubkey}:${d}`],
          ['k', String(LEASE_VAULT_KIND)],
        ],
        content: 'the spawn this record was written for was refused',
      });
      const second = await this.#publishRaw(deletion, relays);
      this.#lastPublish = {
        at: this.#at().toISOString(),
        workloadId,
        what: 'retract',
        relays: [...first.relays, ...second.relays],
        accepted: [...new Set([...first.accepted, ...second.accepted])],
      };
      return first.accepted.length > 0
        ? { retracted: true }
        : {
            retracted: false,
            reason: `no relay took the retraction: ${describeRefusals(first.relays)}`,
          };
    } catch (error) {
      return {
        retracted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Forget this session's leases — a sign-out, not a deletion. */
  forget(): void {
    this.#forPubkey = undefined;
    this.#open = new Map();
    this.#looked = false;
    this.#relayList = undefined;
    this.#unreadable = 0;
    this.#lastPublish = undefined;
  }

  #hold(d: string, entry: OpenLease): LeaseView {
    this.#open.set(d, entry);
    this.#looked = true;
    return toView(entry);
  }

  async #publishRaw(event: unknown, relays: readonly string[]) {
    return publishToRelays({
      event,
      relays,
      ...(this.#deps.dial === undefined ? {} : { dial: this.#deps.dial }),
      ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
    });
  }

  /**
   * Where a vault record goes: the account's NIP-65 WRITE relays, or the
   * network profile's when it has named none.
   *
   * The same policy as the Chain Seed's, and the same awkward second case: the
   * profile's relay is a TOON relay, which prices its writes at 1 µUSDC and
   * refuses an unpaid one outright. `notPersisted` says so in the words the
   * relay used, rather than caching the record and calling it published.
   */
  #writeTargets(): { relays: readonly string[]; source: 'nip65' | 'profile' | 'none' } {
    const write = this.#relayList?.write ?? [];
    if (write.length > 0) return { relays: write, source: 'nip65' };
    const seeds = this.#deps.seedRelays().filter((url) => url.length > 0);
    return seeds.length > 0
      ? { relays: seeds, source: 'profile' }
      : { relays: [], source: 'none' };
  }

  /** Read the account's NIP-65 list once per session, on first need. */
  async #ensureRelayList(pubkey: string): Promise<void> {
    if (this.#relayList !== undefined) return;
    this.#relayList = await this.#readRelayList(pubkey);
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

function toView(held: OpenLease): LeaseView {
  const { record } = held;
  return {
    workloadId: record.workload_id,
    state: record.state,
    standbySet: record.standby_set,
    provider: record.provider,
    paidAt: record.paid_at,
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
    ...(record.retracted_because === undefined
      ? {}
      : { retractedBecause: record.retracted_because }),
    source: held.source,
    relays: held.relays,
    recordId: held.event.id,
  };
}

/** The paid-relay seam, spelled out rather than swallowed (as in #89). */
function notPersisted(
  relays: readonly PublishOutcome[],
  source: 'nip65' | 'profile' | 'none'
): LeaseVaultError {
  const paid = relays.filter(looksLikePaidWrite);
  if (paid.length > 0 && paid.length === relays.length) {
    const where =
      source === 'profile'
        ? 'This account has published no NIP-65 relay list, so the only relay the console had ' +
          'to try was the network profile’s — and that one charges for writes.'
        : 'Every relay this account writes to charges for writes.';
    return new LeaseVaultError(
      'relay_payment_required',
      `The lease record was NOT published, so the spawn was not sent: a Root Secret that only ` +
        `one disk holds is not recoverable, and paying for a lease whose secret could vanish is ` +
        `worse than not spawning. ${where} ${describeRefusals(relays)} A paid write costs ` +
        `1 µUSDC from a payment channel. Publish a relay list naming a relay this account can ` +
        `write to for free, or mark this lease "local only" and accept one disk holding it.`,
      402,
      relays
    );
  }
  return new LeaseVaultError(
    'not_persisted',
    `The lease record was NOT published, so the spawn was not sent and nothing was paid. ` +
      `${describeRefusals(relays)} Nothing was lost: the Root Secret was dropped unused, and ` +
      `no lease was bought with it.`,
    502,
    relays
  );
}

/** A refusal that is really a price. */
function looksLikePaidWrite(outcome: PublishOutcome): boolean {
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
