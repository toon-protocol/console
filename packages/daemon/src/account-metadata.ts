import { queryRelays, type NostrEvent, type QueryOptions } from './relay-read.js';

/**
 * Who is signed in, as the account itself has published it.
 *
 * The console shows a name and an avatar so that a person can tell at a glance
 * WHICH identity is signed in — an npub is sixty-three characters and every
 * one of them looks alike. That is the whole job: this is display, never
 * authority. Nothing the console does is gated on a kind-0, and an account
 * with no metadata at all is signed in exactly as much as one with a picture.
 *
 * Where to read it from, in order:
 *
 * 1. the account's own **NIP-65** relay list (kind 10002), read from the
 *    network profile's relay;
 * 2. failing that, the network profile's relay by itself.
 *
 * NIP-65 first because the account's own relays are where its metadata
 * actually lives — the network profile's relay is a TOON Network relay, and
 * there is no reason an account's kind-0 would be on it. The fallback is
 * there because the list has to be read from SOMEWHERE, and reads are free.
 *
 * There is no relay constant in this module. The one it falls back to is the
 * active profile's `relayUrl`, passed in, for the same reason there is no
 * chain id in `profiles.ts`.
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
  /** The account's NIP-65 read relays, when it publishes a list. */
  readonly relays: readonly string[];
  /** Where the relays came from, for the "where did this come from" question. */
  readonly relaySource: 'nip65' | 'profile' | 'none';
  readonly readAt: string;
}

const METADATA_KIND = 0;
const RELAY_LIST_KIND = 10002;

export async function readAccountProfile(
  pubkey: string,
  fallbackRelays: readonly string[],
  options: QueryOptions = {}
): Promise<AccountProfile> {
  const seeds = fallbackRelays.filter((url) => url.length > 0);
  const readAt = new Date().toISOString();
  if (seeds.length === 0) {
    return { relays: [], relaySource: 'none', readAt };
  }

  // One round trip for both: a relay that has the kind-0 usually has the
  // kind-10002 beside it, and asking twice would double a sign-in's slowest
  // step for nothing.
  const first = await queryRelays(
    seeds,
    { kinds: [METADATA_KIND, RELAY_LIST_KIND], authors: [pubkey], limit: 2 },
    options
  );

  const declared = readRelayList(first.find((event) => event.kind === RELAY_LIST_KIND));
  let metadataEvent = first.find((event) => event.kind === METADATA_KIND);
  const relaySource: AccountProfile['relaySource'] = declared.length > 0 ? 'nip65' : 'profile';

  if (declared.length > 0) {
    // The account says its metadata lives elsewhere. Believe it, and prefer
    // what those relays hold: the seed relay's copy may be years old.
    const fromOwn = await queryRelays(
      declared,
      { kinds: [METADATA_KIND], authors: [pubkey], limit: 1 },
      options
    );
    const candidate = fromOwn.find((event) => event.kind === METADATA_KIND);
    if (candidate && (!metadataEvent || candidate.created_at > metadataEvent.created_at)) {
      metadataEvent = candidate;
    }
  }

  const metadata = parseMetadata(metadataEvent);
  return {
    ...(metadata ? { metadata } : {}),
    relays: declared.length > 0 ? declared : seeds,
    relaySource,
    readAt,
  };
}

/**
 * NIP-65: `["r", "<url>"]`, optionally with `"read"` or `"write"`. A bare `r`
 * is both, so a tag marked `write` only is the one to drop here.
 */
function readRelayList(event: NostrEvent | undefined): string[] {
  if (!event) return [];
  const urls: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r') continue;
    const url = tag[1];
    if (typeof url !== 'string' || url.length === 0) continue;
    if (tag[2] === 'write') continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function parseMetadata(event: NostrEvent | undefined): AccountMetadata | undefined {
  if (!event) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    // A kind-0 whose content is not JSON is a kind-0 with nothing to show.
    return { publishedAt: new Date(event.created_at * 1000).toISOString() };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { publishedAt: new Date(event.created_at * 1000).toISOString() };
  }
  const record = parsed as Record<string, unknown>;
  return {
    name: text(record.name),
    displayName: text(record.display_name),
    about: text(record.about),
    picture: text(record.picture),
    nip05: text(record.nip05),
    publishedAt: new Date(event.created_at * 1000).toISOString(),
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
