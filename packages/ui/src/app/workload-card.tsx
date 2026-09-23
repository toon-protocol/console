import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WorkloadsState } from '@/hooks/use-workloads';
import { GatewayPanel } from './gateway-panel';
import type {
  LeaseAccess,
  LeaseLife,
  RunwayView,
  WorkloadCard as Card,
  WorkloadStatus,
} from '@/lib/daemon';

/**
 * One workload, as a person lives with it (TOON_Network#93).
 *
 * The card answers four questions in the order somebody asks them: **what is
 * it doing**, **how long do my funds keep it doing that**, **can I give it
 * more**, and **how do I stop it**. Four decisions about how it reads follow
 * from the protocol rather than from taste.
 *
 * **Silence is a state, not an error.** A provider that is not answering gets
 * a neutral badge and a sentence saying that the lease may be fine. Nothing
 * red, no retry button that would send the same packet again — the card is
 * already polling.
 *
 * **The three endings are three words.** Expiry, Termination and Eviction are
 * different things that happened (§6.7), and the card says which one and what
 * it means. An ending this build does not recognise is quoted, not guessed.
 *
 * **Extend is priced on the button.** A person pressing it is spending, and a
 * refused request is billed like an accepted one (ADR 0003), so the button
 * carries what it costs and is disabled with the reason beside it whenever the
 * daemon says the request would be refused.
 *
 * **Terminate asks twice.** It is free, immediate, and there is no refund
 * (§6.6): the workload is destroyed and nothing brings it back. So it takes a
 * second press, and the second one says what it will end.
 *
 * **The hostname is a section, not a tab** (TOON_Network#97). A Workload
 * Gateway fronts one workload id, so what it serves belongs on that
 * workload's card and nowhere else — and `gateway-panel.tsx` owns it, with
 * its own hook, so that a card with no gateway is a card with an empty
 * section rather than a card that fails.
 */

export function WorkloadCard({ card, workloads }: { card: Card; workloads: WorkloadsState }) {
  const busy = workloads.busy.includes(card.workloadId);
  return (
    <article className="space-y-3 rounded-lg border px-4 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{card.workloadId.slice(0, 16)}…</span>
        <StateBadge status={card.status} lease={card.lease.state} />
        <Badge variant="outline">
          {card.lease.listing.name} v{card.lease.listing.version}
        </Badge>
        {card.provider.liveness !== undefined && (
          <Badge
            variant="outline"
            title="The provider's published Liveness (spec §4.3), from the Provider Directory."
          >
            provider {card.provider.liveness}
          </Badge>
        )}
        {card.lease.localOnly ? (
          <Badge variant="outline" title="This lease's Root Secret is on this machine only.">
            local only
          </Badge>
        ) : (
          <Badge variant="outline" title={`Vaulted on ${card.lease.relays.join(', ')}`}>
            vaulted
          </Badge>
        )}
      </header>

      <p className="text-muted-foreground text-xs">
        {card.lease.image.reference ? `${card.lease.image.reference}@` : ''}
        {card.lease.image.digest.slice(0, 19)}… on {card.lease.profileId}, from{' '}
        <code>{card.provider.ilpAddress}</code>
      </p>

      <Life card={card} />
      <Runway runway={card.runway} />
      <Access access={card.status.kind === 'read' ? card.status.access : card.lease.access} />

      <Actions card={card} workloads={workloads} busy={busy} />
      <AutoExtend card={card} workloads={workloads} busy={busy} />
      <GatewayPanel workloadId={card.workloadId} />
    </article>
  );
}

/* -------------------------------------------------------------------------- */

function StateBadge({
  status,
  lease,
}: {
  status: WorkloadStatus;
  lease: Card['lease']['state'];
}) {
  if (status.kind === 'read') {
    const life = status.life;
    if (life.phase === 'ended') {
      return <Badge variant="secondary">ended — {endingWord(life)}</Badge>;
    }
    return (
      <Badge variant={life.phase === 'running' ? 'default' : 'secondary'}>{life.phase}</Badge>
    );
  }
  if (status.kind === 'silent') {
    // Not `destructive`: the lease may be perfectly fine, and a red badge
    // would have a person terminating something that never went wrong.
    return <Badge variant="outline">provider not answering</Badge>;
  }
  if (status.kind === 'refused') {
    return <Badge variant="secondary">{status.code}</Badge>;
  }
  return (
    <Badge variant="outline">{lease === 'spawning' ? 'spawn unconfirmed' : 'not asked'}</Badge>
  );
}

/** §6.7's state in words, plus the expiry, plus whatever went wrong instead. */
function Life({ card }: { card: Card }) {
  const status = card.status;
  if (status.kind === 'silent') {
    return (
      <p className="text-muted-foreground text-sm">
        <span className="font-medium text-foreground">This provider is not answering.</span>{' '}
        That says nothing about the workload — it may be running perfectly. {status.reason}
      </p>
    );
  }
  if (status.kind === 'refused') {
    return (
      <p className="text-sm">
        <span className="font-medium">The provider answered </span>
        <code>{status.code}</code>. {status.message}
        {card.endedAs !== undefined && (
          <>
            {' '}
            This console last saw this lease end by{' '}
            <span className="font-medium">{card.endedAs}</span>.
          </>
        )}
      </p>
    );
  }
  if (status.kind === 'unread') {
    return <p className="text-muted-foreground text-sm">{status.reason}</p>;
  }
  return (
    <p className="text-sm">
      {status.life.phase === 'ended' ? (
        <>
          <span className="font-medium">Ended.</span> {endingSentence(status.life)}
        </>
      ) : (
        <>
          <span className="font-medium">{status.role ?? 'lease'}</span>, {status.life.phase}
          {status.expiresAt !== undefined && (
            <> until {new Date(status.expiresAt * 1000).toLocaleString()}</>
          )}
          .
        </>
      )}
      {status.takeover !== undefined && (
        <>
          {' '}
          A Takeover has settled: <code>{status.takeover.winner.slice(0, 12)}…</code> runs this
          workload now (spec §7.1).
        </>
      )}
    </p>
  );
}

export function endingWord(life: Extract<LeaseLife, { phase: 'ended' }>): string {
  return life.ending === 'unstated' ? (life.word ?? 'not said') : life.ending;
}

function endingSentence(life: Extract<LeaseLife, { phase: 'ended' }>): string {
  switch (life.ending) {
    case 'expiry':
      return 'Expiry: no payment bought another Lease Interval, and there is no grace period.';
    case 'termination':
      return 'Termination: its tenant ended it. There is no refund.';
    case 'eviction':
      return 'Eviction: its provider ended it, and must publish an Eviction Notice saying why.';
    default:
      return life.word === undefined
        ? 'The provider did not say which ending this was.'
        : `The provider called this ending ${JSON.stringify(life.word)}, which this console does not know.`;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * How long the money keeps it alive.
 *
 * The figure is the daemon's, down to the arithmetic: the browser knows
 * neither what the channel is denominated in nor what the paying connector
 * charges, and a second copy of that sum here would be the one that drifts.
 * What this does is put it in words, and — when it could not be worked out —
 * say which half was missing rather than showing a zero.
 */
function Runway({ runway }: { runway: RunwayView }) {
  if (runway.state === 'unknown') {
    return (
      <p className="text-muted-foreground text-sm">
        <span className="font-medium">Runway: not known.</span> {runway.reason}
      </p>
    );
  }
  if (runway.state === 'unbounded') {
    return (
      <p className="text-muted-foreground text-sm">
        <span className="font-medium">Runway: not bounded by funds.</span> {runway.reason}
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-medium">{`Runway ${duration(runway.seconds ?? 0)}`}</span>
      {runway.until !== undefined && (
        <span className="text-muted-foreground">
          {' '}
          — to about {new Date(runway.until).toLocaleString()}
        </span>
      )}
      <span className="text-muted-foreground">
        {`: ${duration(runway.paidSeconds ?? 0)} already paid for, plus `}
        {`${runway.affordableIntervals ?? 0} more interval(s) of ${runway.leaseIntervalSeconds} s that ${runway.available ?? '?'} base units buys at ${runway.pricePerInterval ?? '?'} each. The Listing prices an interval at ${runway.listingPrice} µUSDC; the figure counted here is what the connector that collects actually quotes.`}
      </span>
    </p>
  );
}

/** Seconds as something a person reads. Whole units, never a false precision. */
export function duration(seconds: number): string {
  if (seconds <= 0) return 'none';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

function Access({ access }: { access?: LeaseAccess | undefined }) {
  if (!access) return null;
  const { host, ssh_port: sshPort, ports } = access;
  return (
    <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
      <dt className="text-muted-foreground">Host</dt>
      <dd className="font-mono">{host}</dd>
      {sshPort !== undefined && (
        <>
          <dt className="text-muted-foreground">SSH</dt>
          <dd className="font-mono">
            ssh -p {sshPort} tenant@{host}
          </dd>
        </>
      )}
      {(ports ?? []).map((port) => (
        <ForwardedPort key={port.container_port} host={host} port={port} />
      ))}
    </dl>
  );
}

function ForwardedPort({
  host,
  port,
}: {
  host: string;
  port: { container_port: number; host_port: number };
}) {
  return (
    <>
      <dt className="text-muted-foreground">Port {port.container_port}</dt>
      <dd className="font-mono">
        {host}:{port.host_port}
      </dd>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function Actions({
  card,
  workloads,
  busy,
}: {
  card: Card;
  workloads: WorkloadsState;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const ended = card.status.kind === 'read' && card.status.life.phase === 'ended';
  const price = card.extend.route?.price;

  // A confirmation that outlives the thing it confirms is a trap. It clears
  // itself, so a "Yes, destroy it" left on screen cannot be pressed by a hand
  // that has forgotten what it was for.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 10_000);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!card.extend.ok || busy}
          onClick={() => {
            void workloads.extend(card.workloadId, price);
          }}
        >
          {busy
            ? 'Working…'
            : price === undefined
              ? 'Extend'
              : `Extend — ${price} base units for ${card.lease.listing.lease_interval_s} s`}
        </Button>
        {!ended &&
          (confirming ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void workloads.terminate(card.workloadId);
                }}
              >
                Yes — destroy this workload
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Terminate
            </Button>
          ))}
      </div>
      {confirming && (
        <p className="text-muted-foreground text-xs">
          Terminating destroys the workload immediately and there is no refund (spec §6.6).
          Nothing brings it back, and the time already paid for is not returned.
        </p>
      )}
      {!card.extend.ok && card.extend.problems.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          {card.extend.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The budget: the one control here that spends while nobody is watching.
 *
 * It is closed until it is opened, it states in full what arming it means, and
 * the button carries the whole figure rather than a word like "enable". The
 * daemon checks the price again before it arms anything, so a tab left open at
 * yesterday's price cannot arm a budget at today's.
 */
function AutoExtend({
  card,
  workloads,
  busy,
}: {
  card: Card;
  workloads: WorkloadsState;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState('');
  const armed = card.autoExtend;
  const price = card.extend.route?.price;

  if (armed !== undefined) {
    return (
      <div className="bg-muted/40 space-y-2 rounded-lg border px-3 py-2 text-xs">
        <p>
          <span className="font-medium">
            {armed.armed ? 'Extending automatically' : 'Automatic extension is off'}
          </span>{' '}
          — {armed.spent} of {armed.budget} base units spent over {armed.extensions}{' '}
          extension(s), {armed.remaining} left, at no more than {armed.agreedPrice} an
          interval, bought inside the last {duration(armed.leadSeconds)} before expiry.
        </p>
        {armed.stoppedBecause !== undefined && (
          <p className="text-muted-foreground">It stopped: {armed.stoppedBecause}</p>
        )}
        {armed.lastRun !== undefined && armed.stoppedBecause === undefined && (
          <p className="text-muted-foreground">
            Last run {new Date(armed.lastRun.at).toLocaleString()} — {armed.lastRun.outcome}:{' '}
            {armed.lastRun.reason}
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void workloads.disarm(card.workloadId);
          }}
        >
          {armed.armed ? 'Stop extending automatically' : 'Forget this budget'}
        </Button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="text-muted-foreground text-xs underline"
        onClick={() => setOpen(true)}
      >
        Set up automatic extension, within a budget…
      </button>
    );
  }

  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border px-3 py-2 text-xs">
      <p>
        <span className="font-medium">This spends money with nobody present.</span> The console
        will buy one Lease Interval at a time, at no more than{' '}
        {price ?? 'the price it is quoted'} base units each, inside the last stretch before
        expiry, until the budget below is spent — and then it stops. It stops early too: if the
        price moves, if the provider stops answering, if an extension is refused, or if the
        lease ends. It runs only on this machine, and only while this console is running.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`budget-${card.workloadId}`}>Budget, in base units</Label>
          <Input
            id={`budget-${card.workloadId}`}
            value={budget}
            placeholder={price === undefined ? '' : `${price} buys one interval`}
            onChange={(event) => setBudget(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={busy || price === undefined || !/^\d+$/u.test(budget.trim())}
          onClick={() => {
            if (price === undefined) return;
            void workloads
              .arm(card.workloadId, { budget: budget.trim(), agreedPrice: price })
              .then((armedOk) => {
                if (armedOk) setOpen(false);
              });
          }}
        >
          {price === undefined || !/^\d+$/u.test(budget.trim())
            ? 'Set a budget'
            : `Spend up to ${budget.trim()} base units without asking`}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
