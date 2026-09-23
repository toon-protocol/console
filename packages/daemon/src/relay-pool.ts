import WebSocket from 'ws';

import { isHiddenServiceUrl, type AnonCarriage } from './hidden-transport.js';
import { verifyEvent, type NostrEvent, type NostrFilter } from './nostr.js';

/**
 * Reading relays, one question at a time. **Reading, and nothing else.**
 *
 * A relay read is free — the spec prices a provider's routes, never a relay's
 * reads (§5) — so browsing the Provider Directory costs nothing, holds no
 * lease and opens no payment channel. That is why this module needs neither
 * keys nor money.
 *
 * There is no write half here, and there must never be one again. A write to a
 * TOON relay is a paid packet (ADR 0007) and goes through `relay-write.ts`,
 * which is the console's only writer (TOON_Network#120). What used to live
 * below this comment was a plain websocket `EVENT`, which a TOON relay answers
 * with `restricted: writes require ILP payment` and nothing else — a socket
 * this module opens is for asking, never for telling.
 *
 * Deliberately a QUERY and not a standing subscription. The console asks when
 * a person is looking: it opens a socket, sends one REQ, takes what the relay
 * already holds, and hangs up at EOSE. A long-lived subscription is the right
 * shape for a gateway that must react to a Takeover within seconds; it is the
 * wrong shape for a directory page, which would otherwise hold a socket open
 * against every relay in the network for as long as the console runs. The
 * liveness countdown a person watches ticks off the event's own `expiration`
 * (§4.3), so the page keeps ageing correctly with no socket at all.
 *
 * Several relays carry the same events, so duplicates are ordinary and
 * de-duplication is by event id. One relay being down is ordinary too: the
 * read reports which relays answered rather than failing, because a directory
 * assembled from two relays out of three is still a directory, and saying so
 * is more useful than an error page.
 */

/** A relay socket, reduced to what a query needs. Fakes implement this. */
export interface RelayConnection {
  send(message: string): void;
  close(): void;
}

export interface RelayHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
  onError(reason: string): void;
}

/** How a connection is made. Injected so a test can answer without a network. */
export type RelayDialer = (url: string, handlers: RelayHandlers) => RelayConnection;

export type RelayState =
  /** It answered everything it holds: an EOSE arrived. */
  | 'read'
  /** It was still answering when the deadline passed; what arrived is kept. */
  | 'timeout'
  /** It could not be reached, or it hung up before the EOSE. */
  | 'failed';

export interface RelayOutcome {
  readonly url: string;
  readonly state: RelayState;
  /** Events it sent that verified. */
  readonly events: number;
  readonly reason?: string;
}

export interface RelayReadResult {
  /** Every verified event, de-duplicated by id across relays. */
  readonly events: readonly NostrEvent[];
  readonly relays: readonly RelayOutcome[];
  /** Events a relay sent that were not the author's. Never silently zero. */
  readonly rejected: number;
}

export interface RelayQuery {
  readonly relays: readonly string[];
  readonly filters: readonly NostrFilter[];
  readonly dial?: RelayDialer;
  readonly timeoutMs?: number;
  /** A ceiling per relay, so one hostile relay cannot exhaust the daemon. */
  readonly maxEventsPerRelay?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_EVENTS = 5_000;

/** The default dialer: a plain `ws` client, one socket per relay per query. */
export const dialWebSocket: RelayDialer = (url, handlers) =>
  attach(new WebSocket(url, { handshakeTimeout: 5_000 }), handlers);

/**
 * The dialer for a relay set that may name a `.anyone` relay (spec §10).
 *
 * A Hidden Provider's own Relay Set is on the overlay — it reaches every relay
 * through `anon`, so the URLs its Profile publishes are `.anyone` ones — and a
 * console reading them has the same two choices this repository keeps making:
 * over a circuit, or not at all.
 *
 * NOT AT ALL IS NOT "FAILED TO CONNECT". `ws` would resolve the name first,
 * and a plaintext DNS query naming the hidden service is the fact the address
 * exists to withhold — so a `.anyone` relay with no carriage is refused BEFORE
 * the socket, and reported as a relay that did not answer. The directory reads
 * perfectly well from the relays that did: a provider's Profile is on the seed
 * relay or it is not purchasable at all (§4.2).
 */
export function hiddenAwareDialer(carriage: AnonCarriage | undefined): RelayDialer {
  return (url, handlers) => {
    if (!isHiddenServiceUrl(url)) return dialWebSocket(url, handlers);
    if (carriage === undefined) {
      // A microtask, not a synchronous call: the caller is still wiring up its
      // own state when `dial` returns.
      queueMicrotask(() => {
        handlers.onError(
          'this relay is a hidden service, and reaching one needs a running Anyone Protocol ' +
            'daemon to proxy through. Nothing was dialled: resolving the name here would put ' +
            'it in a plaintext DNS query (spec §10).'
        );
        handlers.onClose();
      });
      return { send: () => undefined, close: () => undefined };
    }
    return attach(carriage.createWebSocket(url) as WebSocket, handlers);
  };
}

/** The handlers, wired onto a `ws` socket however it was created. */
function attach(socket: WebSocket, handlers: RelayHandlers): RelayConnection {
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (raw) => handlers.onMessage(String(raw)));
  socket.on('error', (error: Error) => handlers.onError(error.message));
  socket.on('close', () => handlers.onClose());
  return {
    send: (message) => socket.send(message),
    close: () => {
      socket.close();
      socket.terminate();
    },
  };
}

let nextSubscriptionId = 0;

/**
 * Ask every relay in `relays` the same question, and stop at EOSE.
 *
 * Resolves when every relay has finished, failed, or run out of time —
 * never earlier, because a directory missing the one provider a slow relay
 * carries is worse than a page that took another second.
 */
export async function queryRelays(query: RelayQuery): Promise<RelayReadResult> {
  const urls = [...new Set(query.relays)].filter((url) => url.length > 0);
  if (urls.length === 0) return { events: [], relays: [], rejected: 0 };

  const dial = query.dial ?? dialWebSocket;
  const timeoutMs = query.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxEvents = query.maxEventsPerRelay ?? DEFAULT_MAX_EVENTS;
  const subscriptionId = `toon-console-${nextSubscriptionId++}`;
  const message = JSON.stringify(['REQ', subscriptionId, ...query.filters]);

  const byId = new Map<string, NostrEvent>();
  let rejected = 0;

  const keep = (value: unknown): boolean => {
    if (!verifyEvent(value)) {
      rejected += 1;
      return false;
    }
    if (byId.has(value.id)) return false;
    byId.set(value.id, value);
    return true;
  };

  const outcomes = await Promise.all(
    urls.map((url) =>
      readOne({ url, dial, timeoutMs, maxEvents, subscriptionId, message, keep })
    )
  );

  return { events: [...byId.values()], relays: outcomes, rejected };
}

interface OneRead {
  readonly url: string;
  readonly dial: RelayDialer;
  readonly timeoutMs: number;
  readonly maxEvents: number;
  readonly subscriptionId: string;
  readonly message: string;
  readonly keep: (value: unknown) => boolean;
}

function readOne(read: OneRead): Promise<RelayOutcome> {
  return new Promise<RelayOutcome>((resolve) => {
    let events = 0;
    let settled = false;
    let connection: RelayConnection | undefined;
    /** Set when a dialer reports `open` before it has returned its connection. */
    let openedEarly = false;

    const timer = setTimeout(
      () => finish('timeout', `no EOSE within ${read.timeoutMs} ms`),
      read.timeoutMs
    );
    timer.unref?.();

    const finish = (state: RelayState, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (state === 'read' || state === 'timeout') connection?.send(closeMessage(read));
      } catch {
        // The socket went away underneath us; nothing left to tidy.
      }
      try {
        connection?.close();
      } catch {
        // As above.
      }
      resolve({ url: read.url, state, events, ...(reason === undefined ? {} : { reason }) });
    };

    const request = () => {
      if (connection === undefined) {
        openedEarly = true;
        return;
      }
      try {
        connection.send(read.message);
      } catch (error) {
        finish('failed', error instanceof Error ? error.message : String(error));
      }
    };

    const handlers: RelayHandlers = {
      onOpen: request,
      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // Not our problem: a relay is allowed to be broken.
        }
        if (!Array.isArray(parsed)) return;
        const [verb, id, payload] = parsed as [unknown, unknown, unknown];
        if (id !== read.subscriptionId) return;
        if (verb === 'EVENT') {
          if (read.keep(payload)) events += 1;
          if (events >= read.maxEvents) finish('read', `stopped at ${read.maxEvents} events`);
          return;
        }
        if (verb === 'EOSE') finish('read');
        // A relay may refuse a subscription outright; its reason is the answer.
        if (verb === 'CLOSED')
          finish('failed', typeof payload === 'string' ? payload : 'refused');
      },
      onClose: () => finish('failed', 'the relay closed the connection'),
      onError: (reason) => finish('failed', reason),
    };

    try {
      connection = read.dial(read.url, handlers);
      if (openedEarly) request();
    } catch (error) {
      finish('failed', error instanceof Error ? error.message : String(error));
    }
  });
}

function closeMessage(read: OneRead): string {
  return JSON.stringify(['CLOSE', read.subscriptionId]);
}
