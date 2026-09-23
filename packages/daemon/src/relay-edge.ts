/**
 * Where a relay says its own writes are paid for (TOON_Network#121, spec §13).
 *
 * A TOON relay refuses every write that arrives on its websocket, and until
 * #121 it refused without saying where a write IS taken. So every party that
 * wrote had been told out of band and each had been told differently: the
 * provider's publisher by `RELAY_WRITE_ROUTES`, and this console by its OWN
 * connector's `GET /ilp` — which is the right answer only because the active
 * profile's connector happens to front the profile's relay. It is the right
 * answer by coincidence, and the coincidence is one relay wide.
 *
 * A relay now answers for itself. `GET` its URL with
 * `Accept: application/nostr+json` and it serves a NIP-11 relay information
 * document whose `toon` object names `ilp_address`, `connector_url`,
 * `connector_seal_key`, `carriage`, `price` and `settlement` — the first three
 * spelled exactly as a Provider Profile spells them (§4.1), because they are
 * the same three facts. This module reads that object, and this module is the
 * only place in the console that understands its wire shape.
 *
 * **What a relay's pin is worth, and what it is not worth (ADR 0024).** A
 * Provider Profile is a Nostr event signed by the provider's key, so its
 * `connector_seal_key` cannot be forged even by whoever controls the URL
 * beside it. A relay's document is an unsigned HTTP response: it is worth
 * exactly what the relay's URL is worth, which is the same URL the account's
 * records are read back from. That is enough — and it is why §13.2 says a
 * client that checks the document against the connector's own
 * self-description MUST refuse on a disagreement rather than let either side
 * win. `relay-write.ts` does that check and refuses; nothing here prefers one
 * statement over the other.
 *
 * **Everything is read, nothing is assumed.** A document that does not carry
 * all five normative fields yields no edge at all, and a reading that yields
 * no edge carries the sentence saying why — because "this relay got nothing"
 * is a thing a person has to be able to act on. There is no default address,
 * no default price and no default connector anywhere in here.
 *
 * @module
 */

import { normalizeRelayUrl } from './relay-list.js';

/** NIP-11's media type. Asking for it is what asks for the document. */
const NOSTR_JSON = 'application/nostr+json';

/**
 * The carriage a write route pins: which transport the packet must ride.
 *
 * `both`, or anything else meaning "either is fine", is NOT a carriage — §13.3
 * says a carriage that is not a pin is silence and a client MUST read it as
 * such. A value that IS a pin but names a transport this console cannot ride
 * is neither silence nor a pin it can honour, and `readRelayEdge` refuses the
 * relay rather than guessing which half of the document to believe.
 */
export type RelayCarriage = 'http' | 'btp';

/** One chain a relay's connector settles claims in, as §13.1 spells it. */
export interface RelayEdgeSettlement {
  /** `solana` or `evm:<chainId>`, verbatim. */
  readonly chain: string;
  /** The token's mint or contract address. */
  readonly token: string;
  readonly decimals: number;
}

/**
 * A relay's paid write edge: everything needed to buy one write to it.
 *
 * The field names are this console's (camelCase); the wire's are the spec's.
 * The translation happens once, here.
 */
export interface RelayWriteEdge {
  /** The ILP address a write to this relay is addressed to. */
  readonly ilpAddress: string;
  /**
   * The terminating connector's self-description URL, as that connector
   * advertises it. **A location hint only** — §13.1 says a client MUST NOT
   * derive any other URL from it, and nothing here does.
   */
  readonly connectorUrl: string;
  /** That connector's sealing public key. The pin a packet is sealed to. */
  readonly sealKey: string;
  /** Absent means the route pins none that the relay could learn of (§13.3). */
  readonly carriage?: RelayCarriage | undefined;
  /**
   * What one write costs, in the settlement token's base units, as the
   * document stated it. `'0'` is a value and means this relay charges nothing.
   *
   * A string because every other price in this console is one: they are
   * `bigint`-sized on the wire, and a number that silently loses precision is
   * worse than a string nobody can accidentally do arithmetic on.
   */
  readonly price: string;
  readonly settlement: readonly RelayEdgeSettlement[];
}

/**
 * What NIP-11 said about a relay, apart from its edge.
 *
 * Carried because it is what makes a refusal legible: a relay serving a
 * document with `payment_required: false` and no `toon` object is a relay
 * saying "I take no write on the websocket and cannot say where one is taken
 * instead" (§13.4), and a person reading "this relay got nothing" deserves to
 * be told that much rather than just "no edge".
 */
export interface RelayInfoView {
  readonly name?: string | undefined;
  readonly software?: string | undefined;
  readonly version?: string | undefined;
  readonly paymentRequired?: boolean | undefined;
  readonly restrictedWrites?: boolean | undefined;
}

/** A relay that named its edge. */
export interface RelayEdgeFound {
  readonly state: 'edge';
  /** The relay's websocket URL, normalized (`relay-list.ts`'s spelling). */
  readonly url: string;
  readonly edge: RelayWriteEdge;
  readonly info: RelayInfoView;
}

/** A relay that named no edge this console can buy a write on, and why. */
export interface RelayEdgeMissing {
  readonly state: 'none';
  readonly url: string;
  /**
   * Branch on this, never on the sentence.
   *
   * - `no_document` — nothing served the NIP-11 document: a non-JSON answer,
   *   an HTTP error, `426 Upgrade Required` from a relay that predates §13, a
   *   `nak serve` that never heard of it, or a host that did not answer.
   * - `no_edge` — a document, served honestly, with no `toon` object. The
   *   relay says it takes no websocket write and cannot say where one is
   *   taken instead (§13.2, §13.4).
   * - `bad_edge` — a `toon` object missing one of the five normative fields,
   *   or carrying one this console cannot read.
   * - `carriage_unsupported` — a pinned carriage that is neither `http` nor
   *   `btp`, so there is no transport here that could ride it.
   */
  readonly code: 'no_document' | 'no_edge' | 'bad_edge' | 'carriage_unsupported';
  /** One sentence, for the person who has to decide what to do about it. */
  readonly reason: string;
  readonly info?: RelayInfoView | undefined;
}

export type RelayEdgeReading = RelayEdgeFound | RelayEdgeMissing;

/**
 * The HTTP form of a relay's websocket URL.
 *
 * §13.1 puts the document "at the HTTP form of its own relay URL", which is
 * the same origin and the same path with the scheme swapped — `wss` to
 * `https`, `ws` to `http`. Nothing else about the URL is touched: a relay
 * served under a path serves its document under that path.
 */
export function relayHttpUrl(url: string): string | undefined {
  const relay = normalizeRelayUrl(url);
  if (relay === undefined) return undefined;
  const parsed = new URL(relay);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return parsed.toString();
}

/** The fetch seam, so every case below is testable without a relay. */
export type RelayEdgeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface RelayEdgeOptions {
  readonly fetch?: RelayEdgeFetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * How long a relay is given to serve its document.
 *
 * Short on purpose: this runs once per relay before a write, and a relay that
 * cannot answer a free GET in five seconds is not one this console is about to
 * buy a packet to. Slow is reported as `no_document` with the reason verbatim,
 * which is the truth — nothing was read — rather than a guess in either
 * direction.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Read one relay's write edge.
 *
 * Never throws. Every failure is a `none` reading with a code to branch on and
 * a sentence to show, because a relay this console could not read is a relay
 * an Account's record does not reach, and that has to be reportable rather
 * than thrown away.
 */
export async function readRelayEdge(
  url: string,
  options: RelayEdgeOptions = {}
): Promise<RelayEdgeReading> {
  const relay = normalizeRelayUrl(url);
  if (relay === undefined) {
    return {
      state: 'none',
      url: String(url),
      code: 'no_document',
      reason: `\`${String(url)}\` is not a relay URL, so there is nothing to ask.`,
    };
  }
  const httpUrl = relayHttpUrl(relay);
  if (httpUrl === undefined) {
    return {
      state: 'none',
      url: relay,
      code: 'no_document',
      reason: `${relay} has no HTTP form to ask for a relay information document at.`,
    };
  }

  const doFetch = options.fetch ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let body: string;
  try {
    const response = await doFetch(httpUrl, {
      headers: { accept: NOSTR_JSON },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        state: 'none',
        url: relay,
        code: 'no_document',
        reason:
          `${relay} answered HTTP ${response.status} to a request for its relay information ` +
          `document (${NOSTR_JSON}), so it does not say where a write to it is paid for. A ` +
          `relay that predates spec §13 answers \`426 Upgrade Required\` here.`,
      };
    }
    body = await response.text();
  } catch (error) {
    return {
      state: 'none',
      url: relay,
      code: 'no_document',
      reason:
        `${relay} did not serve a relay information document: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return {
      state: 'none',
      url: relay,
      code: 'no_document',
      reason:
        `${relay} answered a request for its relay information document with something that ` +
        `is not JSON, so nothing about its write edge could be read.`,
    };
  }
  return edgeFromDocument(relay, document);
}

/**
 * The document's `toon` object, narrowed to an edge — or the reason there is
 * not one.
 *
 * Pure, and the whole of §13.1's reading. Split out from the fetch so the
 * shapes a relay can serve are tested as data rather than over a socket.
 */
export function edgeFromDocument(relay: string, document: unknown): RelayEdgeReading {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return {
      state: 'none',
      url: relay,
      code: 'no_document',
      reason: `${relay}'s relay information document is not a JSON object.`,
    };
  }
  const info = infoOf(document as Record<string, unknown>);
  const toon = (document as Record<string, unknown>)['toon'];
  if (toon === undefined || toon === null) {
    return {
      state: 'none',
      url: relay,
      code: 'no_edge',
      reason:
        `${relay} serves a relay information document that names no \`toon\` write edge, so ` +
        `it does not say where a write to it is paid for. That is a relay saying it takes no ` +
        `write on its websocket and cannot say where one is taken instead (spec §13.4) — ask ` +
        `its operator.`,
      info,
    };
  }
  if (typeof toon !== 'object' || Array.isArray(toon)) {
    return {
      state: 'none',
      url: relay,
      code: 'bad_edge',
      reason: `${relay}'s relay information document carries a \`toon\` that is not an object.`,
      info,
    };
  }

  const fields = toon as Record<string, unknown>;
  const ilpAddress = fields['ilp_address'];
  const connectorUrl = fields['connector_url'];
  const sealKey = fields['connector_seal_key'];
  const missing = [
    typeof ilpAddress === 'string' && ilpAddress.length > 0 ? [] : ['ilp_address'],
    typeof connectorUrl === 'string' && connectorUrl.length > 0 ? [] : ['connector_url'],
    typeof sealKey === 'string' && sealKey.length > 0 ? [] : ['connector_seal_key'],
  ].flat();
  const price = priceOf(fields['price']);
  if (price === undefined) missing.push('price');
  const settlement = settlementOf(fields['settlement']);
  if (settlement === undefined) missing.push('settlement');
  if (missing.length > 0 || price === undefined || settlement === undefined) {
    return {
      state: 'none',
      url: relay,
      code: 'bad_edge',
      reason:
        `${relay}'s write edge is missing ${missing.join(', ')}. Spec §13.1 makes ` +
        `\`ilp_address\`, \`connector_url\`, \`connector_seal_key\`, \`price\` and ` +
        `\`settlement\` normative, and an edge short of one of them is not one this console ` +
        `will spend money on.`,
      info,
    };
  }

  const carriage = carriageOf(fields['carriage']);
  if (carriage === 'unsupported') {
    return {
      state: 'none',
      url: relay,
      code: 'carriage_unsupported',
      reason:
        `${relay} pins its write route to the \`${String(fields['carriage'])}\` carriage, ` +
        `and this console rides \`http\` and \`btp\`. There is no transport here that could ` +
        `carry a packet to it.`,
      info,
    };
  }

  return {
    state: 'edge',
    url: relay,
    edge: {
      ilpAddress: ilpAddress as string,
      connectorUrl: connectorUrl as string,
      sealKey: sealKey as string,
      ...(carriage === undefined ? {} : { carriage }),
      price,
      settlement,
    },
    info,
  };
}

/**
 * `price` as this console carries prices: base units, as a string.
 *
 * §13.1 types it as an integer. A float, a negative, a `NaN` or a string is
 * not one, and none of them is repaired into one — a price this console had to
 * guess at is a price it will not pay. A numeric string IS accepted, because
 * a `bigint`-sized price is routinely serialized as one and the connector's
 * own self-description already publishes prices that way.
 */
function priceOf(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  return undefined;
}

function settlementOf(value: unknown): readonly RelayEdgeSettlement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const settlements: RelayEdgeSettlement[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { chain, token, decimals } = entry as Record<string, unknown>;
    if (typeof chain !== 'string' || chain.length === 0) continue;
    if (typeof token !== 'string') continue;
    if (typeof decimals !== 'number') continue;
    settlements.push({ chain, token, decimals });
  }
  return settlements.length > 0 ? settlements : undefined;
}

/**
 * `carriage`, read as §13.3 says to read it.
 *
 * `undefined` is silence and so is `both` or any other "either is fine" — a
 * carriage that is not a pin is silence, and a client MUST read it as such.
 * A pin naming a transport this console has no carriage for comes back as
 * `'unsupported'`, which is neither silence nor something to honour.
 */
function carriageOf(value: unknown): RelayCarriage | 'unsupported' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'http' || value === 'btp') return value;
  if (value === 'both' || value === 'any' || value === '') return undefined;
  return 'unsupported';
}

function infoOf(document: Record<string, unknown>): RelayInfoView {
  const limitation = document['limitation'];
  const limits =
    typeof limitation === 'object' && limitation !== null
      ? (limitation as Record<string, unknown>)
      : {};
  const name = document['name'];
  const software = document['software'];
  const version = document['version'];
  return {
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof software === 'string' ? { software } : {}),
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof limits['payment_required'] === 'boolean'
      ? { paymentRequired: limits['payment_required'] }
      : {}),
    ...(typeof limits['restricted_writes'] === 'boolean'
      ? { restrictedWrites: limits['restricted_writes'] }
      : {}),
  };
}

const defaultFetch: RelayEdgeFetch = (url, init) =>
  fetch(url, { method: 'GET', headers: init.headers, signal: init.signal });

/* -------------------------------------------------------------------------- */
/* Reading them once per session, not once per write                          */
/* -------------------------------------------------------------------------- */

/**
 * A relay's edge, remembered for as long as it is worth remembering.
 *
 * A publish writes to every relay in an Account's NIP-65 write list, and a
 * session publishes a Chain Seed, a relay list and a vault record per lease.
 * Re-reading every relay's document before every packet would be a free GET
 * per relay per write — cheap, but it is a request a relay operator sees and
 * a round trip a person waits through, for a document that changes when a
 * connector is repriced and not otherwise.
 *
 * A failed reading is cached too, and for less time: the ordinary reason a
 * document is missing is a relay that predates spec §13, which will not start
 * serving one in the next minute — but a relay that was merely unreachable
 * should be asked again soon.
 */
export class RelayEdgeReader {
  readonly #options: RelayEdgeOptions;
  readonly #okMs: number;
  readonly #missMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; reading: RelayEdgeReading }>();

  constructor(
    options: RelayEdgeOptions & {
      okMs?: number | undefined;
      missMs?: number | undefined;
      now?: (() => number) | undefined;
    } = {}
  ) {
    this.#options = options;
    this.#okMs = options.okMs ?? 300_000;
    this.#missMs = options.missMs ?? 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  async read(url: string): Promise<RelayEdgeReading> {
    const key = normalizeRelayUrl(url) ?? url;
    const held = this.#cache.get(key);
    const now = this.#now();
    if (held !== undefined) {
      const ttl = held.reading.state === 'edge' ? this.#okMs : this.#missMs;
      if (now - held.at < ttl) return held.reading;
    }
    const reading = await readRelayEdge(url, this.#options);
    this.#cache.set(key, { at: now, reading });
    return reading;
  }

  /** Forget everything, so the next read asks again. For a profile switch. */
  forget(): void {
    this.#cache.clear();
  }
}
