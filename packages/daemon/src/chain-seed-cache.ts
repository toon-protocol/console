import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isEventShape, type NostrEvent } from './nostr.js';
import { accountChainSeedPath, type ConsolePaths } from './paths.js';

/**
 * The local copy of an account's sealed Chain Seed record.
 *
 * A **cache**, in the strict sense: everything in it can be fetched again from
 * the account's relays, and the console is correct — only slower — with the
 * file deleted. That is what the recovery criterion tests, and it is why this
 * file is allowed to exist at all. ADR 0020 rejected a seed kept only on one
 * machine; a machine-local copy of something the relays also hold is the
 * opposite of that.
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
  /** The sealed kind-30078, as published. Absent until one has been. */
  readonly event?: NostrEvent | undefined;
  /** Relays last known to hold it, to ask again on the next read. */
  readonly relays?: readonly string[] | undefined;
  readonly warningAcknowledgedAt?: string | undefined;
}

export interface ChainSeedCache {
  read(pubkey: string): CachedChainSeed | undefined;
  writeEvent(pubkey: string, event: NostrEvent, relays?: readonly string[]): void;
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
      ...(file.event ? { event: file.event } : {}),
      ...(file.relays ? { relays: file.relays } : {}),
      ...(file.warningAcknowledgedAt === undefined
        ? {}
        : { warningAcknowledgedAt: file.warningAcknowledgedAt }),
    };
  }

  writeEvent(pubkey: string, event: NostrEvent, relays: readonly string[] = []): void {
    const held = this.#load(pubkey);
    this.#save(pubkey, {
      ...(held ?? {}),
      v: 1,
      pubkey,
      event,
      relays: merge(held?.relays, relays),
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

  writeEvent(pubkey: string, event: NostrEvent, relays: readonly string[] = []): void {
    const held = this.#held.get(pubkey);
    this.#held.set(pubkey, { ...held, event, relays: merge(held?.relays, relays) });
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
