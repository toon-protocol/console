/**
 * Network profiles.
 *
 * A profile names the endpoints the console talks to and NOTHING about the
 * chains behind them. Which chains a profile settles on, what the settlement
 * addresses are, what a route costs — all of it is read from the connector's
 * own `GET /ilp` at runtime (`@toon-protocol/client`'s `ConnectorEdgeClient`).
 * That is the whole reason a profile carries a `connectorUrl` and no chain id:
 * the connector is the authority on its own terms, and a constant here would
 * be a second, staler copy of them (TOON_Network#87).
 *
 * The three built-ins are the three places the console is expected to run
 * against: the public devnet, a local docker sandbox (`infra/sandbox`), and
 * mainnet. Mainnet is deliberately shipped WITHOUT endpoints — there is no
 * public mainnet connector yet — so it is present, selectable, and honest
 * about having nothing behind it rather than pointing at a guess.
 */

/** Where a profile's endpoints came from. */
export type ProfileOrigin = 'built-in' | 'user';

/**
 * The chain nodes this profile's balances and transactions go through.
 *
 * An RPC URL is an **endpoint**, not a chain fact: it says where to ask, and
 * nothing about what the answer will be. It has to live here because a
 * connector's `GET /ilp` deliberately does not publish one — the connector is
 * the authority on its own settlement terms, not on which node a buyer should
 * read the chain from — and because the local sandbox's chains are on this
 * machine's loopback, where no preset could ever point.
 *
 * Absent means "whatever `@toon-protocol/client` defaults to", which is that
 * package's own devnet preset. That is deliberate: it keeps the public
 * devnet's RPC endpoints in the library that already publishes them rather
 * than copying them into a second place that could drift.
 *
 * The keys name a chain FAMILY and nothing more. There is no chain id here,
 * no token address and no settlement address; `profiles.test.ts` is the test
 * that says so.
 */
export interface ChainRpcEndpoints {
  readonly evm?: string;
  readonly solana?: string;
}

export interface NetworkProfile {
  /** Stable id; the key the active profile is remembered by. */
  readonly id: string;
  /** What a person sees in the switcher. */
  readonly label: string;
  /** One line on what this profile is. */
  readonly description: string;
  /**
   * The connector's client edge — `https://host` or `https://host/ilp`, both
   * normalize to the same base. Empty when the profile has no connector yet,
   * which is the whole of mainnet's story today.
   */
  readonly connectorUrl: string;
  /** The relay the Provider Directory is read from. Empty when unconfigured. */
  readonly relayUrl: string;
  /** The suffix a Workload Gateway serves hostnames under. Empty when unconfigured. */
  readonly gatewayDomain: string;
  /** Where to get test funds, when the network has a faucet. */
  readonly faucetUrl?: string | undefined;
  /** Where to read the chains and send transactions. Empty uses the client's. */
  readonly rpc: ChainRpcEndpoints;
  readonly origin: ProfileOrigin;
}

/**
 * A profile with no connector cannot be asked anything, so every view that
 * reads live facts has to branch on it. One predicate, named once.
 */
export function isConfigured(profile: NetworkProfile): boolean {
  return profile.connectorUrl.length > 0;
}

export const DEVNET: NetworkProfile = {
  id: 'devnet',
  label: 'Devnet',
  description: "TOON Network's public test network.",
  connectorUrl: 'https://proxy.relay.devnet.toonprotocol.dev/ilp',
  relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
  gatewayDomain: 'gw.devnet.toonprotocol.dev',
  faucetUrl: 'https://faucet.devnet.toonprotocol.dev',
  // Left to the client's own presets: the public test chains' endpoints are
  // published by `@toon-protocol/client` already, and a second copy here would
  // be a second thing to correct when one of them moves.
  rpc: {},
  origin: 'built-in',
};

export const SANDBOX: NetworkProfile = {
  id: 'sandbox',
  label: 'Local sandbox',
  description: "The docker sandbox in infra/sandbox, on this machine's loopback.",
  connectorUrl: 'http://localhost:3200/ilp',
  relayUrl: 'ws://localhost:7100',
  gatewayDomain: 'gw.localhost:3280',
  // The sandbox's own chains, on this machine. Nothing could default to these.
  rpc: { evm: 'http://localhost:8545', solana: 'http://localhost:8899' },
  origin: 'built-in',
};

export const MAINNET: NetworkProfile = {
  id: 'mainnet',
  label: 'Mainnet',
  description: 'Reserved. No public mainnet connector has been announced yet.',
  connectorUrl: '',
  relayUrl: '',
  gatewayDomain: '',
  rpc: {},
  origin: 'built-in',
};

export const BUILT_IN_PROFILES: readonly NetworkProfile[] = [DEVNET, SANDBOX, MAINNET];

export const DEFAULT_PROFILE_ID = DEVNET.id;

export function findBuiltIn(id: string): NetworkProfile | undefined {
  return BUILT_IN_PROFILES.find((profile) => profile.id === id);
}
