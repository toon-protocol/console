import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FundingState } from '@/hooks/use-funding';
import type { GasStationState } from '@/hooks/use-gas-station';
import type {
  Amount,
  ChainFundingView,
  ChannelView,
  FaucetView,
  FundingStatus,
  QuoteView,
} from '@/lib/daemon';

/**
 * Funds: an account from empty to a channel it can pay a provider from.
 *
 * The screen is arranged around the thing that actually stops people, and it
 * is not the deposit. **Native gas is the obstacle.** Opening a payment
 * channel is a transaction on a chain, a transaction costs that chain's own
 * coin, and a fresh Chain Seed has none of it anywhere. No faucet in this
 * network gives any: the devnet one drips the settlement token and says
 * itself that it holds no ETH, a public Solana airdrop is capped per day and
 * answers `429` once it is, and an EVM testnet's faucets are gated behind
 * accounts somewhere else.
 *
 * So the order on this page is deliberate, and it is not the order the money
 * moves in:
 *
 * 1. **What you are missing**, at the top, before anything else — one panel
 *    per chain that cannot pay for a transaction, saying so in those words and
 *    saying where to get what is missing.
 * 2. **Where to send it**: the address and its QR code, which is both where
 *    the settlement token goes AND where the gas goes. The same address, which
 *    is worth saying out loud, because "deposit USDC here" and "send a little
 *    ETH here" look like two instructions and are one.
 * 3. **What you hold**, per chain, with `unknown` where a chain could not be
 *    read — never a zero standing in for a failure.
 * 4. **Open a channel**, last, and disabled with the reason written on it
 *    whenever the steps above are not done.
 *
 * The button is never live when it would fail. A console that let someone
 * press it with an empty gas tank would be teaching the same lesson at the
 * price of a transaction that looks like a bug.
 */
export function FundingView({
  funding,
  gas,
}: {
  funding: FundingState;
  gas?: GasStationState;
}) {
  const status = funding.status;

  if (!status) {
    return (
      <p className="text-muted-foreground text-sm">
        {funding.loading ? 'Reading your funds…' : 'The daemon said nothing about funds.'}
      </p>
    );
  }

  if (status.state !== 'ready') {
    return <NotYet status={status} funding={funding} />;
  }

  return (
    <div className="space-y-4">
      {funding.error && <Problem funding={funding} />}
      {status.heldSeed && <HeldSeed held={status.heldSeed} />}
      {status.supersededSeeds > 0 && <SupersededSeeds count={status.supersededSeeds} />}
      <GasGate status={status} {...(gas === undefined ? {} : { gas })} />
      {status.chains.map((chain) => (
        <ChainCard
          key={chain.chain}
          chain={chain}
          funding={funding}
          {...(status.faucet === undefined ? {} : { faucet: status.faucet })}
          {...(status.quote === undefined ? {} : { quote: status.quote })}
        />
      ))}
      <Footnotes status={status} funding={funding} />
    </div>
  );
}

/** Nothing to fund yet, and exactly why. */
function NotYet({ status, funding }: { status: FundingStatus; funding: FundingState }) {
  const title =
    status.state === 'signed_out'
      ? 'Sign in first'
      : status.state === 'no_seed'
        ? 'This account has no Chain Seed yet'
        : status.state === 'unconfigured'
          ? `${status.profile.label} has no connector`
          : 'The connector did not answer';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          Deposit addresses come from the account&rsquo;s Chain Seed, and which chains they are
          for comes from the connector. Both are needed before there is anything to show.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{status.reason}</p>
        {status.state === 'connector_unreachable' && (
          <Button
            size="sm"
            variant="outline"
            onClick={funding.refresh}
            disabled={funding.busy}
          >
            Try again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The panel this whole ticket is arranged around.
 *
 * Shown above everything the moment any chain cannot pay for a transaction,
 * and worded as the problem rather than as an error: nobody has done anything
 * wrong yet. It names the coin, says plainly that nothing here can supply it,
 * and gives the one thing that does work per chain.
 */
function GasGate({ status, gas }: { status: FundingStatus; gas?: GasStationState }) {
  const stuck = status.chains.filter((chain) => chain.gas.verdict !== 'present');
  if (stuck.length === 0) return null;
  const none = stuck.filter((chain) => chain.gas.verdict === 'none');
  // Whether ANY of the blocked chains can be bought for. It changes the
  // headline, and nothing else: the explanation below stays word for word,
  // because it is still true of every chain this cannot help.
  const buyable = (gas?.status?.chains ?? []).filter((chain) => chain.verdict === 'buyable');

  return (
    <Card
      role="region"
      aria-label="Native gas"
      className="border-warning/50 bg-warning/5"
      data-testid="gas-gate"
    >
      <CardHeader>
        <CardTitle>
          {none.length === 0
            ? 'Whether you can pay for a transaction is unknown'
            : buyable.length > 0
              ? 'You need native gas — and one of these chains you can buy'
              : 'You need native gas, and nothing here can give it to you'}
        </CardTitle>
        <CardDescription>
          Opening a payment channel is a transaction on a chain, so it is paid for in that
          chain&rsquo;s own coin — not in the token this network prices everything in. TOON
          Network settles in a token and mints no coin, so this is the one step it cannot do
          for you. It is worth knowing now rather than at a failed transaction.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {gas?.status?.firstChannel && (
          <p className="text-sm font-medium" data-testid="first-channel">
            {gas.status.firstChannel}
          </p>
        )}
        {stuck.map((chain) => (
          <div key={chain.chain} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{chain.chain}</span>
              <GasBadge chain={chain} />
            </div>
            <p className="text-sm">{chain.gas.headline}</p>
            <p className="text-sm">{chain.gas.detail}</p>
            {chain.gas.command && <CopyLine label="Run this" value={chain.gas.command} />}
            {gas && <BuyGas chain={chain.chain} gas={gas} />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Buying one chain's gas with a channel on another (TOON_Network#119).
 *
 * The order on this panel is the acceptance criterion, in three steps that
 * cannot be skipped:
 *
 * 1. **What it would do**, from the daemon — which chain pays, at which edge,
 *    what one packet costs there. A read; nothing has been spent.
 * 2. **The quote**, bought and then SHOWN: the station's own fee payer, what
 *    it will move, its own ceiling, and the deadline it merged with its
 *    blockhash's validity. A countdown, because that deadline is short and a
 *    person deciding slowly should see it running rather than discover it.
 * 3. **The purchase**, which names the quote on the screen. There is no button
 *    that executes without a quote in hand, and nothing recomputes a price:
 *    what is displayed is the connector's figure and the station's figure,
 *    each repeated.
 *
 * A refusal is shown as a refusal, with what it cost — because a refused paid
 * request is still billed, and a panel that hid that would be the silent loss
 * this ticket exists to rule out.
 */
function BuyGas({ chain, gas }: { chain: string; gas: GasStationState }) {
  const plan = gas.status?.chains.find((entry) => entry.chain === chain);
  if (!plan || plan.verdict === 'not_blocked') return null;

  const quote = gas.quote?.chain === chain ? gas.quote : undefined;
  const purchase = gas.purchase?.chain === chain ? gas.purchase : undefined;

  if (plan.verdict !== 'buyable') {
    return (
      <p className="text-muted-foreground text-sm" data-testid={`gas-buy-${chain}`}>
        {plan.reason}
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border px-3 py-2" data-testid={`gas-buy-${chain}`}>
      <p className="text-sm">{plan.reason}</p>
      {gas.error && (
        <div role="alert" className="text-destructive space-y-1 text-sm">
          <p>{gas.error}</p>
          <Button size="sm" variant="outline" onClick={gas.clearError}>
            Dismiss
          </Button>
        </div>
      )}
      {purchase && <GasPurchased purchase={purchase} />}
      {quote ? (
        <div className="space-y-2" data-testid={`gas-quote-${chain}`}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">It will move</dt>
            <dd className="font-mono">{quote.lamports} lamports</dd>
            <dt className="text-muted-foreground">To</dt>
            <dd className="font-mono break-all">{quote.recipient}</dd>
            <dt className="text-muted-foreground">From its fee payer</dt>
            <dd className="font-mono break-all">{quote.feePayer}</dd>
            <dt className="text-muted-foreground">Its own ceiling</dt>
            <dd className="font-mono">{quote.maxLamports} lamports</dd>
            <dt className="text-muted-foreground">The route</dt>
            <dd className="font-mono break-all">
              {quote.destination} at {quote.price} base units
            </dd>
            <dt className="text-muted-foreground">The quote has cost</dt>
            <dd className="font-mono">{totalOf(quote.attempts)} base units so far</dd>
          </dl>
          <p className="text-muted-foreground text-xs">
            This quote and the blockhash it named expire together, at{' '}
            {new Date(quote.expiresAt).toLocaleTimeString()}. After that, quote again — a
            transaction built on an expired blockhash cannot be broadcast, so there is nothing
            to salvage by sending it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={gas.busy}
              onClick={() => void gas.buyGas({ chain, quoteId: quote.quoteId })}
            >
              Pay {quote.price} base units and buy it
            </Button>
            <Button size="sm" variant="outline" disabled={gas.busy} onClick={gas.dismiss}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={gas.busy}
          onClick={() => void gas.quoteGas({ chain })}
        >
          {gas.busy ? 'Asking the gas station…' : `Get a quote (${plan.price} base units)`}
        </Button>
      )}
    </div>
  );
}

/** What a purchase did, in the station's own words where it declined. */
function GasPurchased({ purchase }: { purchase: NonNullable<GasStationState['purchase']> }) {
  const cost =
    purchase.cost === undefined ? '' : ` It cost ${purchase.cost} base units in total.`;
  if (purchase.state === 'delivered') {
    return (
      <p className="text-sm" data-testid="gas-purchase">
        The gas station co-signed and broadcast it: {purchase.lamports} lamports are on their
        way to {purchase.recipient}, in transaction{' '}
        <span className="font-mono break-all">{purchase.signature}</span>.{cost} Refresh the
        balances below; once the chain shows them, opening a channel here needs nothing
        further.
      </p>
    );
  }
  if (purchase.state === 'refused') {
    return (
      <p className="text-sm" role="alert" data-testid="gas-purchase">
        The gas station declined: <span className="font-mono">{purchase.reason}</span>.{' '}
        {purchase.detail} It answered, so the packet was billed and nothing was bought.{cost}
      </p>
    );
  }
  return (
    <p className="text-sm" role="alert" data-testid="gas-purchase">
      Nobody reported what became of that packet, so whether the gas station ran the job is
      unknown — it is not done and it is not undone.{cost} Read the balances below before
      buying again.
    </p>
  );
}

/** Every packet's cost, summed. Never a price multiplied by a packet count. */
function totalOf(attempts: readonly { cost?: string }[]): string {
  let total = 0n;
  for (const attempt of attempts) {
    if (attempt.cost === undefined) continue;
    try {
      total += BigInt(attempt.cost);
    } catch {
      continue;
    }
  }
  return total.toString();
}

function GasBadge({ chain }: { chain: ChainFundingView }) {
  if (chain.gas.verdict === 'present') {
    return <Badge variant="success">gas: {formatAmount(chain.balances.native)}</Badge>;
  }
  if (chain.gas.verdict === 'none') {
    return <Badge variant="destructive">no {chain.gas.symbol ?? 'gas'}</Badge>;
  }
  return <Badge variant="secondary">gas: unknown</Badge>;
}

/** ADR 0020's second ruling, on screen: surfaced, never merged, never quiet. */
/**
 * The seed behind these addresses is not yet recoverable (TOON_Network#120).
 *
 * It belongs on THIS screen, above the addresses, because this is the screen
 * that invites a deposit — and depositing into an address whose seed one disk
 * holds is the mistake the state exists to prevent. The way out runs through
 * here too: the channel opened with this money is what pays for the seed's own
 * publication.
 */
function HeldSeed({ held }: { held: NonNullable<FundingStatus['heldSeed']> }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 space-y-2 rounded-lg border px-4 py-3 text-sm"
      data-testid="held-seed"
    >
      <p className="font-semibold">This account’s Chain Seed is not yet recoverable</p>
      <p>{held.text}</p>
      <ol className="list-decimal space-y-1 pl-5 text-xs">
        {held.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-xs">
        The addresses below are real and may be funded — that is the next step. Publish the
        seed from the Account tab as soon as this account has a channel.
      </p>
    </div>
  );
}

function SupersededSeeds({ count }: { count: number }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-lg border px-4 py-3 text-sm"
    >
      <p className="font-semibold">
        This account has {count === 1 ? 'another' : `${count} other`} sealed Chain{' '}
        {count === 1 ? 'Seed' : 'Seeds'}.
      </p>
      <p>
        Two machines that both minted while offline leave two records, and only one of them is
        current. Anything at the other&rsquo;s addresses is not reachable from these, and the
        console will not merge them or keep deriving from the loser. Check the Account tab
        before you deposit anything here.
      </p>
    </div>
  );
}

/** One chain: where to send money, what is there, and the channel. */
function ChainCard({
  chain,
  funding,
  faucet,
  quote,
}: {
  chain: ChainFundingView;
  funding: FundingState;
  faucet?: FaucetView;
  quote?: QuoteView;
}) {
  const [deposit, setDeposit] = useState('');
  const amount = deposit.trim() === '' ? (chain.suggestedDeposit ?? '') : deposit.trim();

  return (
    <Card data-testid={`chain-${chain.chain}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-mono text-base">{chain.chain}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <GasBadge chain={chain} />
            <ChannelBadge channel={chain.channel} />
          </div>
        </div>
        <CardDescription>
          Settled in the token at{' '}
          <span className="font-mono break-all">{chain.token.address}</span> (
          {chain.token.decimals} decimals), against the connector at{' '}
          <span className="font-mono break-all">{chain.counterparty}</span>. Every one of those
          facts is read from the connector&rsquo;s own <code>GET /ilp</code>.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <Deposit
          chain={chain}
          funding={funding}
          {...(faucet === undefined ? {} : { faucet })}
        />
        <Balances chain={chain} />
        <Channel channel={chain.channel} />
        <OpenChannel
          chain={chain}
          funding={funding}
          amount={amount}
          deposit={deposit}
          onDeposit={setDeposit}
          {...(quote === undefined ? {} : { quote })}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Where to send money — and the sentence that stops it being two instructions.
 *
 * One address takes both the settlement token and the chain's own coin, and
 * the QR code is of the bare address so that any wallet on either chain can
 * read it without having to understand a URI scheme first.
 */
function Deposit({
  chain,
  funding,
  faucet,
}: {
  chain: ChainFundingView;
  funding: FundingState;
  faucet?: FaucetView;
}) {
  const leg = faucet?.chains.find((entry) => entry.kind === chain.kind);
  return (
    <section className="space-y-2">
      <h3 className="text-muted-foreground text-xs tracking-wide uppercase">
        Deposit address
      </h3>
      <div className="flex flex-wrap items-start gap-4">
        {/* The one fixed colour in this package, and the theme test names it
            as such: a QR code is read by a camera, and it has to be dark on
            light whichever Omarchy theme is set (TOON_Network#99). */}
        <div className="rounded-lg border bg-white p-2" aria-hidden="true">
          <QRCodeSVG value={chain.deposit.address} size={116} level="M" />
        </div>
        <div className="min-w-56 flex-1 space-y-2">
          <p className="font-mono text-xs break-all" data-testid={`deposit-${chain.chain}`}>
            {chain.deposit.address}
          </p>
          <p className="text-muted-foreground font-mono text-[0.7rem]">{chain.deposit.path}</p>
          <p className="text-muted-foreground text-xs">
            Send both here: the settlement token this network is priced in, and the{' '}
            {chain.gas.symbol ?? 'native coin'} that pays for the transaction. They are one
            address, and only one of them can be asked for from a faucet.
          </p>
          <CopyLine label="Copy address" value={chain.deposit.address} />
        </div>
      </div>

      {faucet && (
        <div className="space-y-1 rounded-lg border px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {faucet.state === 'unreachable'
                ? `The faucet at ${faucet.url} did not answer.`
                : leg
                  ? `This network's faucet drips ${leg.drips
                      .map((drip) => `${drip.amount} ${drip.asset}`)
                      .join(', ')} here${
                      leg.cooldownHours ? `, once every ${leg.cooldownHours} hours` : ''
                    }.`
                  : `This network's faucet does not cover ${chain.chain}.`}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={funding.busy || leg === undefined || !leg.ready}
              onClick={() => void funding.drip(chain.chain)}
            >
              {funding.busy ? 'Asking…' : 'Ask the faucet'}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {faucet.givesGas
              ? `It says it has ${chain.gas.symbol ?? 'native coin'} to give as well.`
              : `It gives the settlement token only — no ${
                  chain.gas.symbol ?? 'native coin'
                }, so it cannot pay for the open.`}
          </p>
          {faucet.lastDrip?.chain === chain.chain && (
            <p
              className={
                faucet.lastDrip.state === 'delivered' ? 'text-xs' : 'text-destructive text-xs'
              }
            >
              {faucet.lastDrip.state === 'delivered' ? 'Asked: ' : 'Refused: '}
              {faucet.lastDrip.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** What the chain says is there — or that it did not say. */
function Balances({ chain }: { chain: ChainFundingView }) {
  return (
    <section className="space-y-2">
      <h3 className="text-muted-foreground text-xs tracking-wide uppercase">On chain</h3>
      {chain.balances.state === 'unknown' ? (
        <p className="text-sm" data-testid={`balances-unknown-${chain.chain}`}>
          <Badge variant="secondary">unknown</Badge>{' '}
          <span className="ml-1">{chain.balances.reason}</span>
        </p>
      ) : (
        <dl className="grid gap-2 sm:grid-cols-2">
          <Figure
            label={`${chain.gas.symbol ?? 'Native'} (gas)`}
            value={formatAmount(chain.balances.native)}
            raw={chain.balances.native?.amount}
          />
          <Figure
            label={`${chain.balances.token?.symbol ?? 'Settlement token'} (what it is priced in)`}
            value={formatAmount(chain.balances.token)}
            raw={chain.balances.token?.amount}
          />
        </dl>
      )}
      <p className="text-muted-foreground text-xs">
        Read at {chain.rpc.url}
        {chain.rpc.source === 'client-default'
          ? ' — the endpoint the client library defaults to, not one this profile named.'
          : ' — the endpoint this network profile names.'}
      </p>
    </section>
  );
}

/** The channel, in whichever of its several honest states it is in. */
function Channel({ channel }: { channel: ChannelView }) {
  return (
    <section className="space-y-2">
      <h3 className="text-muted-foreground text-xs tracking-wide uppercase">Channel</h3>
      {channel.phase === 'none' || channel.phase === 'failed' ? (
        <p
          className={channel.phase === 'failed' ? 'text-destructive text-sm' : 'text-sm'}
          data-testid="channel-story"
        >
          {channel.phase === 'failed' && <strong>The open did not land. </strong>}
          {channel.reason}
          {channel.outOfGas === true && (
            <> That was the gas, not the console: the chain refused to run the transaction.</>
          )}
        </p>
      ) : (
        <>
          <dl className="grid gap-2 sm:grid-cols-3">
            <Figure label="Collateral" value={channel.deposit ?? 'unknown'} />
            <Figure label="Spent" value={channel.spent ?? 'unknown'} />
            <Figure label="Available" value={channel.available ?? 'unknown'} />
          </dl>
          {channel.channelId && (
            <p className="text-muted-foreground font-mono text-[0.7rem] break-all">
              {channel.channelId}
            </p>
          )}
          {channel.reason && <p className="text-sm">{channel.reason}</p>}
        </>
      )}
    </section>
  );
}

function ChannelBadge({ channel }: { channel: ChannelView }) {
  // `opening` is NOT a failure and must never look like one: the transaction
  // is in flight, and the only remedy is to wait.
  if (channel.phase === 'opening') return <Badge variant="warning">opening…</Badge>;
  if (channel.phase === 'open') return <Badge variant="success">channel open</Badge>;
  if (channel.phase === 'failed') return <Badge variant="destructive">open failed</Badge>;
  if (channel.phase === 'closing') return <Badge variant="warning">closing</Badge>;
  if (channel.phase === 'settled') return <Badge variant="secondary">settled</Badge>;
  return <Badge variant="secondary">no channel</Badge>;
}

/**
 * The button, and what it will not do.
 *
 * Disabled with its reason spelled out whenever the chain cannot pay for the
 * transaction, whenever an open is already in flight, and whenever a channel
 * already exists. `blockedBy` comes from the daemon, which is where the
 * decision is made: a UI that decided this for itself would be a second
 * opinion on whether a person has enough gas.
 */
function OpenChannel({
  chain,
  funding,
  quote,
  amount,
  deposit,
  onDeposit,
}: {
  chain: ChainFundingView;
  funding: FundingState;
  quote?: QuoteView;
  amount: string;
  deposit: string;
  onDeposit: (value: string) => void;
}) {
  return (
    <section className="space-y-2 border-t pt-4">
      <h3 className="text-muted-foreground text-xs tracking-wide uppercase">
        Open a payment channel
      </h3>
      <p className="text-sm">
        This locks collateral on chain with the connector as the other participant, and pays{' '}
        {chain.gas.symbol ?? 'the chain’s own coin'} for the transaction that does it. If this
        address already holds a channel with this connector, that one is adopted rather than a
        second one opened.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(submit) => {
          submit.preventDefault();
          void funding.openChannel({
            chain: chain.chain,
            ...(amount === '' ? {} : { deposit: amount }),
          });
        }}
      >
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor={`deposit-amount-${chain.chain}`}>
            Collateral, in base units ({chain.token.decimals} decimals)
          </Label>
          <Input
            id={`deposit-amount-${chain.chain}`}
            value={deposit}
            onChange={(change) => onDeposit(change.target.value)}
            placeholder={chain.suggestedDeposit ?? '100000'}
            inputMode="numeric"
            autoComplete="off"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={funding.busy || !chain.canOpen}
          title={chain.blockedBy ?? undefined}
        >
          {chain.channel.phase === 'opening' ? 'Opening…' : 'Open channel'}
        </Button>
      </form>
      {!chain.canOpen && chain.blockedBy && (
        <p className="text-sm" role="note" data-testid={`blocked-${chain.chain}`}>
          {chain.blockedBy}
        </p>
      )}
      {quote && (
        <p className="text-muted-foreground text-xs">
          The suggestion is {quote.packets} packets at the price this connector quotes for{' '}
          <span className="font-mono">{quote.route}</span>: {quote.price} base units each.
          {quote.pricePerKib && (
            <>
              {' '}
              That route also meters by size, at {quote.pricePerKib} per kibibyte, so a packet
              on it costs more than the flat figure — how much more is the connector&rsquo;s to
              say when the packet is sent, and the console never works it out itself.
            </>
          )}
        </p>
      )}
    </section>
  );
}

function Footnotes({ status, funding }: { status: FundingStatus; funding: FundingState }) {
  return (
    <div className="text-muted-foreground space-y-2 text-xs">
      <p>
        Prices are the connector&rsquo;s own, repeated. The console never recomputes one: the
        client and the connector round a per-kibibyte charge differently, and the connector is
        the one that decides (TOON_Network#82).
      </p>
      {status.channelStorePath && (
        <p>
          Channel state for {status.profile.label} lives at{' '}
          <span className="font-mono break-all">{status.channelStorePath}</span>. One store per
          network, never shared.
        </p>
      )}
      <p>{status.custody.text}</p>
      <Button size="sm" variant="outline" onClick={funding.refresh} disabled={funding.loading}>
        {funding.loading ? 'Reading the chains…' : 'Read the chains again'}
      </Button>
    </div>
  );
}

function Figure({ label, value, raw }: { label: string; value: string; raw?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-sm break-all">{value}</dd>
      {raw !== undefined && raw !== value && (
        <dd className="text-muted-foreground font-mono text-[0.7rem]">{raw} base units</dd>
      )}
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="bg-muted rounded px-2 py-1 text-xs break-all">{value}</code>
      <Button
        size="sm"
        variant="outline"
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false)
          );
        }}
      >
        {copied ? 'Copied' : label}
      </Button>
    </div>
  );
}

function Problem({ funding }: { funding: FundingState }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive space-y-2 rounded-lg border px-4 py-3 text-sm"
    >
      <p>{funding.error}</p>
      <Button size="sm" variant="outline" onClick={funding.clearError}>
        Dismiss
      </Button>
    </div>
  );
}

/**
 * Base units, scaled for reading — never for arithmetic.
 *
 * String maths, because a balance can be larger than a double can hold
 * exactly and a wei figure certainly is. Nothing here is fed back into a
 * request: what goes to the daemon is always the integer the chain reported.
 */
export function formatAmount(value: Amount | undefined): string {
  if (!value) return 'unknown';
  const text =
    value.decimals === undefined ? value.amount : scale(value.amount, value.decimals);
  return value.symbol ? `${text} ${value.symbol}` : text;
}

function scale(amount: string, decimals: number): string {
  if (decimals <= 0 || !/^\d+$/u.test(amount)) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/u, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
