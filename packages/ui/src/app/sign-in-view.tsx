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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AccountState } from '@/hooks/use-account';
import type { SessionStatus, SignerRecord } from '@/lib/daemon';

/**
 * Signing in.
 *
 * The remote signer comes first on the page, and that is the argument ADR 0020
 * makes laid out in pixels: a signer that never reveals the key is the right
 * default, and the console's own keystore is the fallback for an account that
 * has no signer yet. Both are offered plainly — a console that hid the local
 * keystore would just be one people paste an nsec into somewhere worse.
 *
 * What a person types here — an nsec, a mnemonic, a passphrase — goes to the
 * daemon and nowhere else. It is never put in component state that outlives
 * the submit, never in `localStorage`, and never in the URL.
 */
export function SignInView({ account }: { account: AccountState }) {
  const status = account.status;
  if (!status) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <RemoteSignerCard account={account} status={status} />
        <LocalKeystoreCard account={account} status={status} />
      </div>
      {status.signers.length > 0 && <SavedSigners account={account} status={status} />}
    </div>
  );
}

function RemoteSignerCard({
  account,
  status,
}: {
  account: AccountState;
  status: SessionStatus;
}) {
  const [uri, setUri] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const invitation = status.invitation;

  const needsPassphrase = status.keystore.needsPassphrase;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Connect a remote signer</CardTitle>
          <Badge variant="success">key never leaves it</Badge>
        </div>
        <CardDescription>
          NIP-46: Amber, nsec.app or <code className="font-mono text-xs">nak bunker</code>. The
          console signs by asking it, and holds no key of yours.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-2"
          onSubmit={(submit) => {
            submit.preventDefault();
            void account
              .addBunkerSigner({
                uri,
                ...(needsPassphrase && passphrase ? { passphrase } : {}),
              })
              .then((done) => {
                if (done) {
                  setUri('');
                  setPassphrase('');
                }
              });
          }}
        >
          <Label htmlFor="bunker-uri">Bunker URI</Label>
          <Input
            id="bunker-uri"
            name="bunker-uri"
            placeholder="bunker://…  or  you@example.com"
            autoComplete="off"
            spellCheck={false}
            value={uri}
            onChange={(change) => setUri(change.target.value)}
          />
          {needsPassphrase && (
            <>
              <Label htmlFor="bunker-passphrase">Keystore passphrase</Label>
              <Input
                id="bunker-passphrase"
                name="bunker-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(change) => setPassphrase(change.target.value)}
              />
            </>
          )}
          <Button type="submit" disabled={account.busy || uri.trim().length === 0}>
            {account.busy ? 'Connecting…' : 'Connect'}
          </Button>
        </form>

        <div className="border-t pt-4">
          {invitation ? (
            <div className="space-y-2">
              <div className="text-muted-foreground text-xs tracking-wide uppercase">
                {invitation.state === 'waiting'
                  ? 'Waiting for a signer to accept'
                  : 'The invitation failed'}
              </div>
              <code className="bg-muted block rounded-md p-2 font-mono text-[0.7rem] break-all">
                {invitation.uri}
              </code>
              {invitation.error && (
                <p className="text-destructive text-sm">{invitation.error}</p>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={account.busy}
                onClick={() => void account.cancelInvite()}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">
                Or have the signer come to the console instead: this prints a{' '}
                <code className="font-mono text-xs">nostrconnect://</code> for Amber to scan.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={account.busy}
                onClick={() =>
                  void account.invite(needsPassphrase && passphrase ? { passphrase } : {})
                }
              >
                Show a nostrconnect invitation
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type LocalMode = 'generate' | 'nsec' | 'nip06';

function LocalKeystoreCard({
  account,
  status,
}: {
  account: AccountState;
  status: SessionStatus;
}) {
  const [mode, setMode] = useState<LocalMode>('generate');
  const [nsec, setNsec] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const needsPassphrase = status.keystore.needsPassphrase;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Use the local keystore</CardTitle>
          <Badge variant={status.keystore.backend === 'libsecret' ? 'secondary' : 'warning'}>
            {status.keystore.backend === 'libsecret' ? 'gnome-keyring' : 'encrypted file'}
          </Badge>
        </div>
        <CardDescription>
          The key is sealed into {status.keystore.location} and held by the daemon only while
          you are signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(submit) => {
            submit.preventDefault();
            void account
              .addLocalSigner({
                mode,
                ...(mode === 'nsec' ? { nsec } : {}),
                ...(mode === 'nip06' ? { mnemonic } : {}),
                ...(needsPassphrase && passphrase ? { passphrase } : {}),
              })
              .then((done) => {
                if (done) {
                  setNsec('');
                  setMnemonic('');
                  setPassphrase('');
                }
              });
          }}
        >
          <div
            role="group"
            aria-label="Where the key comes from"
            className="bg-muted inline-flex items-center gap-1 rounded-lg p-1"
          >
            {(
              [
                ['generate', 'Generate'],
                ['nsec', 'Import nsec'],
                ['nip06', 'Import mnemonic'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? 'default' : 'ghost'}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
          </div>

          {mode === 'generate' && (
            <p className="text-muted-foreground text-sm">
              A new Nostr identity, made here and sealed into the keystore. Back it up from
              your keyring before you rely on it.
            </p>
          )}

          {mode === 'nsec' && (
            <div className="space-y-2">
              <Label htmlFor="local-nsec">Secret key</Label>
              <Input
                id="local-nsec"
                name="local-nsec"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="nsec1…"
                value={nsec}
                onChange={(change) => setNsec(change.target.value)}
              />
            </div>
          )}

          {mode === 'nip06' && (
            <div className="space-y-2">
              <Label htmlFor="local-mnemonic">NIP-06 words</Label>
              <Input
                id="local-mnemonic"
                name="local-mnemonic"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="twelve or twenty-four words"
                value={mnemonic}
                onChange={(change) => setMnemonic(change.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                This is the account&rsquo;s Nostr key. The Chain Seed is a separate mnemonic
                and comes later.
              </p>
            </div>
          )}

          {needsPassphrase && (
            <div className="space-y-2">
              <Label htmlFor="local-passphrase">Keystore passphrase</Label>
              <Input
                id="local-passphrase"
                name="local-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(change) => setPassphrase(change.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                No keyring answered on this session, so the key is sealed under this
                passphrase. Nothing can recover it if you lose it.
              </p>
            </div>
          )}

          <Button
            type="submit"
            disabled={
              account.busy ||
              (mode === 'nsec' && nsec.trim().length === 0) ||
              (mode === 'nip06' && mnemonic.trim().length === 0)
            }
          >
            {account.busy
              ? 'Working…'
              : mode === 'generate'
                ? 'Generate and sign in'
                : 'Import and sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SavedSigners({ account, status }: { account: AccountState; status: SessionStatus }) {
  const [passphrases, setPassphrases] = useState<Record<string, string>>({});
  const needsPassphrase = status.keystore.needsPassphrase;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Signers on this machine</CardTitle>
        <CardDescription>
          Signing out leaves these here. Forgetting one removes its secret from the keystore.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {status.signers.map((signer) => (
          <div
            key={signer.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{signer.label}</span>
                <Badge variant="outline">{describeSigner(signer)}</Badge>
              </div>
              <div className="text-muted-foreground font-mono text-xs break-all">
                {signer.npub}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {needsPassphrase && (
                <Input
                  aria-label={`Passphrase for ${signer.label}`}
                  type="password"
                  className="h-8 w-40"
                  autoComplete="off"
                  value={passphrases[signer.id] ?? ''}
                  onChange={(change) =>
                    setPassphrases((held) => ({ ...held, [signer.id]: change.target.value }))
                  }
                />
              )}
              <Button
                size="sm"
                disabled={account.busy}
                onClick={() => {
                  const passphrase = passphrases[signer.id];
                  void account
                    .signIn({ id: signer.id, ...(passphrase ? { passphrase } : {}) })
                    .then(() => setPassphrases((held) => ({ ...held, [signer.id]: '' })));
                }}
              >
                Sign in
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={account.busy}
                onClick={() => void account.forgetSigner(signer.id)}
              >
                Forget
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function describeSigner(signer: SignerRecord): string {
  if (signer.kind === 'remote') return 'remote signer';
  if (signer.origin === 'nip06') return 'local key, from a mnemonic';
  if (signer.origin === 'nsec') return 'local key, imported';
  return 'local key, generated here';
}
