import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * NIP-01, the reading half.
 *
 * The console reads the Provider Directory and writes nothing to it: a
 * provider signs its Profile, its Listings and its Liveness, and a tenant
 * signs no event of this protocol at all (spec §4, ADR 0016). So there is no
 * signing here, and no key — only what it takes to decide whether an event a
 * relay handed over is really the provider's.
 *
 * A relay is not trusted. Every event the directory acts on has its `id`
 * re-derived from its own fields and its `sig` checked against its `pubkey`
 * here first, because a relay that serves someone else's Listing under a
 * provider's pubkey would otherwise be choosing who a person pays.
 *
 * Nothing in this file is TOON-specific. The kinds and the label live in
 * `directory.ts`, which is where the spec's meaning starts.
 */

export interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

/** A relay filter, as NIP-01 spells one on the wire. */
export type NostrFilter = Record<string, readonly string[] | readonly number[] | number>;

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value);
}

/** The NIP-01 serialization an event's id is the SHA-256 of. */
export function serializeEvent(event: NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** An event's id, re-derived from its own fields rather than believed. */
export function eventId(event: NostrEvent): string {
  return bytesToHex(sha256(new TextEncoder().encode(serializeEvent(event))));
}

/**
 * Whether a relay's JSON is an event at all, shape first.
 *
 * Kept apart from the signature check so a caller can say WHY something was
 * dropped: "that is not an event" and "that event is not this provider's" are
 * different answers to a person wondering why a provider is missing.
 */
export function isEventShape(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    isHex(event.id, 32) &&
    isHex(event.pubkey, 32) &&
    isHex(event.sig, 64) &&
    Number.isInteger(event.kind) &&
    Number.isInteger(event.created_at) &&
    typeof event.content === 'string' &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string')
    )
  );
}

/**
 * Whether an event is really what it says it is.
 *
 * Never throws. A relay may send anything at all, and a console that crashed
 * on one malformed event would be taken offline by anybody who can write to a
 * relay it reads.
 */
export function verifyEvent(value: unknown): value is NostrEvent {
  try {
    if (!isEventShape(value)) return false;
    if (eventId(value) !== value.id.toLowerCase()) return false;
    return schnorr.verify(
      hexToBytes(value.sig),
      hexToBytes(value.id),
      hexToBytes(value.pubkey)
    );
  } catch {
    return false;
  }
}

/** The value of the first tag named `name`, or `undefined`. */
export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/** Every value of every tag named `name`, in the order the event carries them. */
export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.flatMap((tag) =>
    tag[0] === name && tag[1] !== undefined ? [tag[1]] : []
  );
}

/**
 * NIP-01's replacement rule: later wins, and a tie goes to the lower id.
 *
 * Two relays can hold two versions of the same replaceable or addressable
 * event, and a provider that republishes a Listing does not delete the old one
 * everywhere at once — so the console decides which is current itself rather
 * than trusting whichever relay answered first (spec §4.2, ADR 0009).
 */
export function supersedes(candidate: NostrEvent, held: NostrEvent): boolean {
  if (candidate.created_at !== held.created_at) return candidate.created_at > held.created_at;
  return candidate.id < held.id;
}

/** NIP-40: the moment this event stops being true, or `undefined`. */
export function expirationOf(event: NostrEvent): number | undefined {
  const raw = tagValue(event, 'expiration');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isInteger(seconds) ? seconds : undefined;
}

/**
 * Keep the current version of each of a stream of events, by key.
 *
 * The same shape serves all three directory kinds: a Profile and a Liveness
 * are keyed by their author, a Listing by its author and `d` tag (spec §4).
 */
export class CurrentEvents {
  readonly #held = new Map<string, NostrEvent>();
  #superseded = 0;

  /** @returns whether `event` became the current one for `key`. */
  offer(key: string, event: NostrEvent): boolean {
    const held = this.#held.get(key);
    if (held === undefined) {
      this.#held.set(key, event);
      return true;
    }
    if (held.id === event.id) return false; // the same event, from a second relay
    if (!supersedes(event, held)) {
      this.#superseded += 1;
      return false;
    }
    this.#held.set(key, event);
    this.#superseded += 1;
    return true;
  }

  get(key: string): NostrEvent | undefined {
    return this.#held.get(key);
  }

  entries(): IterableIterator<[string, NostrEvent]> {
    return this.#held.entries();
  }

  /** How many older versions were seen and set aside. */
  get supersededCount(): number {
    return this.#superseded;
  }
}
