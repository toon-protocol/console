import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isEventShape, type NostrEvent } from './nostr.js';
import { accountChainSeedPath, type ConsolePaths } from './paths.js';

/**
 * The local copy of an account's sealed Chain Seed record.
 *
 * A **cache**, in the strict sense, once `published` is true: everything in it
 * can be fetched again from the account's relays, and the console is correct —
 * only slower — with the file deleted. That is what the recovery criterion
 * tests, and it is why this file is allowed to exist at all. ADR 0020 rejected
 * a seed kept only on one machine; a machine-local copy of something the
 * relays also hold is the opposite of that.
 *
 * There is now one window in which it is NOT a cache, and the whole point of
 * `published` is that the window is named and visible. A seed cannot pay for
 * its own publication — the payer keys are derived FROM it, and the write is a
 * paid packet — so it is minted, held here with `published: false`, and only
 * published once the account has funded a payer address and opened a channel
 * (TOON_Network#120). Until that write lands this file is the only copy there
 * is, and `chain-seed.ts` says so in those words rather than letting the state
 * pass for the real thing.
 *
 * **What is stored is the SEALED event, byte for byte as published.** Never a
 * mnemonic, never a derived key, never even an address — an address is not
 * secret, but a cache holding one would be a cache that could answer questions
 * without the signer, and the moment it can, something will ask it to. Opening
 * this file requires the account's Nostr key, exactly as opening the relay's
 * copy does, so a stolen disk is worth no more than a subscription to a relay.
 *
 * It also remembers that the custody warning has been shown, which is the only
 * way "warn, once" can survive a restart or a second window.
 *
 * One file per account pubkey, not per network profile: an account's chain
 * keys are the same on devnet and on mainnet (ADR 0020), and a per-profile
 * copy would invite two seeds for one account.
 */

export interface CachedChainSeed {
  /** The sealed kind-30078, as signed. Absent until one has been minted. */
  readonly event?: NostrEvent | undefined;
  /** Relays last known to hold it, to ask again on the next read. */
  readonly relays?: readonly string[] | undefined;
  /**
   * `false` while this seed is **not yet recoverable**: sealed and signed on
   * this machine, and on no relay (TOON_Network#120).
   *
   * The one field that stops a temporary state from becoming a silent lie. A
   * held record and a published one are the same bytes, so without this the
   * console could not tell "recoverable anywhere this account can sign" from
   * "one disk holds everything" — and the difference only ever surfaces on the
   * day the disk dies. Absent means published, which is what every record
   * written before this field existed was.
   */
  readonly published?: boolean | undefined;
  readonly warningAcknowledgedAt?: string | undefined;
}

export interface CachedSeedWrite {
  readonly event: NostrEvent;
  readonly relays?: readonly string[] | undefined;
  /** Whether a relay took it. A caller must say; there is no safe default. */
  readonly published: boolean;
}

export interface ChainSeedCache {
  read(pubkey: string): CachedChainSeed | undefined;
  writeEvent(pubkey: string, entry: CachedSeedWrite): void;
  /**
   * Relays this account has been seen on, kept so the next read knows where to
   * look. Not a secret and not authoritative — the account's NIP-65 list is —
   * but without it a console that has just published a relay list to a relay
   * nothing else names would have no way back to it.
   */
  rememberRelays(pubkey: string, relays: readonly string[]): void;
  acknowledgeWarning(pubkey: string, at: Date): void;
}

interface CacheFile {
  readonly v: 1;
  readonly pubkey: string;
  readonly event?: NostrEvent;
  readonly relays?: string[];
  readonly published?: boolean;
  readonly warningAcknowledgedAt?: string;
}

export class FileChainSeedCache implements ChainSeedCache {
  readonly #paths: ConsolePaths;

  constructor(paths: ConsolePaths) {
    this.#paths = paths;
  }

  read(pubkey: string): CachedChainSeed | undefined {
    const file = this.#load(pubkey);
    if (!file) return undefined;
    return {
      ...(file.event ? { event: file.event, published: file.published !== false } : {}),
      ...(file.relays ? { relays: file.relays } : {}),
      ...(file.warningAcknowledgedAt === undefined
        ? {}
        : { warningAcknowledgedAt: file.warningAcknowledgedAt }),
    };
  }

  writeEvent(pubkey: string, entry: CachedSeedWrite): void {
    const held = this.#load(pubkey);
    this.#save(pubkey, {
      ...(held ?? {}),
      v: 1,
      pubkey,
      event: entry.event,
      published: entry.published,
      relays: merge(held?.relays, entry.relays ?? []),
    });
  }

  rememberRelays(pubkey: string, relays: readonly string[]): void {
    const held = this.#load(pubkey);
    this.#save(pubkey, {
      ...(held ?? {}),
      v: 1,
      pubkey,
      relays: merge(held?.relays, relays),
    });
  }

  acknowledgeWarning(pubkey: string, at: Date): void {
    const held = this.#load(pubkey);
    if (held?.warningAcknowledgedAt !== undefined) return; // once means once
    this.#save(pubkey, {
      ...(held ?? { v: 1, pubkey }),
      v: 1,
      pubkey,
      warningAcknowledgedAt: at.toISOString(),
    });
  }

  /**
   * A cache that cannot be read is an empty cache, never a failed sign-in: the
   * relays hold the same record, and a person whose JSON got truncated by a
   * full disk should get their addresses back, not an error page.
   */
  #load(pubkey: string): CacheFile | undefined {
    let raw: string;
    try {
      raw = readFileSync(accountChainSeedPath(this.#paths, pubkey), 'utf8');
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
    // A cache file is a file on disk, and a file on disk is a thing anything
    // on this machine can write. Whatever it claims is an event is checked for
    // shape here and re-verified by the reader before it is believed.
    if (file.event !== undefined && !isEventShape(file.event)) {
      return { v: 1, pubkey, ...(file.relays ? { relays: file.relays } : {}) };
    }
    return file;
  }

  #save(pubkey: string, file: CacheFile): void {
    const path = accountChainSeedPath(this.#paths, pubkey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

/** A short, bounded list of relays: newest first, and no duplicates. */
function merge(held: readonly string[] | undefined, added: readonly string[]): string[] {
  return [...new Set([...added, ...(held ?? [])])].slice(0, 16);
}

/** A cache that forgets, for tests and for a console asked to keep nothing. */
export class InMemoryChainSeedCache implements ChainSeedCache {
  readonly #held = new Map<string, CachedChainSeed>();

  read(pubkey: string): CachedChainSeed | undefined {
    return this.#held.get(pubkey);
  }

  writeEvent(pubkey: string, entry: CachedSeedWrite): void {
    const held = this.#held.get(pubkey);
    this.#held.set(pubkey, {
      ...held,
      event: entry.event,
      published: entry.published,
      relays: merge(held?.relays, entry.relays ?? []),
    });
  }

  rememberRelays(pubkey: string, relays: readonly string[]): void {
    const held = this.#held.get(pubkey);
    this.#held.set(pubkey, { ...held, relays: merge(held?.relays, relays) });
  }

  acknowledgeWarning(pubkey: string, at: Date): void {
    const held = this.#held.get(pubkey);
    if (held?.warningAcknowledgedAt !== undefined) return;
    this.#held.set(pubkey, { ...held, warningAcknowledgedAt: at.toISOString() });
  }
}
