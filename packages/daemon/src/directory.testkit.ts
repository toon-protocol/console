import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { K_LISTING, K_LIVENESS, K_PROFILE, LABEL } from './directory.js';
import { eventId, type NostrEvent } from './nostr.js';
import type { RelayConnection, RelayDialer, RelayHandlers } from './relay-pool.js';

/**
 * A provider that publishes, for the tests only.
 *
 * The directory reads signed events and refuses everything else, so the tests
 * have to sign — a hand-written object with a plausible `sig` is exactly what
 * `verifyEvent` exists to throw away. This is the ONLY place in the console
 * that holds a secret key or signs anything: the console itself signs no event
 * of this protocol (spec §4, ADR 0016).
 *
 * The fake relay below answers a REQ the way a relay does, filters included,
 * so a test can show that a `#l` filter narrows the read at the relay rather
 * than only in the daemon afterwards.
 */

export interface FakeProvider {
  readonly secret: Uint8Array;
  readonly pubkey: string;
}

export function fakeProvider(seed: string): FakeProvider {
  const secret = new Uint8Array(32);
  const bytes = new TextEncoder().encode(seed);
  secret.set(bytes.slice(0, 31), 1);
  secret[0] = 1; // never zero, which is not a valid scalar
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
}

export function sign(
  provider: FakeProvider,
  draft: { kind: number; content: string; tags: string[][]; created_at: number }
): NostrEvent {
  const unsigned = { ...draft, pubkey: provider.pubkey, id: '', sig: '' };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), provider.secret)) };
}

export interface ProfileDraft {
  readonly relays?: string[];
  readonly isolation?: string;
  readonly hidden?: boolean;
  readonly host?: string;
  readonly cadence?: number;
  readonly createdAt?: number;
  readonly connectorUrl?: string;
}

export function profileEvent(provider: FakeProvider, draft: ProfileDraft = {}): NostrEvent {
  const hidden = draft.hidden ?? false;
  return sign(provider, {
    kind: K_PROFILE,
    created_at: draft.createdAt ?? 1_790_000_000,
    tags: [['L', LABEL]],
    content: JSON.stringify({
      ilp_address: 'g.test.provider',
      connector_url: draft.connectorUrl ?? 'https://connector.test/ilp',
      connector_seal_key: '0x04',
      relays: draft.relays ?? [],
      settlement: [{ chain: 'evm:84532', token: '0xtoken', decimals: 6 }],
      isolation: draft.isolation ?? 'shared-kernel',
      hidden,
      ...(hidden || draft.host === undefined ? {} : { host: draft.host }),
      liveness_cadence_s: draft.cadence ?? 60,
    }),
  });
}

export interface ListingDraft {
  readonly name: string;
  readonly version?: number;
  readonly arch?: string;
  readonly isolation?: string;
  readonly price?: number;
  readonly standbyPrice?: number;
  readonly leaseIntervalSeconds?: number;
  readonly capabilities?: string[];
  readonly gpu?: string;
  /** The `l gpu:` tag, when it should differ from `resources.gpu`. */
  readonly gpuLabel?: string;
  readonly hiddenLabel?: boolean;
  readonly createdAt?: number;
}

export function listingEvent(provider: FakeProvider, draft: ListingDraft): NostrEvent {
  const isolation = draft.isolation ?? 'shared-kernel';
  const arch = draft.arch ?? 'amd64';
  const gpuLabel = draft.gpuLabel ?? draft.gpu;
  return sign(provider, {
    kind: K_LISTING,
    created_at: draft.createdAt ?? 1_790_000_000,
    tags: [
      ['d', draft.name],
      ['a', `${K_PROFILE}:${provider.pubkey}:`],
      ['L', LABEL],
      ['l', `isolation:${isolation}`, LABEL],
      ['l', `arch:${arch}`, LABEL],
      ...(draft.hiddenLabel ? [['l', 'hidden:true', LABEL]] : []),
      ...(gpuLabel === undefined ? [] : [['l', `gpu:${gpuLabel}`, LABEL]]),
      ...(draft.capabilities ?? []).map((capability) => ['t', capability]),
    ],
    content: JSON.stringify({
      version: draft.version ?? 1,
      resources: {
        cpu_millicores: 1000,
        memory_mb: 1024,
        storage_gb: 10,
        ...(draft.gpu === undefined ? {} : { gpu: draft.gpu }),
      },
      arch,
      lease_interval_s: draft.leaseIntervalSeconds ?? 3600,
      price: draft.price ?? 1000,
      ...(draft.standbyPrice === undefined ? {} : { standby_price: draft.standbyPrice }),
      capabilities: draft.capabilities ?? [],
    }),
  });
}

export function livenessEvent(
  provider: FakeProvider,
  draft: { expiresAt: number; available?: Record<string, number>; createdAt?: number }
): NostrEvent {
  return sign(provider, {
    kind: K_LIVENESS,
    created_at: draft.createdAt ?? draft.expiresAt - 300,
    tags: [
      ['L', LABEL],
      ['expiration', String(draft.expiresAt)],
    ],
    content: JSON.stringify({ available: draft.available ?? {} }),
  });
}

/** Whether one event satisfies one NIP-01 filter, the way a relay decides. */
export function eventMatchesFilter(
  event: NostrEvent,
  filter: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'kinds') {
      if (!(value as number[]).includes(event.kind)) return false;
    } else if (key === 'authors') {
      if (!(value as string[]).includes(event.pubkey)) return false;
    } else if (key === 'limit') {
      continue;
    } else if (key.startsWith('#')) {
      const name = key.slice(1);
      const held = event.tags.flatMap((tag) => (tag[0] === name && tag[1] ? [tag[1]] : []));
      // NIP-01 is OR inside one tag filter and AND across them, which is why
      // `directoryFilters` spells two labels as two entries in one `#l`… and
      // why the daemon checks every one of them again itself.
      if (!(value as string[]).some((wanted) => held.includes(wanted))) return false;
    }
  }
  return true;
}

export interface FakeRelay {
  readonly url: string;
  readonly events: readonly NostrEvent[];
  /** Answers nothing and hangs up, so a read over a dead relay can be shown. */
  readonly broken?: boolean;
}

/** REQs this dialer was asked, in order, so a test can assert what went out. */
export interface RecordedRequest {
  readonly url: string;
  readonly filters: Record<string, unknown>[];
}

export function fakeRelays(
  relays: readonly FakeRelay[],
  recorded: RecordedRequest[] = []
): { dial: RelayDialer; requests: RecordedRequest[] } {
  const dial: RelayDialer = (url, handlers: RelayHandlers): RelayConnection => {
    const relay = relays.find((candidate) => candidate.url === url);
    queueMicrotask(() => {
      if (relay === undefined || relay.broken === true) {
        handlers.onError(`no relay at ${url}`);
        return;
      }
      handlers.onOpen();
    });
    return {
      send(message: string) {
        const parsed = JSON.parse(message) as [string, string, ...Record<string, unknown>[]];
        if (parsed[0] !== 'REQ' || relay === undefined) return;
        const [, subscriptionId, ...filters] = parsed;
        recorded.push({ url, filters });
        for (const event of relay.events) {
          if (filters.some((filter) => eventMatchesFilter(event, filter))) {
            handlers.onMessage(JSON.stringify(['EVENT', subscriptionId, event]));
          }
        }
        handlers.onMessage(JSON.stringify(['EOSE', subscriptionId]));
      },
      close() {
        // Nothing to release: the fake holds no socket.
      },
    };
  };
  return { dial, requests: recorded };
}
