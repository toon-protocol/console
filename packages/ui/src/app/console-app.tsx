import { Button } from '@/components/ui/button';
import { useConsole } from '@/hooks/use-console';

import { HealthView } from './health-view';
import { ProfileSwitcher } from './profile-switcher';

/**
 * The shell.
 *
 * One view in this ticket — health — behind the header that will carry the
 * rest: the account and its signer (#88), funds (#89) and the workload
 * dashboard (#90 onward). The header is what stays; the main region is what
 * those tickets fill.
 */
export function ConsoleApp() {
  const { health, profiles, loading, switching, error, refresh, selectProfile } = useConsole();

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
        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm"
          >
            {error}
          </div>
        )}

        {health ? (
          <HealthView health={health} />
        ) : (
          !error && <p className="text-muted-foreground text-sm">Reading the daemon&rsquo;s health&hellip;</p>
        )}
      </main>
    </div>
  );
}
