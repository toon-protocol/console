import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAccount } from '@/hooks/use-account';
import { useChainSeed } from '@/hooks/use-chain-seed';
import { useConsole } from '@/hooks/use-console';
import { useDirectory } from '@/hooks/use-directory';
import { useFunding } from '@/hooks/use-funding';
import { useTemplates } from '@/hooks/use-templates';

import { AccountCard, AccountChip } from './account-view';
import { ChainSeedCard } from './chain-seed-view';
import { DirectoryView } from './directory-view';
import { FundingView } from './funding-view';
import { HealthView } from './health-view';
import { ProfileSwitcher } from './profile-switcher';
import { SignInView } from './sign-in-view';
import { TemplatesView } from './templates-view';

/**
 * The shell.
 *
 * Five views now — health (#87), the Provider Directory (#91), Templates (#94),
 * the Account (#88, with its Chain Seed from #89) and Funds (#90) — behind the
 * header that will carry the workload dashboard (#93 onward).
 *
 * Templates sits beside Providers rather than inside it, because the two
 * answer different questions: a Listing is WHERE a workload runs and what it
 * costs, a Template is WHAT runs and what may be set about it. Neither knows
 * about the other until a spawn puts them together (#92).
 *
 * Funds is the one view that is USELESS without an account, and it says so
 * rather than being hidden: a person deciding whether this is worth an account
 * should be able to see what funding would involve — two addresses, a gas
 * problem nobody can solve for them, and a channel — before they make one.
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

type Tab = 'health' | 'directory' | 'templates' | 'account' | 'funds';

const TABS: { id: Tab; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'directory', label: 'Providers' },
  { id: 'templates', label: 'Templates' },
  { id: 'funds', label: 'Funds' },
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
  // Keyed to the profile for the same reason the directory is: Templates are
  // published to a network's relays, and another network has other publishers.
  const templates = useTemplates({
    active: tab === 'templates',
    ...(health === undefined ? {} : { profileId: health.profile.id }),
  });
  const account = useAccount();
  const signedIn = account.status?.signedIn === true;
  // Keyed to the account: the Chain Seed belongs to whoever is signed in, and
  // signing in as somebody else is a different seed or none (ADR 0020).
  const chainSeed = useChainSeed({ pubkey: account.status?.account?.pubkey });
  // Keyed to the account AND the network: an address belongs to the account, a
  // channel belongs to the network, and a switch of either is another view.
  const funding = useFunding({
    active: tab === 'funds',
    pubkey: account.status?.account?.pubkey,
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
            {[error, directory.error, templates.error, account.error]
              .filter((message): message is string => Boolean(message))
              .filter((message, at, all) => all.indexOf(message) === at)
              .map((message) => (
                <p key={message}>{message}</p>
              ))}
          </div>
        )}

        {tab === 'funds' ? (
          <FundingView funding={funding} />
        ) : tab === 'account' ? (
          account.status &&
          (signedIn ? (
            <div className="space-y-4">
              <AccountCard account={account} />
              <ChainSeedCard seed={chainSeed} />
            </div>
          ) : (
            <SignInView account={account} />
          ))
        ) : tab === 'templates' ? (
          <TemplatesView templates={templates} />
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
