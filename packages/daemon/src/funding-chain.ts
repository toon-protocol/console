import {
  ConnectorEdgeClient,
  ToonClient,
  fundWallet,
  isInsufficientGasError,
  readWalletBalances,
  type NodeSelfDescription,
} from '@toon-protocol/client';

import {
  carriageRefusal,
  isHiddenServiceUrl,
  type HiddenTransportPort,
} from './hidden-transport.js';
import {
  ChainOpenError,
  type Amount,
  type ChainPort,
  type DripRequest,
  type FaucetChainView,
  type FaucetView,
  type OpenChannelRequest,
  type OpenedChannel,
  type QuoteView,
  type WalletReadRequest,
  type WalletReadResult,
} from './funding.js';

/**
 * The real chains, behind `funding.ts`'s port.
 *
 * Everything that touches an RPC endpoint, a faucet or `ToonClient` is here,
 * and the policy — the gas verdict, the pending open, the refusal to turn an
 * unreachable endpoint into a zero — is next door where it can be tested
 * without any of them.
 *
 * Nothing in this file decides anything about money. The settlement facts each
 * call needs arrive from the connector's own `GET /ilp` through the request,
 * the deposit arrives from the caller, and the keys are lent for one call and
 * wiped by the lender. In particular there is no price arithmetic here: what a
 * route costs is quoted by the connector and repeated (TOON_Network#82).
 */
export class LiveChainPort implements ChainPort {
  readonly #edge: ConnectorEdgeClient;
  readonly #timeoutMs: number;
  readonly #hidden: HiddenTransportPort | undefined;
  #overAnon: { proxy: string; edge: ConnectorEdgeClient } | undefined;

  constructor(options: { timeoutMs?: number; hidden?: HiddenTransportPort } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#edge = new ConnectorEdgeClient({ timeout: this.#timeoutMs });
    this.#hidden = options.hidden;
  }

  /**
   * The edge client for one connector — over a circuit when it is a Hidden
   * Provider's (TOON_Network#98, spec §10, ADR 0008).
   *
   * A `.anyone` name must never reach `fetch` unproxied, and the reason is not
   * that the request would fail. It is that resolving one locally puts the
   * hidden service this console is about to talk to into a plaintext DNS
   * query — the single fact the address exists to withhold. `socks5h` exists
   * so the PROXY resolves it, and no carriage means no dial at all.
   */
  async #edgeFor(connectorUrl: string): Promise<ConnectorEdgeClient> {
    if (!isHiddenServiceUrl(connectorUrl)) return this.#edge;
    if (this.#hidden === undefined) {
      throw new ChainOpenError(
        `${connectorUrl} is a Hidden Provider's connector and this build has no Anyone ` +
          `Protocol carriage to reach one through, so nothing was dialled (spec §10).`,
        { outOfGas: false }
      );
    }
    const carriage = await this.#hidden.open();
    if (this.#overAnon?.proxy !== carriage.socksProxy) {
      this.#overAnon = {
        proxy: carriage.socksProxy,
        edge: new ConnectorEdgeClient({ fetch: carriage.fetch, timeout: 120_000 }),
      };
    }
    return this.#overAnon.edge;
  }

  /**
   * The native coin and the connector's settlement token, for one address.
   *
   * A read and nothing more: no key, no signature, no transaction. That is
   * what lets the funding view poll on an account whose Signer is a phone.
   *
   * `readWalletBalances` already degrades a chain it cannot reach to
   * `unreadable` rather than throwing, which is the behaviour this console
   * needs — a balance it invented would be worse than one it admits it does
   * not have.
   */
  async readWallet(request: WalletReadRequest): Promise<WalletReadResult> {
    // A `.anyone` RPC endpoint is not read here, and it is not read DIRECTLY
    // either: resolving the name locally would put it in a plaintext DNS query
    // (spec §10). No shipped profile names one; a hand-written one might, and
    // an unreadable balance is the honest answer rather than a leak.
    if (isHiddenServiceUrl(request.rpcUrl)) {
      return {
        unreadable: true,
        error:
          `${request.rpcUrl} is a hidden-service endpoint, and this console reads balances ` +
          `on clearnet only. Nothing was dialled (spec §10).`,
      };
    }
    const [chain] = await readWalletBalances(
      request.kind === 'evm'
        ? {
            evm: {
              chainKey: request.chain,
              rpcUrl: request.rpcUrl,
              owner: request.owner,
              tokenAddress: request.tokenAddress,
            },
          }
        : {
            solana: {
              chainKey: request.chain,
              rpcUrl: request.rpcUrl,
              owner: request.owner,
              tokenMint: request.tokenAddress,
            },
          }
    );
    if (!chain) return { unreadable: true, error: 'The chain reader returned nothing.' };
    if (chain.unreadable === true) {
      return {
        unreadable: true,
        ...(chain.error === undefined ? {} : { error: chain.error }),
      };
    }
    const token = chain.tokens.find((entry) =>
      sameAddress(entry.address, request.tokenAddress)
    );
    return {
      ...(chain.native === undefined ? {} : { native: toAmount(chain.native) }),
      ...(token === undefined ? {} : { token: toAmount(token) }),
      ...(chain.error === undefined ? {} : { error: chain.error }),
    };
  }

  /**
   * Open the channel, on chain, with the account's own key and its own gas.
   *
   * No connector is asked to open anything: a connector has no endpoint that
   * opens a channel, and discovers one by reading the chain (the client's ADR
   * 0052). `channel.open` adopts an already-open channel with the same
   * counterparty where there is one, so pressing this twice costs a read
   * rather than a second deposit.
   */
  async openChannel(request: OpenChannelRequest): Promise<OpenedChannel> {
    let client: ToonClient | undefined;
    // `socksProxy` and nothing beside it: the client builds the whole carriage
    // from it, and anything this console injected would win over the proxy in
    // silence. See `hidden-transport.ts`.
    const refusal = carriageRefusal({ socksProxy: request.socksProxy });
    if (refusal !== null) throw new ChainOpenError(refusal, { outOfGas: false });
    try {
      client = await ToonClient.create({
        connector: request.connectorUrl,
        evmPrivateKey: request.keys.evm.privateKey,
        solanaSecretKey: request.keys.solana.secretKey,
        chain: request.kind,
        rpcUrl: request.rpcUrl,
        channelStore: request.channelStore,
        timeoutMs: request.socksProxy === undefined ? this.#timeoutMs : 120_000,
        ...(request.socksProxy === undefined ? {} : { socksProxy: request.socksProxy }),
        ...(request.proxyRpc === undefined ? {} : { proxyRpc: request.proxyRpc }),
        // Opening is what this call IS, so it is never a side effect of
        // something else here.
        autoOpenChannel: true,
      });
      const state = await client.channel.open(
        request.deposit === undefined ? {} : { deposit: request.deposit }
      );
      return {
        channelId: state.channelId,
        status: state.status,
        ...(state.depositTotal === undefined ? {} : { depositTotal: state.depositTotal }),
      };
    } catch (error) {
      throw new ChainOpenError(messageOf(error), {
        // The library's detector, not a regular expression here: viem wraps a
        // node's insufficient-funds revert several `cause` levels deep.
        outOfGas: isInsufficientGasError(error),
        cause: error,
      });
    } finally {
      // Flushes the channel store and releases any socket. It does not touch
      // the channel — the collateral stays where the transaction put it.
      await client?.close().catch(() => undefined);
    }
  }

  /**
   * What the faucet says about itself.
   *
   * Read rather than assumed, and the reading is the point: the console tells
   * a person that this network's faucet gives the settlement token and no
   * native gas, and it can only say that honestly because the faucet reports
   * its own balances and its own drips. A faucet that started handing out gas
   * would change this view with no release here.
   *
   * Never throws. A faucet that is down is a fact about the faucet.
   */
  async faucetInfo(faucetUrl: string): Promise<FaucetView> {
    const url = `${faucetUrl.replace(/\/+$/u, '')}/api/info`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        return {
          url: faucetUrl,
          state: 'unreachable',
          reason: `${url} answered ${response.status}.`,
          chains: [],
          givesGas: false,
        };
      }
      return parseFaucetInfo(faucetUrl, await response.json());
    } catch (error) {
      return {
        url: faucetUrl,
        state: 'unreachable',
        reason: messageOf(error),
        chains: [],
        givesGas: false,
      };
    }
  }

  async drip(request: DripRequest): Promise<{ delivered: boolean; message: string }> {
    try {
      const result = await fundWallet(request.faucetUrl, request.address, request.kind);
      return {
        delivered: true,
        message: describeDrip(result.response) ?? 'The faucet accepted the request.',
      };
    } catch (error) {
      return { delivered: false, message: messageOf(error) };
    }
  }

  /**
   * The dearest route the connector publishes, and its price VERBATIM.
   *
   * The whole of the console's involvement with a price: it reads the figure
   * the connector quoted and repeats it. It does not add a per-kibibyte charge
   * of its own, because the client and the connector round that differently
   * and the connector is the one that decides (TOON_Network#82) — so a metered
   * route's rate is carried alongside, unmultiplied, and what a packet on it
   * really costs is asked for at the moment it is sent.
   */
  async quote(connectorUrl: string): Promise<QuoteView | undefined> {
    let described: NodeSelfDescription;
    try {
      described = await (await this.#edgeFor(connectorUrl)).describe(connectorUrl);
    } catch {
      return undefined;
    }
    const dearest = dearestRoute(described.routes);
    if (dearest === undefined) return undefined;
    return {
      route: dearest.prefix,
      price: dearest.price.toString(),
      ...(dearest.pricePerKib === undefined
        ? {}
        : { pricePerKib: dearest.pricePerKib.toString() }),
      // Filled in by the caller, which owns the policy of how many packets a
      // starting deposit should be worth.
      packets: 0,
    };
  }
}

/**
 * The dearest route a connector publishes — with one deliberate tie-break.
 *
 * Dearest by the flat per-packet price, and where two routes quote the same
 * one, the route that ALSO meters by size wins. It is the dearer route in
 * fact: `g.toon.relay.gas` and `g.toon.relay.store` both quote 1001 µUSDC on
 * devnet today, and only the second charges a further 10 per kibibyte, so a
 * packet on it always costs more. Taking the first of the two would have hidden
 * exactly the figure TOON_Network#82 is about.
 *
 * A route priced at zero is not a quote. A connector that publishes only free
 * routes gets no suggested deposit rather than a suggestion of nothing.
 */
export function dearestRoute(
  routes: NodeSelfDescription['routes']
): NodeSelfDescription['routes'][number] | undefined {
  const dearest = routes
    .filter((route) => route.price > 0n)
    .reduce<NodeSelfDescription['routes'][number] | undefined>((held, route) => {
      if (held === undefined || route.price > held.price) return route;
      if (route.price < held.price) return held;
      return held.pricePerKib === undefined && route.pricePerKib !== undefined ? route : held;
    }, undefined);
  return dearest;
}

/**
 * `/api/info`, as the devnet faucet answers it today and as a later one might.
 *
 * Read defensively on purpose. The live document nests a per-chain object with
 * a `ready` flag, while the field this was specified against is `tokenReady`;
 * both are accepted, because the console's job here is to report what the
 * faucet says rather than to be right about which release said it.
 *
 * A chain entry is recognised STRUCTURALLY, the same way the client tells one
 * settlement entry from another: an SPL mint names Solana, a chain id names
 * EVM. Matching on the key would have tied this to the words one faucet
 * happens to use for its networks.
 */
export function parseFaucetInfo(faucetUrl: string, body: unknown): FaucetView {
  const doc = asRecord(body);
  const chains: FaucetChainView[] = [];
  for (const [name, raw] of Object.entries(asRecord(doc.chains))) {
    const entry = asRecord(raw);
    const kind = faucetChainKind(entry);
    if (kind === undefined) continue;
    if (entry.enabled === false) continue;
    chains.push({
      kind,
      name,
      ready: entry.tokenReady === true || entry.ready === true,
      ...(typeof entry.route === 'string' ? { route: entry.route } : {}),
      drips: Object.entries(asRecord(entry.drips)).map(([asset, amount]) => ({
        asset,
        amount: String(amount),
      })),
      ...(entry.cooldownHours === undefined
        ? {}
        : { cooldownHours: String(entry.cooldownHours) }),
    });
  }
  return {
    url: faucetUrl,
    state: 'ready',
    chains,
    givesGas: faucetGivesGas(doc, chains),
  };
}

/**
 * Does this faucet have native gas to give?
 *
 * Two ways it could say yes, and on the public devnet it says neither: it
 * publishes a native drip amount beside a native balance of `null`, which is
 * the faucet telling you it would if it could. The console repeats that rather
 * than reading the advertised amount as an offer.
 */
function faucetGivesGas(
  doc: Record<string, unknown>,
  chains: readonly FaucetChainView[]
): boolean {
  const balances = asRecord(doc.faucetBalances);
  const nativeDrip = positive(doc.ethAmount);
  const nativeHeld = positive(balances.eth);
  if (nativeDrip && nativeHeld) return true;
  return chains.some((chain) =>
    chain.drips.some((drip) => NATIVE_ASSET.test(drip.asset) && positive(drip.amount))
  );
}

/** The names a faucet gives a chain's own coin, as opposed to a token. */
const NATIVE_ASSET = /^(eth|sol|native|gas)$/iu;

function faucetChainKind(entry: Record<string, unknown>): 'evm' | 'solana' | undefined {
  if (typeof entry.usdcMint === 'string' || typeof entry.mint === 'string') return 'solana';
  if (entry.chainId !== undefined || typeof entry.tokenAddress === 'string') return 'evm';
  return undefined;
}

function describeDrip(response: unknown): string | undefined {
  const body = asRecord(response);
  for (const key of ['message', 'signature', 'txHash', 'transactionHash', 'tx']) {
    const value = body[key];
    if (typeof value === 'string' && value !== '') return `${key}: ${value}`;
  }
  return undefined;
}

function toAmount(value: {
  amount: string;
  symbol?: string;
  decimals?: number;
  address?: string;
}): Amount {
  return {
    amount: value.amount,
    ...(value.symbol === undefined ? {} : { symbol: value.symbol }),
    ...(value.decimals === undefined ? {} : { decimals: value.decimals }),
    ...(value.address === undefined ? {} : { address: value.address }),
  };
}

/** EVM addresses differ in case between a connector's document and a chain read. */
function sameAddress(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function positive(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  return text !== '' && text !== '0' && Number(text) > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
