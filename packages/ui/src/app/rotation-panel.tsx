import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRotation } from '@/hooks/use-rotation';
import type { RotationMemberResult, RotationMemberView, RotationResult } from '@/lib/daemon';

/**
 * Rotation, on a workload's card (TOON_Network#96, spec §6.8, ADR 0018).
 *
 * The panel answers the three questions somebody with a leaked token asks, in
 * that order: **what does this do**, **did it work everywhere**, and **what do
 * I do about the member that did not answer**. Five things about how it reads
 * come from the protocol rather than from taste.
 *
 * **It says what rotating ENDS.** A rotation is a revocation: the old token
 * and every Gateway Grant derived from it stop working at each member it
 * reaches, all at once, with no grace period. Somebody whose hostname goes
 * dark a second later is entitled to have been told first, and to be told
 * again afterwards that handing the workload over again fixes it.
 *
 * **It asks twice.** Not because it is dangerous to the workload — it is not,
 * the lease keeps running untouched — but because it breaks every delegation
 * the account has handed out, and because it costs relay writes.
 *
 * **A partially rotated set is a state, not an error.** §6.8 says so: a member
 * the tenant cannot reach does not block the rest, and a set rotated at some
 * members and not others breaks no invariant. So the panel shows *2 of 3
 * confirmed* with a **Finish the rotation** button, in ordinary type, and the
 * member that did not answer gets a sentence rather than a red banner.
 *
 * **`unavailable` is shown as retryable, never as success.** It is the
 * provider saying it could not persist: nothing changed, the old token still
 * works. Showing that as a rotated member would be telling somebody a leaked
 * token was dead when it is not — which is the one lie this panel must never
 * tell (TOON_Network#78).
 *
 * **Nothing here shows a secret**, and a rotation has two: the root this lease
 * has and the one it is moving to. Neither reaches this window; the daemon's
 * answers have no field for either.
 */

export function RotationPanel({ workloadId }: { workloadId: string }) {
  const rotation = useRotation(workloadId);
  const view = rotation.view;
  const [confirming, setConfirming] = useState(false);

  if (view === undefined) {
    return (
      <p className="text-muted-foreground text-xs">
        {rotation.error ?? (rotation.loading ? 'Reading this lease’s rotation…' : '')}
      </p>
    );
  }

  const done = view.confirmed === view.of && view.of > 0;
  return (
    <section className="space-y-2 border-t pt-3">
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">Continuation Token</h4>
        {view.underWay ? (
          <Badge variant="secondary">
            rotation under way — {view.confirmed} of {view.of} confirmed
          </Badge>
        ) : view.rotatedAt !== undefined ? (
          <Badge variant="outline" title={`Last rotated ${view.rotatedAt}`}>
            rotated {new Date(view.rotatedAt).toLocaleString()}
          </Badge>
        ) : (
          <Badge variant="outline">not rotated</Badge>
        )}
        {view.members.every((member) => member.route?.price === '0' || !member.ok) && (
          <Badge
            variant="outline"
            title="Every member's connector prices `.rotate` at nothing (spec §5)."
          >
            free
          </Badge>
        )}
      </header>

      <p className="text-muted-foreground text-sm">
        Rotating replaces this lease&rsquo;s Continuation Token at every member of its Standby
        Set, from a <strong>fresh Root Secret</strong>. The workload keeps running and nothing
        else about the lease changes — but the old token stops working at once, and so does{' '}
        <strong>every Gateway Grant derived from it</strong>: a gateway this workload was
        handed to stops reading it, not merely serving it (spec §6.8, ADR 0018). There is no
        grace period. Hand the workload over again afterwards and the hostname works again,
        from the new token.
      </p>

      {view.underWay && (
        <p className="text-sm">
          A rotation started {new Date(view.startedAt ?? '').toLocaleString()} is part-way
          through. This account holds <strong>both</strong> root secrets until every member
          confirms, so every member is still readable — the ones that have confirmed with the
          new token, the rest with the old. Finishing it asks only the members that have not.
        </p>
      )}

      <ul className="space-y-1 text-xs">
        {view.members.map((member) => (
          <Member key={member.pubkey} member={member} />
        ))}
      </ul>

      {rotation.lastRun !== undefined && <Ran result={rotation.lastRun} />}

      {view.problems.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs" role="status">
          {view.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {rotation.error !== undefined && (
        <p className="text-destructive text-xs" role="status">
          {rotation.error}
        </p>
      )}

      {!view.localOnly && view.vault.ready === false && (
        <p className="text-xs" role="status">
          The new Root Secret is recorded on this account&rsquo;s relays before anything is
          sent (ADR 0021), and that write cannot be bought right now:{' '}
          {view.vault.blockedBy ?? 'the connector did not say why'}. Nothing would be sent.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={rotation.busy || !view.ok}
              onClick={() => {
                setConfirming(false);
                void rotation.rotate();
              }}
            >
              {rotation.busy
                ? 'Rotating…'
                : view.underWay
                  ? `Yes — finish it at ${view.of - view.confirmed} member(s)`
                  : `Yes — rotate at ${view.of} member(s) and end every grant`}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={rotation.busy || !view.ok}
            onClick={() => setConfirming(true)}
          >
            {view.underWay && !done ? 'Finish the rotation' : 'Rotate the token'}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={rotation.loading} onClick={rotation.load}>
          {rotation.loading ? 'Reading…' : 'Refresh'}
        </Button>
      </div>

      {!view.ok && (
        <p className="text-muted-foreground text-xs">
          No member of this Standby Set can be reached right now, so nothing would be sent and
          no Root Secret would be minted.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function Member({ member }: { member: RotationMemberView }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <code>{member.pubkey.slice(0, 12)}…</code>
      <span className="text-muted-foreground">{member.role}</span>
      {member.skipped === true ? (
        <Badge variant="outline">left out</Badge>
      ) : member.confirmed ? (
        <Badge>holds the new token</Badge>
      ) : (
        <Badge variant="outline">holds the old token</Badge>
      )}
      {member.route !== undefined && (
        <span className="text-muted-foreground">
          <code>{member.route.route}</code> at {member.route.payAt} —{' '}
          {member.route.price === '0'
            ? 'free'
            : `${member.route.price ?? 'unpriced'} base units`}
        </span>
      )}
      {member.problems.length > 0 && (
        <span className="text-muted-foreground">{member.problems.join(' ')}</span>
      )}
    </li>
  );
}

/** What the last run did, member by member. */
function Ran({ result }: { result: RotationResult }) {
  if (!result.started) {
    return (
      <p className="text-sm" role="status">
        <span className="font-medium">Nothing was sent. </span>
        {result.problems.join(' ')}
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-md border px-3 py-2 text-sm" role="status">
      <p>
        <span className="font-medium">
          {result.rotated
            ? 'Rotated at every member. '
            : `Rotated at ${result.confirmed} of ${result.of} member(s). `}
        </span>
        {result.rotated
          ? 'The old token is refused everywhere, and every Gateway Grant derived from it is ' +
            'bad_grant. This account now holds the new Root Secret only.'
          : 'This account still holds BOTH root secrets, and every member is still readable. ' +
            'Run it again to finish — the members that confirmed are left alone.'}
      </p>
      <ul className="space-y-1 text-xs">
        {result.members.map((member) => (
          <Outcome key={member.pubkey} member={member} />
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        {result.cost === undefined || result.cost === '0'
          ? 'The rotate requests cost nothing: `rotate` is a free route and each was bought where it is free (spec §5).'
          : `The rotate requests cost ${result.cost} base units — free at a provider is not free through a hop.`}
        {result.vaultCost !== undefined &&
          ` The vault writes cost ${result.vaultCost} base units.`}
      </p>
      {result.vaultBehind !== undefined && <p className="text-xs">{result.vaultBehind}</p>}
    </div>
  );
}

function Outcome({ member }: { member: RotationMemberResult }) {
  return (
    <li>
      <code>{member.pubkey.slice(0, 12)}…</code>{' '}
      {member.rotated ? (
        <Badge>{member.already === true ? 'already rotated' : 'rotated'}</Badge>
      ) : member.retryable === true ? (
        <Badge variant="secondary">retryable</Badge>
      ) : (
        <Badge variant="outline">not rotated</Badge>
      )}{' '}
      {member.providerError !== undefined && <code>{member.providerError}</code>}{' '}
      <span className="text-muted-foreground">
        {member.message ?? member.problems?.join(' ')}
      </span>
    </li>
  );
}
