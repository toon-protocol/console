import WebSocket from 'ws';

import { verifyEvent, type NostrEvent, type NostrFilter } from './nostr.js';

/**
 * Reading relays, one question at a time.
 *
 * A relay read is free — the spec prices a provider's routes, never a relay's
 * reads (§5) — so browsing the Provider Directory costs nothing, holds no
 * lease and opens no payment channel. That is why this ticket needs neither
 * keys nor money.
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
export const dialWebSocket: RelayDialer = (url, handlers) => {
  const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
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
};

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

/**
 * Writing: the other half, added for the Chain Seed (TOON_Network#89).
 *
 * Reading the Provider Directory needed none of this — a tenant signs no event
 * of the protocol (ADR 0016) — but an account's OWN records do get published:
 * its Chain Seed (ADR 0020), its Lease Vault (ADR 0021) and, when it has none,
 * its NIP-65 list. All three go to the account's own relays, which is why this
 * lives beside the read rather than in the module that owns any one of them.
 *
 * What a caller needs back is not "did it work" but WHICH relay said WHAT, and
 * the reason is money. The TOON relay refuses a plain websocket write with
 * `restricted: writes require ILP payment` — its writes are 1 µUSDC, paid
 * through a channel the console may not have opened yet. "Published to one of
 * two relays" and "refused by the only relay there was" have to be different
 * answers, and the second has to carry the relay's own words, because the way
 * out of it depends on which refusal it was.
 */

export type PublishState =
  /** The relay answered `OK … true`. It holds the event. */
  | 'accepted'
  /** The relay answered `OK … false`. It said why, and it meant it. */
  | 'rejected'
  /** No answer inside the deadline. It may or may not hold the event. */
  | 'timeout'
  /** It could not be reached, or hung up before answering. */
  | 'failed';

export interface PublishOutcome {
  readonly url: string;
  readonly state: PublishState;
  /** The relay's own message, verbatim, when it sent one. */
  readonly reason?: string;
  /**
   * NIP-01's machine-readable prefix on a refusal — `restricted`, `blocked`,
   * `rate-limited`, `invalid`, `pow`, `duplicate`, `error` — when there is one.
   */
  readonly code?: string;
}

export interface PublishResult {
  readonly relays: readonly PublishOutcome[];
  /** The relays that now hold the event. Empty means nothing was persisted. */
  readonly accepted: readonly string[];
}

export interface PublishRequest {
  /** A signed event, as NIP-01 puts one on the wire. */
  readonly event: unknown;
  readonly relays: readonly string[];
  readonly dial?: RelayDialer;
  readonly timeoutMs?: number;
}

/** A `duplicate:` refusal is the relay saying it already has it. */
export function isPersisted(outcome: PublishOutcome): boolean {
  return outcome.state === 'accepted' || outcome.code === 'duplicate';
}

export async function publishToRelays(request: PublishRequest): Promise<PublishResult> {
  const urls = [...new Set(request.relays)].filter((url) => url.length > 0);
  if (urls.length === 0) return { relays: [], accepted: [] };

  const dial = request.dial ?? dialWebSocket;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const eventId = (request.event as { id?: unknown }).id;
  const message = JSON.stringify(['EVENT', request.event]);

  const outcomes = await Promise.all(
    urls.map((url) => publishOne({ url, dial, timeoutMs, message, eventId }))
  );
  return {
    relays: outcomes,
    accepted: outcomes.filter(isPersisted).map((outcome) => outcome.url),
  };
}

interface OneWrite {
  readonly url: string;
  readonly dial: RelayDialer;
  readonly timeoutMs: number;
  readonly message: string;
  readonly eventId: unknown;
}

function publishOne(write: OneWrite): Promise<PublishOutcome> {
  return new Promise<PublishOutcome>((resolve) => {
    let settled = false;
    let connection: RelayConnection | undefined;
    let openedEarly = false;

    const timer = setTimeout(
      () => finish({ state: 'timeout', reason: `no OK within ${write.timeoutMs} ms` }),
      write.timeoutMs
    );
    timer.unref?.();

    const finish = (outcome: Omit<PublishOutcome, 'url'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        connection?.close();
      } catch {
        // The socket went away underneath us; nothing left to tidy.
      }
      resolve({ url: write.url, ...outcome });
    };

    const send = () => {
      if (connection === undefined) {
        openedEarly = true;
        return;
      }
      try {
        connection.send(write.message);
      } catch (error) {
        finish({ state: 'failed', reason: errorText(error) });
      }
    };

    const handlers: RelayHandlers = {
      onOpen: send,
      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;
        const [verb, id, accepted, reason] = parsed as [unknown, unknown, unknown, unknown];
        if (verb !== 'OK' || id !== write.eventId) return;
        const text = typeof reason === 'string' ? reason : undefined;
        finish({
          state: accepted === true ? 'accepted' : 'rejected',
          ...(text === undefined ? {} : { reason: text }),
          ...(text === undefined ? {} : optionalCode(text)),
        });
      },
      // A relay that hangs up without an OK has told us nothing, and a caller
      // that treated silence as success would report a seed as persisted that
      // is not.
      onClose: () => finish({ state: 'failed', reason: 'the relay closed the connection' }),
      onError: (reason) => finish({ state: 'failed', reason }),
    };

    try {
      connection = write.dial(write.url, handlers);
      if (openedEarly) send();
    } catch (error) {
      finish({ state: 'failed', reason: errorText(error) });
    }
  });
}

/** NIP-01's `<machine-readable-prefix>: <human-readable>`, when it is one. */
function optionalCode(reason: string): { code?: string } {
  const prefix = /^([a-z-]+):/u.exec(reason)?.[1];
  return prefix === undefined ? {} : { code: prefix };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
