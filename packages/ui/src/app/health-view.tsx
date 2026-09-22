import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { ConnectorHealth, Health } from '@/lib/daemon';

/**
 * What the console is, and what it is talking to.
 *
 * Two cards: the daemon's own identity, and the active profile's connector as
 * the connector itself describes it. Nothing on the right-hand card is a
 * constant in this app — the ILP addresses, the settlement chains and the
 * route prices are all read from `GET /ilp` on the connector the active
 * profile names, so a repriced route or a new chain shows up here without a
 * release (TOON_Network#87).
 */
export function HealthView({ health }: { health: Health }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Daemon</CardTitle>
          <CardDescription>The service this window is talking to.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <Field label="Version" value={`${health.daemon.name} ${health.daemon.version}`} />
          <Field label="Node" value={health.daemon.node} />
          <Field label="Uptime" value={formatUptime(health.daemon.uptimeSeconds)} />
          <Field label="Channel state" value={health.storage.channels} mono />
          <Field label="Checked" value={new Date(health.checkedAt).toLocaleTimeString()} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Connector</CardTitle>
            <ConnectorBadge connector={health.connector} />
          </div>
          <CardDescription>
            {health.profile.label} &mdash; read live from the connector&rsquo;s own{' '}
            <code className="font-mono text-xs">GET /ilp</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConnectorFacts connector={health.connector} />
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectorBadge({ connector }: { connector: ConnectorHealth }) {
  if (connector.state === 'ok') return <Badge variant="success">answering</Badge>;
  if (connector.state === 'unreachable') return <Badge variant="destructive">unreachable</Badge>;
  return <Badge variant="warning">not configured</Badge>;
}

function ConnectorFacts({ connector }: { connector: ConnectorHealth }) {
  if (connector.state !== 'ok') {
    return <p className="text-muted-foreground text-sm">{connector.reason}</p>;
  }
  return (
    <div className="space-y-3">
      <Field label="Endpoint" value={connector.endpoint} mono />
      <div>
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          ILP addresses
        </div>
        <ul className="mt-1 flex flex-wrap gap-1">
          {connector.ilpAddresses.map((address) => (
            <li key={address}>
              <Badge variant="outline" className="font-mono">
                {address}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-muted-foreground text-xs uppercase tracking-wide">
          Settlement chains
        </div>
        {connector.settlements.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-sm">
            This connector settles on no chain.
          </p>
        ) : (
          <ul className="mt-1 space-y-2">
            {connector.settlements.map((settlement) => (
              <li key={settlement.chain} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="font-mono">
                    {settlement.chain}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {settlement.decimals} decimals
                  </span>
                </div>
                <div className="mt-1 space-y-0.5">
                  <Field label="Settles with" value={settlement.settlementAddress} mono />
                  <Field label="Token" value={settlement.tokenAddress} mono />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details>
        <summary className="text-muted-foreground cursor-pointer text-xs uppercase tracking-wide">
          Routes ({connector.routes.length})
        </summary>
        <ul className="mt-1 space-y-0.5">
          {connector.routes.map((route) => (
            <li key={route.prefix} className="flex justify-between gap-4 font-mono text-xs">
              <span className="truncate">{route.prefix}</span>
              <span className="text-muted-foreground shrink-0">
                {route.price}
                {route.pricePerKib ? ` + ${route.pricePerKib}/KiB` : ''}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-muted-foreground shrink-0 text-xs uppercase tracking-wide">
        {label}
      </span>
      <span className={mono ? 'font-mono text-xs break-all' : 'break-words'}>{value}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
