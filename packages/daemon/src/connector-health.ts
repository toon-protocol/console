import {
  ConnectorEdgeClient,
  connectorEdgeBaseUrl,
  type NodeSelfDescription,
} from '@toon-protocol/client';

import { isHiddenServiceUrl, type HiddenTransportPort } from './hidden-transport.js';
import { isConfigured, type NetworkProfile } from './profiles.js';

/**
 * What the active profile's connector says about itself.
 *
 * Every chain fact the console shows comes from here — `GET /ilp`, the free,
 * unauthenticated self-description — and none of it from a constant. The
 * console does not know that devnet settles USDC on Base Sepolia and Solana
 * devnet; it knows how to ask, and the answer is whatever the operator has
 * running right now. That is the difference between a health view and a
 * decoration: if the connector is repriced, re-keyed or moved to another
 * chain, this view changes with it and a hard-coded one would quietly lie.
 *
 * The three outcomes are kept apart on purpose. `unconfigured` is a profile
 * with no connector (mainnet today) and is not a fault. `unreachable` is a
 * connector that did not answer, which is. `ok` carries the document.
 */

export type ConnectorHealth =
  | { readonly state: 'unconfigured'; readonly reason: string }
  | { readonly state: 'unreachable'; readonly endpoint: string; readonly reason: string }
  | {
      readonly state: 'ok';
      readonly endpoint: string;
      readonly ilpAddresses: readonly string[];
      readonly settlements: readonly SettlementView[];
      readonly routes: readonly RouteView[];
      readonly peerCarriages: readonly string[];
      readonly edgeKeyId?: string | undefined;
      /**
       * The edge's own secp256k1 sealing key, as `GET /ilp` reports it.
       *
       * Here because a Gateway Handover has nowhere else to learn it: a
       * provider's sealing key is pinned in its signed Provider Profile
       * (ADR 0011), and a Workload Gateway publishes no Profile and signs
       * nothing at all — it is chosen by a packet rather than a publication
       * (ADR 0017). So what pins a gateway's key is the TLS name the active
       * profile's `gatewayConnectorUrl` points at, and this is that key
       * (TOON_Network#97).
       *
       * A key, not a secret: it is the PUBLIC half, and the whole network
       * reads it from the same free document.
       */
      readonly edgeSealKey?: string | undefined;
      readonly supportedVersions: readonly number[];
    };

/** One settlement chain, flattened to what a health view shows. */
export interface SettlementView {
  /** `evm:<chainId>` or `solana`, verbatim from the connector. */
  readonly chain: string;
  readonly kind: 'evm' | 'solana';
  /** The on-chain counterparty a channel is opened WITH. */
  readonly settlementAddress: string;
  /** The token every channel on this chain settles in. */
  readonly tokenAddress: string;
  readonly decimals: number;
}

export interface RouteView {
  readonly prefix: string;
  /** Base units per packet, as a string — these are already `bigint`-sized. */
  readonly price: string;
  readonly pricePerKib?: string;
}

export interface ConnectorReader {
  describe(
    endpoint: string,
    options?: { forceRefresh?: boolean }
  ): Promise<NodeSelfDescription>;
}

/**
 * How long a circuit is given to answer, against ten seconds on clearnet.
 *
 * An introduction-point circuit to a cold hidden service routinely takes most
 * of a minute, and a too-short deadline turns "slow" into "unreachable" — which
 * here would read as "this Hidden Provider is down" on a provider that is fine.
 * The same figure the client uses for a `.anyone` connector.
 */
const HIDDEN_TIMEOUT_MS = 120_000;

/**
 * The default reader: the client's own edge client, caching per endpoint —
 * and, for a `.anyone` endpoint, a second one bound to the Anyone Protocol
 * carriage (TOON_Network#98, spec §10).
 *
 * This is the first thing that touches a Hidden Provider's connector, and it
 * touches it by DIALLING it: `GET /ilp` is how the console learns what a route
 * costs and what the connector settles in. So it is the first place a direct
 * dial could leak one, and there is none to be had here — a `.anyone` endpoint
 * with no carriage throws, `readConnectorHealth` turns that into `unreachable`
 * with the reason verbatim, and every caller above already treats an
 * unreachable connector as "do not send" (ADR 0008).
 */
export function defaultConnectorReader(
  options: { timeout?: number; hidden?: HiddenTransportPort | undefined } | number = {}
): ConnectorReader {
  const resolved = typeof options === 'number' ? { timeout: options } : options;
  const timeout = resolved.timeout ?? 10_000;
  const clearnet = new ConnectorEdgeClient({ timeout });
  const hidden = resolved.hidden;
  if (hidden === undefined) return clearnet;

  /** One edge client per proxy, so the carriage's pool is shared, not rebuilt. */
  let overAnon: { proxy: string; client: ConnectorEdgeClient } | undefined;
  return {
    async describe(endpoint, describeOptions) {
      if (!isHiddenServiceUrl(endpoint)) return clearnet.describe(endpoint, describeOptions);
      const carriage = await hidden.open();
      if (overAnon?.proxy !== carriage.socksProxy) {
        overAnon = {
          proxy: carriage.socksProxy,
          client: new ConnectorEdgeClient({
            fetch: carriage.fetch,
            timeout: HIDDEN_TIMEOUT_MS,
          }),
        };
      }
      return overAnon.client.describe(endpoint, describeOptions);
    },
  };
}

export async function readConnectorHealth(
  profile: NetworkProfile,
  reader: ConnectorReader,
  options: { forceRefresh?: boolean } = {}
): Promise<ConnectorHealth> {
  if (!isConfigured(profile)) {
    return {
      state: 'unconfigured',
      reason: `${profile.label} names no connector yet, so there is nothing to ask.`,
    };
  }

  const endpoint = connectorEdgeBaseUrl(profile.connectorUrl);
  try {
    const described = await reader.describe(profile.connectorUrl, options);
    return {
      state: 'ok',
      endpoint,
      ilpAddresses: described.ilpAddresses,
      settlements: described.settlements.map(toSettlementView),
      routes: described.routes.map(toRouteView),
      peerCarriages: described.peerCarriages,
      edgeKeyId: described.edgeIdentity?.keyId,
      ...(described.edgeIdentity?.publicKey === undefined
        ? {}
        : { edgeSealKey: described.edgeIdentity.publicKey }),
      supportedVersions: described.supportedVersions,
    };
  } catch (error) {
    return { state: 'unreachable', endpoint, reason: describeError(error) };
  }
}

function toSettlementView(entry: NodeSelfDescription['settlements'][number]): SettlementView {
  return {
    chain: entry.chain,
    kind: entry.kind,
    settlementAddress: entry.settlementAddress,
    tokenAddress: entry.tokenAddress,
    decimals: entry.decimals,
  };
}

function toRouteView(entry: NodeSelfDescription['routes'][number]): RouteView {
  return {
    prefix: entry.prefix,
    price: String(entry.price),
    ...(entry.pricePerKib === undefined ? {} : { pricePerKib: String(entry.pricePerKib) }),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
