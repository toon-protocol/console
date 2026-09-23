import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * **Reaching a Hidden Provider** (TOON_Network#98, spec §10, ADR 0008).
 *
 * A Hidden Provider publishes no host. Its connector is one `.anyone` address
 * and every lease it sells is another, and the only way to a `.anyone` address
 * is a circuit built by a running Anyone Protocol `anon` daemon. This module
 * is the console's one door onto that daemon: who may open it, what rides it,
 * and — the part that matters most — what happens when it will not open.
 *
 * **There is no fallback, ever.** Every other unreachable endpoint in this
 * console degrades into a view that says so and carries on. This one refuses.
 * A console that could not build a circuit and dialled something directly
 * instead would be reaching the provider from this machine's real address, at
 * an address somebody went to considerable trouble to keep off the wire — and
 * a Hidden Provider's Profile may still carry a leaked `host` (§4.1 forbids
 * it; nothing enforces it), so "fall back to the direct route" is a sentence
 * that can be written here and must not be. A silent fallback is a
 * deanonymisation, not a convenience. `HiddenTransportError` is what a caller
 * gets instead, and its message says what to start.
 *
 * **The carriage is three objects, not one, and the trap is which one wins.**
 * `@toon-protocol/client`'s `hidden-service` entry builds a SOCKS5h-bound
 * `fetch` (the client edge and, through undici's dispatcher, chain RPC) and a
 * SOCKS5h-bound websocket factory (the BTP carriage), because those are three
 * different holes in Node and no single object plugs them. The client wires
 * all three itself when it is handed `socksProxy` — but it wires them with
 * `config.fetch ?? transport.fetch`, so **an injected `fetch` or
 * `createWebSocket` beats the proxy silently**. That is the same trap the
 * provider's publisher refuses at startup (`tools/publisher/proxy.mjs`,
 * `transportRefusal`): there a BTP carriage bypassed a `fetch`-installed proxy
 * and a "hidden" publisher reached the connector from its real address while
 * every log line said it was proxied. {@link carriageRefusal} is this
 * console's standing version of that refusal.
 *
 * **Where the proxy comes from.** `TOON_CONSOLE_SOCKS_PROXY`, and nothing
 * else. Not a constant in this repository — a SOCKS port is this machine's
 * fact, not the network's — and not a daemon this console starts: the client
 * ships one that can start `anon` for you but exports it from no public
 * subpath, so the console names what it needs rather than spawning a process
 * it cannot supervise.
 */

/** The three shapes of one proxy that this console actually hands out. */
export interface AnonCarriage {
  /** The `socks5h://` URL every one of these is bound to. */
  readonly socksProxy: string;
  /** `fetch`, bound to the proxy. For a `.anyone` client edge. */
  readonly fetch: typeof fetch;
  /** A `ws` factory bound to the proxy, for a `.anyone` relay or BTP. */
  readonly createWebSocket: (url: string) => unknown;
}

/** Why no circuit was built. Never "so it went direct instead". */
export class HiddenTransportError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = 'HiddenTransportError';
    this.code = code;
    this.status = status;
  }
}

/** What the health view says about the anon carriage. */
export interface AnonTransportView {
  readonly state: 'unconfigured' | 'ready' | 'unreachable' | 'misconfigured';
  /** Present once one is configured. It is a loopback port, not a secret. */
  readonly socksProxy?: string | undefined;
  readonly reason: string;
}

export interface HiddenTransportPort {
  /** The configured proxy, or `undefined`. Reading it opens nothing. */
  configured(): string | undefined;
  /**
   * The carriage.
   *
   * @throws {HiddenTransportError} when none is configured, when the URL is
   *   not `socks5h://`, or when nothing is listening on it. A caller that
   *   catches this must report it, never route around it.
   */
  open(): Promise<AnonCarriage>;
  /** For the health view: the same question, answered instead of thrown. */
  describe(): Promise<AnonTransportView>;
  close(): Promise<void>;
}

/** What the client's `hidden-service` entry gives us, as this module uses it. */
interface HiddenServiceModule {
  createHiddenServiceTransport(
    socksProxy: string,
    options?: { connectTimeoutMs?: number }
  ): {
    fetch: typeof fetch;
    createWebSocket: (url: string) => unknown;
    dispatcher: unknown;
    close(): Promise<void>;
  };
  probeSocks5Proxy(socksProxy: string, timeoutMs?: number): Promise<void>;
  validateSocks5hUrl(socksProxy: string): { host: string; port: number };
}

export interface AnonTransportDeps {
  /** Read each time, so a daemon restarted with a proxy picks it up. */
  readonly socksProxy: () => string | undefined;
  /** Injected for the tests, which must never dial a SOCKS port. */
  readonly load?: (() => Promise<HiddenServiceModule>) | undefined;
}

/**
 * The one carriage, built once and shared.
 *
 * Built once because a dispatcher holds a connection pool and a websocket
 * agent holds sockets, and a console that built a new one per packet would
 * leave a circuit's worth of state behind on every spawn. Re-probed whenever
 * the last attempt failed, because "the daemon was not running two minutes
 * ago" is not a reason to refuse for the rest of the session.
 */
export class AnonTransport implements HiddenTransportPort {
  readonly #deps: AnonTransportDeps;
  #open: { proxy: string; carriage: AnonCarriage; close: () => Promise<void> } | undefined;
  #opening: Promise<AnonCarriage> | undefined;

  constructor(deps: AnonTransportDeps) {
    this.#deps = deps;
  }

  configured(): string | undefined {
    const value = this.#deps.socksProxy()?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  async open(): Promise<AnonCarriage> {
    const proxy = this.configured();
    if (proxy === undefined) {
      throw new HiddenTransportError(
        'no_anon_proxy',
        'This is a Hidden Provider, so it is reachable only over an Anyone Protocol circuit, ' +
          'and this console has no SOCKS proxy to build one through. Start an `anon` daemon ' +
          'and set TOON_CONSOLE_SOCKS_PROXY to its SOCKS port (e.g. ' +
          'socks5h://127.0.0.1:9050). Nothing was dialled: a console that reached this ' +
          "provider directly would be reaching it from this machine's own address, which is " +
          'the one thing it is hiding (spec §10, ADR 0008).'
      );
    }
    if (this.#open?.proxy === proxy) return this.#open.carriage;
    // A proxy that changed under us: drop the old pool before building another.
    if (this.#open !== undefined) await this.close();
    this.#opening ??= this.#build(proxy).finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  async describe(): Promise<AnonTransportView> {
    const proxy = this.configured();
    if (proxy === undefined) {
      return {
        state: 'unconfigured',
        reason:
          'No SOCKS proxy is set, so this console cannot reach a Hidden Provider. Set ' +
          "TOON_CONSOLE_SOCKS_PROXY to a running `anon` daemon's SOCKS port. Everything " +
          'else works without one.',
      };
    }
    try {
      await this.open();
      return {
        state: 'ready',
        socksProxy: proxy,
        reason: `A SOCKS5h proxy answered at ${proxy}, so a \`.anyone\` address can be dialled.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        state:
          error instanceof HiddenTransportError && error.code === 'bad_anon_proxy'
            ? 'misconfigured'
            : 'unreachable',
        socksProxy: proxy,
        reason: message,
      };
    }
  }

  async close(): Promise<void> {
    const held = this.#open;
    this.#open = undefined;
    await held?.close().catch(() => undefined);
  }

  async #build(proxy: string): Promise<AnonCarriage> {
    const module = await (this.#deps.load ?? loadHiddenService)();
    try {
      module.validateSocks5hUrl(proxy);
    } catch (error) {
      throw new HiddenTransportError(
        'bad_anon_proxy',
        `TOON_CONSOLE_SOCKS_PROXY is not usable: ${messageOf(error)}`,
        500
      );
    }
    // Fail EARLY and fail CLOSED. Finding out at packet time costs a signed
    // claim, and a paid route bills for a refusal (ADR 0003).
    try {
      await module.probeSocks5Proxy(proxy);
    } catch (error) {
      throw new HiddenTransportError(
        'anon_unreachable',
        `Nothing is listening on ${proxy}, so no circuit can be built and nothing was sent: ` +
          `${messageOf(error)} Start the Anyone Protocol \`anon\` daemon whose SOCKS port ` +
          `that is. This console will not dial a Hidden Provider any other way (spec §10, ` +
          `ADR 0008).`
      );
    }
    let built;
    try {
      built = module.createHiddenServiceTransport(proxy);
    } catch (error) {
      throw new HiddenTransportError(
        'anon_unavailable',
        `The hidden-service carriage could not be built: ${messageOf(error)}`,
        500
      );
    }
    const carriage: AnonCarriage = {
      socksProxy: proxy,
      fetch: built.fetch,
      createWebSocket: built.createWebSocket,
    };
    this.#open = { proxy, carriage, close: () => built.close() };
    return carriage;
  }
}

/** The default loader. Dynamic: a console that never touches `.anyone` never pays for it. */
async function loadHiddenService(): Promise<HiddenServiceModule> {
  try {
    return (await import('@toon-protocol/client/hidden-service')) as HiddenServiceModule;
  } catch (error) {
    throw new HiddenTransportError(
      'anon_unavailable',
      `This build cannot reach a hidden service: ${messageOf(error)} The carriage needs the ` +
        `client's optional \`undici\` and \`socks\` dependencies.`,
      500
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The rules, all pure                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A `.anyone` address: reachable over a circuit or not at all (spec §10).
 *
 * `.anyone` and nothing else. `anon` routes that TLD alone — a `.anon` or
 * `.onion` name is treated as clearnet and fails late and cryptically — so a
 * name that is not this shape is a clearnet name and must be dialled as one.
 */
export function isHiddenServiceUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.anyone');
  } catch {
    return false;
  }
}

/**
 * The refusal that keeps the carriage from being bypassed.
 *
 * Ported, decision for decision, from the provider publisher's
 * `transportRefusal` (`tools/publisher/proxy.mjs`). There the lesson was a BTP
 * websocket that never passed through the `fetch` the proxy had been installed
 * as; here the client wires the websocket itself, so the hole is the other
 * one — `@toon-protocol/client` resolves `config.fetch ?? transport.fetch` and
 * `config.createWebSocket ?? transport.createWebSocket`, so anything this
 * console injects WINS and the circuit is silently not used.
 *
 * Both of those are injected for tests and for odd runtimes. Neither may ever
 * be injected beside a `socksProxy`, and this says so out loud rather than
 * leaving it to whoever adds the next injection point.
 *
 * @returns the reason to refuse, or `null` to proceed.
 */
export function carriageRefusal(input: {
  socksProxy?: string | undefined;
  fetch?: unknown;
  createWebSocket?: unknown;
}): string | null {
  if (input.socksProxy === undefined) return null;
  if (input.fetch !== undefined) {
    return (
      'A hidden-service packet must not be sent with an injected `fetch`: the client resolves ' +
      '`config.fetch ?? transport.fetch`, so the injected one wins and every request leaves ' +
      "this machine's own address while the proxy sits unused (spec §10, ADR 0008)."
    );
  }
  if (input.createWebSocket !== undefined) {
    return (
      'A hidden-service packet must not be sent with an injected `createWebSocket`: the BTP ' +
      'carriage is a websocket, the client resolves `config.createWebSocket ?? ' +
      "transport.createWebSocket`, and the injected one would dial from this machine's own " +
      'address (spec §10, ADR 0008).'
    );
  }
  return null;
}

/** Loopback, an RFC 1918 or link-local range, a ULA, or the unspecified address. */
export function isPrivateAddress(ip: string): boolean {
  const address = String(ip).replace(/^\[|\]$/gu, '');
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(address)) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (a === undefined || b === undefined) return false;
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = address.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(v6);
  if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1]);
  return /^f[cd][0-9a-f]{0,2}:/u.test(v6) || /^fe[89ab][0-9a-f]?:/u.test(v6);
}

/**
 * Whether reaching `url` takes no packet off this host or its own private
 * network — the same rule, and the same reason, as the provider publisher's
 * `isNearUrl`.
 *
 * It decides ONE thing: whether the chain RPC rides the circuit beside the
 * packets. It must, when it is a public endpoint — a console that paid a
 * hidden connector over a circuit while reading its channel on clearnet would
 * broadcast the payer's settlement address from this machine's own IP, timed
 * either side of every paid request (toon-client ADR 0002, ADR 0008's third
 * leg). It must NOT when the endpoint is already private, because `anon`
 * builds no circuit to a loopback or RFC 1918 address: proxying it would fail
 * rather than hide anything, since the packet never crosses a network anybody
 * outside can watch. The local sandbox's chains are exactly that case.
 *
 * A name that does not resolve is not near. The safe way to be wrong about a
 * host is to proxy it.
 */
export async function isNearUrl(
  url: string,
  lookup: typeof dnsLookup = dnsLookup
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  if (host.toLowerCase() === 'localhost') return true;
  if (/^[\d.]+$/u.test(host) || host.includes(':')) return isPrivateAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((entry) => isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/**
 * Does the chain RPC ride the circuit? `proxyRpc`, as the client spells it.
 *
 * `true` for anything that leaves this host, `false` for an endpoint `anon`
 * could not reach anyway. See {@link isNearUrl} for why that is the whole of
 * the rule.
 */
export async function proxyRpcFor(
  rpcUrl: string,
  lookup: typeof dnsLookup = dnsLookup
): Promise<boolean> {
  return !(await isNearUrl(rpcUrl, lookup));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
