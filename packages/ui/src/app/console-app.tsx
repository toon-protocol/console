import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useConsole } from '@/hooks/use-console';
import { useDirectory } from '@/hooks/use-directory';

import { DirectoryView } from './directory-view';
import { HealthView } from './health-view';
import { ProfileSwitcher } from './profile-switcher';

/**
 * The shell.
 *
 * Two views now — health (#87) and the Provider Directory (#91) — behind the
 * header that will carry the rest: the account and its signer (#88), funds
 * (#89) and the workload dashboard (#90 onward). The header is what stays;
 * the main region is what those tickets fill.
 */

type Tab = 'health' | 'directory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'directory', label: 'Providers' },
];

export function ConsoleApp() {
  const { health, profiles, loading, switching, error, refresh, selectProfile } = useConsole();
  const [tab, setTab] = useState<Tab>('health');
  // The directory is keyed to the active profile: a switch is another network,
  // another relay and another set of providers.
  const directory = useDirectory({
    active: tab === 'directory',
    ...(health === undefined ? {} : { profileId: health.profile.id }),
  });

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div>
            <h1 className="text-base font-semibold">TOON Console</h1>
            <p className="text-muted-foreground text-xs">
              {health ? `daemon ${health.daemon.version}` : 'connecting to the daemon…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <nav className="flex items-center gap-1" aria-label="Views">
              {TABS.map((entry) => (
                <Button
                  key={entry.id}
                  size="sm"
                  variant={tab === entry.id ? 'secondary' : 'ghost'}
                  aria-pressed={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </Button>
              ))}
            </nav>
            <ProfileSwitcher
              profiles={profiles}
              {...(switching === undefined ? {} : { switching })}
              onSelect={selectProfile}
            />
            <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
              {loading ? 'Reading…' : 'Refresh'}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-6 py-6">
        {(error ?? directory.error) && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm"
          >
            {error ?? directory.error}
          </div>
        )}

        {tab === 'directory' ? (
          <DirectoryView
            {...(directory.directory === undefined ? {} : { directory: directory.directory })}
            filters={directory.filters}
            loading={directory.loading}
            now={directory.now}
            onFilters={directory.setFilters}
            onRefresh={directory.refresh}
          />
        ) : health ? (
          <HealthView health={health} />
        ) : (
          !error && (
            <p className="text-muted-foreground text-sm">
              Reading the daemon&rsquo;s health&hellip;
            </p>
          )
        )}
      </main>
    </div>
  );
}
