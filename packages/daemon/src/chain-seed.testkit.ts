import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { eventMatchesFilter } from './directory.testkit.js';
import { isEventShape, tagValue, supersedes, type NostrEvent } from './nostr.js';
import type { RelayConnection, RelayDialer, RelayHandlers } from './relay-pool.js';
import { LocalKeySigner, type AccountSigning } from './signer.js';

/**
 * A relay that also takes writes, for the Chain Seed's tests.
 *
 * `directory.testkit.ts`'s fake answers a REQ and nothing else, which was the
 * whole of what reading the Provider Directory needed. Publishing needs the
 * other half, and it needs a relay that can be told to REFUSE — because the
 * refusal is the interesting case: a TOON relay answers an unpaid write with
 * `restricted: writes require ILP payment`, and how the console behaves when
 * every relay says that is the one behaviour this ticket most has to get
 * right.
 *
 * Replaceable-event semantics are implemented for real (NIP-01: one event per
 * author, kind and `d`, later wins) so that a test can publish twice and see
 * what a relay would actually then serve back.
 */

export interface FakeRelayServer {
  readonly url: string;
  events: NostrEvent[];
  /** Refuse every write with this `OK … false` message. */
  refuse?: string;
  /** Answer nothing at all. */
  down?: boolean;
  /** Take the write and say nothing, so a caller's deadline is exercised. */
  silent?: boolean;
}

export function fakeRelayServer(
  url: string,
  options: Partial<Omit<FakeRelayServer, 'url'>> = {}
): FakeRelayServer {
  // A relay that is down never gets as far as refusing anything, so `down`
  // clears `refuse`: a test says one thing about a relay, not two.
  const { down, ...rest } = options;
  return { url, events: [], ...(down === true ? { down } : rest) };
}

/** The dialer to hand a `ChainSeedStore` as its `dial`. */
export function fakeRelayNetwork(relays: readonly FakeRelayServer[]): RelayDialer {
  return (url, handlers: RelayHandlers): RelayConnection => {
    const relay = relays.find((candidate) => candidate.url === url);
    queueMicrotask(() => {
      if (relay === undefined || relay.down === true) {
        handlers.onError(`no relay at ${url}`);
        return;
      }
      handlers.onOpen();
    });
    return {
      send(message: string) {
        if (relay === undefined) return;
        const parsed = JSON.parse(message) as unknown[];
        if (parsed[0] === 'REQ') {
          const [, subscriptionId, ...filters] = parsed as [
            string,
            string,
            ...Record<string, unknown>[],
          ];
          for (const event of relay.events) {
            if (filters.some((filter) => eventMatchesFilter(event, filter))) {
              handlers.onMessage(JSON.stringify(['EVENT', subscriptionId, event]));
            }
          }
          handlers.onMessage(JSON.stringify(['EOSE', subscriptionId]));
          return;
        }
        if (parsed[0] !== 'EVENT') return;
        const event = parsed[1];
        if (!isEventShape(event)) return;
        if (relay.silent === true) return;
        if (relay.refuse !== undefined) {
          handlers.onMessage(JSON.stringify(['OK', event.id, false, relay.refuse]));
          return;
        }
        store(relay, event);
        handlers.onMessage(JSON.stringify(['OK', event.id, true, '']));
      },
      close() {
        // Nothing to release: the fake holds no socket.
      },
    };
  };
}

/** NIP-01 replacement, as a relay applies it to the 10000 and 30000 ranges. */
function store(relay: FakeRelayServer, event: NostrEvent): void {
  const addressable = event.kind >= 30_000 && event.kind < 40_000;
  const replaceable = event.kind >= 10_000 && event.kind < 20_000;
  if (!addressable && !replaceable) {
    relay.events = [...relay.events, event];
    return;
  }
  const key = (candidate: NostrEvent) =>
    `${candidate.kind}:${candidate.pubkey}:${addressable ? (tagValue(candidate, 'd') ?? '') : ''}`;
  const held = relay.events.find((candidate) => key(candidate) === key(event));
  if (held && !supersedes(event, held)) return;
  relay.events = [...relay.events.filter((candidate) => key(candidate) !== key(event)), event];
}

/**
 * An account's key, behind the same `AccountSigning` port the session hands
 * over — and backed by the REAL `LocalKeySigner`, so what the tests exercise
 * is the console's own NIP-44 self-sealing and not a stand-in for it.
 */
export interface FakeAccount extends AccountSigning {
  readonly secretKey: Uint8Array;
}

export function fakeAccount(secretKey: Uint8Array = generateSecretKey()): FakeAccount {
  const pubkey = getPublicKey(secretKey);
  const signer = new LocalKeySigner(Uint8Array.from(secretKey), pubkey);
  return {
    secretKey,
    pubkey,
    sign: (template) => signer.signEvent(template),
    sealToSelf: (plaintext) => signer.sealToSelf(plaintext),
    unsealFromSelf: (ciphertext) => signer.unsealFromSelf(ciphertext),
  };
}

/** A NIP-65 list this account published, for the relays a test wants it on. */
export async function publishRelayListEvent(
  account: AccountSigning,
  relays: readonly FakeRelayServer[],
  entries: readonly (string | [string, 'read' | 'write'])[],
  createdAt = 1_790_000_000
): Promise<NostrEvent> {
  const event = (await account.sign({
    kind: 10002,
    created_at: createdAt,
    tags: entries.map((entry) => (typeof entry === 'string' ? ['r', entry] : ['r', ...entry])),
    content: '',
  })) as unknown as NostrEvent;
  for (const relay of relays) store(relay, event);
  return event;
}
