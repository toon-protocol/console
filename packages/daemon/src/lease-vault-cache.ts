import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isEventShape, type NostrEvent } from './nostr.js';
import { accountLeaseVaultPath, type ConsolePaths } from './paths.js';

/**
 * The local copy of an account's Lease Vault (ADR 0021).
 *
 * The same shape as the Chain Seed's cache next door, and for the same reason:
 * **what is stored is the SEALED event, byte for byte as it was signed.** Never
 * a Root Secret, never a derived token. Opening this file takes the account's
 * Nostr key exactly as opening a relay's copy does, so a stolen disk is worth
 * no more than a subscription to the account's relays.
 *
 * It differs from that cache in one way, and the difference is the whole of
 * why this is not simply a speed-up. A lease may be marked **local only**, and
 * a local-only lease is never published to any relay — so for that one lease
 * this file is not a cache but the only copy there is. That is the trade ADR
 * 0021 offers: no `workload_id` reaches any relay, and one disk becomes the
 * single point of failure for that lease. The record says which it is
 * (`published`), so the console can tell a person which of their workloads
 * would survive this machine and which would not.
 *
 * One file per account pubkey, holding one entry per lease keyed by its `d`
 * tag. Not one file per lease: a person with thirty workloads should not have
 * a directory of thirty files to reason about, and the whole vault is read
 * together on every sign-in anyway.
 */

export interface CachedLease {
  /** The sealed kind-30078, exactly as signed. */
  readonly event: NostrEvent;
  /** Relays known to hold it. Empty for a local-only lease. */
  readonly relays?: readonly string[] | undefined;
  /** `false` when this lease was marked local only and never left this disk. */
  readonly published: boolean;
}

export interface LeaseVaultCache {
  /** Every lease this machine holds for `pubkey`, keyed by its `d` tag. */
  read(pubkey: string): ReadonlyMap<string, CachedLease>;
  write(pubkey: string, d: string, entry: CachedLease): void;
  remove(pubkey: string, d: string): void;
  /** Relays this account's vault has been seen on, so the next read finds it. */
  rememberRelays(pubkey: string, relays: readonly string[]): void;
  relays(pubkey: string): readonly string[];
}

interface CacheFile {
  readonly v: 1;
  readonly pubkey: string;
  readonly leases: Record<
    string,
    { event: NostrEvent; relays?: string[]; published: boolean }
  >;
  readonly relays?: string[];
}

export class FileLeaseVaultCache implements LeaseVaultCache {
  readonly #paths: ConsolePaths;

  constructor(paths: ConsolePaths) {
    this.#paths = paths;
  }

  read(pubkey: string): ReadonlyMap<string, CachedLease> {
    const file = this.#load(pubkey);
    const held = new Map<string, CachedLease>();
    for (const [d, entry] of Object.entries(file?.leases ?? {})) {
      // A cache file is a file on disk, and a file on disk is something
      // anything running as this user can write. Whatever it claims is an
      // event is checked for shape here and re-verified before it is believed.
      if (!isEventShape(entry.event)) continue;
      held.set(d, {
        event: entry.event,
        ...(entry.relays ? { relays: entry.relays } : {}),
        published: entry.published !== false,
      });
    }
    return held;
  }

  write(pubkey: string, d: string, entry: CachedLease): void {
    const file = this.#load(pubkey);
    this.#save(pubkey, {
      v: 1,
      pubkey,
      ...(file?.relays ? { relays: file.relays } : {}),
      leases: {
        ...(file?.leases ?? {}),
        [d]: {
          event: entry.event,
          ...(entry.relays && entry.relays.length > 0 ? { relays: [...entry.relays] } : {}),
          published: entry.published,
        },
      },
    });
  }

  remove(pubkey: string, d: string): void {
    const file = this.#load(pubkey);
    if (!file) return;
    const leases = { ...file.leases };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete leases[d];
    this.#save(pubkey, { ...file, v: 1, pubkey, leases });
  }

  rememberRelays(pubkey: string, relays: readonly string[]): void {
    const file = this.#load(pubkey);
    this.#save(pubkey, {
      v: 1,
      pubkey,
      leases: file?.leases ?? {},
      relays: merge(file?.relays, relays),
    });
  }

  relays(pubkey: string): readonly string[] {
    return this.#load(pubkey)?.relays ?? [];
  }

  /**
   * A cache that cannot be read is an empty cache — with one loud exception
   * this console cannot make for itself: a local-only lease that lived only
   * here is gone with it, and nothing can bring it back. That is the cost ADR
   * 0021 names for the local-only switch, and the reason it is not the default.
   */
  #load(pubkey: string): CacheFile | undefined {
    let raw: string;
    try {
      raw = readFileSync(accountLeaseVaultPath(this.#paths, pubkey), 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const file = parsed as CacheFile;
    if (file.v !== 1 || file.pubkey !== pubkey) return undefined;
    if (typeof file.leases !== 'object' || file.leases === null) {
      return { v: 1, pubkey, leases: {}, ...(file.relays ? { relays: file.relays } : {}) };
    }
    return file;
  }

  #save(pubkey: string, file: CacheFile): void {
    const path = accountLeaseVaultPath(this.#paths, pubkey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

function merge(held: readonly string[] | undefined, added: readonly string[]): string[] {
  return [...new Set([...added, ...(held ?? [])])].slice(0, 16);
}

/** A vault cache that forgets. For tests, and for the fresh-machine case. */
export class InMemoryLeaseVaultCache implements LeaseVaultCache {
  readonly #leases = new Map<string, Map<string, CachedLease>>();
  readonly #relays = new Map<string, string[]>();

  read(pubkey: string): ReadonlyMap<string, CachedLease> {
    return this.#leases.get(pubkey) ?? new Map();
  }

  write(pubkey: string, d: string, entry: CachedLease): void {
    const held = this.#leases.get(pubkey) ?? new Map<string, CachedLease>();
    held.set(d, entry);
    this.#leases.set(pubkey, held);
  }

  remove(pubkey: string, d: string): void {
    this.#leases.get(pubkey)?.delete(d);
  }

  rememberRelays(pubkey: string, relays: readonly string[]): void {
    this.#relays.set(pubkey, merge(this.#relays.get(pubkey), relays));
  }

  relays(pubkey: string): readonly string[] {
    return this.#relays.get(pubkey) ?? [];
  }
}
