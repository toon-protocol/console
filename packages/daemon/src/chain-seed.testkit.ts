import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { eventMatchesFilter } from './directory.testkit.js';
import { isEventShape, tagValue, supersedes, type NostrEvent } from './nostr.js';
import type { RelayConnection, RelayDialer, RelayHandlers } from './relay-pool.js';
import {
  RelayWriteError,
  type RelayWriteReceipt,
  type RelayWriteTargets,
  type RelayWriter,
} from './relay-write.js';
import { LocalKeySigner, type AccountSigning } from './signer.js';

/**
 * A relay, for the tests of everything that reads one and everything that
 * writes to one.
 *
 * Two halves, and the split is the shape of the network rather than a
 * convenience. `fakeRelayNetwork` is the READ side: a socket that answers a
 * REQ, which is free and is all a relay's websocket does for a client.
 * `fakePaidWriter` is the WRITE side: a stand-in for the console's one writer,
 * which buys each write as a TOON packet (TOON_Network#120) — so a test drives
 * a refusal by refusing a PAYMENT, which is the only way a write is refused
 * now, and never by making a socket say `restricted`.
 *
 * Replaceable-event semantics are implemented for real (NIP-01: one event per
 * author, kind and `d`, later wins) so that a test can write twice and see
 * what a relay would actually then serve back.
 */

export interface FakeRelayServer {
  readonly url: string;
  events: NostrEvent[];
  /** Answer nothing at all: a relay that is not there. */
  down?: boolean;
}

export function fakeRelayServer(
  url: string,
  options: Partial<Omit<FakeRelayServer, 'url'>> = {}
): FakeRelayServer {
  return { url, events: [], ...options };
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
        // Anything but a REQ is ignored, because a TOON relay's socket is for
        // asking: a plain `EVENT` on it is refused `restricted: writes require
        // ILP payment`, and the console no longer sends one (#120).
      },
      close() {
        // Nothing to release: the fake holds no socket.
      },
    };
  };
}

/** NIP-01 replacement, as a relay applies it to the 10000 and 30000 ranges. */
export function store(relay: FakeRelayServer, event: NostrEvent): void {
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

/**
 * The console's writer, without a connector, a chain or a channel.
 *
 * It behaves like the real one in the two ways the modules above depend on:
 * a write that lands puts the event on the relay (so the next READ finds it,
 * which is what recovery means) and reports a cost, and a write that does not
 * land throws `RelayWriteError` and leaves the relay untouched.
 *
 * Refusals are set on the writer rather than on the relay, because that is
 * where they happen now: no channel, a rejected claim, a connector that would
 * not route. `cost` defaults to the devnet relay's own price for one write.
 */
export interface FakeWriter extends RelayWriter {
  /** Every event it was asked to write, in order. */
  readonly written: NostrEvent[];
  /** Refuse every write from now on, as the writer's own error. */
  refuse?: RelayWriteError;
  /** What a write costs, in base units. */
  cost: string;
  /** Turn the whole writer off: `targets()` says why, `write()` throws it. */
  blockedBy?: RelayWriteError;
}

export const FAKE_DESTINATION = 'g.toon.relay';
export const FAKE_PAY_AT = 'https://connector.test/ilp';

export function fakePaidWriter(
  relay: FakeRelayServer | undefined,
  options: { cost?: string } = {}
): FakeWriter {
  const writer: FakeWriter = {
    written: [],
    cost: options.cost ?? '1',
    targets(): Promise<RelayWriteTargets> {
      const blocked = writer.blockedBy ?? writer.refuse;
      if (relay === undefined || blocked !== undefined) {
        return Promise.resolve({
          relays: relay === undefined ? [] : [relay.url],
          plan:
            relay === undefined
              ? []
              : [
                  {
                    url: relay.url,
                    ready: false,
                    code: 'no_channel',
                    reason: blocked?.message ?? 'This network names no relay.',
                  },
                ],
          ready: false,
          blockedBy: blocked?.message ?? 'This network names no relay.',
        });
      }
      return Promise.resolve({
        relays: [relay.url],
        plan: [
          {
            url: relay.url,
            ready: true,
            destination: FAKE_DESTINATION,
            payAt: FAKE_PAY_AT,
            price: writer.cost,
            chain: 'evm:31337',
            channelId: '0xchannel',
            via: 'document',
          },
        ],
        destination: FAKE_DESTINATION,
        payAt: FAKE_PAY_AT,
        price: writer.cost,
        totalPrice: writer.cost,
        chain: 'evm:31337',
        channelId: '0xchannel',
        ready: true,
      });
    },
    write({ event, what }): Promise<RelayWriteReceipt> {
      const blocked = writer.blockedBy ?? writer.refuse;
      if (blocked !== undefined) return Promise.reject(blocked);
      if (relay === undefined || relay.down === true) {
        return Promise.reject(
          new RelayWriteError(
            'write_unconfirmed',
            `${what} was NOT written: no relay answered.`,
            504
          )
        );
      }
      if (!isEventShape(event)) {
        return Promise.reject(
          new RelayWriteError('invalid_event', 'That is not a signed Nostr event.', 400)
        );
      }
      writer.written.push(event);
      store(relay, event);
      return Promise.resolve({
        at: new Date(1_790_000_000_000).toISOString(),
        what,
        relays: [relay.url],
        destination: FAKE_DESTINATION,
        payAt: FAKE_PAY_AT,
        chain: 'evm:31337',
        channelId: '0xchannel',
        cost: writer.cost,
        writes: [
          {
            url: relay.url,
            destination: FAKE_DESTINATION,
            state: 'written',
            cost: writer.cost,
          },
        ],
      });
    },
  };
  return writer;
}

/** A writer with nothing to pay from: every write refused, nothing written. */
export function brokeWriter(relay?: FakeRelayServer): FakeWriter {
  const writer = fakePaidWriter(relay);
  writer.blockedBy = new RelayWriteError(
    'no_channel',
    'This account holds no payment channel with the connector at https://connector.test/ilp, ' +
      'so a write to this network’s relay cannot be paid for.',
    402
  );
  return writer;
}
