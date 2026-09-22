import type { NostrEvent } from './nostr.js';
import { parseRelayList, RELAY_LIST_KIND } from './relay-list.js';
import { queryRelays, type RelayDialer } from './relay-pool.js';

/**
 * Who is signed in, as the account itself has published it.
 *
 * The console shows a name and an avatar so that a person can tell at a glance
 * WHICH identity is signed in — an npub is sixty-three characters and every one
 * of them looks alike. That is the whole job: this is display, never authority.
 * Nothing the console does is gated on a kind-0, and an account with no
 * metadata at all is signed in exactly as much as one with a picture.
 *
 * It reads through the same `relay-pool` the Provider Directory uses
 * (TOON_Network#91), which means every event here has had its id re-derived and
 * its signature checked before this module sees it. That matters more than it
 * looks: an unverified read would let any relay serve ANY name and avatar under
 * the account's pubkey, and the one thing this view exists to do is tell a
 * person which identity they are about to spend money as.
 *
 * Where to read from, in order:
 *
 * 1. the account's own **NIP-65** relay list (kind 10002), read from the
 *    network profile's relay;
 * 2. failing that, the network profile's relay by itself.
 *
 * NIP-65 first because the account's own relays are where its metadata actually
 * lives — the profile's relay is a TOON Network relay, and there is no reason
 * an account's kind-0 would be on it. The fallback is there because the list
 * has to be read from SOMEWHERE, and reads are free.
 *
 * There is no relay constant in this module. The one it falls back to is the
 * active profile's `relayUrl`, passed in, for the same reason there is no chain
 * id in `profiles.ts`.
 */

export interface AccountMetadata {
  readonly name?: string | undefined;
  readonly displayName?: string | undefined;
  readonly about?: string | undefined;
  readonly picture?: string | undefined;
  readonly nip05?: string | undefined;
  /** When the kind-0 the console is showing was published. */
  readonly publishedAt?: string | undefined;
}

export interface AccountProfile {
  /** Absent when no kind-0 came back — not an error, just a quiet account. */
  readonly metadata?: AccountMetadata | undefined;
  /** The relays the metadata was looked for on. */
  readonly relays: readonly string[];
  /** Where those relays came from, for the "where did this come from" question. */
  readonly relaySource: 'nip65' | 'profile' | 'none';
  readonly readAt: string;
}

export interface ProfileReadOptions {
  readonly dial?: RelayDialer | undefined;
  readonly timeoutMs?: number | undefined;
}

const METADATA_KIND = 0;

export async function readAccountProfile(
  pubkey: string,
  fallbackRelays: readonly string[],
  options: ProfileReadOptions = {}
): Promise<AccountProfile> {
  const seeds = fallbackRelays.filter((url) => url.length > 0);
  const readAt = new Date().toISOString();
  if (seeds.length === 0) return { relays: [], relaySource: 'none', readAt };

  // One round trip for both: a relay that has the kind-0 usually has the
  // kind-10002 beside it, and asking twice would double a sign-in's slowest
  // step for nothing.
  const first = await read(seeds, [METADATA_KIND, RELAY_LIST_KIND], pubkey, options);
  // A kind-0 is READ from the relays the account reads on. Which relays its
  // own records are WRITTEN to is `relay-list.ts`'s other half, and the Chain
  // Seed's business (TOON_Network#89).
  const declared = parseRelayList(newest(first, RELAY_LIST_KIND)).read;
  let metadataEvent = newest(first, METADATA_KIND);

  if (declared.length > 0) {
    // The account says its metadata lives elsewhere. Believe it, and prefer
    // what those relays hold: the seed relay's copy may be years old.
    const own = newest(await read(declared, [METADATA_KIND], pubkey, options), METADATA_KIND);
    if (own && (!metadataEvent || own.created_at > metadataEvent.created_at)) {
      metadataEvent = own;
    }
  }

  const metadata = parseMetadata(metadataEvent);
  return {
    ...(metadata ? { metadata } : {}),
    relays: declared.length > 0 ? declared : seeds,
    relaySource: declared.length > 0 ? 'nip65' : 'profile',
    readAt,
  };
}

function read(
  relays: readonly string[],
  kinds: number[],
  pubkey: string,
  options: ProfileReadOptions
): Promise<{ events: readonly NostrEvent[] }> {
  return queryRelays({
    relays,
    filters: [{ kinds, authors: [pubkey], limit: kinds.length }],
    ...(options.dial === undefined ? {} : { dial: options.dial }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/**
 * The newest event of a kind.
 *
 * Relays return whatever they hold, and several of them return it at once, so
 * "the account's name" is the most recent kind-0 across all of them rather than
 * whichever arrived first.
 */
function newest(
  result: { events: readonly NostrEvent[] },
  kind: number
): NostrEvent | undefined {
  let held: NostrEvent | undefined;
  for (const event of result.events) {
    if (event.kind !== kind) continue;
    if (!held || event.created_at > held.created_at) held = event;
  }
  return held;
}

function parseMetadata(event: NostrEvent | undefined): AccountMetadata | undefined {
  if (!event) return undefined;
  const publishedAt = new Date(event.created_at * 1000).toISOString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    // A kind-0 whose content is not JSON is a kind-0 with nothing to show.
    return { publishedAt };
  }
  if (typeof parsed !== 'object' || parsed === null) return { publishedAt };
  const record = parsed as Record<string, unknown>;
  return {
    name: text(record.name),
    displayName: text(record.display_name),
    about: text(record.about),
    picture: text(record.picture),
    nip05: text(record.nip05),
    publishedAt,
  };
}

/**
 * Only strings, and only short ones. A kind-0 is a stranger's JSON: it can
 * carry a megabyte of anything, and the console renders it.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, 512);
}
