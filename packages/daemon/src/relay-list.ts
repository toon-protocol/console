import type { EventTemplate } from 'nostr-tools/core';

import type { NostrEvent } from './nostr.js';
import { queryRelays, type RelayDialer } from './relay-pool.js';

/**
 * NIP-65: which relays an account reads from, and which it writes to.
 *
 * The distinction is the whole reason this module exists. Reading an account's
 * kind-0 wants its READ relays; publishing its Chain Seed (ADR 0020) or a
 * Lease Vault record (ADR 0021) wants its WRITE relays, and they are routinely
 * different sets. Until #89 the console only ever read, so `account-metadata`
 * kept the one half it needed; both halves live here now, parsed once, so that
 * "where does this account's seed go" has a single answer.
 *
 * A bare `["r", "<url>"]` is both, per the NIP. `["r", url, "read"]` and
 * `["r", url, "write"]` are one each. Anything else in the third slot is not a
 * marker this NIP defines, and a tag the console does not understand is left
 * out of both lists rather than guessed at — a guess here would publish an
 * account's sealed seed to a relay it never asked for.
 */

export const RELAY_LIST_KIND = 10002;

export type RelayMode = 'read' | 'write' | 'both';

export interface RelayEntry {
  readonly url: string;
  readonly mode: RelayMode;
}

export interface RelayList {
  /** Every relay the account named, with what it named it for. */
  readonly entries: readonly RelayEntry[];
  readonly read: readonly string[];
  readonly write: readonly string[];
  /** When the list was published, when it came off a relay. */
  readonly publishedAt?: string | undefined;
  readonly eventId?: string | undefined;
}

export const NO_RELAY_LIST: RelayList = { entries: [], read: [], write: [] };

export function parseRelayList(event: NostrEvent | undefined): RelayList {
  if (!event) return NO_RELAY_LIST;
  const entries: RelayEntry[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r') continue;
    const url = normalizeRelayUrl(tag[1]);
    if (url === undefined) continue;
    const marker = tag[2];
    if (marker !== undefined && marker !== '' && marker !== 'read' && marker !== 'write') {
      continue;
    }
    const mode: RelayMode = marker === 'read' || marker === 'write' ? marker : 'both';
    const held = entries.find((entry) => entry.url === url);
    if (!held) {
      entries.push({ url, mode });
      continue;
    }
    // The same relay listed twice, once each way, is the account spelling out
    // what a bare `r` would have said.
    if (held.mode !== mode) {
      entries[entries.indexOf(held)] = { url, mode: 'both' };
    }
  }
  return {
    entries,
    read: entries.filter((entry) => entry.mode !== 'write').map((entry) => entry.url),
    write: entries.filter((entry) => entry.mode !== 'read').map((entry) => entry.url),
    publishedAt: new Date(event.created_at * 1000).toISOString(),
    eventId: event.id,
  };
}

/**
 * A websocket URL, or nothing.
 *
 * Relays are named with and without a trailing slash by different clients, and
 * the two are the same relay; the console picks one spelling so that a list
 * carrying both does not make it dial twice. A non-websocket scheme is dropped
 * outright rather than dialled: an `https://` in an `r` tag is a mistake or a
 * trap, and either way there is no relay behind it.
 */
export function normalizeRelayUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
  const text = url.toString();
  return text.endsWith('/') && url.pathname === '/' ? text.slice(0, -1) : text;
}

export interface RelayListReadOptions {
  readonly dial?: RelayDialer | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * The account's list, read from wherever the console can currently look.
 *
 * `seeds` are the relays to ask — the network profile's, plus anything already
 * known. An account with no list anywhere gets `NO_RELAY_LIST` back, which is
 * not an error: it is the state the console offers to fix by publishing one.
 */
export async function readRelayListOf(
  pubkey: string,
  seeds: readonly string[],
  options: RelayListReadOptions = {}
): Promise<RelayList> {
  const relays = seeds.filter((url) => url.length > 0);
  if (relays.length === 0) return NO_RELAY_LIST;
  const result = await queryRelays({
    relays,
    filters: [{ kinds: [RELAY_LIST_KIND], authors: [pubkey], limit: 1 }],
    ...(options.dial === undefined ? {} : { dial: options.dial }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  let newest: NostrEvent | undefined;
  for (const event of result.events) {
    if (event.kind !== RELAY_LIST_KIND) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  return parseRelayList(newest);
}

export class RelayListError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RelayListError';
    this.code = code;
  }
}

/**
 * The kind-10002 to sign, from what a person typed.
 *
 * Validated hard, because this event is what every other Nostr client the
 * account uses will route by from now on: a typo published here quietly moves
 * an account's whole correspondence, not just the console's records.
 */
export function relayListTemplate(
  entries: readonly { url: string; mode?: RelayMode }[],
  createdAt: number
): EventTemplate {
  const tags: string[][] = [];
  for (const entry of entries) {
    const url = normalizeRelayUrl(entry.url);
    if (url === undefined) {
      throw new RelayListError(
        'invalid_relay_url',
        `\`${String(entry.url)}\` is not a relay URL. A relay is \`wss://host\` or \`ws://host\`.`
      );
    }
    if (tags.some((tag) => tag[1] === url)) continue;
    const mode = entry.mode ?? 'both';
    tags.push(mode === 'both' ? ['r', url] : ['r', url, mode]);
  }
  if (tags.length === 0) {
    throw new RelayListError(
      'no_relays',
      'A relay list with no relays in it would take this account off Nostr. Name at least one.'
    );
  }
  return { kind: RELAY_LIST_KIND, created_at: createdAt, tags, content: '' };
}
