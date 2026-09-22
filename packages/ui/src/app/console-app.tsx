import { Button } from '@/components/ui/button';
import { useAccount } from '@/hooks/use-account';
import { useConsole } from '@/hooks/use-console';

import { AccountCard, AccountChip } from './account-view';
import { HealthView } from './health-view';
import { ProfileSwitcher } from './profile-switcher';
import { SignInView } from './sign-in-view';

/**
 * The shell.
 *
 * Two views now: sign-in and the signed-in console. Which one is shown is the
 * daemon's answer to `/api/account` and not anything this window remembers —
 * ADR 0020 puts the key in a signer the daemon holds, so the daemon is the
 * only thing that knows whether one is connected.
 *
 * The health view stays visible either way. Which network the console is
 * pointed at is a fact about the machine, not about the account, and a person
 * checking that the devnet connector is answering should not have to sign in
 * first.
 */
export function ConsoleApp() {
  const { health, profiles, loading, switching, error, refresh, selectProfile } = useConsole();
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
          <div className="flex items-center gap-3">
            {signedIn && <AccountChip account={account} />}
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
        {/* One region, not one per concern: a window with no launch token
            fails every call at once, and three identical boxes saying so is
            noise a person has to read three times. */}
        {(error ?? account.error) && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-lg border px-4 py-3 text-sm"
          >
            {[account.error, error]
              .filter((message): message is string => Boolean(message))
              .filter((message, at, all) => all.indexOf(message) === at)
              .map((message) => (
                <p key={message}>{message}</p>
              ))}
          </div>
        )}

        {account.status &&
          (signedIn ? <AccountCard account={account} /> : <SignInView account={account} />)}

        {health ? (
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
