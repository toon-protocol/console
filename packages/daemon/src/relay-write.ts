import type { ChannelStore } from '@toon-protocol/client';

import { channelAvailable, channelStoreFor, findChannelBinding } from './channel-store.js';
import type { PayerKeys } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { resolveRpc } from './funding.js';
import { verifyEvent } from './nostr.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
import {
  RelayEdgeReader,
  type RelayCarriage,
  type RelayEdgeReading,
  type RelayWriteEdge,
} from './relay-edge.js';
import { normalizeRelayUrl } from './relay-list.js';

/**
 * **The one writer.** Every event this console puts on a relay is bought here,
 * as a sealed TOON packet paid from the account's own payment channel
 * (TOON_Network#120).
 *
 * The rule it exists to enforce is the network's, not the console's: a relay
 * write on TOON Network is a PAID packet (ADR 0007), and a TOON relay answers
 * a plain websocket `EVENT` with `restricted: writes require ILP payment` and
 * nothing else. The provider's `tools/publisher` has always written its
 * Profile, its Listings and its Liveness this way; until #120 the console was
 * the one party in the fleet that did not, and #89 and #92 both ended up
 * asking for "a free relay" that no TOON network provides. The plain-websocket
 * write half is gone from `relay-pool.ts`, which now reads and only reads.
 *
 * **Paying is not optional in here.** There is no unpaid branch, no fallback
 * socket and no flag that turns one on. A caller either gets a receipt naming
 * what the write cost, or a refusal saying why nothing was written.
 *
 * **It writes to every relay the Account named that it can pay
 * (TOON_Network#121).** #120 wrote to exactly one relay — the profile's, the
 * only one its own connector could buy a packet to — so an Account's Chain
 * Seed and its Lease Vault reached one relay of its NIP-65 write list and
 * "recoverable anywhere" (ADR 0021) rested on that relay keeping them. A relay
 * now names its own paid write edge in its own NIP-11 document (spec §13,
 * ADR 0024), so a relay this console merely holds the URL of can be paid. The
 * write set is the profile's relay plus the Account's NIP-65 write list; every
 * relay in it is planned separately, and the ones that cannot be paid are
 * REPORTED rather than dropped.
 *
 * Five facts shape the rest of it.
 *
 * **Where a write goes is read, never assumed.** Each relay's destination,
 * price, carriage and sealing key come from that relay's own document, and the
 * profile's relay may fall back to #120's reading of this console's own
 * connector. There is no ILP address, price or relay constant in this
 * repository, exactly as there is no chain id in `profiles.ts`
 * (TOON_Network#87).
 *
 * **The connector's price is the price (TOON_Network#82).** Nothing here
 * multiplies, rounds or recomputes one: `send` carries no `amount`, so the
 * client pays what the route quoted, and what comes back on the claim is what
 * this reports as the cost. A per-relay figure is reported per relay and the
 * total is their sum — never a price times a relay count.
 *
 * **A refused paid request is still billed (ADR 0003, TOON_Network#115).** So
 * everything checkable is checked before a packet leaves: the event is
 * re-hashed and its signature re-verified once, here, before ANY relay is
 * paid — a bad event would otherwise be billed for once per relay.
 *
 * **It never opens a channel.** `autoOpenChannel: false` in the live port, and
 * a relay with no channel behind its connector is reported as one this console
 * could not pay — never as a reason to lock collateral on chain and pay gas
 * because somebody pressed "save".
 *
 * **A record that reaches one relay is published; one that reaches none is a
 * refusal.** That rule is #89's and #120's and it does not move: a partial
 * write returns a receipt naming every relay it reached, every relay it did
 * not, and what each cost. A write that reached nothing throws, and nothing is
 * cached as published.
 */

/* -------------------------------------------------------------------------- */
/* The packet port                                                            */
/* -------------------------------------------------------------------------- */

/** One paid write, as the port needs it sent. */
export interface RelayWritePacket {
  /** The connector edge whose channel pays for this packet. */
  readonly payAt: string;
  /** The paid ILP destination. */
  readonly destination: string;
  /**
   * The key to seal the payload to, when {@link payAt} does not TERMINATE
   * {@link destination} but forwards it.
   *
   * A payload must be sealed to the connector that terminates it and no hop
   * may name that key on its behalf. Until #121 there was never one to name:
   * the destination was always an address this console's own connector
   * answered for, so there was no hop to seal past. A relay's own document now
   * pins its terminating connector's key (spec §13.1, ADR 0024), which is the
   * missing half — and it is a weaker pin than a Provider Profile's, because
   * a relay's document is signed by nothing. Absent means the destination
   * terminates at `payAt` and there is nothing to seal past.
   */
  readonly sealTo?: string | undefined;
  /**
   * The carriage the relay says its write route pins, when it says one.
   *
   * Absent means no pin was read, and the port falls back to the carriage
   * this console has always used. See `relay-write-route.ts`.
   */
  readonly carriage?: RelayCarriage | undefined;
  /** The signed event, already verified. It travels as `{ event }`. */
  readonly event: unknown;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly keys: PayerKeys;
  readonly channelStore: ChannelStore;
  readonly timeoutMs?: number | undefined;
}

/**
 * What came back, in the three kinds a caller must tell apart.
 *
 * The same three as a spawn's (`lease.ts`), and for the same reason: `answered`
 * and `refused` are DEFINITIVE, and `unknown` is a packet whose fate nobody
 * reported. A record whose write is `unknown` must not be called published and
 * must not be called lost either.
 */
export type RelayPacketOutcome =
  | {
      readonly kind: 'answered';
      /** The RELAY app's own HTTP status. A 422 is a paid-for refusal. */
      readonly status: number;
      readonly text: string;
      readonly cost?: string | undefined;
      readonly channelId?: string | undefined;
    }
  | {
      readonly kind: 'refused';
      readonly code: string;
      readonly refusedBy: 'destination' | 'path' | 'edge';
      readonly message: string;
      readonly cost?: string | undefined;
    }
  | { readonly kind: 'unknown'; readonly message: string };

export interface RelayWritePort {
  send(packet: RelayWritePacket): Promise<RelayPacketOutcome>;
}

/* -------------------------------------------------------------------------- */
/* What a caller sees                                                         */
/* -------------------------------------------------------------------------- */

export type RelayWriteState =
  /** The relay took it and said so. */
  | 'written'
  /** A connector or the relay refused it. It may still have been billed. */
  | 'refused'
  /** Nobody reported this packet's fate. It may or may not have landed. */
  | 'unknown'
  /**
   * No packet was ever sent to this relay, and nothing was billed for it.
   *
   * Kept apart from `refused` because the two call for different things: a
   * refusal is a relay or a connector saying no to a packet that cost money,
   * and this is the console saying it never found a way to buy one. #121's
   * whole report is this state carrying a reason (spec §13).
   */
  | 'unpayable';

export interface RelayWriteOutcome {
  readonly url: string;
  /** The paid route this write was bought on. Absent on an unpayable relay. */
  readonly destination?: string | undefined;
  /** The connector edge the packet was paid at. */
  readonly payAt?: string | undefined;
  /** What the route quoted, before it was bought. Never recomputed (#82). */
  readonly price?: string | undefined;
  /** The carriage the packet rode, when the relay pinned one. */
  readonly carriage?: RelayCarriage | undefined;
  readonly state: RelayWriteState;
  readonly reason?: string | undefined;
  /**
   * An ILP reject code, `http_<status>` from the relay, or — on an unpayable
   * relay — why it could not be paid: `no_document`, `no_edge`, `bad_edge`,
   * `carriage_unsupported`, `connector_unreachable`, `edge_disagrees`,
   * `no_write_route`, `no_settlement`, `no_channel` or `unaffordable`. Branch
   * on this.
   */
  readonly code?: string | undefined;
  /** What it cost in base units — present on a refusal too (#115). */
  readonly cost?: string | undefined;
}

/** A write that landed: what it reached, what it cost, and who was paid. */
export interface RelayWriteReceipt {
  readonly at: string;
  /** What was written, for the report a person reads. */
  readonly what: string;
  /** The relays that now hold the event. Never empty — an empty one throws. */
  readonly relays: readonly string[];
  /**
   * Every relay this publish considered, written or not. `relays` is the
   * subset that took it; `writes` is the whole account of where an Account's
   * record did and did not reach (#121).
   */
  readonly writes: readonly RelayWriteOutcome[];
  /**
   * The first relay that took it: the route, the edge and the chain it was
   * paid on. Per-relay detail is in {@link writes}; these are here because a
   * status line has room for one of each.
   */
  readonly destination: string;
  readonly payAt: string;
  readonly chain: string;
  readonly channelId?: string | undefined;
  /**
   * What the WHOLE publish cost, in base units: every packet's claim summed,
   * refused ones included, because TOON bills for an answer and a refusal is
   * one (ADR 0003). Never a price multiplied by a relay count.
   */
  readonly cost?: string | undefined;
}

/** One relay, as `targets()` reports it before anything is bought. */
export interface RelayWriteTarget {
  readonly url: string;
  /** Whether a write to this relay could be bought right now. */
  readonly ready: boolean;
  readonly destination?: string | undefined;
  readonly payAt?: string | undefined;
  /** The route's price in base units, verbatim from whoever quoted it. */
  readonly price?: string | undefined;
  readonly carriage?: RelayCarriage | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
  /** How this relay's edge was found. */
  readonly via?: 'document' | 'profile-connector' | undefined;
  /** Set exactly when `ready` is false. The same codes as an outcome's. */
  readonly code?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * Where a write would go right now, what it would cost, and what stops it.
 *
 * Every field is something read rather than decided: the relays are the
 * profile's plus the Account's own NIP-65 write list, each destination and
 * price is that relay's connector's, and each channel is one in this console's
 * store. `ready` is the whole of the preflight a caller needs before it mints
 * anything (#115): true when at least ONE relay can be paid, because a record
 * that reaches one relay is published.
 */
export interface RelayWriteTargets {
  /** The relays a write would reach — the payable ones, in order. */
  readonly relays: readonly string[];
  /** Every relay considered, payable or not, with the reason either way. */
  readonly plan: readonly RelayWriteTarget[];
  /** The first payable relay's route, edge, price and channel. */
  readonly destination?: string | undefined;
  readonly payAt?: string | undefined;
  readonly price?: string | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
  /** Every payable relay's quoted price, summed: what one publish costs. */
  readonly totalPrice?: string | undefined;
  readonly ready: boolean;
  readonly blockedBy?: string | undefined;
}

export class RelayWriteError extends Error {
  readonly code: string;
  readonly status: number;
  /** Per-relay detail: what was tried, what it cost, and what stopped it. */
  readonly writes?: readonly RelayWriteOutcome[];
  constructor(
    code: string,
    message: string,
    status = 502,
    writes?: readonly RelayWriteOutcome[]
  ) {
    super(message);
    this.name = 'RelayWriteError';
    this.code = code;
    this.status = status;
    if (writes) this.writes = writes;
  }
}

export interface RelayWriteRequest {
  /** A signed Nostr event, as NIP-01 puts one on the wire. */
  readonly event: unknown;
  /** What this write is: `chain-seed`, `lease`, `relay-list`, a retraction. */
  readonly what: string;
}

/**
 * The seam every record-keeping module writes through.
 *
 * Narrow on purpose: a caller decides WHAT to publish and learns what it cost,
 * and can decide nothing about how it is paid for or which relays it reaches.
 * There is no "and if that fails, try a socket".
 */
export interface RelayWriter {
  targets(): Promise<RelayWriteTargets>;
  /** @throws {RelayWriteError} when NO relay took it. */
  write(request: RelayWriteRequest): Promise<RelayWriteReceipt>;
}

/* -------------------------------------------------------------------------- */
/* Which route writes to a relay                                              */
/* -------------------------------------------------------------------------- */

export interface RelayWriteRoute {
  readonly destination: string;
  /** Base units per packet, as the connector published it. */
  readonly price: string;
}

/**
 * The paid route that writes to this connector's relay, from its own
 * self-description and nothing else.
 *
 * This is #120's reading, and since #121 it is the FALLBACK rather than the
 * way: a relay names its own edge now (spec §13), and this answers only for
 * the profile's own relay when that relay serves no document — every relay
 * built before §13, which on the day this shipped was every relay in the fleet
 * but devnet's.
 *
 * A connector names the ILP addresses it terminates (`ilpAddresses`) and
 * prices the routes it publishes (`routes`). The relay's write route is the
 * one that is BOTH: an address this connector answers for, published at a
 * price above zero. On the devnet relay's connector that is `g.toon.relay` at
 * 1 base unit, beside `g.toon.relay.ephemeral` at zero; on the sandbox hub it
 * is the same pair. Nothing here spells either of them.
 *
 * A zero-priced address is skipped and so is anything under `.ephemeral`,
 * which is the FREE ephemeral lane — never persisted (NIP-16) and rate-limited
 * per remote address, so shared by everyone behind one connector. The
 * provider's publisher refuses to start when it is configured to write there
 * (ADR 0007); this refuses to discover it. A relay that genuinely charges
 * nothing says so in its own document, where `price: 0` is a statement rather
 * than a guess (§13.4), and that path does not come through here.
 *
 * The shortest address wins when a connector terminates several, because a
 * longer one is a sub-application of it — `g.toon.relay.gas` and
 * `g.toon.relay.store` are the gas station and the blob store, not the relay.
 */
export function relayWriteDestination(
  health: Extract<ConnectorHealth, { state: 'ok' }>
): RelayWriteRoute | undefined {
  const priced = new Map(health.routes.map((route) => [route.prefix, route.price]));
  const candidates = health.ilpAddresses
    .filter((address) => !address.split('.').includes('ephemeral'))
    .flatMap((address) => {
      const price = priced.get(address);
      if (price === undefined) return [];
      let amount: bigint;
      try {
        amount = BigInt(price);
      } catch {
        return [];
      }
      return amount > 0n ? [{ destination: address, price }] : [];
    })
    .sort((left, right) => {
      const depth = left.destination.split('.').length - right.destination.split('.').length;
      return depth !== 0 ? depth : left.destination.localeCompare(right.destination);
    });
  return candidates[0];
}

/**
 * What a connector quotes for an address, whether it terminates it or
 * forwards it.
 *
 * A route's `prefix` covers itself and everything beneath it, so the price for
 * `g.toon.relay` is quoted by a route on `g.toon.relay` or on `g.toon`. The
 * LONGEST covering prefix wins, because that is the one the connector itself
 * matches on. `undefined` means this connector quotes nothing for that
 * address, which is a connector that will not carry the packet.
 */
export function routePriceFor(
  health: Extract<ConnectorHealth, { state: 'ok' }>,
  address: string
): string | undefined {
  let best: { prefix: string; price: string } | undefined;
  for (const route of health.routes) {
    if (address !== route.prefix && !address.startsWith(`${route.prefix}.`)) continue;
    if (best === undefined || route.prefix.length > best.prefix.length) {
      best = { prefix: route.prefix, price: route.price };
    }
  }
  return best?.price;
}

/**
 * Whether two published keys are the same key.
 *
 * Case and an `0x` prefix are spelling, not identity: a connector's own
 * `GET /ilp` and a relay's document restate the same secp256k1 point and are
 * two separate renderings of it. Anything beyond that is a genuine
 * disagreement, and §13.2 says a client that notices one MUST refuse rather
 * than pick a side.
 */
function sameSealKey(left: string, right: string): boolean {
  const bare = (key: string) => key.trim().toLowerCase().replace(/^0x/u, '');
  return bare(left) === bare(right);
}

/* -------------------------------------------------------------------------- */
/* The writer                                                                 */
/* -------------------------------------------------------------------------- */

export interface PaidRelayWriterDeps {
  readonly profile: () => NetworkProfile;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  /**
   * Read any connector's own self-description, by URL.
   *
   * Needed since #121: a relay's document names the connector that terminates
   * its writes, and that connector is routinely NOT this profile's. Absent
   * means this writer can only pay at the profile's own edge, and a relay
   * behind another connector is reported as one it could not pay.
   */
  readonly readHealthAt?: ((connectorUrl: string) => Promise<ConnectorHealth>) | undefined;
  /**
   * The Account's NIP-65 **write** relays, as they are known right now.
   *
   * A function because the list is discovered — read off whatever relay could
   * be reached, and empty until something has looked. An Account with no list
   * writes to the profile's relay alone, which is exactly #120's behaviour.
   */
  readonly writeRelays?: (() => readonly string[]) | undefined;
  /** Reads each relay's NIP-11 write edge, and remembers it. */
  readonly edges?: { read(url: string): Promise<RelayEdgeReading> } | undefined;
  /**
   * Borrow the account's payer keys for the length of ONE publish.
   *
   * A function and not the `ChainSeedStore` itself: this module has no business
   * minting, importing or publishing a seed, and a narrow port is what says so.
   * The keys are wiped when the borrow returns (ADR 0020). One borrow covers
   * every relay in a publish, so a five-relay write derives the mnemonic once.
   */
  readonly payerKeys: <T>(use: (keys: PayerKeys) => Promise<T>) => Promise<T>;
  readonly paths: ConsolePaths;
  readonly port: RelayWritePort;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
}

interface WritePlan {
  readonly relay: string;
  readonly destination: string;
  readonly price: string;
  readonly payAt: string;
  readonly sealTo?: string | undefined;
  readonly carriage?: RelayCarriage | undefined;
  readonly chain: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  /** Absent on a free route: §13.4's relay needs no channel to be written to. */
  readonly channelId?: string | undefined;
  readonly channelStore: ChannelStore;
  readonly via: 'document' | 'profile-connector';
}

/** A relay that gets nothing, and the sentence saying why. */
interface BlockedRelay {
  readonly relay: string;
  readonly code: string;
  readonly reason: string;
  /** What is known about the edge anyway, for the report. */
  readonly destination?: string | undefined;
  readonly payAt?: string | undefined;
  readonly price?: string | undefined;
  readonly carriage?: RelayCarriage | undefined;
}

type RelayPlanning = { plan: WritePlan } | { blocked: BlockedRelay };

/** One route, as a relay's document or this console's own connector quoted it. */
interface PlannedRoute {
  readonly destination: string;
  readonly price: string;
  readonly sealTo?: string | undefined;
  readonly carriage?: RelayCarriage | undefined;
  readonly via: 'document' | 'profile-connector';
}

export class PaidRelayWriter implements RelayWriter {
  readonly #deps: PaidRelayWriterDeps;
  readonly #edges: { read(url: string): Promise<RelayEdgeReading> };

  constructor(deps: PaidRelayWriterDeps) {
    this.#deps = deps;
    this.#edges = deps.edges ?? new RelayEdgeReader();
  }

  async targets(): Promise<RelayWriteTargets> {
    const planned = await this.#plan();
    const plan: RelayWriteTarget[] = planned.order.map((relay) => {
      const ready = planned.plans.find((entry) => entry.relay === relay);
      if (ready) {
        return {
          url: relay,
          ready: true,
          destination: ready.destination,
          payAt: ready.payAt,
          price: ready.price,
          ...(ready.carriage === undefined ? {} : { carriage: ready.carriage }),
          chain: ready.chain,
          channelId: ready.channelId,
          via: ready.via,
        };
      }
      const blocked = planned.blocked.find((entry) => entry.relay === relay);
      return {
        url: relay,
        ready: false,
        ...(blocked?.destination === undefined ? {} : { destination: blocked.destination }),
        ...(blocked?.payAt === undefined ? {} : { payAt: blocked.payAt }),
        ...(blocked?.price === undefined ? {} : { price: blocked.price }),
        ...(blocked?.carriage === undefined ? {} : { carriage: blocked.carriage }),
        code: blocked?.code ?? 'unplanned',
        reason: blocked?.reason ?? 'This relay was not planned.',
      };
    });

    const first = planned.plans[0];
    if (first === undefined) {
      return {
        relays: [],
        plan,
        ready: false,
        blockedBy: blockedSentence(this.#deps.profile(), planned.order, planned.blocked),
      };
    }
    const total = sumOf(planned.plans.map((entry) => entry.price));
    return {
      relays: planned.plans.map((entry) => entry.relay),
      plan,
      destination: first.destination,
      payAt: first.payAt,
      price: first.price,
      chain: first.chain,
      channelId: first.channelId,
      ...(total === undefined ? {} : { totalPrice: total }),
      ready: true,
    };
  }

  /**
   * Buy one write per payable relay.
   *
   * The order is the safety property. The event is verified ONCE and the whole
   * plan is made BEFORE any money moves — a bad event would otherwise be
   * billed for once per relay — and the keys are borrowed for the whole
   * publish and wiped after it.
   *
   * Packets go one at a time, never in parallel. A claim carries a strictly
   * increasing nonce per channel, and two packets on one channel in flight at
   * once race their own nonces; relays behind different connectors could in
   * principle go together, but a console writes to a handful of relays and the
   * concurrency would buy a fraction of a second at the price of a rule that
   * has to hold for every future caller.
   */
  async write(request: RelayWriteRequest): Promise<RelayWriteReceipt> {
    // Before anything is paid for: a relay answers a bad signature with 422,
    // and TOON bills for that answer like any other (ADR 0003, #115).
    if (!verifyEvent(request.event)) {
      throw new RelayWriteError(
        'invalid_event',
        'That is not a signed Nostr event this console would pay to publish: its id or its ' +
          'signature does not check out. Nothing was sent and nothing was billed — a relay ' +
          'refuses a bad event with `422 Invalid event signature`, and a paid route bills for ' +
          'that answer like any other (ADR 0003).',
        400
      );
    }

    const planned = await this.#plan();
    if (planned.plans.length === 0) {
      throw new RelayWriteError(
        codeOfNothing(planned.blocked),
        `${request.what} was NOT written. ` +
          blockedSentence(this.#deps.profile(), planned.order, planned.blocked),
        statusOfNothing(planned.blocked),
        planned.blocked.map(unpayableOutcome)
      );
    }

    // One borrow for the whole publish: the mnemonic is unsealed and derived
    // from once, whatever the relay count, and wiped when this returns.
    const sent = await this.#deps.payerKeys(async (keys) => {
      const outcomes: RelayWriteOutcome[] = [];
      for (const plan of planned.plans) {
        const outcome = await this.#deps.port.send({
          payAt: plan.payAt,
          destination: plan.destination,
          ...(plan.sealTo === undefined ? {} : { sealTo: plan.sealTo }),
          ...(plan.carriage === undefined ? {} : { carriage: plan.carriage }),
          event: request.event,
          chainKind: plan.chainKind,
          rpcUrl: plan.rpcUrl,
          keys,
          channelStore: plan.channelStore,
          ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
        });
        outcomes.push(toOutcome(plan, outcome));
      }
      return outcomes;
    });

    // Reported in the order the relays were considered, so a report reads the
    // same whether a relay was paid or skipped.
    const byRelay = new Map(sent.map((outcome) => [outcome.url, outcome]));
    const blocked = new Map(planned.blocked.map((entry) => [entry.relay, entry]));
    const writes: RelayWriteOutcome[] = planned.order.flatMap((relay) => {
      const outcome = byRelay.get(relay);
      if (outcome) return [outcome];
      const stopped = blocked.get(relay);
      return stopped ? [unpayableOutcome(stopped)] : [];
    });

    const landed = writes.filter((outcome) => outcome.state === 'written');
    const cost = sumOf(writes.map((outcome) => outcome.cost));
    const first = landed[0];
    if (first === undefined) {
      throw new RelayWriteError(
        writes.some((outcome) => outcome.state === 'unknown')
          ? 'write_unconfirmed'
          : 'write_refused',
        `${request.what} was NOT written: no relay took it. ${failureSentence(writes)} ` +
          (cost === undefined
            ? 'Nothing was billed.'
            : `It was still billed ${cost} base units in total: TOON bills for an answer, and ` +
              `a refusal is one (ADR 0003, spec §5).`),
        writes.some((outcome) => outcome.state === 'unknown') ? 504 : 502,
        writes
      );
    }

    const plan = planned.plans.find((entry) => entry.relay === first.url);
    return {
      at: this.#at().toISOString(),
      what: request.what,
      relays: landed.map((outcome) => outcome.url),
      writes,
      destination: first.destination ?? '',
      payAt: first.payAt ?? '',
      chain: plan?.chain ?? '',
      ...(plan?.channelId === undefined ? {} : { channelId: plan.channelId }),
      ...(cost === undefined ? {} : { cost }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Planning                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Every relay this publish would touch, split into the ones it can pay and
   * the ones it cannot.
   *
   * The profile's connector is read ONCE for the whole set, because most
   * relays on a network are fronted by it and re-reading it per relay would be
   * one round trip per relay for one answer.
   */
  async #plan(): Promise<{
    readonly order: readonly string[];
    readonly plans: readonly WritePlan[];
    readonly blocked: readonly BlockedRelay[];
  }> {
    const profile = this.#deps.profile();
    const order = this.#relays(profile);
    if (order.length === 0) return { order: [], plans: [], blocked: [] };

    const health = isConfigured(profile) ? await this.#deps.readHealth(profile) : undefined;
    const own = health?.state === 'ok' ? health : undefined;
    const channels = channelStoreFor(this.#deps.paths, profile.id);

    const plans: WritePlan[] = [];
    const blocked: BlockedRelay[] = [];
    for (const relay of order) {
      const planned = await this.#planRelay(relay, profile, own, health, channels.store);
      if ('plan' in planned) plans.push(planned.plan);
      else blocked.push(planned.blocked);
    }
    return { order, plans, blocked };
  }

  /**
   * Where an Account's records go: the profile's relay, then the relays its
   * own NIP-65 list names to write to.
   *
   * The profile's relay is in the set whatever the list says, and that is
   * deliberate. It is the relay this console reads the Provider Directory
   * from, the one whose connector it holds a channel with, and therefore the
   * one it can almost always pay — so keeping it is what makes "a record
   * reaches at least one relay" true for an Account that has just published a
   * list naming relays it cannot yet pay. It is also #120's behaviour
   * unchanged, which is the one thing this ticket must not break.
   *
   * A NIP-65 list is a statement ABOUT relays, not a fence around them: §13
   * gives a client a way to pay any relay it holds the URL of, and an Account
   * that wants its records only on the relays it named says so by naming them
   * — at which point the profile's relay is in the list too, and deduplicated.
   */
  #relays(profile: NetworkProfile): readonly string[] {
    const wanted = [profile.relayUrl, ...(this.#deps.writeRelays?.() ?? [])];
    const seen = new Set<string>();
    const relays: string[] = [];
    for (const url of wanted) {
      const relay = normalizeRelayUrl(url);
      if (relay === undefined || seen.has(relay)) continue;
      seen.add(relay);
      relays.push(relay);
    }
    return relays;
  }

  /**
   * One relay's plan, read in the order a person would ask: what does the
   * relay say about itself, who terminates that address, and is there a
   * channel to pay them from.
   */
  async #planRelay(
    relay: string,
    profile: NetworkProfile,
    own: Extract<ConnectorHealth, { state: 'ok' }> | undefined,
    ownHealth: ConnectorHealth | undefined,
    store: ChannelStore
  ): Promise<RelayPlanning> {
    const reading = await this.#edges.read(relay);
    if (reading.state === 'none') {
      return this.#withoutDocument(relay, profile, own, ownHealth, store, reading);
    }
    const edge = reading.edge;

    if (own !== undefined && sameConnectorUrl(own.selfEndpoint, edge.connectorUrl)) {
      // The relay names THIS console's own connector: #120's case, and still
      // the common one on every network where one connector fronts the relay
      // a profile points at. Nothing to seal past, and the channel is the one
      // this account already holds.
      const disagreement = this.#sealKeyDisagreement(relay, own, edge);
      if (disagreement) return { blocked: disagreement };
      return this.#withChannel(relay, profile, own, store, {
        destination: edge.ilpAddress,
        price: routePriceFor(own, edge.ilpAddress) ?? edge.price,
        ...(edge.carriage === undefined ? {} : { carriage: edge.carriage }),
        via: 'document',
      });
    }

    if (own !== undefined && !own.ilpAddresses.includes(edge.ilpAddress)) {
      // The relay is behind somebody else's connector. If THIS console's
      // connector publishes a route covering that address, it forwards there,
      // and one channel — the one this account already holds — pays for the
      // write. The payload is sealed to the far connector's own key, because
      // no hop may name that key on its behalf. This is the branch that keeps
      // "N relays" from meaning "N channels".
      //
      // The guard matters: an address this console's own connector TERMINATES
      // is one where a packet bought here would arrive at this connector's
      // own relay rather than at the one being written to, whatever the
      // document says. That falls through to the connector the relay named,
      // which is the only honest route to it.
      const forwarded = routePriceFor(own, edge.ilpAddress);
      if (forwarded !== undefined) {
        return this.#withChannel(relay, profile, own, store, {
          destination: edge.ilpAddress,
          price: forwarded,
          sealTo: edge.sealKey,
          ...(edge.carriage === undefined ? {} : { carriage: edge.carriage }),
          via: 'document',
        });
      }
    }

    // Nothing this account's own edge can carry: pay the relay's connector
    // directly, which needs a channel with it.
    const readAt = this.#deps.readHealthAt;
    if (readAt === undefined) {
      return {
        blocked: {
          relay,
          code: 'connector_unreachable',
          reason:
            `${relay} says its writes are paid for at ${edge.connectorUrl}, and this writer ` +
            `can only pay at the network profile's own connector.`,
          destination: edge.ilpAddress,
          payAt: edge.connectorUrl,
          price: edge.price,
        },
      };
    }
    const far = await readAt(edge.connectorUrl);
    if (far.state !== 'ok') {
      return {
        blocked: {
          relay,
          code: 'connector_unreachable',
          reason:
            `${relay} says its writes are paid for at ${edge.connectorUrl}, and that connector ` +
            `did not answer, so neither what a write costs nor how to pay for it could be ` +
            `read. ${far.reason}`,
          destination: edge.ilpAddress,
          payAt: edge.connectorUrl,
          price: edge.price,
        },
      };
    }
    const disagreement = this.#sealKeyDisagreement(relay, far, edge);
    if (disagreement) return { blocked: disagreement };
    return this.#withChannel(relay, profile, far, store, {
      destination: edge.ilpAddress,
      price: routePriceFor(far, edge.ilpAddress) ?? edge.price,
      // A connector that terminates the address needs no `sealTo`; one that
      // merely answers for the URL the relay named still forwards it.
      ...(far.ilpAddresses.includes(edge.ilpAddress) ? {} : { sealTo: edge.sealKey }),
      ...(edge.carriage === undefined ? {} : { carriage: edge.carriage }),
      via: 'document',
    });
  }

  /**
   * A relay that said nothing about its own edge.
   *
   * The profile's OWN relay keeps #120's route: this profile pins a connector
   * and that connector fronts that relay, so its self-description is a
   * statement about this pair rather than a guess. Every relay built before
   * spec §13 depends on it — which on the day #121 shipped was every relay in
   * the fleet but devnet's, the local sandbox's included, so the local smoke
   * keeps working. ADR 0024 calls this what it is: a fallback rather than the
   * way, and it retires itself as relays start answering for themselves.
   *
   * Any OTHER relay gets nothing, and is reported with the reason it gave.
   * There is no second guess to make: this console holds that relay's URL and
   * nothing else, and an ILP address invented for it would send an Account's
   * sealed seed, and its money, somewhere nobody named.
   */
  #withoutDocument(
    relay: string,
    profile: NetworkProfile,
    own: Extract<ConnectorHealth, { state: 'ok' }> | undefined,
    ownHealth: ConnectorHealth | undefined,
    store: ChannelStore,
    reading: Extract<RelayEdgeReading, { state: 'none' }>
  ): RelayPlanning {
    if (relay !== normalizeRelayUrl(profile.relayUrl)) {
      return {
        blocked: {
          relay,
          code: reading.code,
          reason:
            `${reading.reason} This console holds nothing else about ${relay}, so an ` +
            `Account's record does not reach it.`,
        },
      };
    }
    if (!isConfigured(profile)) {
      return {
        blocked: {
          relay,
          code: 'unconfigured',
          reason:
            `${profile.label} names no connector, so a write to ${relay} cannot be paid for — ` +
            `and a TOON relay takes no other kind. ${reading.reason}`,
        },
      };
    }
    if (own === undefined) {
      return {
        blocked: {
          relay,
          code: 'connector_unreachable',
          reason:
            `The connector at ${profile.connectorUrl} did not answer, so neither what a write ` +
            `to ${relay} costs nor how to pay for it can be read. ` +
            `${ownHealth === undefined || ownHealth.state === 'ok' ? '' : ownHealth.reason}`,
          payAt: profile.connectorUrl,
        },
      };
    }
    const route = relayWriteDestination(own);
    if (route === undefined) {
      return {
        blocked: {
          relay,
          code: 'no_write_route',
          reason:
            `${relay} publishes no write edge of its own, and the connector at ` +
            `${profile.connectorUrl} publishes no paid route of its own to buy a relay write ` +
            `on either. It answers for ${own.ilpAddresses.join(', ') || 'nothing'}, and a ` +
            `write has to be bought on a route that costs something: the free ephemeral lane ` +
            `is never persisted and is shared by everyone behind this connector (ADR 0007).`,
          payAt: own.selfEndpoint,
        },
      };
    }
    return this.#withChannel(relay, profile, own, store, {
      destination: route.destination,
      price: route.price,
      via: 'profile-connector',
    });
  }

  /**
   * §13.2's check, and the refusal it calls for.
   *
   * A relay's document and its connector's own self-description are two
   * statements of one key. They are worth the SAME — the relay's is signed by
   * nothing, so neither wins (ADR 0024) — and a client that notices them
   * disagree MUST refuse rather than pick a side. What it is checking for is a
   * misconfiguration rather than an attack, which is exactly why guessing is
   * the wrong move: whichever side is stale, spending money on it is spending
   * it on a key somebody may not hold.
   */
  #sealKeyDisagreement(
    relay: string,
    health: Extract<ConnectorHealth, { state: 'ok' }>,
    edge: RelayWriteEdge
  ): BlockedRelay | undefined {
    if (health.edgeSealKey === undefined) return undefined;
    if (sameSealKey(health.edgeSealKey, edge.sealKey)) return undefined;
    return {
      relay,
      code: 'edge_disagrees',
      reason:
        `${relay} pins one sealing key for ${edge.connectorUrl} and that connector publishes ` +
        `another, so one of the two is stale and this console cannot tell which. Spec §13.2 ` +
        `says to refuse rather than pick a side, because a relay's document is signed by ` +
        `nothing and neither statement outranks the other (ADR 0024). Nothing was sent.`,
      destination: edge.ilpAddress,
      payAt: edge.connectorUrl,
      price: edge.price,
    };
  }

  /**
   * The channel half of a plan: which chain this edge settles on that the
   * Account already holds a channel for, and whether it holds enough.
   *
   * It never opens one. An open locks collateral on chain and pays the chain's
   * own gas, and writing to a second relay must not become a way to spend an
   * Account's money on a channel nobody asked for — which is most of the
   * answer to "is writing to N relays N channels". It is N channels only when
   * N relays sit behind N connectors this Account has separately funded; the
   * ordinary case is one, because the relays are behind one connector or
   * behind one this console's connector forwards to.
   */
  #withChannel(
    relay: string,
    profile: NetworkProfile,
    health: Extract<ConnectorHealth, { state: 'ok' }>,
    store: ChannelStore,
    route: PlannedRoute
  ): RelayPlanning {
    const where = {
      destination: route.destination,
      payAt: health.selfEndpoint,
      price: route.price,
      ...(route.carriage === undefined ? {} : { carriage: route.carriage }),
    };
    let price: bigint;
    try {
      price = BigInt(route.price);
    } catch {
      return {
        blocked: {
          relay,
          code: 'bad_edge',
          reason:
            `A write to ${relay} is quoted at \`${route.price}\`, which is not a number of ` +
            `base units, so this console will not buy a packet on it.`,
          ...where,
        },
      };
    }
    if (health.settlements.length === 0) {
      return {
        blocked: {
          relay,
          code: 'no_settlement',
          reason:
            `The connector at ${health.selfEndpoint} names no settlement chain, so there is ` +
            `no channel a write to ${relay} could be paid from.`,
          ...where,
        },
      };
    }
    // The channel binding is looked up by what the connector SAYS about
    // itself (`health.selfEndpoint`), never by a URL this console happened to
    // dial — a connector answering on `localhost` and on `127.0.0.1` alike
    // publishes only one of them, and `@toon-protocol/client` keys a binding
    // by whatever string it was told to dial. Comparing against the profile's
    // own string would key a fresh channel right and then fail to find it the
    // next time this console reached the same connector by its other name
    // (TOON_Network#126). It is also why a relay's `connector_url` is never
    // the key: that is a location hint (§13.1), and `selfEndpoint` is the
    // string the client itself agrees on.
    const planOn = (
      settlement: (typeof health.settlements)[number],
      channelId: string | undefined
    ): RelayPlanning => ({
      plan: {
        relay,
        destination: route.destination,
        price: route.price,
        payAt: health.selfEndpoint,
        ...(route.sealTo === undefined ? {} : { sealTo: route.sealTo }),
        ...(route.carriage === undefined ? {} : { carriage: route.carriage }),
        chain: settlement.chain,
        chainKind: settlement.kind,
        rpcUrl: resolveRpc(profile, settlement.kind).url,
        ...(channelId === undefined ? {} : { channelId }),
        channelStore: store,
        via: route.via,
      },
    });

    for (const settlement of health.settlements) {
      const binding = findChannelBinding(store, health.selfEndpoint, settlement.chain);
      if (!binding) continue;
      const left = channelAvailable(store, binding);
      if (left !== undefined && left < price) {
        return {
          blocked: {
            relay,
            code: 'unaffordable',
            reason:
              `A write to ${relay} costs ${route.price} base units on ${route.destination}, ` +
              `and this account's channel with ${health.selfEndpoint} has ${left} left. Top ` +
              `it up from the Funds tab.`,
            ...where,
          },
        };
      }
      return planOn(settlement, binding.channelId);
    }

    // A relay that charges nothing works with no channel at all, and that is
    // the point of §13.4: `price: 0` is a statement, and a write to a free
    // relay is still a packet to an address — it just carries no claim. A
    // console that demanded a channel here would refuse the one relay on the
    // network that never needed one.
    const first = health.settlements[0];
    if (price === 0n && first !== undefined) return planOn(first, undefined);

    return {
      blocked: {
        relay,
        code: 'no_channel',
        reason:
          `This account holds no payment channel with the connector at ${health.selfEndpoint}, ` +
          `which is where a write to ${relay} is paid for, so its record does not reach that ` +
          `relay. One write on ${route.destination} costs ${route.price} base units of the ` +
          `settlement token. Open a channel on ` +
          `${health.settlements.map((entry) => entry.chain).join(' or ')} from the Funds tab — ` +
          `a write must never open one for you, because opening locks collateral on chain and ` +
          `costs the chain's own gas.`,
        ...where,
      },
    };
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }
}

/** `https://node.example` and `https://node.example/ilp` are the same node. */
function sameConnectorUrl(a: string, b: string): boolean {
  const base = (url: string) => url.replace(/\/+$/u, '').replace(/\/ilp$/u, '');
  return base(a) === base(b);
}

function toOutcome(plan: WritePlan, outcome: RelayPacketOutcome): RelayWriteOutcome {
  const where = {
    url: plan.relay,
    destination: plan.destination,
    payAt: plan.payAt,
    price: plan.price,
    ...(plan.carriage === undefined ? {} : { carriage: plan.carriage }),
  };
  if (outcome.kind === 'unknown') {
    return {
      ...where,
      state: 'unknown',
      reason:
        `The packet was sent and nothing came back: ${outcome.message} Whether ${plan.relay} ` +
        `holds the event is genuinely unknown.`,
    };
  }
  if (outcome.kind === 'refused') {
    const who =
      outcome.refusedBy === 'destination'
        ? 'The connector that terminates this route refused the packet'
        : outcome.refusedBy === 'edge'
          ? 'The connector this console pays at refused the packet before routing it'
          : 'A hop on the way refused the packet';
    return {
      ...where,
      state: 'refused',
      code: outcome.code,
      reason: `${who} (${outcome.code}): ${outcome.message}`,
      ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
    };
  }
  if (outcome.status !== 200) {
    return {
      ...where,
      state: 'refused',
      code: `http_${outcome.status}`,
      reason: `${plan.relay} answered HTTP ${outcome.status}: ${outcome.text.slice(0, 300)}`,
      ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
    };
  }
  return {
    ...where,
    state: 'written',
    ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
  };
}

function unpayableOutcome(blocked: BlockedRelay): RelayWriteOutcome {
  return {
    url: blocked.relay,
    state: 'unpayable',
    code: blocked.code,
    reason: blocked.reason,
    ...(blocked.destination === undefined ? {} : { destination: blocked.destination }),
    ...(blocked.payAt === undefined ? {} : { payAt: blocked.payAt }),
    ...(blocked.price === undefined ? {} : { price: blocked.price }),
    ...(blocked.carriage === undefined ? {} : { carriage: blocked.carriage }),
  };
}

/**
 * Base units summed, or nothing.
 *
 * `undefined` rather than `'0'` when nobody reported a figure: a zero that
 * stands in for "nobody said" is something a person would act on, and this one
 * ends up in a receipt.
 */
function sumOf(values: readonly (string | undefined)[]): string | undefined {
  let total = 0n;
  let any = false;
  for (const value of values) {
    if (value === undefined) continue;
    try {
      total += BigInt(value);
      any = true;
    } catch {
      // A figure this console cannot read is left out of the sum rather than
      // guessed at; the per-relay line still carries it verbatim.
    }
  }
  return any ? total.toString() : undefined;
}

/** The one sentence for "nothing can be written right now". */
function blockedSentence(
  profile: NetworkProfile,
  order: readonly string[],
  blocked: readonly BlockedRelay[]
): string {
  if (order.length === 0) {
    return (
      `${profile.label} names no relay and this account's NIP-65 list names none either, so ` +
      `there is nowhere to write. Switch to a network that has one, or publish a relay list.`
    );
  }
  const only = blocked.length === 1 ? blocked[0] : undefined;
  if (only !== undefined) return only.reason;
  return (
    `None of the ${order.length} relays this account writes to can be paid right now. ` +
    blocked.map((entry) => `${entry.relay}: ${entry.reason}`).join(' ')
  );
}

/** What a publish that could buy nothing is called, so a caller can branch. */
function codeOfNothing(blocked: readonly BlockedRelay[]): string {
  if (blocked.length === 0) return 'no_relay';
  const codes = new Set(blocked.map((entry) => entry.code));
  return codes.size === 1 ? (blocked[0]?.code ?? 'no_relay') : 'no_payable_relay';
}

/**
 * Money first, then reachability, then everything else.
 *
 * `402` wins as soon as ONE relay was stopped by a missing or empty channel,
 * even when others were stopped by something else. That is the ordering a
 * person can act on: opening or topping up a channel is a thing they can do,
 * and a relay that serves no document is not.
 */
function statusOfNothing(blocked: readonly BlockedRelay[]): number {
  if (blocked.length === 0) return 409;
  if (blocked.some((entry) => entry.code === 'no_channel' || entry.code === 'unaffordable')) {
    return 402;
  }
  if (blocked.some((entry) => entry.code === 'connector_unreachable')) return 502;
  return 409;
}

function failureSentence(writes: readonly RelayWriteOutcome[]): string {
  return writes
    .map((outcome) => `${outcome.url}: ${outcome.reason ?? outcome.code ?? 'no reason given'}`)
    .join(' ');
}
