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
import type { ChainSeedState } from '@/hooks/use-chain-seed';
import type { ChainSeedStatus } from '@/lib/daemon';

/**
 * The Chain Seed: one card, five states.
 *
 * ADR 0020 in a screen. An account's payer keys on Base and Solana come from
 * one BIP-39 phrase sealed to its Nostr key, so what this card shows is where
 * money goes — two addresses and the paths they came from, checkable in any
 * other wallet — and never the phrase itself. There is no reveal button and
 * no export: the daemon has no route that would answer one, and recovery is
 * signing in again anywhere, which is what the seal is FOR.
 *
 * The custody warning is shown before anything is minted and has to be
 * acknowledged once. It is not decoration: an account's whole balance follows
 * its Nostr key from here on, and that is the one sentence a person cannot be
 * allowed to find out later.
 *
 * The fifth state is the one TOON_Network#120 added, and it is the reason this
 * card is loud in a way the others are not. A Chain Seed cannot pay for its
 * own publication — the key that pays is derived from the seed — so between
 * minting it and publishing it there is a window where one disk holds
 * everything. In that window the card says **NOT YET RECOVERABLE**, in a
 * panel, above the addresses it is inviting deposits to, with the steps out of
 * it and the button that takes the last one. It is impossible to confuse with
 * a published seed: there is no record to show, and the badge says so.
 */
export function ChainSeedCard({ seed }: { seed: ChainSeedState }) {
  const status = seed.status;
  if (!status || status.state === 'signed_out') return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Chain Seed</CardTitle>
          <StateBadge status={status} />
        </div>
        <CardDescription>
          One BIP-39 phrase, sealed to this account with NIP-44 and kept on its own relays.
          Your payer keys on every settlement chain come from it, and signing in anywhere
          brings them back.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {seed.error && <Problem seed={seed} />}

        {status.state === 'not_yet_recoverable' ? (
          <NotYetRecoverable status={status} seed={seed} />
        ) : status.state === 'ready' ? (
          <Ready status={status} seed={seed} />
        ) : status.state === 'unreadable' ? (
          <p className="text-sm">
            This account has a Chain Seed record, but the signer in use did not open it.{' '}
            {status.reason}
          </p>
        ) : (
          <NoSeedYet status={status} seed={seed} />
        )}

        <RelayList status={status} seed={seed} />
      </CardContent>
    </Card>
  );
}

function StateBadge({ status }: { status: ChainSeedStatus }) {
  if (status.state === 'ready') {
    return (
      <Badge variant="success">{status.origin === 'imported' ? 'imported' : 'minted'}</Badge>
    );
  }
  if (status.state === 'not_yet_recoverable') {
    return <Badge variant="destructive">not yet recoverable</Badge>;
  }
  if (status.state === 'unreadable') return <Badge variant="destructive">not readable</Badge>;
  if (status.state === 'absent') return <Badge variant="warning">none yet</Badge>;
  return <Badge variant="secondary">reading…</Badge>;
}

/** The addresses, and where the record that produced them came from. */
function Ready({ status, seed }: { status: ChainSeedStatus; seed: ChainSeedState }) {
  const addresses = status.addresses;
  if (!addresses) return null;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <AddressBlock
          chain="EVM (Base)"
          address={addresses.evm.address}
          path={addresses.evm.path}
        />
        <AddressBlock
          chain="Solana"
          address={addresses.solana.address}
          path={addresses.solana.path}
        />
      </div>

      {status.supersededSeeds > 0 && (
        <p role="alert" className="text-destructive text-sm">
          {status.supersededSeeds === 1
            ? 'One older record held a DIFFERENT seed.'
            : `${status.supersededSeeds} older records held different seeds.`}{' '}
          Anything those addresses hold is not reachable from this one. Check them before
          depositing.
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        {status.record?.source === 'cache'
          ? 'Read from this machine’s cache; no relay answered.'
          : `Read from ${listOf(status.record?.relays ?? [])}.`}{' '}
        Published {status.record?.publishedAt?.slice(0, 10)}.
      </p>

      <Button
        size="sm"
        variant="outline"
        disabled={seed.busy}
        onClick={() => void seed.refresh()}
      >
        {seed.busy ? 'Reading…' : 'Read from relays again'}
      </Button>
    </div>
  );
}

/**
 * The held state: the sentence, the steps, the addresses, and the one button.
 *
 * The sentence and the steps are the daemon's own words — it is a consequence
 * of #120's ordering, not a piece of copy, and a console that phrased it
 * differently here would be a second version of the same promise.
 */
function NotYetRecoverable({
  status,
  seed,
}: {
  status: ChainSeedStatus;
  seed: ChainSeedState;
}) {
  const held = status.held;
  const addresses = status.addresses;
  const writes = status.writes;
  return (
    <div className="space-y-3">
      <div
        role="alert"
        className="border-destructive/40 bg-destructive/10 space-y-2 rounded-lg border px-4 py-3 text-sm"
      >
        <p className="font-semibold">This Chain Seed is not yet recoverable</p>
        <p>{held?.text}</p>
        <ol className="list-decimal space-y-1 pl-5 text-xs">
          {(held?.steps ?? []).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {held?.lastAttempt && (
          <p className="text-xs" data-testid="held-last-attempt">
            The last attempt to publish it: {held.lastAttempt}
          </p>
        )}
      </div>

      {addresses && (
        <div className="grid gap-3 sm:grid-cols-2">
          <AddressBlock
            chain="EVM (Base)"
            address={addresses.evm.address}
            path={addresses.evm.path}
          />
          <AddressBlock
            chain="Solana"
            address={addresses.solana.address}
            path={addresses.solana.path}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={seed.busy || !writes.ready}
          onClick={() => void seed.publish()}
        >
          {seed.busy ? 'Publishing…' : 'Publish it — one paid write'}
        </Button>
        <p className="text-muted-foreground text-xs">
          {writes.ready
            ? `One packet on ${writes.destination}: ${writes.price} base units of this network’s settlement token, paid from this account’s own channel.`
            : writes.blockedBy}
        </p>
      </div>
    </div>
  );
}

function AddressBlock({
  chain,
  address,
  path,
}: {
  chain: string;
  address: string;
  path: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border px-3 py-2">
      <p className="text-muted-foreground text-xs tracking-wide uppercase">{chain}</p>
      <p
        className="font-mono text-xs break-all"
        data-testid={`address-${chain.split(' ')[0]}`}
      >
        {address}
      </p>
      <p className="text-muted-foreground font-mono text-[0.7rem]">{path}</p>
    </div>
  );
}

/** Mint or import — but the warning first, and only once. */
function NoSeedYet({ status, seed }: { status: ChainSeedStatus; seed: ChainSeedState }) {
  const acknowledged = status.warning.acknowledgedAt !== undefined;
  const [mnemonic, setMnemonic] = useState('');
  const [showImport, setShowImport] = useState(false);

  if (!acknowledged) {
    return (
      <div className="space-y-3">
        <div
          role="alert"
          className="border-warning/40 bg-warning/10 space-y-2 rounded-lg border px-4 py-3 text-sm"
        >
          <p className="font-semibold">Before this account has any money in it</p>
          <p>{status.warning.text}</p>
        </div>
        <Button size="sm" disabled={seed.busy} onClick={() => void seed.acknowledge()}>
          I understand — continue
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        This account has no Chain Seed yet. Mint a new one, or import a phrase you already use
        so that your chain keys match another wallet. Either way it is held here until you have
        a payment channel to publish it from — a relay write is a paid packet, and the key that
        pays for it comes from the seed.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={seed.busy} onClick={() => void seed.mint()}>
          {seed.busy ? 'Working…' : 'Mint a Chain Seed'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={seed.busy}
          onClick={() => setShowImport((open) => !open)}
        >
          Import a mnemonic
        </Button>
      </div>

      {showImport && (
        <form
          className="space-y-2"
          onSubmit={(submit) => {
            submit.preventDefault();
            void seed.importMnemonic(mnemonic).then((done) => {
              // Cleared either way: the words have no business outliving the
              // request, and a failed attempt is retyped rather than left on
              // screen.
              if (done) setMnemonic('');
            });
          }}
        >
          <Label htmlFor="chain-seed-mnemonic">Your 12 or 24 BIP-39 words</Label>
          <textarea
            id="chain-seed-mnemonic"
            value={mnemonic}
            onChange={(change) => setMnemonic(change.target.value)}
            rows={3}
            autoComplete="off"
            spellCheck={false}
            placeholder="abandon abandon abandon …"
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px]"
          />
          <p className="text-muted-foreground text-xs">
            Sealed to this account and held on this machine until you publish it; it is never
            shown again and never leaves the daemon in the clear.
          </p>
          <Button size="sm" type="submit" disabled={seed.busy || mnemonic.trim() === ''}>
            {seed.busy ? 'Sealing…' : 'Import as the Chain Seed'}
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * Where the seed is kept, and where a write is bought.
 *
 * Two different questions since #120, and the card keeps them apart. A write
 * goes to the relay this console can buy a packet to, at the price that
 * connector quotes. A NIP-65 list is about READING: it says where this
 * account's records are to be looked for, by this console on a new machine and
 * by every other Nostr client. It is offered, not required.
 */
function RelayList({ status, seed }: { status: ChainSeedStatus; seed: ChainSeedState }) {
  const [url, setUrl] = useState('');
  const list = status.relayList;
  const writes = status.writes;
  const offering = list.state === 'none' && status.state !== 'signed_out';

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-muted-foreground text-xs tracking-wide uppercase">Where it is kept</p>
      <p className="text-sm">
        {writes.ready
          ? `Records are written to ${listOf(writes.relays)} as paid packets on ${writes.destination ?? 'this network’s relay route'} — ${writes.price} base units of the settlement token each, from this account’s own payment channel.`
          : (writes.blockedBy ??
            'This console cannot buy a relay write on this network right now.')}
      </p>
      {list.state === 'present' ? (
        <p className="text-sm">
          This account&rsquo;s NIP-65 list names {listOf(list.write)} to write to and{' '}
          {listOf(list.read)} to read from; the console looks on all of them.
        </p>
      ) : (
        <p className="text-sm">
          This account has published no NIP-65 relay list. Publishing one says where its
          records are to be looked for — on a new machine, and by any other Nostr client. It is
          one paid write like any other.
        </p>
      )}

      {offering && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(submit) => {
            submit.preventDefault();
            void seed.publishRelayList([{ url }]).then((done) => {
              if (done) setUrl('');
            });
          }}
        >
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="chain-seed-relay">Publish a relay list</Label>
            <Input
              id="chain-seed-relay"
              value={url}
              onChange={(change) => setUrl(change.target.value)}
              placeholder="wss://relay.example"
              autoComplete="off"
            />
          </div>
          <Button size="sm" type="submit" disabled={seed.busy || url.trim() === ''}>
            Publish
          </Button>
          {/* Read-only, and the safe thing to press first on a machine that
              has never seen this account: a look publishes nothing. */}
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={seed.busy || url.trim() === ''}
            onClick={() => void seed.refresh([url])}
          >
            Just look there
          </Button>
        </form>
      )}
    </div>
  );
}

/** A failure, with what each relay actually said when that is the story. */
function Problem({ seed }: { seed: ChainSeedState }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive space-y-2 rounded-lg border px-4 py-3 text-sm"
    >
      <p>{seed.error}</p>
      {seed.refusals && seed.refusals.length > 0 && (
        <ul className="space-y-1 text-xs">
          {seed.refusals.map((outcome) => (
            <li key={outcome.url} className="font-mono break-all">
              {outcome.url} — {outcome.state}
              {outcome.reason ? `: ${outcome.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="outline" onClick={seed.clearError}>
        Dismiss
      </Button>
    </div>
  );
}

function listOf(urls: readonly string[]): string {
  const last = urls.at(-1);
  if (last === undefined) return 'nowhere';
  if (urls.length === 1) return last;
  return `${urls.slice(0, -1).join(', ')} and ${last}`;
}
