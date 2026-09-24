import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EvmSigner,
  deriveFullIdentity,
  generateMnemonic,
  readWalletBalances,
  sendTransfer,
} from '@toon-protocol/client';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decode as nip19decode, npubEncode, nsecEncode } from 'nostr-tools/nip19';

import { defaultConnectorReader, readConnectorHealth } from './connector-health.js';
import type { NostrEvent } from './nostr.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import type { NetworkProfile } from './profiles.js';
import { PaidRelayWriter } from './relay-write.js';
import { LiveRelayWritePort } from './relay-write-route.js';
import {
  SmokeRun,
  must,
  planConditional,
  present,
  summarize,
  type NetworkFacts,
  type SmokeReport,
} from './smoke-console.js';
import { readOciEntry } from './smoke-image.js';

/**
 * The live half of `smoke-console` (TOON_Network#101).
 *
 * It starts a daemon of its own on a data directory nobody else has, drives
 * `/api/*` exactly as the window does, and asserts each answer. Everything it
 * knows about the network it reads FROM the network: the chains from the
 * connector's `GET /ilp` through `/api/funding`, the providers and their
 * Listings from the Provider Directory, the gateway from its connector's own
 * route list. There is no chain id, price, address or provider key in this
 * file, which is the same rule the daemon itself is held to.
 *
 * ## What it is careful about, and why
 *
 * **It never touches a console anybody is using.** `XDG_DATA_HOME`,
 * `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` are pointed at a temporary tree, the
 * port is `0` so the kernel picks one, and the keystore is forced to the
 * passphrase-encrypted file so that no key of this run's reaches a session
 * keyring. It starts and stops one process it spawned itself; it does not know
 * what `systemctl` is.
 *
 * **It holds its own two keys, and the daemon holds neither for it.** The
 * account key is generated here as an `nsec` and imported, because the fresh
 * data directory at the end has to sign in as the SAME account — that is the
 * whole of the vault-recovery assertion, and a key the daemon generated could
 * not be produced again. The Chain Seed is generated here as a BIP-39 phrase
 * and imported for the same shape of reason plus one more: the console has no
 * route that publishes an arbitrary event, so the one event this smoke must
 * put on a relay itself — the Template — is paid for by a `PaidRelayWriter`
 * built here, exactly as `toon-docs-publish` builds one, from the same seed
 * the daemon is using. Neither key is ever printed.
 *
 * **It pays for what it does.** Every spend is reported per stage and summed,
 * because a smoke that quietly costs money is worse than no smoke. The one
 * place it is deliberately spent twice is nowhere: there is one lease per run.
 *
 * **A lease is ended even when a stage failed.** The teardown runs in a
 * `finally`, and the last stage asserts the ending rather than assuming it.
 */

/* -------------------------------------------------------------------------- */
/* What a run is given                                                        */
/* -------------------------------------------------------------------------- */

export interface SmokeOptions {
  readonly profile: NetworkProfile;
  /** The image the Template names. Anything a public OCI registry serves. */
  readonly image: string;
  /** The Listing's `d` name to buy on. Absent picks the cheapest live one. */
  readonly listing?: string | undefined;
  /** The provider to buy from, by pubkey. Absent picks the first live one. */
  readonly provider?: string | undefined;
  /** Which settlement chain to fund and pay on. Absent picks the first fundable. */
  readonly chain?: string | undefined;
  /**
   * The `relay` the published Template hints at. Absent takes the chosen
   * provider's own Relay Set, which is the spelling that provider can follow.
   */
  readonly templateRelay?: string | undefined;
  /** Collateral, base units. Absent takes the connector's own suggestion. */
  readonly deposit?: string | undefined;
  /** Native coin to top the payer up to, base units. Absent is the default below. */
  readonly gas?: string | undefined;
  /** The BIP-39 phrase whose account 0 holds the test funds. */
  readonly funder: string;
  /**
   * The account's Chain Seed, so a devnet run can re-use one channel instead
   * of stranding a little collateral at a fresh address every time. Absent
   * mints a fresh phrase, which is right for a sandbox and wasteful on devnet.
   */
  readonly chainSeed?: string | undefined;
  /** The account's Nostr key, for the same reason. Absent generates one. */
  readonly nsec?: string | undefined;
  /**
   * Where the FIRST daemon keeps its data, kept between runs.
   *
   * A channel's watermark is local bookkeeping: the connector remembers how
   * far this channel's claims have advanced, and a console that opens with a
   * fresh store signs a claim the connector refuses as `replay` (F01) — and is
   * billed for the refusal. So re-using a Chain Seed is only half of re-using
   * a channel; this is the other half. Absent, the run gets a temporary
   * directory and deletes it, which is right for a sandbox and wasteful on a
   * network whose money is worth something.
   *
   * The RECOVERY daemon is always a fresh directory, whatever this says. That
   * is the assertion the whole smoke exists for.
   */
  readonly stateDir?: string | undefined;
  /** Leave the lease running and the data directories behind. For debugging. */
  readonly keep: boolean;
  readonly json: boolean;
  readonly log: (line: string) => void;
}

/**
 * Native coin to leave at the payer address when it has none.
 *
 * A POLICY, not a chain fact: enough for a channel open and its approval on a
 * test chain, small enough that a devnet run strands pennies. `--gas` is the
 * knob, and the `clean` stage reports what was left behind either way.
 */
const GAS_DEFAULT: Readonly<Record<'evm' | 'solana', string>> = {
  evm: '2000000000000000', // 0.002 of an 18-decimal coin
  solana: '50000000', // 0.05 SOL
};

/**
 * Never hand the funder's whole balance to the payer.
 *
 * The amounts above are what a LOCAL chain wants, where an open costs real
 * gwei and the funder holds thousands of coins. On a public test chain the
 * same account holds a fraction of one — Foundry's account 0 on Base Sepolia
 * had 0.000064 ETH the day this was written — and sending it all away leaves
 * the funder unable to pay for the transfer it is making. So the target is
 * capped at half of what the funder holds, which on a local chain never binds
 * and on a public one always does. `--gas` overrides it outright.
 */
export function gasTargetFor(chain: ChainView, held: bigint, asked?: string): bigint {
  if (asked !== undefined) return BigInt(asked);
  const wanted = BigInt(GAS_DEFAULT[chain.kind]);
  const affordable = held / 2n;
  return wanted < affordable ? wanted : affordable;
}

/** How long a channel open is given before the run calls it stuck. */
const OPEN_TIMEOUT_MS = 180_000;

/**
 * How long bought gas is given to show up in a balance read.
 *
 * The gas station answers only after the transaction has CONFIRMED, so this is
 * the gap between a confirmation and an RPC replica agreeing — seconds on a
 * local validator, and long enough on a public cluster that a tighter deadline
 * would read as "the purchase failed" on a purchase that worked.
 */
const GAS_ARRIVAL_TIMEOUT_MS = 90_000;
/** How long a fresh container is given to report `running`. */
const RUNNING_TIMEOUT_MS = 180_000;

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const run = new SmokeRun(
    options.profile.label,
    options.profile.connectorUrl,
    options.profile.relayUrl,
    options.log
  );

  // Two keys, both this run's own, both generated before anything starts so
  // that the fresh data directory at the end can be the SAME account.
  const nsec = options.nsec ?? nsecEncode(generateSecretKey());
  const pubkey = getPublicKey(secretFromNsec(nsec));
  const mnemonic = options.chainSeed ?? generateMnemonic();
  const passphrase = randomPassphrase();
  const sshPublicKey = generateSshKey();

  const homes: string[] = [];
  const daemons: Daemon[] = [];
  let daemon: Daemon | undefined;
  let workloadId: string | undefined;

  try {
    daemon = await run.run('daemon', async (step) => {
      const home = options.stateDir ?? mkdtempSync(join(tmpdir(), 'toon-smoke-'));
      mkdirSync(home, { recursive: true });
      // A directory somebody asked to keep is not one this run deletes.
      if (options.stateDir === undefined) homes.push(home);
      const started = await startDaemon(home, options.profile.id);
      daemons.push(started);
      const health = await started.get('/api/health');
      must(health.status === 200, `GET /api/health answered ${health.status}`);
      const profiles = await started.post('/api/profiles/active', { id: options.profile.id });
      must(
        (profiles.body as { activeId?: string }).activeId === options.profile.id,
        `the daemon would not switch to the “${options.profile.id}” profile`
      );
      step.fact(
        `a daemon on ${started.url}, profile ${options.profile.id}, keeping its state in ` +
          `${options.stateDir === undefined ? 'a temporary directory' : `${home} (kept)`}`
      );
      return started;
    });
    if (daemon === undefined) return run.report();

    const api = daemon;

    await run.run('signin', async (step) => {
      const added = await api.post('/api/account/signers/local', {
        mode: 'nsec',
        nsec,
        label: 'smoke-console',
        passphrase,
      });
      must(added.status === 200, `sign-in answered ${added.status}: ${text(added.body)}`);
      const account = (added.body as { account?: { pubkey?: string; signerKind?: string } })
        .account;
      must(account?.pubkey === pubkey, 'the daemon signed in as a different account');
      must(account?.signerKind === 'local', 'the signer is not the local keystore');
      // The rule ADR 0020 turns on: nothing that went in comes back out.
      must(
        !JSON.stringify(added.body).includes(nsec),
        'the sign-in answer echoed the nsec back — a key must never leave the daemon'
      );
      step.fact(
        `${npubEncode(pubkey)} signed in from the local keystore, and no key came back`
      );
    });
    if (!run.passed('signin')) return run.report();

    await run.run('chain-seed', async (step) => {
      await api.post('/api/chain-seed/acknowledge', {});
      const sealed = await api.post('/api/chain-seed/import', { mnemonic });
      must(
        sealed.status === 200,
        `the seed import answered ${sealed.status}: ${text(sealed.body)}`
      );
      const body = sealed.body as {
        addresses?: { evm?: { address?: string }; solana?: { address?: string } };
        origin?: string;
      };
      const expected = deriveFullIdentity(mnemonic, { accountIndex: 0 });
      must(
        body.addresses?.evm?.address?.toLowerCase() === expected.evm.address.toLowerCase(),
        'the console derived a different EVM payer address from this seed'
      );
      must(
        body.addresses.solana?.address === expected.solana.publicKey,
        'the console derived a different Solana payer address from this seed'
      );
      wipeIdentity(expected);
      must(
        !JSON.stringify(sealed.body).includes(mnemonic),
        'the seed answer echoed the phrase back'
      );
      step.fact(
        `sealed to the account; its payer addresses are the seed's own, and the phrase did not come back`
      );
    });
    if (!run.passed('chain-seed')) return run.report();

    const target = await run.run('directory', async (step) => {
      const read = await api.get('/api/directory');
      must(read.status === 200, `GET /api/directory answered ${read.status}`);
      const providers = (read.body as { providers?: ProviderView[] }).providers ?? [];
      must(providers.length > 0, 'the Provider Directory on this relay is empty');
      const chosen = chooseProvider(providers, options);
      step.fact(
        `${providers.length} provider(s); buying ${chosen.listing.name} v${chosen.listing.version} ` +
          `(${chosen.listing.leaseIntervalSeconds}s at ${chosen.listing.price}) from ` +
          `${chosen.provider.pubkey.slice(0, 12)}…`
      );
      return chosen;
    });
    if (target === undefined) return run.report();

    const facts = await readNetworkFacts(options.profile, target.providers);

    const funded = await run.run('funds', async (step) => {
      // Every connector that will collect from this account, not just the
      // profile's. A relay write is bought at the profile's connector; a lease
      // is bought wherever the packet TERMINATES, which is the profile's
      // connector when it publishes a route carrying the provider's prefix and
      // the provider's own otherwise (§4.1, §5, ADR 0005). On the sandbox that
      // is one connector; on devnet it is two, and a run that opened only the
      // first would be refused `no_channel` after paying for a Template.
      const collectors = await collectingConnectors(api, options.profile, target.provider);

      let picked: ChainView | undefined;
      let alternatives: string[] = [];
      const opened: string[] = [];
      for (const connector of collectors) {
        const where =
          connector === options.profile.connectorUrl
            ? ''
            : `&connector=${encodeURIComponent(connector)}`;
        const view = await api.get(`/api/funding?refresh=1${where}`);
        must(view.status === 200, `GET /api/funding for ${connector} answered ${view.status}`);
        const chains = (view.body as { chains?: ChainView[] }).chains ?? [];
        must(chains.length > 0, `${connector} publishes no settlement chain at all`);
        if (picked === undefined) {
          alternatives = chains.map((entry) => entry.chain);
        }

        const wanted =
          picked !== undefined
            ? chains.filter((chain) => chain.chain === picked?.chain)
            : options.chain === undefined
              ? chains
              : chains.filter((chain) => chain.chain === options.chain);
        must(
          wanted.length > 0,
          `${connector} settles on ${chains.map((entry) => entry.chain).join(', ')}, and this ` +
            `run pays on ${JSON.stringify(picked?.chain ?? options.chain)}. Both connectors have ` +
            'to settle the chain a lease is bought on, or one of them would have to convert.'
        );

        const chain = await firstFundable(wanted, options.funder);
        must(
          chain !== undefined,
          `the funder holds neither the native coin nor the settlement token on any of ` +
            `${wanted.map((entry) => entry.chain).join(', ')} at ${connector}. Its account 0 is ` +
            `${funderAddress(options.funder, wanted[0]?.kind ?? 'evm')}; fund that, or set ` +
            'TOON_SMOKE_FUNDER_MNEMONIC to a phrase that holds test money here.'
        );
        picked ??= chain;

        if (chain.channel.phase === 'open') {
          step.fact(
            `${connector} already holds channel ${chain.channel.channelId?.slice(0, 18)}… with ` +
              `${chain.channel.available ?? 'an unknown balance'} left; nothing was funded`
          );
          opened.push(connector);
          continue;
        }

        const deposit = BigInt(options.deposit ?? chain.suggestedDeposit ?? '0');
        must(
          deposit > 0n,
          `${connector} suggested no collateral for ${chain.chain}; pass --deposit`
        );
        const held = present(
          await funderBalances(chain, options.funder),
          `the funder's balances on ${chain.chain} could not be read`
        );
        const gasTarget = gasTargetFor(chain, held.native, options.gas);
        for (const line of await topUp(chain, options.funder, deposit, gasTarget)) {
          step.fact(line);
        }

        // Asked again AFTER funding, because the console reaches a gas verdict
        // per chain and the whole of #90 is that an open blocked on gas says so
        // before the transaction rather than after it.
        const ready = await chainAt(api, connector, options.profile, chain.chain);
        must(
          ready.canOpen,
          `${connector} still will not open on ${chain.chain}: ${
            ready.blockedBy ?? 'no reason ' + 'given'
          }. Raise --gas if this is about the chain's own coin.`
        );

        const answer = await api.post('/api/funding/channel', {
          chain: chain.chain,
          deposit: deposit.toString(),
          ...(connector === options.profile.connectorUrl ? {} : { connector }),
        });
        must(
          answer.status === 200,
          `opening a channel with ${connector} answered ${answer.status}: ${text(answer.body)}`
        );
        const open = await waitForChannel(
          api,
          connector,
          options.profile,
          chain.chain,
          OPEN_TIMEOUT_MS
        );
        must(
          open.phase === 'open',
          `the channel with ${connector} is “${open.phase}” after ` +
            `${Math.round(OPEN_TIMEOUT_MS / 1000)}s` +
            (open.reason === undefined ? '' : `: ${open.reason}`)
        );
        step.fact(
          `a channel with ${connector} (${chain.counterparty}) on ${chain.chain}, ` +
            `${open.deposit} base units of collateral, channel ${open.channelId?.slice(0, 18)}…`
        );
        opened.push(connector);
      }

      const chain = present(picked, 'no chain was settled on');
      run.settles(chain.chain, chain.token.address);
      step.fact(
        `${opened.length} channel(s) on ${chain.chain}, one per connector that collects: ` +
          `${opened.join(', ')}` +
          (alternatives.length <= 1
            ? ''
            : `; it also settles on ${alternatives
                .filter((entry) => entry !== chain.chain)
                .join(', ')}, which \`--chain\` would pick instead`)
      );
      return {
        chain,
        collectors,
        alternatives: alternatives.filter((entry) => entry !== chain.chain),
      };
    });
    if (funded === undefined) return run.report();

    // Buying the next chain's gas with the chain that is already paid for
    // (TOON_Network#119). It goes HERE, after `funds` and before anything is
    // spawned, because that is where it belongs in a person's day: one chain
    // is funded, another is not, and this is the step that closes the gap
    // without sending them outside the network.
    //
    // It proves the thing and then proves it MATTERED: a chain the console
    // refused to open on for want of gas, gas bought over the other chain's
    // channel, and then the same open going through unaided.
    await run.run('gas-station', async (step) => {
      const plan = await api.get('/api/funding/gas');
      must(plan.status === 200, `GET /api/funding/gas answered ${plan.status}`);
      const view = plan.body as GasStationStatus;
      if (view.state !== 'ready') {
        step.skip(
          `this console has nothing to buy gas with here: ${view.reason ?? view.state}.`
        );
      }
      if (view.chains.every((chain) => chain.verdict !== 'buyable')) {
        step.skip(
          'no chain on this network is both blocked for want of gas and buyable through a ' +
            `gas station. ${view.chains
              .map((chain) => `${chain.chain}: ${chain.verdict}`)
              .join('; ')}. ` +
            (view.firstChannel ?? '')
        );
      }
      const target = present(
        view.chains.find((chain) => chain.verdict === 'buyable'),
        'a buyable chain was there a line ago'
      );

      // NOTHING is funded on this chain before the purchase. Not the gas,
      // obviously — that is the thing being bought — but not the collateral
      // either, because the funder's own transfer would be the second way
      // money reached this address and a stage that used two could not say
      // which one unblocked it.
      const blocked = await chainAt(
        api,
        options.profile.connectorUrl,
        options.profile,
        target.chain
      );
      must(
        !blocked.canOpen && blocked.gas?.verdict === 'none',
        `${target.chain} was supposed to be blocked for want of gas before this stage and the ` +
          `console says canOpen=${blocked.canOpen}, gas=${blocked.gas?.verdict ?? '?'}`
      );
      step.fact(
        `${target.chain} will not open: ${blocked.blockedBy ?? 'no reason given'} — and the ` +
          `claim that is about to buy that gas is signed on ${target.payer?.chain}, which ` +
          `costs no gas on any chain`
      );

      // A quote, and — if the first one is refused — the one thing a person
      // would do about it.
      //
      // Which door takes which phase is published nowhere: a connector prices
      // a route's prefix and never names the handler path it terminates at.
      // On devnet the relay hub forwards exactly ONE of the gas station's
      // three doors and it is the execute-only one, so the first quote a
      // fresh console sends through the channel it already holds is refused
      // F00 — billed, and worth every bit of it, because the console then
      // knows. What it says to do next is open a channel with the station's
      // own connector, which terminates all three; that is a #92 open with a
      // `connector`, it spends collateral and chain gas, and it is the
      // PERSON's to decide — `gas-station.ts` never opens a channel on its
      // own. This stage is that person.
      let quoted = await api.post('/api/funding/gas/quote', { chain: target.chain });
      if (quoted.status !== 200) {
        const again = (
          (await api.get('/api/funding/gas')).body as GasStationStatus
        ).chains.find((chain) => chain.chain === target.chain);
        const elsewhere = again?.openChannelWith;
        must(
          elsewhere !== undefined,
          `quoting gas for ${target.chain} answered ${quoted.status}: ${text(quoted.body)}`
        );
        step.fact(
          `the first quote was refused and billed; the console now says why and where to go ` +
            `instead: ${again?.reason ?? ''}`
        );
        const payOn = present(target.payer, 'a buyable chain named no payer').chain;
        // That channel is a THIRD one on the paying chain, so it wants its own
        // collateral and its own gas: the first two took what `funds` sent.
        const payView = await chainAt(api, elsewhere, options.profile, payOn);
        const stationDeposit = BigInt(options.deposit ?? payView.suggestedDeposit ?? '0');
        const funderHeld = present(
          await funderBalances(payView, options.funder),
          `the funder's balances on ${payOn} could not be read`
        );
        for (const line of await topUp(
          payView,
          options.funder,
          stationDeposit,
          gasTargetFor(payView, funderHeld.native, options.gas)
        )) {
          step.fact(`${payOn}: ${line}`);
        }
        const second = await api.post('/api/funding/channel', {
          chain: payOn,
          connector: elsewhere,
          ...(stationDeposit > 0n ? { deposit: stationDeposit.toString() } : {}),
        });
        must(
          second.status === 200,
          `opening a channel with ${elsewhere} on ${payOn} answered ${second.status}: ` +
            text(second.body)
        );
        const open = await waitForChannel(
          api,
          elsewhere,
          options.profile,
          payOn,
          OPEN_TIMEOUT_MS
        );
        must(
          open.phase === 'open',
          `the channel with ${elsewhere} on ${payOn} is “${open.phase}”` +
            (open.reason === undefined ? '' : `: ${open.reason}`)
        );
        step.fact(
          `opened a channel with the gas station's own connector on ${payOn} ` +
            `(${open.channelId?.slice(0, 18)}…), which terminates every door it publishes`
        );
        quoted = await api.post('/api/funding/gas/quote', { chain: target.chain });
      }
      must(
        quoted.status === 200,
        `quoting gas for ${target.chain} answered ${quoted.status}: ${text(quoted.body)}`
      );
      const quote = quoted.body as GasQuote;
      step.spent(sum(quote.attempts.map((attempt) => attempt.cost)));
      must(
        quote.quoteId !== '' && quote.feePayer !== '' && quote.recentBlockhash !== '',
        `the quote for ${target.chain} named no quoteId, fee payer or blockhash: ${text(quote)}`
      );
      must(
        quote.recipient === blocked.deposit.address,
        `the quote would send gas to ${quote.recipient} and this account's address on ` +
          `${target.chain} is ${blocked.deposit.address}`
      );
      step.fact(
        `quoted ${quote.lamports} lamports to ${quote.recipient.slice(0, 12)}… from the ` +
          `station's fee payer ${quote.feePayer.slice(0, 12)}…, ceiling ${quote.maxLamports}, ` +
          `on ${quote.destination} at ${quote.price} base units a packet`
      );

      const bought = await api.post('/api/funding/gas/buy', {
        chain: target.chain,
        quoteId: quote.quoteId,
      });
      must(
        bought.status === 200,
        `buying gas for ${target.chain} answered ${bought.status}: ${text(bought.body)}`
      );
      const purchase = bought.body as GasPurchase;
      step.spent(
        sum(purchase.attempts.slice(quote.attempts.length).map((attempt) => attempt.cost))
      );
      must(
        purchase.state === 'delivered',
        `the gas station did not deliver: ${purchase.state} ` +
          `${purchase.reason ?? ''} ${purchase.detail ?? ''}`.trim()
      );
      step.fact(
        `the station co-signed and broadcast it: ${purchase.signature?.slice(0, 16)}…, ` +
          `${purchase.lamports} lamports, ${purchase.cost ?? '0'} base units all in`
      );

      // The chain, not the receipt. A transaction that was broadcast is not a
      // balance; what decides this stage is the console reading the address
      // and changing its own mind about the open.
      const arrived = await waitFor(
        async () => {
          const chain = await chainAt(
            api,
            options.profile.connectorUrl,
            options.profile,
            target.chain
          );
          return chain.canOpen ? chain : undefined;
        },
        GAS_ARRIVAL_TIMEOUT_MS,
        () =>
          `${target.chain} still cannot open ${Math.round(GAS_ARRIVAL_TIMEOUT_MS / 1000)}s ` +
          `after the gas station broadcast the transfer`,
        3_000
      );
      step.fact(
        `the console re-read ${target.chain} and changed its mind: it now holds ` +
          `${arrived.balances.native?.amount ?? '?'} base units of the native coin, and the ` +
          `open is no longer blocked`
      );

      // Only now the collateral, and ONLY the collateral: nothing here sends
      // the native coin, so the coin this channel opens on is the coin the gas
      // station sold.
      //
      // The token is asked of the FAUCET first, through the console's own
      // route. That is the division this whole ticket is arranged around, run
      // in order: the faucet gives the settlement token and no gas, the gas
      // station gives the gas and no token, and between them an address that
      // held neither can open a channel. The funder is the fallback for a
      // network with no faucet — the sandbox.
      let held = arrived;
      if (options.profile.faucetUrl !== undefined && options.profile.faucetUrl !== '') {
        const drip = await api.post('/api/funding/faucet', { chain: target.chain });
        const last = (drip.body as { faucet?: { lastDrip?: { message?: string } } }).faucet
          ?.lastDrip;
        step.fact(
          `the faucet was asked for the settlement token on ${target.chain}: ` +
            `${last?.message ?? 'it said nothing'} — it gives the token and no gas, which is ` +
            `the other half of what an open costs`
        );
        held = await chainAt(api, options.profile.connectorUrl, options.profile, target.chain);
      }
      if (BigInt(held.balances.token?.amount ?? '0') === 0n) {
        for (const line of await topUp(
          held,
          options.funder,
          BigInt(options.deposit ?? held.suggestedDeposit ?? '0'),
          0n
        )) {
          step.fact(`${target.chain}: ${line}`);
        }
        held = await chainAt(api, options.profile.connectorUrl, options.profile, target.chain);
      }

      // Whatever the token balance now is, capped at what the connector
      // suggests. The figure is not the point — that this address can open at
      // all, on gas it bought, is.
      const suggested = BigInt(options.deposit ?? held.suggestedDeposit ?? '0');
      const balance = BigInt(held.balances.token?.amount ?? '0');
      const collateral = suggested > 0n && suggested < balance ? suggested : balance;
      must(
        collateral > 0n,
        `${target.chain} holds no settlement token, so there is no collateral to open with. ` +
          `The gas arrived; the token did not.`
      );
      const answer = await api.post('/api/funding/channel', {
        chain: target.chain,
        deposit: collateral.toString(),
      });
      must(
        answer.status === 200,
        `opening a channel on ${target.chain} answered ${answer.status}: ${text(answer.body)}`
      );
      const open = await waitForChannel(
        api,
        options.profile.connectorUrl,
        options.profile,
        target.chain,
        OPEN_TIMEOUT_MS
      );
      must(
        open.phase === 'open',
        `the channel on ${target.chain} is “${open.phase}” after the bought gas` +
          (open.reason === undefined ? '' : `: ${open.reason}`)
      );
      step.fact(
        `${target.chain} opened a channel UNAIDED on gas bought over ${target.payer?.chain}: ` +
          `${open.channelId?.slice(0, 18)}…, ${open.deposit} base units of collateral`
      );
    });

    await run.run('publish-seed', async (step) => {
      const published = await api.post('/api/chain-seed/publish', {});
      must(
        published.status === 200,
        `publishing the seed answered ${published.status}: ${text(published.body)}`
      );
      const body = published.body as {
        state?: string;
        lastPublish?: { cost?: string; accepted?: string[] };
      };
      step.spent(body.lastPublish?.cost);
      must(
        body.state === 'ready',
        `the seed is “${body.state}” rather than recoverable after its write`
      );
      must(
        (body.lastPublish?.accepted ?? []).length > 0,
        'no relay accepted the sealed record, so the account could not recover it'
      );
      step.fact(
        `the sealed record is on ${(body.lastPublish?.accepted ?? []).join(', ')}, bought for ` +
          `${body.lastPublish?.cost ?? '0'} base units`
      );
    });
    if (!run.passed('publish-seed')) return run.report();

    const template = await run.run('template', async (step) => {
      const published = await publishTemplate({
        options,
        paths: daemonPaths(api.home),
        relay: templateRelay(options, target.provider),
        mnemonic,
        nsec,
        pubkey,
        arch: target.listing.arch,
        onCost: step.spent,
        onFact: step.fact,
      });
      const address = published.address;
      target.imageDigest = published.digest;
      const gallery = await api.get('/api/templates');
      must(gallery.status === 200, `GET /api/templates answered ${gallery.status}`);
      const found = ((gallery.body as { templates?: TemplateView[] }).templates ?? []).find(
        (candidate) => candidate.address === address
      );
      must(
        found !== undefined,
        `the Template ${address} was written but the gallery does not carry it back`
      );
      must(
        found.availability.state === 'available',
        `the gallery calls the Template unavailable: ${found.availability.reason ?? ''}`
      );
      const expanded = await api.post('/api/templates/expand', {
        template: address,
        sshPublicKey,
      });
      must(
        expanded.status === 200,
        `expanding it answered ${expanded.status}: ${text(expanded.body)}`
      );
      const spawnContent = (expanded.body as { spawn?: { image?: { digest?: string } } })
        .spawn;
      must(
        spawnContent?.image?.digest === found.image.digest,
        'the expansion names a different image from the Template'
      );
      step.fact(
        `the gallery reads it back as available and expands it to ${found.image.digest.slice(0, 20)}…`
      );
      return address;
    });
    if (template === undefined) return run.report();

    workloadId = await run.run('spawn', async (step) => {
      const spawned = await api.post('/api/templates/spawn', {
        template,
        provider: target.provider.pubkey,
        listing: target.listing.name,
        listingVersion: target.listing.version,
        sshPublicKey,
      });
      must(
        spawned.status === 200,
        `the spawn answered ${spawned.status}: ${text(spawned.body)}${crossingHint(
          text(spawned.body),
          funded
        )}`
      );
      const result = spawned.body as {
        cost?: string;
        lease?: { workloadId?: string; state?: string; relays?: string[]; template?: string };
      };
      step.spent(result.cost);
      const lease = present(result.lease, 'the spawn returned no lease');
      const id = present(lease.workloadId, 'the lease names no workload id');
      must(
        lease.state === 'live',
        `the vault calls the lease “${lease.state}” after the spawn`
      );
      must(
        (lease.relays ?? []).length > 0,
        'no relay holds the Root Secret, so the lease exists only on this disk'
      );
      must(
        lease.template === template,
        'the vault record does not name the Template it came from'
      );
      must(
        !JSON.stringify(spawned.body).includes(mnemonic),
        'the spawn answer carried key material'
      );
      step.fact(
        `workload ${id.slice(0, 16)}… bought for ${result.cost ?? '0'} base units, Root Secret ` +
          `sealed on ${(lease.relays ?? []).join(', ')} before the packet left`
      );
      return id;
    });
    if (workloadId === undefined) return run.report();
    const id = workloadId;

    await run.run('dashboard', async (step) => {
      const card = await waitForRunning(api, id, RUNNING_TIMEOUT_MS);
      must(
        card.status.kind === 'read',
        `the provider's status is “${card.status.kind}”` +
          ('reason' in card.status ? `: ${card.status.reason}` : '') +
          ('message' in card.status ? `: ${card.status.message}` : '')
      );
      step.spent(card.status.cost);
      must(
        card.status.life.phase === 'running',
        `the lease is “${card.status.life.phase}”, not running`
      );
      must(
        card.runway.state !== 'unknown',
        `the runway is unknown: ${card.runway.reason ?? 'no reason given'}`
      );
      step.fact(
        `running until ${new Date((card.status.expiresAt ?? 0) * 1000).toISOString()}, runway ` +
          `${card.runway.state}` +
          (card.runway.affordableIntervals === undefined
            ? ''
            : ` — ${card.runway.affordableIntervals} more interval(s) affordable`)
      );
    });

    await run.run('extend', async (step) => {
      const before = await card(api, id);
      const extended = await api.post(`/api/workloads/${id}/extend`, {});
      must(
        extended.status === 200,
        `extend answered ${extended.status}: ${text(extended.body)}`
      );
      const result = extended.body as {
        sent?: boolean;
        problems?: string[];
        cost?: string;
        expiresAt?: number;
        op?: string;
        providerError?: string;
        message?: string;
      };
      step.spent(result.cost);
      must(
        result.sent === true,
        `nothing was sent: ${(result.problems ?? []).join(' ') || 'no reason given'}`
      );
      must(
        result.providerError === undefined,
        `the provider refused with ${result.providerError} — and billed for it (ADR 0003): ` +
          `${result.message ?? ''}`
      );
      const was = before.status.kind === 'read' ? (before.status.expiresAt ?? 0) : 0;
      must(
        (result.expiresAt ?? 0) > was,
        `the expiry did not move: ${was} → ${result.expiresAt ?? 'nothing'}`
      );
      step.fact(
        `one interval on \`${result.op}\` for ${result.cost ?? '0'} base units; expiry moved ` +
          `${(result.expiresAt ?? 0) - was}s to ${new Date((result.expiresAt ?? 0) * 1000).toISOString()}`
      );
    });

    await run.run('rotate', async (step) => {
      const rotated = await api.post(`/api/workloads/${id}/rotate`, {});
      must(rotated.status === 200, `rotate answered ${rotated.status}: ${text(rotated.body)}`);
      const result = rotated.body as {
        started?: boolean;
        rotated?: boolean;
        confirmed?: number;
        of?: number;
        problems?: string[];
        cost?: string;
        vaultCost?: string;
      };
      step.spent(result.cost);
      step.spent(result.vaultCost);
      must(
        result.started === true,
        `nothing was sent: ${(result.problems ?? []).join(' ') || 'the vault record was not written'}`
      );
      must(
        result.rotated === true,
        `only ${result.confirmed ?? 0} of ${result.of ?? 0} members hold the new token: ` +
          `${(result.problems ?? []).join(' ')}`
      );
      must(
        !JSON.stringify(rotated.body).includes('root'),
        'the rotation answer mentions a root secret'
      );
      // A rotation is a revocation, so the lease must still answer afterwards
      // — with the NEW token, which is the only one the console now holds.
      const after = await card(api, id, true);
      must(
        after.status.kind === 'read',
        'the lease stopped answering after its token was replaced, which is what a rotation ' +
          'gone wrong looks like'
      );
      step.spent(after.status.cost);
      step.fact(
        `${result.confirmed}/${result.of} member(s) took the new Continuation Token for ` +
          `${result.cost ?? '0'} + ${result.vaultCost ?? '0'} base units, and the lease still ` +
          'answers the new one'
      );
    });

    const conditional = planConditional(facts);

    await run.run('standby-set', async (step) => {
      if (!conditional['standby-set'].run) step.skip(conditional['standby-set'].reason);
      const second = present(
        target.providers.find(
          (provider) =>
            provider.pubkey !== target.provider.pubkey &&
            !provider.profile.hidden &&
            provider.listings.some((listing) => listing.standbyPrice != null)
        ),
        'a second provider selling a standby was counted and then not found'
      );
      const tier = present(
        second.listings.find((listing) => listing.standbyPrice != null),
        'that provider sells no tier with a standby price'
      );
      // Free, and it sends NOTHING: a preflight is how this console proves it
      // could buy a Standby Set without buying a second lease to prove it
      // (TOON_Network#115 — a refused paid request is billed).
      const checked = await api.post('/api/leases/standby-set/preflight', {
        provider: target.provider.pubkey,
        listing: target.listing.name,
        image: { digest: target.imageDigest ?? '' },
        sshPublicKey,
        standbys: [{ provider: second.pubkey, listing: tier.name }],
      });
      must(
        checked.status === 200,
        `the Standby Set preflight answered ${checked.status}: ${text(checked.body)}`
      );
      const plan = checked.body as {
        ok?: boolean;
        problems?: string[];
        cost?: string;
        members?: {
          pubkey: string;
          role: string;
          view: { ok: boolean; problems?: string[]; payment?: { routePrice?: string } };
        }[];
      };
      const members = plan.members ?? [];
      must(members.length >= 2, `the plan names ${members.length} member(s), not a set`);
      must(
        plan.ok === true,
        `the set could not be bought here: ${(plan.problems ?? []).join(' ') || 'no reason given'}`
      );
      for (const member of members) {
        must(
          member.view.ok,
          `the ${member.role} ${member.pubkey.slice(0, 12)}… could not be bought: ` +
            `${(member.view.problems ?? []).join(' ')}`
        );
      }
      step.fact(
        `a set of ${members.length} (${members.map((member) => member.role).join(' + ')}) could ` +
          `be bought here for ${plan.cost ?? 'an unquoted sum'} base units — priced, routed and ` +
          'payable at every member, and NOTHING was sent, because a refused paid request is ' +
          'billed like an accepted one (TOON_Network#115). A Takeover on top of it would need a ' +
          'provider to go away, which this smoke does not arrange'
      );
    });

    await run.run('hidden', async (step) => {
      if (!conditional.hidden.run) step.skip(conditional.hidden.reason);
      const hidden = target.providers.filter((provider) => provider.profile.hidden);
      const health = await api.get('/api/health');
      const carriage = (health.body as { anon?: { state?: string; reason?: string } }).anon;
      must(
        hidden.length > 0,
        'a hidden provider was counted and then not found in the directory'
      );
      const first = present(hidden[0], 'no hidden provider');
      const listing = present(first.listings[0], 'that hidden provider publishes no Listing');
      // Free: a preflight sends nothing. What it proves depends on whether a
      // circuit exists, and BOTH answers are worth having — a console with no
      // proxy must refuse a `.anyone` address out loud rather than dial it.
      const checked = await api.post('/api/leases/preflight', {
        provider: first.pubkey,
        listing: listing.name,
        image: { digest: target.imageDigest ?? '' },
        sshPublicKey,
      });
      must(
        checked.status === 200 || checked.status === 502,
        `the preflight answered ${checked.status}: ${text(checked.body)}`
      );
      const problems = (checked.body as { problems?: string[]; message?: string })
        .problems ?? [(checked.body as { message?: string }).message ?? ''];
      if (facts.socksProxy) {
        must(
          !problems.some((problem) => /circuit|proxy|anyone/iu.test(problem)),
          `a circuit is configured and the console still refused it: ${problems.join(' ')}`
        );
        step.fact(
          `${hidden.length} Hidden Provider(s); the console plans to reach ` +
            `${first.profile.connectorUrl} over its circuit`
        );
      } else {
        must(
          problems.some((problem) => /circuit|proxy|anyone/iu.test(problem)),
          'this console has no circuit and did NOT refuse a `.anyone` connector — a hidden ' +
            "provider's address must never be dialled directly (ADR 0008)"
        );
        step.fact(
          `${hidden.length} Hidden Provider(s); with no TOON_CONSOLE_SOCKS_PROXY the console ` +
            'refuses to dial one rather than leaking the lookup — which is the behaviour ' +
            'under test, and it costs nothing'
        );
      }
      must(
        (carriage?.state === 'ready') === facts.socksProxy,
        `the health view calls the carriage “${carriage?.state ?? 'absent'}” and this process ` +
          `${facts.socksProxy ? 'was given' : 'was given no'} SOCKS proxy`
      );
    });

    await run.run('gateway', async (step) => {
      if (!conditional.gateway.run) step.skip(conditional.gateway.reason);
      const handed = await api.post(`/api/workloads/${id}/gateway/handover`, {});
      must(
        handed.status === 200,
        `the handover answered ${handed.status}: ${text(handed.body)}`
      );
      const result = handed.body as {
        sent?: boolean;
        problems?: string[];
        cost?: string;
        hostname?: string;
        expectedHostname?: string;
        matches?: boolean;
        gatewayError?: string;
        message?: string;
      };
      step.spent(result.cost);
      must(
        result.sent === true,
        `nothing was sent: ${(result.problems ?? []).join(' ') || 'no reason given'}`
      );
      must(
        result.gatewayError === undefined,
        `the gateway refused with ${result.gatewayError}: ${result.message ?? ''}`
      );
      must(
        result.matches === true,
        `the gateway serves ${result.hostname ?? 'nothing'} and this console derived ` +
          `${result.expectedHostname ?? 'nothing'} (§12.2)`
      );
      must(
        !JSON.stringify(handed.body).includes('grant_'),
        'the handover answer carried something that looks like a Gateway Grant'
      );
      const probed = await api.get(`/api/workloads/${id}/gateway?probe=1`);
      const serving = (probed.body as { serving?: { state?: string; status?: number } })
        .serving;
      // Taking it back is part of leaving nothing behind. A withdrawal ends
      // serving and not reading (§12.7): the grant in force keeps working
      // until the moment it was derived for, and only a rotation revokes it.
      const withdrawn = await api.post(`/api/workloads/${id}/gateway/withdraw`, {});
      step.spent((withdrawn.body as { cost?: string }).cost);
      must(
        (withdrawn.body as { sent?: boolean }).sent === true,
        `the withdrawal did not go out: ${text(withdrawn.body)}`
      );
      step.fact(
        `handed to ${result.hostname} for ${result.cost ?? '0'} base units — the name this ` +
          `console derived itself (§12.2) — and the name answered ${serving?.status ?? 'nothing'} ` +
          `(${serving?.state ?? 'unprobed'}); then withdrawn again, so nothing is left served`
      );
    });

    await run.run('terminate', async (step) => {
      const ended = await api.post(`/api/workloads/${id}/terminate`, {});
      must(ended.status === 200, `terminate answered ${ended.status}: ${text(ended.body)}`);
      const result = ended.body as {
        sent?: boolean;
        problems?: string[];
        cost?: string;
        ended?: string;
        providerError?: string;
        message?: string;
      };
      step.spent(result.cost);
      must(
        result.sent === true,
        `nothing was sent: ${(result.problems ?? []).join(' ') || 'no reason given'}`
      );
      must(
        result.providerError === undefined,
        `the provider refused with ${result.providerError}: ${result.message ?? ''}`
      );
      must(
        result.ended === 'termination',
        `the lease ended as “${result.ended ?? 'nothing'}”, not a Termination (§6.6)`
      );
      workloadId = undefined;
      step.fact(
        `ended as a Termination for ${result.cost ?? '0'} base units; §6.6 refunds nothing`
      );
    });

    /* ---------------------------------------------------------------------- */
    /* The whole point: a machine that has never seen this account            */
    /* ---------------------------------------------------------------------- */

    const second = await run.run('recover', async (step) => {
      const home = mkdtempSync(join(tmpdir(), 'toon-smoke-fresh-'));
      homes.push(home);
      const fresh = await startDaemon(home, options.profile.id);
      daemons.push(fresh);
      await fresh.post('/api/profiles/active', { id: options.profile.id });

      const signedIn = await fresh.post('/api/account/signers/local', {
        mode: 'nsec',
        nsec,
        label: 'smoke-console-fresh',
        passphrase,
      });
      must(
        signedIn.status === 200,
        `the fresh daemon would not sign in: ${text(signedIn.body)}`
      );

      // The seed first, because the vault's records are sealed to the same
      // account and the payer keys that would write one come from it.
      const seed = await fresh.post('/api/chain-seed/refresh', {
        relays: [options.profile.relayUrl],
      });
      const seedBody = seed.body as {
        state?: string;
        origin?: string;
        addresses?: { evm?: { address?: string } };
      };
      const expected = deriveFullIdentity(mnemonic, { accountIndex: 0 });
      const same =
        seedBody.addresses?.evm?.address?.toLowerCase() === expected.evm.address.toLowerCase();
      wipeIdentity(expected);
      must(
        seedBody.state === 'ready',
        `the fresh machine calls the Chain Seed “${seedBody.state}” — it did not come back`
      );
      must(same, 'the recovered Chain Seed derives a different payer address');
      step.fact('the Chain Seed came off the relays and derives the same payer addresses');

      const vault = await fresh.post('/api/leases/refresh', {});
      must(
        vault.status === 200,
        `the vault refresh answered ${vault.status}: ${text(vault.body)}`
      );
      const status = vault.body as {
        leases?: {
          workloadId: string;
          source?: string;
          access?: { host?: string };
          template?: string;
          members?: { provider: string }[];
        }[];
        unreadable?: number;
      };
      const leases = status.leases ?? [];
      must(
        (status.unreadable ?? 0) === 0,
        `${status.unreadable} vault record(s) could not be opened by this account`
      );
      const recovered = leases.find((lease) => lease.workloadId === id);
      must(
        recovered !== undefined,
        `the vault on this fresh machine holds ${leases.length} lease(s) and none of them is ` +
          `${id.slice(0, 16)}…, which this run bought`
      );
      must(
        recovered.source === 'relays',
        `the record was read from “${recovered.source}” rather than from the relays — a fresh ` +
          'data directory has no cache, so this is not a recovery'
      );
      must(
        recovered.access?.host !== undefined,
        'the recovered record carries no access details, so the workload could not be reached'
      );
      must(
        recovered.template === template,
        'the recovered record does not name the Template the lease came from'
      );
      must(
        !JSON.stringify(vault.body).includes('rootSecret'),
        'a vault answer carried a Root Secret'
      );
      step.fact(
        `all ${leases.length} lease(s) recovered from ${options.profile.relayUrl} on a data ` +
          `directory made seconds ago — ${id.slice(0, 16)}… with its access details, and no ` +
          'Root Secret in the answer'
      );
      return fresh;
    });

    await run.run('clean', async (step) => {
      const reader = second ?? api;
      const board = await reader.get('/api/workloads?refresh=1');
      must(board.status === 200, `the dashboard answered ${board.status}`);
      const cards = (board.body as { cards?: WorkloadCardView[] }).cards ?? [];
      for (const each of cards) {
        step.spent(each.status.cost);
        const phase = each.status.kind === 'read' ? each.status.life.phase : undefined;
        must(
          phase !== 'running' && phase !== 'provisioning' && phase !== 'reserved',
          `workload ${each.workloadId.slice(0, 16)}… is still ${phase} — this run left a lease ` +
            'burning money'
        );
      }
      // The FIRST daemon, not the fresh one: a channel lives in the data
      // directory that opened it, and the fresh directory deliberately has
      // none. What the vault recovered is the account's; what the channel
      // holds is this machine's.
      const funds = await api.get('/api/funding?refresh=1');
      void funds;
      let total = 0n;
      const balances: string[] = [];
      for (const connector of funded.collectors) {
        const chain = await chainAt(api, connector, options.profile, funded.chain.chain);
        const left = chain.channel.available;
        if (left !== undefined) total += BigInt(left);
        balances.push(`${left ?? 'unknown'} at ${connector}`);
      }
      run.leaves(total.toString());
      step.fact(
        `${cards.length} lease(s) in the vault and none running; ${balances.join(', ')}` +
          (options.stateDir === undefined
            ? ' — give the next run the SAME `TOON_SMOKE_CHAIN_SEED` and `--state-dir` to ' +
              'spend that rather than stranding it: the seed re-opens the channel and the ' +
              'state directory carries the watermark that stops a claim being refused as a ' +
              'replay'
            : ' — the next run with this `--state-dir` and the same seed spends it')
      );
    });

    return run.report();
  } finally {
    // Whatever happened above, a lease this run bought is not left running:
    // `terminate` is free and irreversible, and a lease left burning somebody
    // else's capacity is the one thing a smoke must not leave behind. It is
    // `undefined` by this point on every path that already ended it.
    if (workloadId !== undefined && daemon !== undefined && !options.keep) {
      try {
        const ended = await daemon.post(`/api/workloads/${workloadId}/terminate`, {});
        options.log(
          `  ..    teardown            ended ${workloadId.slice(0, 16)}…: ` +
            `${(ended.body as { ended?: string }).ended ?? text(ended.body).slice(0, 120)}`
        );
      } catch (error) {
        options.log(
          `  ..    teardown            COULD NOT END ${workloadId}: ${String(error)}`
        );
      }
    }
    for (const started of daemons) await started.stop().catch(() => undefined);
    if (!options.keep) {
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    } else if (homes.length > 0) {
      options.log(`  ..    kept                ${homes.join(' ')}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The daemon this run drives                                                 */
/* -------------------------------------------------------------------------- */

export interface Daemon {
  readonly url: string;
  readonly home: string;
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

/**
 * The directories a daemon started by `startDaemon` on `home` keeps its state
 * in — the same three `XDG_*` variables it was given, read the same way.
 */
function daemonPaths(home: string): ConsolePaths {
  return consolePaths({
    ...process.env,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_RUNTIME_DIR: join(home, 'run'),
  });
}

/**
 * One daemon, on a data directory nobody else has.
 *
 * `TOON_CONSOLE_PORT=0` asks the kernel for a free port, and the launch record
 * in this run's own `XDG_RUNTIME_DIR` is how the URL and the token are found —
 * the same file the desktop launcher reads. `TOON_CONSOLE_KEYSTORE=file` keeps
 * every key of this run inside the temporary tree, so a machine with a session
 * keyring ends the run with nothing new in it.
 */
export async function startDaemon(home: string, profileId: string): Promise<Daemon> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_RUNTIME_DIR: join(home, 'run'),
    TOON_CONSOLE_PORT: '0',
    TOON_CONSOLE_KEYSTORE: 'file',
  };
  const main = join(dirname(fileURLToPath(import.meta.url)), 'main.js');
  const child: ChildProcess = spawn(process.execPath, [main], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  child.stdout?.resume();

  const record = join(home, 'run', 'toon-console', 'launch.json');
  const launch = await waitFor(
    () => {
      try {
        const parsed = JSON.parse(readFileSync(record, 'utf8')) as {
          url?: string;
          token?: string;
        };
        return parsed.url && parsed.token
          ? (parsed as { url: string; token: string })
          : undefined;
      } catch {
        return undefined;
      }
    },
    30_000,
    () =>
      `the daemon for profile ${profileId} never wrote a launch record` +
      (stderr.length === 0 ? '' : `: ${stderr.join('').trim()}`)
  );

  const call = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const answer = await fetch(`${launch.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${launch.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answer.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON answer is still an answer; the assertion says what it was.
    }
    return { status: answer.status, body: parsed };
  };

  return {
    url: launch.url,
    home,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

export interface ChainView {
  readonly chain: string;
  readonly kind: 'evm' | 'solana';
  readonly counterparty: string;
  readonly token: { readonly address: string; readonly decimals: number };
  readonly deposit: { readonly address: string };
  readonly rpc: { readonly url: string };
  readonly balances: {
    readonly state: string;
    readonly native?: { readonly amount: string } | undefined;
    readonly token?: { readonly amount: string } | undefined;
  };
  readonly channel: {
    readonly phase: string;
    readonly channelId?: string;
    readonly deposit?: string;
    readonly available?: string;
    readonly reason?: string;
  };
  readonly gas?: { readonly verdict: string; readonly symbol?: string };
  readonly canOpen: boolean;
  readonly blockedBy?: string;
  readonly suggestedDeposit?: string;
}

/**
 * The gas-station views, mirrored here as every other daemon type in this file
 * is: the smoke drives the API over HTTP, so what it holds is the JSON's shape
 * and not the daemon's own types.
 */
interface GasStationStatus {
  readonly state: string;
  readonly chains: readonly GasBuyChain[];
  readonly firstChannel?: string;
  readonly reason?: string;
}

interface GasBuyChain {
  readonly chain: string;
  readonly recipient: string;
  readonly verdict: string;
  readonly reason: string;
  readonly payer?: { readonly chain: string; readonly payAt: string };
  readonly destination?: string;
  readonly price?: string;
  readonly openChannelWith?: string;
}

interface GasAttempt {
  readonly destination: string;
  readonly phase: string;
  readonly outcome: string;
  readonly cost?: string;
}

interface GasQuote {
  readonly quoteId: string;
  readonly feePayer: string;
  readonly recipient: string;
  readonly lamports: string;
  readonly maxLamports: string;
  readonly recentBlockhash: string;
  readonly destination: string;
  readonly price: string;
  readonly attempts: readonly GasAttempt[];
}

interface GasPurchase {
  readonly state: string;
  readonly signature?: string;
  readonly lamports?: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly attempts: readonly GasAttempt[];
  readonly cost?: string;
}

/** Base-unit strings summed. `undefined` is "nothing reported a cost", not zero. */
function sum(values: readonly (string | undefined)[]): string | undefined {
  let total: bigint | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    try {
      total = (total ?? 0n) + BigInt(value);
    } catch {
      continue;
    }
  }
  return total?.toString();
}

function funderAddress(mnemonic: string, kind: 'evm' | 'solana'): string {
  const identity = deriveFullIdentity(mnemonic, { accountIndex: 0 });
  const address = kind === 'evm' ? identity.evm.address : identity.solana.publicKey;
  wipeIdentity(identity);
  return address;
}

/** The first chain on which the funder holds both what is needed. */
async function firstFundable(
  chains: readonly ChainView[],
  funder: string
): Promise<ChainView | undefined> {
  for (const chain of chains) {
    const held = await funderBalances(chain, funder);
    if (held === undefined) continue;
    if (held.token > 0n && held.native > 0n) return chain;
  }
  return undefined;
}

export async function funderBalances(
  chain: ChainView,
  funder: string
): Promise<{ native: bigint; token: bigint } | undefined> {
  const identity = deriveFullIdentity(funder, { accountIndex: 0 });
  try {
    const read = await readWalletBalances(
      chain.kind === 'evm'
        ? {
            evm: {
              chainKey: chain.chain,
              rpcUrl: chain.rpc.url,
              owner: identity.evm.address,
              tokenAddress: chain.token.address,
            },
          }
        : {
            solana: {
              chainKey: chain.chain,
              rpcUrl: chain.rpc.url,
              owner: identity.solana.publicKey,
              tokenMint: chain.token.address,
            },
          }
    );
    const first = read[0];
    if (first === undefined || first.unreadable === true) return undefined;
    return {
      native: BigInt(first.native?.amount ?? '0'),
      token: BigInt(first.tokens[0]?.amount ?? '0'),
    };
  } catch {
    return undefined;
  } finally {
    wipeIdentity(identity);
  }
}

/**
 * Top the payer address up to what an open needs, and no further.
 *
 * Only the shortfall is sent, so a re-run against the same Chain Seed spends
 * nothing on a payer that is already funded. That is the whole reason
 * `--chain-seed` exists.
 */
export async function topUp(
  chain: ChainView,
  funder: string,
  deposit: bigint,
  gasTarget: bigint
): Promise<string[]> {
  const heldNative = BigInt(chain.balances.native?.amount ?? '0');
  const heldToken = BigInt(chain.balances.token?.amount ?? '0');
  const lines: string[] = [];
  const identity = deriveFullIdentity(funder, { accountIndex: 0 });
  try {
    const config =
      chain.kind === 'evm'
        ? {
            evm: {
              chainKey: chain.chain,
              rpcUrl: chain.rpc.url,
              signer: new EvmSigner(identity.evm.privateKey),
              tokenAddress: chain.token.address,
            },
          }
        : {
            solana: {
              rpcUrl: chain.rpc.url,
              keypair: identity.solana.secretKey,
              tokenMint: chain.token.address,
            },
          };

    if (heldNative < gasTarget) {
      const amount = gasTarget - heldNative;
      await sendTransfer(config, {
        chain: chain.kind,
        asset: 'native',
        to: chain.deposit.address,
        amount: amount.toString(),
      });
      lines.push(
        `sent ${amount} base units of the native coin to the payer, for the open's gas`
      );
    } else {
      lines.push('the payer already holds the native coin an open costs; nothing was sent');
    }

    if (heldToken < deposit) {
      const amount = deposit - heldToken;
      await sendTransfer(config, {
        chain: chain.kind,
        asset: 'token',
        to: chain.deposit.address,
        amount: amount.toString(),
      });
      lines.push(`sent ${amount} base units of the settlement token for the collateral`);
    } else {
      lines.push('the payer already holds the collateral; nothing was sent');
    }
  } finally {
    wipeIdentity(identity);
  }
  return lines;
}

/** One chain's funding view at one connector, profile's or another's. */
async function chainAt(
  api: Daemon,
  connector: string,
  profile: NetworkProfile,
  chain: string
): Promise<ChainView> {
  const where =
    connector === profile.connectorUrl ? '' : `&connector=${encodeURIComponent(connector)}`;
  const view = await api.get(`/api/funding?refresh=1${where}`);
  const found = ((view.body as { chains?: ChainView[] }).chains ?? []).find(
    (candidate) => candidate.chain === chain
  );
  return present(found, `${connector} stopped settling on ${chain} mid-run`);
}

async function waitForChannel(
  api: Daemon,
  connector: string,
  profile: NetworkProfile,
  chain: string,
  timeoutMs: number
): Promise<ChainView['channel']> {
  return waitFor(
    async () => {
      const found = await chainAt(api, connector, profile, chain);
      return found.channel.phase === 'opening' ? undefined : found.channel;
    },
    timeoutMs,
    () =>
      `the channel with ${connector} on ${chain} was still opening after ` +
      `${Math.round(timeoutMs / 1000)}s`,
    3_000
  );
}

/**
 * Every connector this run must hold a channel with.
 *
 * The profile's, because that is where a relay write is bought; and whichever
 * one terminates the chosen provider's routes, because that is where a lease
 * is bought. They are the same connector when the profile's publishes a route
 * carrying the provider's ILP prefix — the sandbox hub does — and two
 * different ones when it does not, which is devnet today. Read from `GET /ilp`
 * and the provider's own Profile; decided by nothing in this file.
 */
async function collectingConnectors(
  api: Daemon,
  profile: NetworkProfile,
  provider: ProviderView
): Promise<string[]> {
  const health = await api.get('/api/health');
  const routes =
    (health.body as { connector?: { routes?: { prefix: string }[] } }).connector?.routes ?? [];
  const ilp = provider.profile.ilpAddress;
  const carried = routes.some(
    (route) => route.prefix === ilp || route.prefix.startsWith(`${ilp}.`)
  );
  if (carried || provider.profile.connectorUrl.length === 0) return [profile.connectorUrl];
  return [profile.connectorUrl, provider.profile.connectorUrl];
}

/* -------------------------------------------------------------------------- */
/* The directory, and what the network can carry                              */
/* -------------------------------------------------------------------------- */

interface ListingView {
  readonly name: string;
  readonly version: number;
  readonly arch: string;
  readonly price: number;
  readonly leaseIntervalSeconds: number;
  readonly standbyPrice?: number | null;
  readonly capabilities?: readonly string[];
}

interface ProviderView {
  readonly pubkey: string;
  readonly profile: {
    readonly ilpAddress: string;
    readonly connectorUrl: string;
    readonly hidden: boolean;
    /** The provider's OWN Relay Set (§4.1) — where IT reads, not where we do. */
    readonly relays: readonly string[];
  };
  readonly liveness: { readonly state: string };
  readonly listings: readonly ListingView[];
}

interface TemplateView {
  readonly address: string;
  readonly image: { readonly digest: string };
  readonly availability: { readonly state: string; readonly reason?: string };
}

interface WorkloadCardView {
  readonly workloadId: string;
  readonly status:
    | {
        kind: 'read';
        life: { phase: string };
        expiresAt?: number;
        cost?: string;
      }
    | { kind: 'silent'; reason: string; cost?: string }
    | { kind: 'refused'; code: string; message: string; cost?: string }
    | { kind: 'unread'; reason?: string; cost?: string };
  readonly runway: {
    readonly state: string;
    readonly reason?: string;
    readonly affordableIntervals?: number;
  };
}

interface Target {
  readonly provider: ProviderView;
  readonly listing: ListingView;
  readonly providers: readonly ProviderView[];
  imageDigest?: string;
}

/**
 * Which provider and tier to buy.
 *
 * The cheapest live clearnet one, unless told otherwise. "Clearnet" because a
 * Hidden Provider needs a circuit this run may not have, and its own stage
 * covers it; "live" because a Listing whose provider stopped publishing
 * Liveness is a lease nobody will start.
 */
function chooseProvider(providers: readonly ProviderView[], options: SmokeOptions): Target {
  const usable = providers.filter(
    (provider) => !provider.profile.hidden && provider.listings.length > 0
  );
  must(
    usable.length > 0,
    'every provider on this network is hidden or publishes no Listing, so there is nothing to buy'
  );
  const wanted =
    options.provider === undefined
      ? usable
      : usable.filter((provider) => provider.pubkey === options.provider);
  must(wanted.length > 0, `no provider ${options.provider} is in this network's directory`);

  const live = wanted.filter((provider) => provider.liveness.state === 'live');
  const pool = live.length > 0 ? live : wanted;

  let best: { provider: ProviderView; listing: ListingView } | undefined;
  for (const provider of pool) {
    for (const listing of provider.listings) {
      if (options.listing !== undefined && listing.name !== options.listing) continue;
      // A tier with capabilities costs more and buys nothing this smoke needs.
      if ((listing.capabilities ?? []).length > 0 && options.listing === undefined) continue;
      if (best === undefined || listing.price < best.listing.price) {
        best = { provider, listing };
      }
    }
  }
  must(
    best !== undefined,
    options.listing === undefined
      ? 'no provider publishes a plain Listing to buy'
      : `no provider publishes a Listing named ${JSON.stringify(options.listing)}`
  );
  return { provider: best.provider, listing: best.listing, providers };
}

/** What the conditional stages need, read from the network and nowhere else. */
export async function readNetworkFacts(
  profile: NetworkProfile,
  providers: readonly ProviderView[]
): Promise<NetworkFacts> {
  const gatewayHandoverRoute =
    profile.gatewayConnectorUrl.length === 0
      ? false
      : await (async () => {
          const health = await readConnectorHealth(
            { ...profile, connectorUrl: profile.gatewayConnectorUrl },
            defaultConnectorReader()
          );
          return (
            health.state === 'ok' &&
            health.routes.some((route) => route.prefix.includes('workload-gateway.handover'))
          );
        })().catch(() => false);

  return {
    clearnetProviders: providers.filter((provider) => !provider.profile.hidden).length,
    standbySellers: providers.filter(
      (provider) =>
        !provider.profile.hidden &&
        provider.listings.some((listing) => listing.standbyPrice != null)
    ).length,
    hiddenProviders: providers.filter((provider) => provider.profile.hidden).length,
    gatewayConnectorUrl: profile.gatewayConnectorUrl,
    gatewayHandoverRoute,
    socksProxy: (process.env.TOON_CONSOLE_SOCKS_PROXY ?? '').length > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* The Template this run publishes                                            */
/* -------------------------------------------------------------------------- */

const REGISTRY_KIND = 30434;
const TEMPLATE_KIND = 30436;
const TOON_LABEL = 'toon.network';
/** The `d` this run replaces on every run, so re-running leaves one of each. */
const TEMPLATE_NAME = 'toon-console-smoke';

/**
 * Publish an Image Registry entry and a Template naming it, as the account.
 *
 * Two paid relay writes, bought through the console's own `PaidRelayWriter` —
 * the one writer (#120) — from the same Chain Seed and the same channel the
 * daemon is using. It is done HERE rather than through the daemon because the
 * console has no route that publishes an arbitrary event, and it should not
 * grow one for a test: `toon-docs-publish` is the precedent, a separate
 * program sharing the code that must not be re-implemented.
 *
 * Both events are addressable, so a second run REPLACES them rather than
 * littering the relay.
 */
export async function publishTemplate(input: {
  options: Pick<SmokeOptions, 'profile' | 'image'>;
  /** The daemon's own directories: whose channel pays for these two writes. */
  paths: ConsolePaths;
  /** The `relay` hint the Template carries — the provider's own (§4.1, §6.2). */
  relay: string;
  mnemonic: string;
  nsec: string;
  pubkey: string;
  arch: string;
  onCost: (cost: string | undefined) => void;
  onFact: (line: string) => void;
}): Promise<{ address: string; digest: string }> {
  const { options, mnemonic, pubkey, arch } = input;
  const { ref, entry } = await readOciEntry(options.image, arch);
  const entryD = `${ref.repository.split('/').pop() ?? 'image'}:${ref.tag}`;
  const entryAddress = `${REGISTRY_KIND}:${pubkey}:${entryD}`;

  const now = Math.floor(Date.now() / 1000);
  const secret = secretFromNsec(input.nsec);
  const entryEvent = finalizeEvent(
    {
      kind: REGISTRY_KIND,
      created_at: now,
      tags: [
        ['d', entryD],
        ['x', entry.digest.slice('sha256:'.length)],
        ['L', TOON_LABEL],
      ],
      content: JSON.stringify(entry),
    },
    secret
  ) as NostrEvent;

  const template = {
    version: 1,
    image: {
      digest: entry.digest,
      // The hint is the PROVIDER's own relay, not this console's.
      //
      // §6.2 makes `relay` a place to LOOK and never an authority, and a
      // provider refuses a hint that is not publicly routable — it will not
      // read an Image Registry entry from inside its operator's own network
      // (§8.4, TOON_Network#107). On a sandbox the same relay is `localhost`
      // to this console and a compose name to the provider, so a hint copied
      // from the network profile is the one spelling that cannot work. The
      // provider publishes its own Relay Set in its Profile (§4.1), which is
      // the spelling that CAN, and `--template-relay` overrides both.
      registry_entry: { address: entryAddress, relay: input.relay },
    },
    ports: [{ container_port: 80, protocol: 'tcp' }],
    env_fixed: {},
    env_tenant: [],
  };
  const templateEvent = finalizeEvent(
    {
      kind: TEMPLATE_KIND,
      created_at: now,
      tags: [
        ['d', TEMPLATE_NAME],
        ['L', TOON_LABEL],
      ],
      content: JSON.stringify(template),
    },
    secret
  ) as NostrEvent;
  secret.fill(0);

  const writer = new PaidRelayWriter({
    profile: () => options.profile,
    readHealth: (profile) => readConnectorHealth(profile, defaultConnectorReader()),
    // A relay names its own paid write edge now (TOON_Network#121), and that
    // edge is routinely a connector other than the profile's. This smoke
    // publishes no NIP-65 list, so `writeRelays` stays empty and the write set
    // is exactly #120's one relay — but that relay is entitled to name a
    // connector of its own, and this is how it would be reached.
    readHealthAt: (connectorUrl) =>
      readConnectorHealth({ ...options.profile, connectorUrl }, defaultConnectorReader()),
    // Borrowed for one packet and wiped when it returns, exactly as the daemon
    // does it (ADR 0020). Nothing holds a key between writes.
    payerKeys: async (use) => {
      const identity = deriveFullIdentity(mnemonic, { accountIndex: 0 });
      try {
        return await use(identity);
      } finally {
        wipeIdentity(identity);
      }
    },
    // The DAEMON's data directory, so this pays from the channel the daemon
    // opened rather than looking for one of its own that does not exist.
    paths: input.paths,
    port: new LiveRelayWritePort(),
  });

  // `write` throws when nothing landed, and its message already names what it
  // cost — a refused write is billed like any other answer (ADR 0003).
  for (const [what, event] of [
    ['image-entry', entryEvent],
    ['template', templateEvent],
  ] as const) {
    const receipt = await writer.write({ event, what });
    input.onCost(receipt.cost);
  }
  input.onFact(
    `published ${entry.blobs.length} blob(s) of ${options.image} as ${entryAddress} and a ` +
      `Template at ${TEMPLATE_KIND}:${pubkey.slice(0, 8)}…:${TEMPLATE_NAME}, both paid writes`
  );
  return { address: `${TEMPLATE_KIND}:${pubkey}:${TEMPLATE_NAME}`, digest: entry.digest };
}

/**
 * The one sentence a hop's conversion refusal is missing.
 *
 * A connector that forwards to a peer settling in a different token has to
 * convert, and it refuses a packet whose amount converts to nothing at the
 * rate it declares — at full price (§5, ADR 0003). The message says all of
 * that and cannot say the thing the reader needs, which is that the lease
 * should have been bought on the chain the far end settles in. Nothing this
 * console can read says WHICH that is, so this names the alternatives rather
 * than guessing between them.
 */
function crossingHint(
  message: string,
  funded: { chain: ChainView; alternatives: readonly string[] }
): string {
  if (!/convert|rate|exchange/iu.test(message)) return '';
  if (funded.alternatives.length === 0) return '';
  return (
    ` — this lease was bought on ${funded.chain.chain}, and a hop had to convert it. This ` +
    `connector also settles on ${funded.alternatives.join(', ')}; \`--chain\` picks the one the ` +
    'far end settles in, and a packet that needs no conversion is never refused for its rate.'
  );
}

/**
 * Which relay a Template's registry-entry hint should name.
 *
 * The chosen provider's own first Relay Set entry, because the hint exists for
 * the provider to follow and the provider is the authority on where it reads
 * (§4.1, §6.2). `--template-relay` overrides it, and the network profile's own
 * relay is the last resort for a provider that publishes none.
 */
function templateRelay(options: SmokeOptions, provider: ProviderView): string {
  return options.templateRelay ?? provider.profile.relays[0] ?? options.profile.relayUrl;
}

/* -------------------------------------------------------------------------- */
/* Small things                                                               */
/* -------------------------------------------------------------------------- */

async function card(api: Daemon, id: string, refresh = false): Promise<WorkloadCardView> {
  const answer = await api.get(`/api/workloads/${id}${refresh ? '?refresh=1' : ''}`);
  must(
    answer.status === 200,
    `reading the card answered ${answer.status}: ${text(answer.body)}`
  );
  return answer.body as WorkloadCardView;
}

async function waitForRunning(
  api: Daemon,
  id: string,
  timeoutMs: number
): Promise<WorkloadCardView> {
  return waitFor(
    async () => {
      const seen = await card(api, id, true);
      if (seen.status.kind !== 'read') return seen;
      return seen.status.life.phase === 'provisioning' ? undefined : seen;
    },
    timeoutMs,
    () => `the workload never left provisioning in ${Math.round(timeoutMs / 1000)}s`,
    3_000
  );
}

async function waitFor<T>(
  look: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  whenStuck: () => string,
  everyMs = 500
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const seen = await look();
    if (seen !== undefined) return seen;
    if (Date.now() >= until) throw new Error(whenStuck());
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

function text(body: unknown): string {
  if (typeof body === 'string') return body;
  const record = body as { message?: unknown; error?: unknown };
  if (typeof record?.message === 'string') return record.message;
  return JSON.stringify(body).slice(0, 400);
}

export function secretFromNsec(nsec: string): Uint8Array {
  const decoded = nip19decode(nsec);
  if (decoded.type !== 'nsec') throw new Error('that is not an nsec');
  return Uint8Array.from(decoded.data as Uint8Array);
}

export function randomPassphrase(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** An SSH key for the workload's sshd. Public half only ever leaves here. */
export function generateSshKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  // OpenSSH's wire format: string "ssh-ed25519" then the 32-byte key. The DER
  // SubjectPublicKeyInfo for ed25519 is a fixed 12-byte prefix and the key.
  const raw = publicKey.subarray(12);
  const field = (bytes: Buffer | Uint8Array): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, Buffer.from(bytes)]);
  };
  const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]);
  return `ssh-ed25519 ${blob.toString('base64')} smoke-console`;
}

export function wipeIdentity(identity: {
  evm: { privateKey: Uint8Array };
  solana: { secretKey: Uint8Array };
}): void {
  identity.evm.privateKey.fill(0);
  identity.solana.secretKey.fill(0);
}

export { summarize };
