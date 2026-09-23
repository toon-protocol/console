import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useGateway } from '@/hooks/use-gateway';
import type { HandoverResult, ServingView } from '@/lib/daemon';

/**
 * The hostname, on a workload's card (TOON_Network#97, spec §12).
 *
 * The panel answers three questions in the order a person asks them: **what
 * is my URL**, **does it work**, and **how do I take it away**. Four decisions
 * about how it reads come from the protocol rather than from taste.
 *
 * **The URL is shown before anything is handed over.** §12.2 makes the
 * hostname a function of the workload id alone, so the console knows it from
 * the moment the lease exists. Showing it early is honest — it is the name,
 * whether or not a gateway is serving it yet — and it is what makes **Check**
 * meaningful: the name the panel prints is not a copy of what the gateway
 * said, so comparing the two is a real check.
 *
 * **`no_grant` is shown as the empty state, not as an error.** It is what
 * §12.3 says a hostname answers when nothing has been handed to it, which is
 * every hostname before its first handover and every one after a withdrawal.
 * A red banner there would have a person debugging a working gateway.
 *
 * **Withdraw does not say "revoke".** A withdrawal ends the serving and not
 * the reading (§12.7): the gateway keeps a grant that reads this lease's
 * `status` until the moment it was derived for. The panel says that where a
 * person will read it, because somebody who believes they revoked something
 * will not go and rotate.
 *
 * **The expiry is a field, with a default that is visible.** A grant stops
 * working at a moment, and a hostname that quietly went dark in a day with
 * nothing on screen to have said so would be the worst thing this panel could
 * do.
 */

/** How long a handover asks for by default, in seconds. A day. */
const DEFAULT_HOURS = 24;

export function GatewayPanel({ workloadId }: { workloadId: string }) {
  const gateway = useGateway(workloadId);
  const view = gateway.view;
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [open, setOpen] = useState(false);

  if (view === undefined) {
    return (
      <p className="text-muted-foreground text-xs">
        {gateway.error ?? (gateway.loading ? 'Reading the gateway…' : '')}
      </p>
    );
  }

  const ports = view.ports;
  const chosen = port === '' ? (view.httpPort ?? ports[0]) : Number(port);

  return (
    <section className="space-y-2 border-t pt-3">
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-medium">Hostname</h4>
        {view.held ? (
          <Badge>served</Badge>
        ) : view.expired === true ? (
          <Badge variant="secondary">grant expired</Badge>
        ) : (
          <Badge variant="outline">not handed over</Badge>
        )}
        {view.gateway?.price === '0' && (
          <Badge
            variant="outline"
            title="The gateway's connector prices its handover route at nothing (spec §5, §12)."
          >
            free
          </Badge>
        )}
      </header>

      {view.hostname === undefined ? (
        <p className="text-muted-foreground text-sm">
          This network names no Workload Gateway, so this workload has no hostname. It is still
          reachable at its provider&rsquo;s own address.
        </p>
      ) : (
        <p className="text-sm">
          <a
            className="font-mono underline"
            href={`https://${view.hostname}/`}
            target="_blank"
            rel="noreferrer"
          >
            {view.hostname}
          </a>
          <span className="text-muted-foreground">
            {' '}
            — derived from this workload&rsquo;s id (spec §12.2), so it is the same name on any
            machine and it survives a Takeover: the gateway resolves the id, not the provider.
          </span>
        </p>
      )}

      <Serving serving={view.serving} />

      {view.held && view.handover !== undefined && (
        <p className="text-muted-foreground text-xs">
          Handed to <code>{view.handover.connectorUrl}</code> on{' '}
          {new Date(view.handover.at).toLocaleString()}, forwarding to container port{' '}
          {view.handover.httpPort}. The grant runs out at{' '}
          {new Date(view.handover.expiresAt * 1000).toLocaleString()} — hand over again before
          then and the name keeps working.
        </p>
      )}

      {gateway.lastAction !== undefined && (
        <p className="text-sm">
          {gateway.lastAction.kind === 'handover' ? (
            <Handed result={gateway.lastAction.result} />
          ) : (
            (gateway.lastAction.result.message ?? 'Withdrawn.')
          )}
        </p>
      )}

      {view.problems.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          {view.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {view.hostname !== undefined && (
          <Button
            size="sm"
            variant="outline"
            disabled={gateway.loading}
            onClick={gateway.check}
          >
            {gateway.loading ? 'Checking…' : 'Check the hostname'}
          </Button>
        )}
        {view.held ? (
          <Button
            size="sm"
            variant="outline"
            disabled={gateway.busy}
            onClick={() => void gateway.withdraw()}
          >
            {gateway.busy ? 'Working…' : 'Withdraw'}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Hand to gateway'}
          </Button>
        )}
      </div>

      {open && !view.held && (
        <div className="space-y-2 rounded-md border px-3 py-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor={`gw-hours-${workloadId}`}>Grant lasts (hours)</Label>
              <Input
                id={`gw-hours-${workloadId}`}
                className="w-28"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
            </div>
            {ports.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor={`gw-port-${workloadId}`}>HTTP container port</Label>
                <Input
                  id={`gw-port-${workloadId}`}
                  className="w-28"
                  placeholder={String(ports[0])}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor={`gw-name-${workloadId}`}>Readable name (optional)</Label>
              <Input
                id={`gw-name-${workloadId}`}
                className="w-40"
                placeholder="blog"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={gateway.busy || !view.ok}
              onClick={() => {
                setOpen(false);
                void gateway.handOver({
                  expiresIn: Math.round(Number(hours) * 3600),
                  ...(chosen === undefined ? {} : { httpPort: chosen }),
                  ...(name === '' ? {} : { name }),
                });
              }}
            >
              {gateway.busy ? 'Working…' : 'Hand it over'}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            The console derives one <strong>Gateway Grant</strong> for each member of this
            lease&rsquo;s Standby Set, from that member&rsquo;s own Continuation Token (spec
            §6.5.1), and seals them to{' '}
            <code>{view.gateway?.connectorUrl ?? 'the gateway'}</code>. The grant lets the
            gateway read this one lease&rsquo;s state and nothing else, until the moment above.
            No grant is stored here and none is ever shown.
          </p>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function Handed({ result }: { result: HandoverResult }) {
  if (result.gatewayError !== undefined) {
    return (
      <>
        <span className="font-medium">The gateway refused this handover: </span>
        <code>{result.gatewayError}</code>. {result.message}
      </>
    );
  }
  if (!result.sent) return <>{result.problems.join(' ')}</>;
  if (result.matches === false) {
    return (
      <>
        <span className="font-medium">The gateway answered a different hostname. </span>
        It says it serves <code>{result.hostname}</code>, and this workload&rsquo;s id derives{' '}
        <code>{result.expectedHostname}</code> (spec §12.2). Use the name the gateway gave, and
        treat the difference as worth reporting.
      </>
    );
  }
  return (
    <>
      <span className="font-medium">Served at </span>
      <code>{result.hostname}</code>
      {result.cost !== undefined && result.cost !== '0' ? (
        <> — this handover cost {result.cost} base units.</>
      ) : (
        <> — the handover cost nothing.</>
      )}
    </>
  );
}

/** What the name itself answered. §12.3's reasons, in words. */
function Serving({ serving }: { serving?: ServingView | undefined }) {
  if (serving === undefined) return null;
  if (serving.kind === 'serving') {
    return (
      <p className="text-sm">
        <span className="font-medium">The hostname answered {serving.status}</span>
        {serving.excerpt !== undefined && (
          <span className="text-muted-foreground"> — {serving.excerpt}</span>
        )}
      </p>
    );
  }
  if (serving.kind === 'no_grant') {
    // §12.3's healthy empty state. Nothing red, no retry button.
    return <p className="text-muted-foreground text-sm">{serving.message}</p>;
  }
  return (
    <p className="text-sm">
      <span className="font-medium">
        {serving.kind === 'unreachable' ? 'The hostname did not answer. ' : ''}
      </span>
      {serving.message}
    </p>
  );
}
