import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { AccountState } from '@/hooks/use-account';
import { DaemonError, daemon, type AccountView as Account } from '@/lib/daemon';

/**
 * Who is signed in.
 *
 * The name and the avatar are the account's own kind-0, read off its relays,
 * and they are here for one reason: an npub is sixty-three characters that all
 * look alike, and a person about to spend money needs to recognise the
 * identity doing it at a glance. If the account has published nothing, the
 * card says so and the npub stands on its own — that is a quiet account, not
 * a broken sign-in.
 *
 * "Sign a test event" is the acceptance criterion made visible: a round trip
 * through whatever signer is connected, which on a remote signer means the
 * phone lights up and the console waits. Nothing is published; the signature
 * is shown and thrown away.
 */
export function AccountCard({ account }: { account: AccountState }) {
  const view = account.status?.account;
  if (!view) return null;
  const metadata = view.profile?.metadata;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Avatar src={metadata?.picture} alt={metadata?.name ?? view.npub} />
            <div className="min-w-0">
              <CardTitle>{metadata?.displayName ?? metadata?.name ?? 'Signed in'}</CardTitle>
              <CardDescription className="font-mono text-xs break-all">
                {view.npub}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={view.signerKind === 'remote' ? 'success' : 'secondary'}>
              {view.signerKind === 'remote' ? 'remote signer' : 'local keystore'}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => void account.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {metadata?.nip05 && <Field label="NIP-05" value={metadata.nip05} />}
        {metadata?.about && <Field label="About" value={metadata.about} />}
        <Field label="Signer" value={view.signerLabel} />
        <Field label="Metadata" value={describeProfile(view)} />
        <TestSignature busy={account.busy} />
      </CardContent>
    </Card>
  );
}

/** The header's line: enough to tell which account, and no more. */
export function AccountChip({ account }: { account: AccountState }) {
  const view = account.status?.account;
  if (!view) return null;
  const metadata = view.profile?.metadata;
  return (
    <div className="flex items-center gap-2">
      <Avatar src={metadata?.picture} alt={metadata?.name ?? view.npub} size={24} />
      <span className="max-w-[14rem] truncate text-sm">
        {metadata?.displayName ?? metadata?.name ?? shortNpub(view.npub)}
      </span>
    </div>
  );
}

function TestSignature({ busy }: { busy: boolean }) {
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<string>();
  const [failure, setFailure] = useState<string>();

  return (
    <div className="space-y-2 border-t pt-3">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || signing}
        onClick={() => {
          setSigning(true);
          setResult(undefined);
          setFailure(undefined);
          daemon
            .sign({
              // NIP-98-shaped and never published: a signature this console
              // asked for, about this console.
              kind: 27235,
              content: '',
              tags: [
                ['u', 'http://127.0.0.1/api/account/sign'],
                ['method', 'POST'],
              ],
            })
            .then((signed) => setResult(signed.event.id))
            .catch((caught: unknown) =>
              setFailure(
                caught instanceof DaemonError ? caught.message : 'The signer did not answer.'
              )
            )
            .finally(() => setSigning(false));
        }}
      >
        {signing ? 'Waiting for the signer…' : 'Sign a test event'}
      </Button>
      {result && (
        <p className="text-sm">
          Signed:{' '}
          <code className="font-mono text-xs break-all" data-testid="test-signature">
            {result}
          </code>
        </p>
      )}
      {failure && <p className="text-destructive text-sm">{failure}</p>}
    </div>
  );
}

function Avatar({ src, alt, size = 40 }: { src?: string; alt: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div
        aria-hidden="true"
        className="bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={{ width: size, height: size }}
      >
        {alt.slice(4, 6).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      onError={() => setBroken(true)}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

function describeProfile(view: Account): string {
  if (view.profileState === 'loading') return 'reading the account’s relays…';
  if (view.profileState === 'none') {
    return view.profile?.relaySource === 'none'
      ? 'this network profile names no relay to read from'
      : 'this account has published no kind-0 on the relays read';
  }
  const from =
    view.profile?.relaySource === 'nip65'
      ? 'the account’s own relays (NIP-65)'
      : 'the network profile’s relay';
  return `read from ${from}`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-muted-foreground shrink-0 text-xs tracking-wide uppercase">
        {label}
      </span>
      <span className="break-words">{value}</span>
    </div>
  );
}

function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}
