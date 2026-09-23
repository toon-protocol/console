import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAccount } from '@/hooks/use-account';
import { useChainSeed } from '@/hooks/use-chain-seed';
import { useConsole } from '@/hooks/use-console';
import { useDesktop } from '@/hooks/use-desktop';
import { useDirectory } from '@/hooks/use-directory';
import { useDocs } from '@/hooks/use-docs';
import { useFunding } from '@/hooks/use-funding';
import { useGasStation } from '@/hooks/use-gas-station';
import { useLeases } from '@/hooks/use-leases';
import { useWorkloads } from '@/hooks/use-workloads';
import { useTemplates } from '@/hooks/use-templates';
import type { MenuView } from '@/lib/daemon';

import { AccountCard, AccountChip } from './account-view';
import { ChainSeedCard } from './chain-seed-view';
import { DirectoryView } from './directory-view';
import { DocsView } from './docs-view';
import { FundingView } from './funding-view';
import { HealthView } from './health-view';
import { ProfileSwitcher } from './profile-switcher';
import { SignInView } from './sign-in-view';
import { TemplatesView } from './templates-view';
import { WorkloadsView } from './workloads-view';

/**
 * The shell.
 *
 * Seven views now — health (#87), the Provider Directory (#91), Templates
 * (#94), Workloads (#92), the Account (#88, with its Chain Seed from #89),
 * Funds (#90) and Help (#102) — behind the header that will carry the runway
 * and the extend and terminate controls (#93).
 *
 * Workloads is where the console first SPENDS: it holds the Lease Vault and
 * the spawn form. It is also the one view that needs the Provider Directory
 * loaded for a reason other than looking at it, which is why the directory
 * hook is live on both tabs — a spawn names a Listing, and the Listing's
 * current version and price come off the relays rather than out of a form.
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

type Tab = 'health' | 'directory' | 'templates' | 'workloads' | 'account' | 'funds' | 'docs';

/**
 * Which tab an Omarchy menu entry means (TOON_Network#99).
 *
 * "New workload" is the Template gallery, because that is where a workload is
 * started from — the milestone's own words. The menu speaks in the three
 * things a person goes to the console FOR; the tabs are how this window is
 * arranged, and the two are allowed to differ.
 */
const MENU_TABS: Record<MenuView, Tab> = {
  workloads: 'workloads',
  'new-workload': 'templates',
  funds: 'funds',
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'health', label: 'Health' },
  { id: 'directory', label: 'Providers' },
  { id: 'templates', label: 'Templates' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'funds', label: 'Funds' },
  { id: 'account', label: 'Account' },
  { id: 'docs', label: 'Help' },
];

export function ConsoleApp() {
  const { health, profiles, loading, switching, error, refresh, selectProfile } = useConsole();
  const [tab, setTab] = useState<Tab>('health');
  // The desktop: the theme this window follows, and the view an Omarchy menu
  // entry asked for. Always live — a theme change has to reach the window
  // whatever tab it is on.
  const desktop = useDesktop();
  const requested = desktop.open;
  const clearOpen = desktop.clearOpen;
  useEffect(() => {
    if (requested === undefined) return;
    setTab(MENU_TABS[requested]);
    clearOpen();
  }, [requested, clearOpen]);
  // The directory is keyed to the active profile: a switch is another network,
  // another relay and another set of providers.
  const directory = useDirectory({
    active: tab === 'directory' || tab === 'workloads',
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
  // Buying the next chain's gas (TOON_Network#119). It sits on the same tab
  // and is keyed the same way; `revision` re-reads it when a channel lands,
  // because a channel that just opened is a channel that can now pay for one.
  const gas = useGasStation({
    active: tab === 'funds',
    pubkey: account.status?.account?.pubkey,
    ...(health === undefined ? {} : { profileId: health.profile.id }),
    revision: funding.status?.chains.map((chain) => chain.channel.phase).join('|'),
  });
  // Keyed to the ACCOUNT alone. A lease belongs to whoever holds its Root
  // Secret, and the vault holds leases from every network this account has
  // spawned on — each record says which (ADR 0021).
  const leases = useLeases({
    active: tab === 'workloads',
    pubkey: account.status?.account?.pubkey,
  });
  // Keyed to the PROFILE and not the account: the docs are published to a
  // network's relays and reading them is free, so the Help tab works before
  // anyone has signed in — which matters, because one of these pages is the
  // one that explains what signing in is for (TOON_Network#102).
  const docs = useDocs({
    active: tab === 'docs',
    ...(health === undefined ? {} : { profileId: health.profile.id }),
  });
  // The dashboard beside it, keyed the same way. It is a SECOND read of the
  // same leases and deliberately so: the vault is what this account owns, and
  // this is what each provider says about it now (§6.5). It polls while the
  // tab is open, on the free route, and spends nothing until a button is
  // pressed (TOON_Network#93).
  const workloads = useWorkloads({
    active: tab === 'workloads',
    pubkey: account.status?.account?.pubkey,
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

        {tab === 'workloads' ? (
          <WorkloadsView
            workloads={workloads}
            leases={leases}
            {...(directory.directory === undefined ? {} : { directory: directory.directory })}
            signedIn={signedIn}
            onFindProviders={() => setTab('directory')}
          />
        ) : tab === 'funds' ? (
          <FundingView funding={funding} gas={gas} />
        ) : tab === 'docs' ? (
          <DocsView docs={docs} />
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
