import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAccount } from '@/hooks/use-account';
import { useConsole } from '@/hooks/use-console';
import { useDirectory } from '@/hooks/use-directory';

import { AccountCard, AccountChip } from './account-view';
import { DirectoryView } from './directory-view';
import { HealthView } from './health-view';
import { ProfileSwitcher } from './profile-switcher';
import { SignInView } from './sign-in-view';

/**
 * The shell.
 *
 * Three views now — health (#87), the Provider Directory (#91) and the Account
 * (#88) — behind the header that will carry the rest: funds (#89) and the
 * workload dashboard (#90 onward).
 *
 * The console is NOT gated on signing in, and that is deliberate. Reading the
 * directory and asking the connector what it settles in are free, they need no
 * key, and a person deciding whether TOON Network is worth an account should be
 * able to look first. Sign-in is a view like the others; the tickets that spend
 * money are what will need it.
 *
 * Whether an account is signed in is the daemon's answer to `/api/account`, and
 * never anything this window remembers: ADR 0020 puts the key in a signer the
 * daemon holds, so the daemon is the only thing that knows.
 */

type Tab = 'health' | 'directory' | 'account';

const TABS: { id: Tab; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'directory', label: 'Providers' },
  { id: 'account', label: 'Account' },
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
  const account = useAccount();
  const signedIn = account.status?.signedIn === true;

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
            {/* Only when signed in: the Account tab is right there, and a
                second control saying the same thing is noise. */}
            {signedIn && <AccountChip account={account} onOpen={() => setTab('account')} />}
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
        {/* One region, not one per concern: a window with no launch token fails
            every call at once, and three identical boxes saying so is noise a
            person has to read three times. */}
        {(error ?? directory.error ?? account.error) && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-lg border px-4 py-3 text-sm"
          >
            {[error, directory.error, account.error]
              .filter((message): message is string => Boolean(message))
              .filter((message, at, all) => all.indexOf(message) === at)
              .map((message) => (
                <p key={message}>{message}</p>
              ))}
          </div>
        )}

        {tab === 'account' ? (
          account.status &&
          (signedIn ? <AccountCard account={account} /> : <SignInView account={account} />)
        ) : tab === 'directory' ? (
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
