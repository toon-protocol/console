import type { ChannelStore } from '@toon-protocol/client';

import { channelStoreFor, findChannelBinding } from './channel-store.js';
import type { PayerKeys } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { resolveRpc } from './funding.js';
import { verifyEvent } from './nostr.js';
import type { ConsolePaths } from './paths.js';
import { isConfigured, type NetworkProfile } from './profiles.js';
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
 * Profile, its Listings and its Liveness this way; until this ticket the
 * console was the one party in the fleet that did not, and #89 and #92 both
 * ended up asking for "a free relay" that no TOON network provides. The
 * plain-websocket write half is gone from `relay-pool.ts`, which now reads and
 * only reads.
 *
 * **Paying is not optional in here.** There is no unpaid branch, no fallback
 * socket and no flag that turns one on. A caller either gets a receipt naming
 * what the write cost, or a refusal saying why nothing was written.
 *
 * Four facts shape the rest of it.
 *
 * **Where a write goes is read, never assumed.** The paid destination comes
 * out of the connector's own `GET /ilp` — see `relayWriteDestination` — so
 * there is no ILP address, price or relay constant in this repository, exactly
 * as there is no chain id in `profiles.ts` (TOON_Network#87).
 *
 * **The connector's price is the price (TOON_Network#82).** Nothing here
 * multiplies, rounds or recomputes one: `send` carries no `amount`, so the
 * client pays what the route quoted, and what comes back on the claim is what
 * this reports as the cost.
 *
 * **A refused paid request is still billed (ADR 0003, TOON_Network#115).** So
 * everything checkable is checked before a packet leaves: the event is
 * re-hashed and its signature re-verified here, because a relay answers a bad
 * one with `422 Invalid event signature` after taking the money.
 *
 * **It never opens a channel.** `autoOpenChannel: false` in the live port, and
 * a plan with no channel refuses with somewhere to go — the Funds tab —
 * rather than locking collateral on chain and paying gas because somebody
 * pressed "save".
 */

/* -------------------------------------------------------------------------- */
/* The packet port                                                            */
/* -------------------------------------------------------------------------- */

/** One paid write, as the port needs it sent. */
export interface RelayWritePacket {
  /** The connector edge whose channel pays for this packet. */
  readonly payAt: string;
  /**
   * The paid ILP destination, which this connector terminates ITSELF.
   *
   * That is an invariant rather than an assumption: the destination is only
   * ever one of the addresses the connector named as its own (`ilpAddresses`),
   * so there is no hop to seal past and no `sealTo` to name. A forwarded relay
   * route would need the terminating connector's pinned key (§4.1, ADR 0011),
   * and the day one exists this is where it arrives.
   */
  readonly destination: string;
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
  | 'unknown';

export interface RelayWriteOutcome {
  readonly url: string;
  /** The paid route this write was bought on. */
  readonly destination: string;
  readonly state: RelayWriteState;
  readonly reason?: string | undefined;
  /** An ILP reject code, or `http_<status>` from the relay. Branch on this. */
  readonly code?: string | undefined;
  /** What it cost in base units — present on a refusal too (#115). */
  readonly cost?: string | undefined;
}

/** A write that landed: what it reached, what it cost, and who was paid. */
export interface RelayWriteReceipt {
  readonly at: string;
  /** What was written, for the report a person reads. */
  readonly what: string;
  /** The relays that now hold the event. */
  readonly relays: readonly string[];
  readonly destination: string;
  readonly payAt: string;
  readonly chain: string;
  readonly channelId?: string | undefined;
  /** Base units of the settlement token, as the claim reported them. */
  readonly cost?: string | undefined;
  readonly writes: readonly RelayWriteOutcome[];
}

/**
 * Where a write would go right now, what it would cost, and what stops it.
 *
 * Every field is something read rather than decided: the relay is the active
 * profile's, the destination and the price are the connector's own, and the
 * channel is the one in this console's store. `ready` is the whole of the
 * preflight a caller needs before it mints anything (#115).
 */
export interface RelayWriteTargets {
  readonly relays: readonly string[];
  readonly destination?: string | undefined;
  readonly payAt?: string | undefined;
  /** The route's price in base units, verbatim from the connector. */
  readonly price?: string | undefined;
  readonly chain?: string | undefined;
  readonly channelId?: string | undefined;
  readonly ready: boolean;
  readonly blockedBy?: string | undefined;
}

export class RelayWriteError extends Error {
  readonly code: string;
  readonly status: number;
  /** Per-relay detail, when a packet was actually sent. */
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
 * and can decide nothing about how it is paid for. There is no "and if that
 * fails, try a socket".
 */
export interface RelayWriter {
  targets(): Promise<RelayWriteTargets>;
  /** @throws {RelayWriteError} when nothing was written. */
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
 * (ADR 0007); this refuses to discover it.
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

/* -------------------------------------------------------------------------- */
/* The writer                                                                 */
/* -------------------------------------------------------------------------- */

export interface PaidRelayWriterDeps {
  readonly profile: () => NetworkProfile;
  readonly readHealth: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  /**
   * Borrow the account's payer keys for the length of ONE write.
   *
   * A function and not the `ChainSeedStore` itself: this module has no business
   * minting, importing or publishing a seed, and a narrow port is what says so.
   * The keys are wiped when the borrow returns (ADR 0020).
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
  readonly chain: string;
  readonly chainKind: 'evm' | 'solana';
  readonly rpcUrl: string;
  readonly channelId: string;
  readonly channelStore: ChannelStore;
}

export class PaidRelayWriter implements RelayWriter {
  readonly #deps: PaidRelayWriterDeps;

  constructor(deps: PaidRelayWriterDeps) {
    this.#deps = deps;
  }

  async targets(): Promise<RelayWriteTargets> {
    const planned = await this.#plan();
    if ('blockedBy' in planned) {
      return {
        relays: planned.relays,
        ...(planned.destination === undefined ? {} : { destination: planned.destination }),
        ...(planned.payAt === undefined ? {} : { payAt: planned.payAt }),
        ...(planned.price === undefined ? {} : { price: planned.price }),
        ready: false,
        blockedBy: planned.blockedBy,
      };
    }
    return {
      relays: [planned.relay],
      destination: planned.destination,
      payAt: planned.payAt,
      price: planned.price,
      chain: planned.chain,
      channelId: planned.channelId,
      ready: true,
    };
  }

  /**
   * Buy one write.
   *
   * The order is the safety property. The event is verified, the plan is made
   * and the channel is found BEFORE any money moves; the keys are borrowed for
   * the one packet and wiped; and what comes back is either a receipt naming
   * the cost or a refusal naming what was — or was not — billed for it.
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
    if ('blockedBy' in planned) {
      throw new RelayWriteError(planned.code, planned.blockedBy, planned.status);
    }

    const outcome = await this.#deps.payerKeys((keys) =>
      this.#deps.port.send({
        payAt: planned.payAt,
        destination: planned.destination,
        event: request.event,
        chainKind: planned.chainKind,
        rpcUrl: planned.rpcUrl,
        keys,
        channelStore: planned.channelStore,
        ...(this.#deps.timeoutMs === undefined ? {} : { timeoutMs: this.#deps.timeoutMs }),
      })
    );

    const write = toOutcome(planned, outcome);
    if (write.state !== 'written') {
      throw new RelayWriteError(
        outcome.kind === 'unknown' ? 'write_unconfirmed' : 'write_refused',
        `${request.what} was NOT written to ${planned.relay}. ${write.reason ?? ''} ` +
          (write.cost === undefined
            ? 'Nothing was billed.'
            : `It was still billed ${write.cost} base units: TOON bills for an answer, and a ` +
              `refusal is one (ADR 0003, spec §5).`),
        outcome.kind === 'unknown' ? 504 : 502,
        [write]
      );
    }

    return {
      at: this.#at().toISOString(),
      what: request.what,
      relays: [planned.relay],
      destination: planned.destination,
      payAt: planned.payAt,
      chain: planned.chain,
      channelId: planned.channelId,
      ...(write.cost === undefined ? {} : { cost: write.cost }),
      writes: [write],
    };
  }

  /**
   * Everything one write needs, or the one sentence that says why there is no
   * write to be had.
   *
   * Read in the order a person would ask: is there a relay, is there a
   * connector, does it answer, does it sell a write, what does it settle in,
   * and is there a channel to pay from.
   */
  async #plan(): Promise<
    | WritePlan
    | {
        readonly blockedBy: string;
        readonly code: string;
        readonly status: number;
        readonly relays: readonly string[];
        readonly destination?: string | undefined;
        readonly payAt?: string | undefined;
        readonly price?: string | undefined;
      }
  > {
    const profile = this.#deps.profile();
    const relay = normalizeRelayUrl(profile.relayUrl);
    if (relay === undefined) {
      return {
        code: 'no_relay',
        status: 409,
        relays: [],
        blockedBy:
          `${profile.label} names no relay, so there is nowhere to write. Switch to a network ` +
          `that has one.`,
      };
    }
    if (!isConfigured(profile)) {
      return {
        code: 'unconfigured',
        status: 409,
        relays: [relay],
        blockedBy:
          `${profile.label} names no connector, so a write to ${relay} cannot be paid for — ` +
          `and a TOON relay takes no other kind.`,
      };
    }

    const health = await this.#deps.readHealth(profile);
    if (health.state !== 'ok') {
      return {
        code: 'connector_unreachable',
        status: 502,
        relays: [relay],
        payAt: profile.connectorUrl,
        blockedBy:
          `The connector at ${profile.connectorUrl} did not answer, so neither what a relay ` +
          `write costs nor how to pay for it can be read. ${health.reason}`,
      };
    }

    const route = relayWriteDestination(health);
    if (route === undefined) {
      return {
        code: 'no_write_route',
        status: 409,
        relays: [relay],
        payAt: profile.connectorUrl,
        blockedBy:
          `The connector at ${profile.connectorUrl} publishes no paid route of its own to buy ` +
          `a relay write on. It answers for ${health.ilpAddresses.join(', ') || 'nothing'}, ` +
          `and a write has to be bought on a route that costs something: the free ephemeral ` +
          `lane is never persisted and is shared by everyone behind this connector (ADR 0007).`,
      };
    }

    const channels = channelStoreFor(this.#deps.paths, profile.id);
    for (const settlement of health.settlements) {
      const binding = findChannelBinding(
        channels.store,
        profile.connectorUrl,
        settlement.chain
      );
      if (!binding) continue;
      return {
        relay,
        destination: route.destination,
        price: route.price,
        payAt: profile.connectorUrl,
        chain: settlement.chain,
        chainKind: settlement.kind,
        rpcUrl: resolveRpc(profile, settlement.kind).url,
        channelId: binding.channelId,
        channelStore: channels.store,
      };
    }

    return {
      code: 'no_channel',
      status: 402,
      relays: [relay],
      payAt: profile.connectorUrl,
      destination: route.destination,
      price: route.price,
      blockedBy:
        `This account holds no payment channel with the connector at ${profile.connectorUrl}, ` +
        `so a write to ${relay} cannot be paid for. One write on ${route.destination} costs ` +
        `${route.price} base units of the settlement token. Open a channel on ` +
        `${health.settlements.map((entry) => entry.chain).join(' or ') || 'its settlement chain'}` +
        ` from the Funds tab — a write must never open one for you, because opening locks ` +
        `collateral on chain and costs the chain's own gas.`,
    };
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }
}

function toOutcome(plan: WritePlan, outcome: RelayPacketOutcome): RelayWriteOutcome {
  if (outcome.kind === 'unknown') {
    return {
      url: plan.relay,
      destination: plan.destination,
      state: 'unknown',
      reason:
        `The packet was sent and nothing came back: ${outcome.message} Whether the relay holds ` +
        `the event is genuinely unknown.`,
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
      url: plan.relay,
      destination: plan.destination,
      state: 'refused',
      code: outcome.code,
      reason: `${who} (${outcome.code}): ${outcome.message}`,
      ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
    };
  }
  if (outcome.status !== 200) {
    return {
      url: plan.relay,
      destination: plan.destination,
      state: 'refused',
      code: `http_${outcome.status}`,
      reason: `The relay answered HTTP ${outcome.status}: ${outcome.text.slice(0, 300)}`,
      ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
    };
  }
  return {
    url: plan.relay,
    destination: plan.destination,
    state: 'written',
    ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
  };
}
