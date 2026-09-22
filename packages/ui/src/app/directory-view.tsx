import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { livenessNow } from '@/hooks/use-directory';
import type { Directory, ListingView, LivenessView, ProviderView } from '@/lib/daemon';

import { DirectoryFilterBar } from './directory-filters';

/**
 * The Provider Directory (TOON_Network#91).
 *
 * One card per provider, because a provider is what a Profile identifies and
 * what a Liveness is about; its tiers are rows inside it, because a Listing
 * without the Profile that says where the provider is reached and paid is not
 * something anybody can buy (§4.2, ADR 0002).
 *
 * Every price is shown PER LEASE INTERVAL and in the unit the wire uses. No
 * conversion, no "about $0.001": the settlement token and its decimals are the
 * provider's own, they are on the card, and a console that quietly turned
 * µUSDC into dollars would be inventing a rate.
 *
 * Nothing here spawns or pays. Choosing a tier is #90.
 */
export function DirectoryView({
  directory,
  filters,
  loading,
  now,
  onFilters,
  onRefresh,
}: {
  directory?: Directory;
  filters: Parameters<typeof DirectoryFilterBar>[0]['filters'];
  loading: boolean;
  now: number;
  onFilters: (filters: Parameters<typeof DirectoryFilterBar>[0]['filters']) => void;
  onRefresh: () => void;
}) {
  const providers = directory?.state === 'ok' ? directory.providers : [];
  const gpuModels = [
    ...new Set(
      providers.flatMap((provider) =>
        provider.listings.flatMap((listing) =>
          listing.resources.gpu === undefined ? [] : [listing.resources.gpu]
        )
      )
    ),
  ].sort();

  return (
    <section className="space-y-4" aria-label="Provider Directory">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DirectoryFilterBar
          filters={filters}
          gpuModels={gpuModels}
          onChange={onFilters}
          disabled={loading}
        />
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading relays…' : 'Read again'}
        </Button>
      </div>

      {directory?.state === 'unconfigured' && (
        <p className="text-muted-foreground text-sm">{directory.reason}</p>
      )}

      {directory?.state === 'ok' && (
        <>
          <RelayLine directory={directory} />
          {providers.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No provider on this network publishes a Listing that matches. Reading the
              directory is free, so widening a filter costs nothing.
            </p>
          ) : (
            <ul className="space-y-4">
              {providers.map((provider) => (
                <li key={provider.pubkey}>
                  <ProviderCard provider={provider} now={now} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {directory === undefined && !loading && (
        <p className="text-muted-foreground text-sm">Nothing read yet.</p>
      )}
    </section>
  );
}

function RelayLine({ directory }: { directory: Extract<Directory, { state: 'ok' }> }) {
  const failed = directory.relays.read.filter((relay) => relay.state !== 'read');
  return (
    <p className="text-muted-foreground text-xs">
      Read free over NIP-01 from {directory.relays.read.length} relay
      {directory.relays.read.length === 1 ? '' : 's'} at{' '}
      {new Date(directory.readAt).toLocaleTimeString()}
      {failed.length > 0 && (
        <>
          {' '}
          &mdash;{' '}
          <span className="text-warning-foreground">
            {failed.map((relay) => `${relay.url} (${relay.state})`).join(', ')}
          </span>
        </>
      )}
      {directory.listingsWithoutProfile > 0 && (
        <>
          {' '}
          &mdash; {directory.listingsWithoutProfile} Listing(s) hidden: no Provider Profile
          found
        </>
      )}
      {directory.rejectedEvents > 0 && (
        <> &mdash; {directory.rejectedEvents} event(s) dropped: bad signature</>
      )}
    </p>
  );
}

function ProviderCard({ provider, now }: { provider: ProviderView; now: number }) {
  const { profile } = provider;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-mono text-sm break-all">{profile.ilpAddress}</CardTitle>
          <div className="flex items-center gap-2">
            {profile.hidden && <Badge variant="secondary">Hidden Provider</Badge>}
            <Badge variant="outline">{profile.isolation}</Badge>
            <LivenessBadge liveness={provider.liveness} now={now} />
          </div>
        </div>
        <CardDescription className="font-mono text-xs break-all">
          {provider.pubkey}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {provider.listings.map((listing) => (
            <li key={listing.address}>
              <ListingRow listing={listing} />
            </li>
          ))}
        </ul>

        <dl className="text-muted-foreground grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
          <dt>Connector</dt>
          <dd className="font-mono break-all">{profile.connectorUrl}</dd>
          {profile.host !== undefined && (
            <>
              <dt>Host</dt>
              <dd className="font-mono break-all">{profile.host}</dd>
            </>
          )}
          <dt>Relay Set</dt>
          <dd className="font-mono break-all">
            {profile.relays.join(', ') || 'none published'}
          </dd>
          <dt>Read from</dt>
          <dd className="font-mono break-all">{provider.relaysRead.join(', ')}</dd>
          <dt>Settles</dt>
          <dd className="font-mono break-all">
            {profile.settlement.map((term) => term.chain).join(', ') || 'nothing published'}
          </dd>
        </dl>

        {(provider.supersededListings > 0 || provider.rejectedListings.length > 0) && (
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">What was set aside</summary>
            {provider.supersededListings > 0 && (
              <p className="mt-1">
                {provider.supersededListings} older Listing version(s) superseded; only the
                current one is shown.
              </p>
            )}
            <ul className="mt-1 space-y-0.5">
              {provider.rejectedListings.map((rejected) => (
                <li key={rejected.name}>
                  <code className="font-mono">{rejected.name}</code> is not purchasable:{' '}
                  {rejected.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function ListingRow({ listing }: { listing: ListingView }) {
  const { resources } = listing;
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium">{listing.name}</span>
          <span className="text-muted-foreground text-xs">v{listing.version}</span>
          <Badge variant="outline">{listing.arch}</Badge>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium">
            {listing.price.toLocaleString()} µUSDC
            <span className="text-muted-foreground font-normal">
              {' '}
              / {formatInterval(listing.leaseIntervalSeconds)}
            </span>
          </div>
          <div className="text-muted-foreground text-xs">
            {listing.standbyPrice === undefined
              ? 'no warm standby'
              : `standby ${listing.standbyPrice.toLocaleString()} µUSDC / ${formatInterval(listing.leaseIntervalSeconds)}`}
          </div>
        </div>
      </div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>
          {resources.cpuMillicores} mCPU &middot; {resources.memoryMb} MB &middot;{' '}
          {resources.storageGb} GB
        </span>
        {resources.gpu !== undefined && <Badge variant="secondary">{resources.gpu}</Badge>}
        {listing.capabilities.map((capability) => (
          <Badge
            key={capability}
            variant={
              listing.unspecifiedCapabilities.includes(capability) ? 'outline' : 'default'
            }
            title={
              listing.unspecifiedCapabilities.includes(capability)
                ? 'This capability is not one the spec defines, so what it grants is between you and the provider.'
                : undefined
            }
          >
            {capability}
          </Badge>
        ))}
        {listing.available !== undefined && <span>{listing.available} could start now</span>}
      </div>
    </div>
  );
}

/**
 * Live or stale, decided here and now.
 *
 * A Liveness expires without a refresh (§4.3), so this badge counts the
 * provider's own `expiration` down in the browser and flips itself over when
 * it passes. Nothing is refetched: what changed is the time, not the event.
 */
function LivenessBadge({ liveness, now }: { liveness: LivenessView; now: number }) {
  const current = livenessNow(liveness, now);
  if (current.state === 'unknown') {
    return (
      <Badge variant="warning" title="No unexpired Liveness on any relay read.">
        no liveness
      </Badge>
    );
  }
  const seconds = current.secondsUntilExpiry ?? 0;
  return current.state === 'live' ? (
    <Badge variant="success" title={`Expires at ${liveness.expiresAt}`}>
      live &middot; {formatSeconds(seconds)} left
    </Badge>
  ) : (
    <Badge variant="destructive" title={`Expired at ${liveness.expiresAt}`}>
      stale &middot; {formatSeconds(-seconds)} ago
    </Badge>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A Lease Interval as a person reads one. The seconds stay in the title. */
function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
