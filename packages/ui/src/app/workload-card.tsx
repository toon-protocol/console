import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WorkloadsState } from '@/hooks/use-workloads';
import { GatewayPanel } from './gateway-panel';
import { RotationPanel } from './rotation-panel';
import type {
  LeaseAccess,
  LeaseLife,
  RunwayView,
  StandbySetView,
  WorkloadCard as Card,
  WorkloadMemberView,
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
 * A **Standby Set** adds a fifth (TOON_Network#95, spec §7). Its members are
 * listed, each with what it is doing and the route that keeps it alive, and
 * three words are kept apart because the protocol keeps them apart:
 *
 * - **Reserved** is a Warm Standby holding capacity with nothing running. It
 *   is paid on `.standby.extend` at the standby price, and letting it lapse
 *   is letting the protection go.
 * - **Self-stop** is a primary that stopped its OWN workload because it could
 *   no longer publish Liveness to a majority of its Relay Set (§7.1). The
 *   lease is still paid, still extendable at the running price, and still
 *   swept at its expiry — it is not an ending.
 * - **Expiry** is an ending: nobody paid, the lease is over, nothing restarts
 *   it. The card must never show one of these three as another.
 *
 * **The hostname is a section, not a tab** (TOON_Network#97). A Workload
 * Gateway fronts one workload id, so what it serves belongs on that
 * workload's card and nowhere else — and `gateway-panel.tsx` owns it, with
 * its own hook, so that a card with no gateway is a card with an empty
 * section rather than a card that fails.
 *
 * **Rotation is the section BELOW it** (TOON_Network#96), and the order is
 * deliberate: rotating ends every Gateway Grant this lease has handed out, so
 * the thing it breaks is on screen directly above the button that breaks it.
 * `rotation-panel.tsx` owns it, with its own hook, for the same reason.
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
        {card.set.warm && (
          <Badge
            variant="outline"
            title="A Standby Set: one workload id, several providers, one Root Secret (spec §7)."
          >
            {card.set.members} members
          </Badge>
        )}
        {card.provider.hidden && (
          <Badge
            variant="secondary"
            title="This provider publishes no host. Every packet to it, and this lease's own address, go over an Anyone Protocol circuit (spec §10)."
          >
            Hidden Provider
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

      {card.provider.notHidden !== undefined && (
        <p className="text-destructive text-xs" role="status">
          {card.provider.notHidden}
        </p>
      )}

      <Life card={card} />
      <Takeover set={card.set} />
      <Runway runway={card.runway} set={card.set} />
      <Access
        access={runningAccess(card)}
        hidden={card.provider.hidden}
        sshOffered={card.lease.sshOffered}
      />

      <Actions card={card} workloads={workloads} busy={busy} />
      {card.set.warm && <Members card={card} workloads={workloads} busy={busy} />}
      <AutoExtend card={card} workloads={workloads} busy={busy} />
      <GatewayPanel workloadId={card.workloadId} />
      <RotationPanel workloadId={card.workloadId} />
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
      {status.life.phase === 'stopped' && (
        <>
          {' '}
          <span className="font-medium">This is a self-stop, not an ending.</span> The primary
          could no longer publish Liveness to a majority of its own Relay Set, so it stopped
          its workload rather than keep running beside a Takeover (spec §7.1). The lease is
          still paid to its expiry, <code>.extend</code> still adds an interval at the running
          price, and the expiry sweep still ends it &mdash; an <em>expired</em> lease is over
          and cannot be restarted, and this one is not that.
        </>
      )}
    </p>
  );
}

/**
 * The Takeover, with its two halves labelled.
 *
 * `announcedAt` is the winner's own signed moment, from the kind-30433 claim
 * it published (§7.1 step 2). `firstSeenAt` is when this console noticed.
 * Showing the second as though it were the first would be inventing a time,
 * so the card says which it has.
 */
function Takeover({ set }: { set: StandbySetView }) {
  const takeover = set.takeover;
  if (!takeover) {
    return set.takeoverUnread === undefined ? null : (
      <p className="text-muted-foreground text-sm">
        Whether a Takeover happened could not be read: {set.takeoverUnread}
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-medium">Takeover.</span>{' '}
      <code>{takeover.winner.slice(0, 12)}…</code> runs this workload now
      {takeover.from === undefined
        ? ''
        : `, taken over from ${takeover.from.slice(0, 12)}…`}.{' '}
      {takeover.announcedAt === undefined ? (
        <span className="text-muted-foreground">
          This console first saw it at {new Date(takeover.firstSeenAt).toLocaleString()} — the
          member said so itself (spec §6.5); nothing it answers carries the moment it happened.
        </span>
      ) : (
        <span className="text-muted-foreground">
          Announced {new Date(takeover.announcedAt).toLocaleString()}, in the winner&rsquo;s
          own signed claim (spec §7.1)
          {takeover.rounds !== undefined && takeover.rounds > 1
            ? `. This set has changed hands ${takeover.rounds} times`
            : ''}
          . No workload state moved: the standby started from the image (ADR 0010).
        </span>
      )}
    </p>
  );
}

/**
 * Every member of the Standby Set, with the route that keeps each one alive.
 *
 * One button per member, and it carries the route as well as the price,
 * because the two extension routes are not interchangeable: §6.3 refuses a
 * reservation on `.extend` as `not_running` and a running lease on
 * `.standby.extend` as `not_standby`, and bills for both. The daemon reads
 * which one applies from a free `status` before it sends anything, so what is
 * on the button is what will actually be bought.
 */
function Members({
  card,
  workloads,
  busy,
}: {
  card: Card;
  workloads: WorkloadsState;
  busy: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border px-3 py-2">
      <p className="text-xs font-medium">
        Standby Set &mdash; {card.set.members} members, one workload id, one Root Secret
        {card.set.pricePerInterval === undefined
          ? ''
          : `; one round of extensions costs ${card.set.pricePerInterval} base units`}
        .
      </p>
      {card.members.map((member) => (
        <Member
          key={member.pubkey}
          member={member}
          card={card}
          workloads={workloads}
          busy={busy}
        />
      ))}
    </div>
  );
}

function Member({
  member,
  card,
  workloads,
  busy,
}: {
  member: WorkloadMemberView;
  card: Card;
  workloads: WorkloadsState;
  busy: boolean;
}) {
  const price = member.extend.route?.price;
  return (
    <div className="space-y-1 border-t pt-2 text-xs first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{member.pubkey.slice(0, 12)}…</span>
        <Badge variant="outline">{member.role}</Badge>
        <MemberState member={member} />
        {member.runningNow && <Badge>running the workload</Badge>}
        <span className="text-muted-foreground">
          {member.listing.name} v{member.listing.version} · {member.provider.ilpAddress}
        </span>
      </div>
      <p className="text-muted-foreground">{memberSentence(member)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!member.extend.ok || busy}
          onClick={() => {
            void workloads.extend(card.workloadId, price, member.pubkey);
          }}
        >
          {price === undefined
            ? `Extend on .${member.extend.op}`
            : `Extend on .${member.extend.op} — ${price} base units for ${member.listing.lease_interval_s} s`}
        </Button>
      </div>
      {!member.extend.ok && member.extend.problems.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5">
          {member.extend.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MemberState({ member }: { member: WorkloadMemberView }) {
  const status = member.status;
  if (status.kind === 'read') {
    if (status.life.phase === 'ended') {
      return <Badge variant="secondary">ended — {endingWord(status.life)}</Badge>;
    }
    if (status.life.phase === 'stopped') {
      return <Badge variant="secondary">self-stopped</Badge>;
    }
    return (
      <Badge variant={status.life.phase === 'running' ? 'default' : 'secondary'}>
        {status.life.phase}
      </Badge>
    );
  }
  if (status.kind === 'silent') return <Badge variant="outline">not answering</Badge>;
  if (status.kind === 'refused') return <Badge variant="secondary">{status.code}</Badge>;
  return <Badge variant="outline">not asked</Badge>;
}

/** What this member is, in the words the protocol uses for it. */
function memberSentence(member: WorkloadMemberView): string {
  if (member.vaultState === 'failed') {
    return `This member's spawn was refused${member.failedBecause ? `: ${member.failedBecause}` : ''}. It was billed anyway (ADR 0003), and it holds nothing for this workload.`;
  }
  if (!member.known) {
    return 'This account holds no record of where this member is, so nothing can be addressed to it until its Provider Profile is readable.';
  }
  const status = member.status;
  if (status.kind !== 'read') return '';
  switch (status.life.phase) {
    case 'reserved':
      return `A Warm Standby: it holds capacity for this workload and runs nothing until a Takeover. It is paid on .standby.extend at the standby price — let it lapse and the protection goes with it (spec §7).`;
    case 'stopped':
      return `A self-stop: this primary could not publish Liveness to a majority of its own Relay Set, so it stopped its workload (spec §7.1). Its lease is still paid and still extendable at the running price. It is not an expired lease.`;
    case 'running':
      return member.role === 'standby'
        ? `This Warm Standby won the Takeover and runs the workload now. Winning buys no time: from here it needs a full-price .extend before its current expiry, or the sweep ends it (spec §7.1).`
        : `Running the workload.`;
    case 'ended':
      return endingSentence(status.life);
    default:
      return `Paid, holding its workload id and its capacity while the workload starts.`;
  }
}

/** The access details of whichever member is actually running the workload. */
function runningAccess(card: Card): LeaseAccess | undefined {
  const running = card.members.find(
    (member) => member.runningNow && member.status.kind === 'read' && member.status.access
  );
  if (running?.status.kind === 'read' && running.status.access) return running.status.access;
  return card.status.kind === 'read' ? card.status.access : card.lease.access;
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
    case 'expired':
      return (
        'Expired: the paid time ran out with nothing extending it, and the provider has ' +
        'removed it. Extend it — or auto-extend — before the paid time runs out to ' +
        'keep one alive; spawning again is the only way to get it back.'
      );
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
function Runway({ runway, set }: { runway: RunwayView; set: StandbySetView }) {
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
      {set.warm ? (
        <span className="text-muted-foreground">
          {` for the whole Standby Set: ${runway.rounds ?? 0} more round(s) of extensions at ${runway.setPricePerInterval ?? '?'} base units each — the primary at its listing's price and every Warm Standby at its standby price. A set protects this workload only while EVERY member is paid, so the figure is bounded by `}
          {runway.boundBy === undefined
            ? 'the member that runs out first'
            : `${runway.boundBy.slice(0, 12)}…, the member that runs out first`}
          .
        </span>
      ) : (
        <span className="text-muted-foreground">
          {`: ${duration(runway.paidSeconds ?? 0)} already paid for, plus `}
          {`${runway.affordableIntervals ?? 0} more interval(s) of ${runway.leaseIntervalSeconds} s that ${runway.available ?? '?'} base units buys at ${runway.pricePerInterval ?? '?'} each. The Listing prices an interval at ${runway.listingPrice} µUSDC; the figure counted here is what the connector that collects actually quotes.`}
        </span>
      )}
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

/**
 * Where the lease answers.
 *
 * For a Hidden Provider this is a PER-LEASE `.anyone` address (spec §10), and
 * showing it is not a leak — it is the whole of how a tenant reaches its own
 * workload, and §10 says a tenant dials it exactly as it would an IP. What is
 * never shown, here or anywhere, is a host for the PROVIDER.
 *
 * **The SSH command is conditional** (TOON_Network#138). The provider always
 * hands back an `access.ssh_port` — it forwards to the container's port 22
 * whether or not anything is listening there — so `ssh_port !== undefined` is
 * not a reason to believe SSH works. `sshOffered` is: it comes from the Lease
 * Vault record set once at spawn time (`lease.ts`), true unless the Template
 * this workload was spawned from said plainly that it has no SSH, or no real
 * key was ever sent. A key that WAS sent for an image that turns out not to
 * run sshd cannot be told apart from here, so that case keeps showing the
 * command — the false negative is worse than the false positive. Only the
 * cases this console actually knows about are hidden.
 */
function Access({
  access,
  hidden,
  sshOffered,
}: {
  access?: LeaseAccess | undefined;
  hidden?: boolean;
  sshOffered: boolean;
}) {
  if (!access) return null;
  const { host, ssh_port: sshPort, ports } = access;
  return (
    <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
      <dt className="text-muted-foreground">{hidden === true ? 'Lease address' : 'Host'}</dt>
      <dd className="font-mono break-all">
        {host}
        {hidden === true && (
          <span className="text-muted-foreground ml-2 font-sans text-xs">
            this lease&rsquo;s own address, over a circuit
          </span>
        )}
      </dd>
      {sshOffered && sshPort !== undefined && (
        <>
          <dt className="text-muted-foreground">SSH</dt>
          <dd className="font-mono">
            ssh -p {sshPort} tenant@{host}
          </dd>
        </>
      )}
      {!sshOffered && (
        <>
          <dt className="text-muted-foreground">SSH</dt>
          <dd className="text-muted-foreground text-xs">
            Not offered — this workload was spawned with no SSH key.
          </dd>
        </>
      )}
      {(ports ?? []).map((port) =>
        sshOffered ? (
          <ForwardedPort key={port.container_port} host={host} port={port} />
        ) : (
          <HttpPort key={port.container_port} host={host} port={port} />
        )
      )}
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

/**
 * A port shown as the URL it actually is, for a workload with no SSH command
 * on the card (TOON_Network#138) — "web: http://host:port", clickable rather
 * than a host and a number a person has to assemble themselves.
 */
function HttpPort({
  host,
  port,
}: {
  host: string;
  port: { container_port: number; host_port: number };
}) {
  const url = `http://${host}:${port.host_port}`;
  return (
    <>
      <dt className="text-muted-foreground">web</dt>
      <dd className="font-mono">
        <a href={url} target="_blank" rel="noreferrer" className="underline">
          {url}
        </a>
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
  // The SET's price, not the primary's: a budget armed against one member
  // would let the reservations lapse, and a Standby Set with a lapsed
  // reservation has stopped protecting anything (spec §7).
  const price = card.set.pricePerInterval;

  if (armed !== undefined) {
    return (
      <div className="bg-muted/40 space-y-2 rounded-lg border px-3 py-2 text-xs">
        <p>
          <span className="font-medium">
            {armed.armed ? 'Extending automatically' : 'Automatic extension is off'}
          </span>{' '}
          — {armed.spent} of {armed.budget} base units spent over {armed.extensions}{' '}
          extension(s), {armed.remaining} left, at no more than {armed.agreedPrice} a round
          across this workload&rsquo;s {card.set.members} member(s), bought inside the last{' '}
          {duration(armed.leadSeconds)} before expiry.
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
        will buy one round of extensions at a time — every member of this workload that is due,
        each on the route that keeps it alive — at no more than{' '}
        {price ?? 'the price it is quoted'} base units a round, inside the last stretch before
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
            placeholder={price === undefined ? '' : `${price} buys one round`}
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
