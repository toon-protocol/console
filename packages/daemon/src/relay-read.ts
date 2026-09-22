/**
 * Reading events off relays.
 *
 * A REQ, whatever comes back before EOSE or the deadline, and a CLOSE. That is
 * the whole of it, and it is written here rather than taken from a pool
 * library because the console's reads have a shape a pool does not: a fixed,
 * small filter, several relays raced for the NEWEST answer, and a hard
 * deadline, because a sign-in that hangs on an unreachable relay is a sign-in
 * that failed.
 *
 * Reads are free on every relay the console talks to, so nothing here pays and
 * nothing here signs. A relay that wants AUTH for a read is simply one that
 * answers nothing, and the caller falls back.
 *
 * The socket is injected. Not for purity — so that the tests can drive EOSE,
 * a garbage frame, a relay that never opens and a relay that closes mid-read
 * without a network or a `ws` dependency in the test tree.
 */

export interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly sig: string;
}

export interface RelayFilter {
  readonly kinds: readonly number[];
  readonly authors?: readonly string[];
  readonly limit?: number;
}

/** The slice of a WebSocket this module uses, and nothing more. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
}

export type SocketFactory = (url: string) => RelaySocket;

export function defaultSocketFactory(): SocketFactory {
  return (url) => new WebSocket(url) as unknown as RelaySocket;
}

export interface QueryOptions {
  readonly socketFactory?: SocketFactory;
  readonly timeoutMs?: number;
}

/**
 * Ask every relay at once and keep the newest event per author and kind.
 *
 * Racing rather than falling through: a stale kind-0 on a fast relay is worse
 * than a slow one that is current, and the only defence is to hear from all of
 * them and compare `created_at`. A relay that is down costs the deadline and
 * nothing else.
 */
export async function queryRelays(
  urls: readonly string[],
  filter: RelayFilter,
  options: QueryOptions = {}
): Promise<NostrEvent[]> {
  const factory = options.socketFactory ?? defaultSocketFactory();
  const timeoutMs = options.timeoutMs ?? 6_000;
  const results = await Promise.all(
    urls.map((url) =>
      queryOne(url, filter, factory, timeoutMs).catch(() => [] as NostrEvent[])
    )
  );

  const newest = new Map<string, NostrEvent>();
  for (const event of results.flat()) {
    const key = `${event.kind}:${event.pubkey}`;
    const held = newest.get(key);
    if (!held || event.created_at > held.created_at) newest.set(key, event);
  }
  return [...newest.values()];
}

function queryOne(
  url: string,
  filter: RelayFilter,
  factory: SocketFactory,
  timeoutMs: number
): Promise<NostrEvent[]> {
  return new Promise((done) => {
    const events: NostrEvent[] = [];
    const subscriptionId = `console-${Math.random().toString(36).slice(2, 10)}`;
    let socket: RelaySocket;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // A socket that never opened has nothing to close.
      }
      done(events);
    };

    const timer = setTimeout(finish, timeoutMs);

    try {
      socket = factory(url);
    } catch {
      clearTimeout(timer);
      done([]);
      return;
    }

    socket.onopen = () => {
      socket.send(JSON.stringify(['REQ', subscriptionId, filter]));
    };
    socket.onmessage = (message) => {
      const frame = parseFrame(message.data);
      if (!frame) return;
      if (frame[0] === 'EVENT' && frame[1] === subscriptionId && isEvent(frame[2])) {
        events.push(frame[2]);
        return;
      }
      // EOSE means the relay has sent everything it has stored. The console
      // never wants the live tail here, so that is the end of this relay.
      if (frame[0] === 'EOSE' && frame[1] === subscriptionId) {
        try {
          socket.send(JSON.stringify(['CLOSE', subscriptionId]));
        } catch {
          // Closing below regardless.
        }
        finish();
      }
    };
    socket.onerror = finish;
    socket.onclose = finish;
  });
}

function parseFrame(data: unknown): unknown[] | undefined {
  const text =
    typeof data === 'string' ? data : data instanceof Uint8Array ? decode(data) : undefined;
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function isEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NostrEvent>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.pubkey === 'string' &&
    typeof candidate.created_at === 'number' &&
    typeof candidate.kind === 'number' &&
    typeof candidate.content === 'string' &&
    Array.isArray(candidate.tags)
  );
}
