import type { ChainSeedStore } from './chain-seed.js';
import type { ConnectorHealth, SettlementView } from './connector-health.js';
import {
  FundingStore,
  type ChainOpenError,
  type ChainPort,
  type DripRequest,
  type FaucetView,
  type FundingDeps,
  type OpenChannelRequest,
  type OpenedChannel,
  type QuoteView,
  type WalletReadRequest,
  type WalletReadResult,
} from './funding.js';
import type { ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';

/**
 * A chain that does what a test tells it to.
 *
 * Every hard case this ticket cares about is a chain behaving badly — an RPC
 * endpoint that does not answer, an address with no gas, an open that takes a
 * while, an open that is refused for want of gas — and none of them is
 * reproducible against a real chain on demand. So the port is faked and the
 * policy is tested; `funding-chain.ts` is the thin layer that is not.
 */
export interface FakeChainState {
  /** Per chain key: what a wallet read answers, or a fault to throw. */
  wallets: Map<string, WalletReadResult>;
  /** Chains whose RPC endpoint does not answer at all. */
  unreachable: Set<string>;
  /** Resolved when a test lets an in-flight open finish. */
  release?: () => void;
  /** What the open answers, once released. */
  opened?: OpenedChannel;
  /** Thrown by the open instead, when set. */
  openFails?: ChainOpenError;
  faucet?: FaucetView;
  quote?: QuoteView;
  /** Every open this port was asked for, in order. */
  opens: OpenChannelRequest[];
  drips: DripRequest[];
}

export interface FakeChainPort extends ChainPort {
  readonly state: FakeChainState;
  /** Hold the next open until `finishOpen` is called. */
  blockOpen(): void;
  finishOpen(): void;
}

export function fakeChainPort(initial: Partial<FakeChainState> = {}): FakeChainPort {
  const state: FakeChainState = {
    wallets: initial.wallets ?? new Map(),
    unreachable: initial.unreachable ?? new Set(),
    opens: [],
    drips: [],
    ...(initial.opened === undefined ? {} : { opened: initial.opened }),
    ...(initial.openFails === undefined ? {} : { openFails: initial.openFails }),
    ...(initial.faucet === undefined ? {} : { faucet: initial.faucet }),
    ...(initial.quote === undefined ? {} : { quote: initial.quote }),
  };
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;

  return {
    state,
    blockOpen() {
      gate = new Promise<void>((done) => {
        release = done;
      });
    },
    finishOpen() {
      release?.();
      gate = undefined;
      release = undefined;
    },
    async readWallet(request: WalletReadRequest): Promise<WalletReadResult> {
      if (state.unreachable.has(request.chain)) {
        return { unreadable: true, error: `no route to ${request.rpcUrl}` };
      }
      // The default is an address with nothing on it — the state a fresh
      // Chain Seed is actually in, and the one the gas copy is written for.
      return (
        state.wallets.get(request.chain) ??
        (request.kind === 'evm'
          ? { native: { amount: '0', symbol: 'ETH', decimals: 18 } }
          : { native: { amount: '0', symbol: 'SOL', decimals: 9 } })
      );
    },
    async openChannel(request: OpenChannelRequest): Promise<OpenedChannel> {
      state.opens.push(request);
      if (gate) await gate;
      if (state.openFails) throw state.openFails;
      const opened = state.opened ?? {
        channelId: `0xchannel-${request.chain}`,
        status: 'open' as const,
        txHash: '0xtx',
        depositTotal: request.deposit ?? 100_000n,
      };
      // A real open writes the binding through the store it was handed; the
      // fake does the same, because the funding view reads the channel back
      // from that store and not from the open's return value.
      request.channelStore.saveBinding?.(`${request.connectorUrl}|${request.chain}|network`, {
        channelId: opened.channelId,
        context: { chainType: request.kind, chainId: 0, tokenNetworkAddress: 'network' },
        ...(opened.depositTotal === undefined ? {} : { depositTotal: opened.depositTotal }),
        openedAt: '2026-09-22T00:00:00.000Z',
      });
      request.channelStore.save(opened.channelId, { nonce: 0, cumulativeAmount: 0n });
      return opened;
    },
    async faucetInfo(faucetUrl: string): Promise<FaucetView> {
      return (
        state.faucet ?? {
          url: faucetUrl,
          state: 'ready',
          chains: [],
          givesGas: false,
        }
      );
    },
    async drip(request: DripRequest) {
      state.drips.push(request);
      return { delivered: true, message: 'minted' };
    },
    async quote(): Promise<QuoteView | undefined> {
      return state.quote;
    },
  };
}

/** A connector that settles on whatever a test says it does. */
export function healthWith(settlements: readonly SettlementView[]): ConnectorHealth {
  return {
    state: 'ok',
    endpoint: SANDBOX.connectorUrl,
    ilpAddresses: ['g.toon.relay'],
    settlements,
    routes: [],
    peerCarriages: [],
    supportedVersions: [1],
  };
}

export const EVM_SETTLEMENT: SettlementView = {
  chain: 'evm:31337',
  kind: 'evm',
  settlementAddress: '0xc0ffee0000000000000000000000000000000001',
  tokenAddress: '0xc0ffee0000000000000000000000000000000002',
  decimals: 18,
};

export const SOLANA_SETTLEMENT: SettlementView = {
  chain: 'solana',
  kind: 'solana',
  settlementAddress: 'Ho1dEr1111111111111111111111111111111111111',
  tokenAddress: 'M1nt111111111111111111111111111111111111111',
  decimals: 6,
};

/** A `FundingStore` over the fake chain, with everything else supplied. */
export function fundingStoreFor(input: {
  chainSeed: ChainSeedStore;
  paths: ConsolePaths;
  chains: ChainPort;
  profile?: NetworkProfile;
  health?: ConnectorHealth;
  now?: () => Date;
  suggestedPackets?: number;
}): FundingStore {
  const profile = input.profile ?? SANDBOX;
  const deps: FundingDeps = {
    profile: () => profile,
    chainSeed: input.chainSeed,
    readHealth: async () => input.health ?? healthWith([EVM_SETTLEMENT, SOLANA_SETTLEMENT]),
    chains: input.chains,
    paths: input.paths,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.suggestedPackets === undefined
      ? {}
      : { suggestedPackets: input.suggestedPackets }),
  };
  return new FundingStore(deps);
}
