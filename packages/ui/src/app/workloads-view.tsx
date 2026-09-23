import { useEffect, useMemo, useState } from 'react';

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
import type { LeasesState } from '@/hooks/use-leases';
import type { WorkloadsState } from '@/hooks/use-workloads';
import type {
  Directory,
  LeaseView,
  ListingView,
  PreflightView,
  ProviderView,
  SpawnRequestBody,
  StandbySetPreflightView,
  StandbySetRequestBody,
} from '@/lib/daemon';
import { WorkloadCard } from './workload-card';

/**
 * Workloads: the first screen in this console that spends money.
 *
 * Everything before it was free — reading the directory, asking a connector
 * what it settles in, opening a channel with the account's own funds. Pressing
 * **Spawn** hands µUSDC to a provider, and it does so whether or not the spawn
 * works: a refused request on a paid route is still billed (spec §5, ADR
 * 0003). So the page is arranged around making that fact impossible to press
 * past by accident.
 *
 * 1. **What it will cost and who collects**, from the preflight, updated as
 *    the form changes. The preflight is free and sends nothing.
 * 2. **Every problem with the request**, listed in full before the button is
 *    live. A provider would charge an interval to tell you the same thing
 *    (TOON_Network#115).
 * 3. **Where the Root Secret will go**, named: the account's own relays, or —
 *    if the lease is marked local only — this machine and nowhere else.
 * 4. **The button**, disabled with the reason on it whenever the above is not
 *    settled.
 *
 * The workload list above the form is the Lease Vault, read from the account's
 * relays. That is the whole of the recovery story: sign in on another machine
 * and these same cards are there, because each one's Root Secret came back
 * sealed to the account's own key (ADR 0021).
 */
export function WorkloadsView({
  leases,
  workloads,
  directory,
  signedIn,
  onFindProviders,
}: {
  leases: LeasesState;
  workloads: WorkloadsState;
  directory?: Directory | undefined;
  signedIn: boolean;
  onFindProviders: () => void;
}) {
  if (!signedIn) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sign in to run a workload</CardTitle>
          <CardDescription>
            A lease&rsquo;s Root Secret is sealed to the account that holds it, and nothing in
            TOON Network can recover one that is lost. There is no account to seal it to until
            you sign in.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {leases.error && <Problem leases={leases} />}
      {workloads.error && <WorkloadProblem workloads={workloads} />}
      {workloads.lastAction && <ActionReport workloads={workloads} />}
      {leases.spawned?.lease && <Spawned leases={leases} />}
      <Vault leases={leases} workloads={workloads} />
      <SpawnForm leases={leases} directory={directory} onFindProviders={onFindProviders} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Problem({ leases }: { leases: LeasesState }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive space-y-2 rounded-lg border px-4 py-3 text-sm"
    >
      <p className="font-medium">
        {leases.providerError
          ? `The provider refused this spawn: ${leases.providerError}`
          : 'That spawn did not happen'}
      </p>
      <p>{leases.error}</p>
      <Button size="sm" variant="outline" onClick={leases.clearError}>
        Dismiss
      </Button>
    </div>
  );
}

/** An action on the dashboard that did not happen. */
function WorkloadProblem({ workloads }: { workloads: WorkloadsState }) {
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive space-y-2 rounded-lg border px-4 py-3 text-sm"
    >
      <p>{workloads.error}</p>
      <Button size="sm" variant="outline" onClick={workloads.clearError}>
        Dismiss
      </Button>
    </div>
  );
}

/**
 * What the last extension or termination did, and what it cost.
 *
 * It is reported even when it did NOT happen, because "nothing was sent and
 * nothing was paid" is the answer that matters most: a refused paid request is
 * billed (ADR 0003, TOON_Network#115), so a person needs to be able to tell a
 * request this console refused to send from one a provider refused after
 * taking the money.
 */
function ActionReport({ workloads }: { workloads: WorkloadsState }) {
  const action = workloads.lastAction;
  if (!action) return null;
  const { result } = action;
  const headline = !result.sent
    ? `Nothing was sent, and nothing was paid.`
    : result.providerError !== undefined
      ? `The provider refused this ${action.kind === 'extend' ? 'extension' : 'termination'}: ${result.providerError}`
      : action.kind === 'extend'
        ? `One Lease Interval bought.`
        : `This lease has ended.`;
  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border px-4 py-3 text-sm" role="status">
      <p className="font-medium">{headline}</p>
      {result.message !== undefined && <p>{result.message}</p>}
      {result.problems.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {result.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {result.cost !== undefined && (
        <p className="text-muted-foreground text-xs">
          It cost {result.cost} base units of the settlement token
          {result.route?.payAt === undefined ? '' : `, paid at ${result.route.payAt}`}.
        </p>
      )}
      <Button size="sm" variant="outline" onClick={workloads.dismissAction}>
        Dismiss
      </Button>
    </div>
  );
}

/** The access details, the moment they come back (spec §6.2). */
function Spawned({ leases }: { leases: LeasesState }) {
  const lease = leases.spawned?.lease;
  if (!lease) return null;
  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle>Your workload is running</CardTitle>
        <CardDescription>
          {leases.spawned?.cost
            ? `This lease cost ${leases.spawned.cost} base units of the settlement token for one interval of ${lease.listing.lease_interval_s} s.`
            : `One interval of ${lease.listing.lease_interval_s} s.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Access lease={lease} />
        {leases.spawned?.confirmationFailed && (
          <p className="text-muted-foreground text-xs">
            The lease is running, but its access details could not be written back to the
            vault: {leases.spawned.confirmationFailed}. The Root Secret is safe — that part was
            published before the spawn was sent.
          </p>
        )}
        <Button size="sm" variant="outline" onClick={leases.dismissSpawned}>
          Dismiss
        </Button>
      </CardContent>
    </Card>
  );
}

function Access({ lease }: { lease: LeaseView }) {
  if (!lease.access) {
    return (
      <p className="text-muted-foreground text-sm">
        No access details yet. A lease that is still provisioning has none, and a Warm Standby
        has none until a Takeover.
      </p>
    );
  }
  const { host, ssh_port: sshPort, ports } = lease.access;
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
      <dt className="text-muted-foreground">Host</dt>
      <dd className="font-mono">{host}</dd>
      {sshPort !== undefined && (
        <>
          <dt className="text-muted-foreground">SSH</dt>
          <dd className="font-mono">
            ssh -p {sshPort} tenant@{host}
          </dd>
        </>
      )}
      {(ports ?? []).map((port) => (
        <ForwardedPort key={port.container_port} host={host} port={port} />
      ))}
    </dl>
  );
}

function ForwardedPort({
  host,
  port,
}: {
  host: string;
  port: { container_port: number; host_port: number };
}) {
  return (
    <>
      <dt className="text-muted-foreground">Port {port.container_port}</dt>
      <dd className="font-mono">
        {host}:{port.host_port}
      </dd>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Every lease this account holds, and what each one is doing.
 *
 * Two reads behind one card, and they are not the same read. The **vault** is
 * what this account owns — recovered from its own relays, which is what makes
 * a lease follow it to another machine (ADR 0021). The **dashboard** is what
 * each provider says about those leases right now (§6.5). A lease with a
 * record and no answer is a provider that has gone quiet, not a lease that has
 * gone away, and the two reads being separate is what lets the card say so.
 */
function Vault({ leases, workloads }: { leases: LeasesState; workloads: WorkloadsState }) {
  const vault = leases.vault;
  const rows = vault?.leases ?? [];
  const cards = workloads.dashboard?.cards ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span>Workloads</span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={workloads.refresh}
              disabled={workloads.loading}
            >
              {workloads.loading ? 'Asking the providers…' : 'Refresh'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={leases.recover}
              disabled={leases.loading}
            >
              {leases.loading ? 'Reading the vault…' : 'Read from my relays'}
            </Button>
          </span>
        </CardTitle>
        <CardDescription>
          Each lease&rsquo;s Root Secret is sealed to this account and written to{' '}
          {vault?.writes.relays.length
            ? vault.writes.relays.join(', ')
            : 'no relay this console can write to'}{' '}
          as a paid packet
          {vault?.writes.ready && vault.writes.price
            ? ` — ${vault.writes.price} base units of the settlement token per write`
            : ''}
          . Sign in anywhere and they come back.
          {vault && !vault.writes.ready ? ` ${vault.writes.blockedBy ?? ''}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {leases.loading
              ? 'Looking for this account&rsquo;s leases…'
              : 'No leases yet. Spawn one below.'}
          </p>
        )}
        {cards.map((card) => (
          <WorkloadCard key={card.workloadId} card={card} workloads={workloads} />
        ))}
        {/* A vault record the dashboard has not caught up with yet — a spawn
            a moment ago, or a lease recovered from the relays since the last
            refresh. Shown rather than hidden: a workload that exists and is
            missing from this list is the one thing this page must never do. */}
        {rows
          .filter((lease) => !cards.some((card) => card.workloadId === lease.workloadId))
          .map((lease) => (
            <LeaseCard key={lease.workloadId} lease={lease} />
          ))}
        {(vault?.unreadable ?? 0) > 0 && (
          <p className="text-muted-foreground text-xs">
            {vault?.unreadable} record(s) on these relays did not open with this
            account&rsquo;s key. They belong to another account, or a relay served something
            that was not this account&rsquo;s.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function LeaseCard({ lease }: { lease: LeaseView }) {
  return (
    <div className="space-y-2 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{lease.workloadId.slice(0, 16)}…</span>
        <Badge variant={lease.state === 'live' ? 'default' : 'secondary'}>
          {lease.state === 'spawning' ? 'spawn unconfirmed' : (lease.role ?? lease.state)}
        </Badge>
        <Badge variant="outline">
          {lease.listing.name} v{lease.listing.version}
        </Badge>
        {lease.localOnly ? (
          <Badge variant="outline" title="This lease's Root Secret is on this machine only.">
            local only
          </Badge>
        ) : (
          <Badge variant="outline" title={`Vaulted on ${lease.relays.join(', ')}`}>
            vaulted
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {lease.image.reference ? `${lease.image.reference}@` : ''}
        {lease.image.digest.slice(0, 19)}… on {lease.profileId}, from{' '}
        {lease.provider.pubkey.slice(0, 12)}…
        {lease.expiresAt !== undefined &&
          ` · expires ${new Date(lease.expiresAt * 1000).toLocaleString()}`}
      </p>
      <Access lease={lease} />
      {lease.state === 'spawning' && (
        <p className="text-muted-foreground text-xs">
          This record was written before its spawn was sent and never confirmed. A workload may
          be running behind it; its Root Secret is kept for exactly that reason.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const EMPTY_FORM = {
  provider: '',
  listing: '',
  reference: '',
  digest: '',
  ports: '80',
  env: '',
  sshPublicKey: '',
  volumeGb: '',
  chain: '',
  localOnly: false,
  /** The Warm Standbys, in the order they take the workload over (spec §7). */
  standbys: [] as { provider: string; listing: string }[],
};

type FormState = typeof EMPTY_FORM;

/** Turn the form into what the daemon takes. Parsing only — no validation. */
export function toSpawnRequest(form: FormState): SpawnRequestBody {
  const ports = form.ports
    .split(/[\s,]+/u)
    .filter((entry) => entry !== '')
    .map((entry) => ({ containerPort: Number(entry) }));
  const env: Record<string, string> = {};
  for (const line of form.env.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    provider: form.provider.trim(),
    listing: form.listing.trim(),
    image: {
      digest: form.digest.trim(),
      ...(form.reference.trim() === '' ? {} : { reference: form.reference.trim() }),
    },
    sshPublicKey: form.sshPublicKey.trim(),
    ...(ports.length === 0 ? {} : { ports }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(form.volumeGb.trim() === '' ? {} : { volumeGb: Number(form.volumeGb) }),
    ...(form.chain.trim() === '' ? {} : { chain: form.chain.trim() }),
    ...(form.localOnly ? { localOnly: true } : {}),
  };
}

/**
 * The same form, as a Standby Set's request (spec §7).
 *
 * One content, one workload id, and a member per provider: the primary bought
 * on `.spawn` at its listing's price and each Warm Standby on `.standby` at
 * its own tier's `standby_price`. Every member names its own listing, because
 * nothing makes two providers publish the same tier at the same version.
 */
export function toStandbySetRequest(form: FormState): StandbySetRequestBody {
  return {
    ...toSpawnRequest(form),
    standbys: form.standbys
      .filter((member) => member.provider !== '' && member.listing !== '')
      .map((member) => ({ provider: member.provider, listing: member.listing })),
  };
}

function SpawnForm({
  leases,
  directory,
  onFindProviders,
}: {
  leases: LeasesState;
  directory?: Directory | undefined;
  onFindProviders: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((held) => ({ ...held, [key]: value }));

  const providers = directory?.state === 'ok' ? directory.providers : [];
  const chosen = providers.find((provider) => provider.pubkey === form.provider);
  const request = useMemo(() => toSpawnRequest(form), [form]);
  const setRequest = useMemo(() => toStandbySetRequest(form), [form]);
  const warm = setRequest.standbys.length > 0;
  const { check, checkSet } = leases;

  // The preflight is FREE and sends no packet, so it may run on a debounce.
  // The spawn is not, and never runs from an effect. A Standby Set's preflight
  // is free at EVERY member too, and it is the one that matters most: a set
  // spends an interval at each one, so a mis-addressed set is billed several
  // times over (§6.2 step 3, ADR 0003).
  useEffect(() => {
    if (request.provider === '' || request.listing === '') return;
    const timer = setTimeout(() => {
      if (warm) {
        void checkSet(setRequest);
      } else {
        void check(request);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [check, checkSet, request, setRequest, warm]);

  const preflight = leases.preflight;
  const setPreflight = leases.standbySetPreflight;
  const ready = warm
    ? setPreflight?.ok === true && !leases.busy
    : preflight?.ok === true && !leases.busy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>New workload</CardTitle>
        <CardDescription>
          A spawn buys one Lease Interval at the listing&rsquo;s price, and there are no
          refunds — a request the provider refuses is billed too (spec §5, ADR 0003). Nothing
          is sent until everything below checks out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="spawn-provider">Provider</Label>
            <select
              id="spawn-provider"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={form.provider}
              onChange={(event) => {
                set('provider', event.target.value);
                set('listing', '');
              }}
            >
              <option value="">Choose a provider…</option>
              {providers.map((provider) => (
                <option key={provider.pubkey} value={provider.pubkey}>
                  {provider.profile.ilpAddress} ({provider.liveness.state})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="spawn-listing">Listing</Label>
            <select
              id="spawn-listing"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={form.listing}
              onChange={(event) => set('listing', event.target.value)}
              disabled={!chosen}
            >
              <option value="">Choose a listing…</option>
              {(chosen?.listings ?? []).map((listing) => (
                <option key={listing.name} value={listing.name}>
                  {describeListing(listing)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {providers.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No providers loaded yet.{' '}
            <button type="button" className="underline" onClick={onFindProviders}>
              Open the Providers tab
            </button>{' '}
            to read the directory first.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="spawn-reference">Image reference</Label>
            <Input
              id="spawn-reference"
              placeholder="traefik/whoami"
              value={form.reference}
              onChange={(event) => set('reference', event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              No tag and no <code>@digest</code>: a provider pulls{' '}
              <code>reference@digest</code>, and the digest is its own field (spec §6.2).
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="spawn-digest">Image digest</Label>
            <Input
              id="spawn-digest"
              placeholder="sha256:…"
              value={form.digest}
              onChange={(event) => set('digest', event.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="spawn-ports">Container ports</Label>
            <Input
              id="spawn-ports"
              placeholder="80"
              value={form.ports}
              onChange={(event) => set('ports', event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="spawn-volume">Persistent volume (GB)</Label>
            <Input
              id="spawn-volume"
              placeholder="none"
              value={form.volumeGb}
              onChange={(event) => set('volumeGb', event.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="spawn-chain">Settlement chain</Label>
          <Input
            id="spawn-chain"
            placeholder="the first chain you hold a channel on"
            value={form.chain}
            onChange={(event) => set('chain', event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            As the connector names it — <code>evm:84532</code>, or <code>solana</code>. Worth
            setting when you hold channels on more than one: a connector forwarding to the
            provider has to convert, and it refuses a packet whose amount converts to nothing
            at the rate it declares — which costs the interval like any other refusal.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="spawn-env">Environment</Label>
          <textarea
            id="spawn-env"
            rows={3}
            className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-sm"
            placeholder="NAME=value, one per line"
            value={form.env}
            onChange={(event) => set('env', event.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="spawn-ssh">SSH public key</Label>
          <textarea
            id="spawn-ssh"
            rows={2}
            className="border-input bg-background w-full rounded-md border px-3 py-2 font-mono text-xs"
            placeholder="ssh-ed25519 AAAA… you@machine"
            value={form.sshPublicKey}
            onChange={(event) => set('sshPublicKey', event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            The PUBLIC half, from <code>~/.ssh/id_ed25519.pub</code>. No password is ever
            issued for a workload (spec §6.2), so this is the only way in.
          </p>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={form.localOnly}
            onChange={(event) => set('localOnly', event.target.checked)}
          />
          <span>
            <span className="font-medium">Local only.</span> Keep this lease&rsquo;s Root
            Secret on this machine and publish nothing. No relay learns that this workload
            exists — and if this disk goes, the lease goes with it, because nothing in the
            protocol can recover a Root Secret (ADR 0021).
          </span>
        </label>

        <Standbys form={form} set={set} providers={providers} />

        {warm
          ? setPreflight && (
              <SetPreflight preflight={setPreflight} localOnly={form.localOnly} />
            )
          : preflight && <Preflight preflight={preflight} localOnly={form.localOnly} />}

        <Button
          disabled={!ready}
          onClick={() => {
            if (warm) {
              void leases.spawnSet(setRequest);
            } else {
              void leases.spawn(request);
            }
          }}
        >
          {leases.busy
            ? 'Spawning…'
            : warm
              ? `Spawn a Standby Set — ${setRequest.standbys.length + 1} members, ${setPreflight?.cost ?? '?'} base units`
              : preflight?.listing
                ? `Spawn — ${preflight.listing.price} µUSDC for ${preflight.listing.leaseIntervalSeconds} s`
                : 'Spawn'}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Warm Standbys: the failover toggle, as a first-class part of the form.
 *
 * A Standby Set is one workload id bought from SEVERAL providers (spec §7), so
 * every member picks its own provider and its own tier — and only a tier that
 * publishes a `standby_price` sells one at all. A tier that prices none has no
 * `.standby` route, and a reservation bought there is refused
 * `wrong_listing_version` and billed (§4.2, §5), so the picker below offers
 * only the tiers that do.
 *
 * It costs money to add one: `standby_price` per interval, for capacity that
 * runs nothing until a Takeover. The panel says so before anything is chosen.
 */
function Standbys({
  form,
  set,
  providers,
}: {
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  providers: readonly ProviderView[];
}) {
  const others = providers.filter((provider) => provider.pubkey !== form.provider);
  return (
    <div className="space-y-2 rounded-lg border px-4 py-3">
      <p className="text-sm font-medium">Warm Standbys</p>
      <p className="text-muted-foreground text-xs">
        A <strong>Standby Set</strong> is this workload id bought from several providers at
        once: the primary runs it, and each Warm Standby holds capacity that runs nothing until
        the primary goes silent (spec §7). A standby costs its tier&rsquo;s{' '}
        <strong>standby price</strong> per interval, paid on <code>.standby.extend</code>, and
        a reservation that lapses is protection that is gone. Takeover carries no workload
        state: the standby starts from the image (ADR 0010).
      </p>
      {form.standbys.map((member, index) => {
        const provider = others.find((candidate) => candidate.pubkey === member.provider);
        const tiers = (provider?.listings ?? []).filter(
          (listing) => listing.standbyPrice !== undefined
        );
        return (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <select
              aria-label={`Standby ${index + 1} provider`}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={member.provider}
              onChange={(event) => {
                const next = [...form.standbys];
                next[index] = { provider: event.target.value, listing: '' };
                set('standbys', next);
              }}
            >
              <option value="">Choose a provider…</option>
              {others
                .filter(
                  (candidate) =>
                    candidate.pubkey === member.provider ||
                    !form.standbys.some((held) => held.provider === candidate.pubkey)
                )
                .map((candidate) => (
                  <option key={candidate.pubkey} value={candidate.pubkey}>
                    {candidate.profile.ilpAddress} ({candidate.liveness.state})
                  </option>
                ))}
            </select>
            <select
              aria-label={`Standby ${index + 1} listing`}
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={member.listing}
              disabled={!provider}
              onChange={(event) => {
                const next = [...form.standbys];
                next[index] = { ...member, listing: event.target.value };
                set('standbys', next);
              }}
            >
              <option value="">
                {provider && tiers.length === 0
                  ? 'This provider sells no Warm Standby'
                  : 'Choose a tier that prices a standby…'}
              </option>
              {tiers.map((listing) => (
                <option key={listing.name} value={listing.name}>
                  {listing.name} v{listing.version} — standby{' '}
                  {listing.standbyPrice?.toLocaleString()} µUSDC /{' '}
                  {listing.leaseIntervalSeconds} s
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                set(
                  'standbys',
                  form.standbys.filter((_, at) => at !== index)
                )
              }
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button
        size="sm"
        variant="outline"
        disabled={others.length <= form.standbys.length}
        onClick={() => set('standbys', [...form.standbys, { provider: '', listing: '' }])}
      >
        {others.length <= form.standbys.length
          ? 'No other provider in the directory to stand by'
          : 'Add a Warm Standby'}
      </Button>
      {form.standbys.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Membership cannot change later: changing it means new spawns under a new workload id
          (spec §7).
        </p>
      )}
    </div>
  );
}

/** What a Standby Set would cost, member by member, before any of it is paid. */
function SetPreflight({
  preflight,
  localOnly,
}: {
  preflight: StandbySetPreflightView;
  localOnly: boolean;
}) {
  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border px-4 py-3 text-sm">
      <p>
        <span className="font-medium">
          One workload id, {preflight.members.length} members, one Root Secret.
        </span>{' '}
        {preflight.cost === undefined
          ? 'Not every member quoted a price, so what this set would cost is unknown.'
          : `${preflight.cost} base units for the first interval at every member.`}
      </p>
      {preflight.members.map((member) => (
        <p key={member.pubkey} className="text-muted-foreground text-xs">
          <span className="font-medium">{member.role}</span>{' '}
          <code>{member.pubkey.slice(0, 12)}…</code>{' '}
          {member.view.route ? <code>{member.view.route}</code> : 'no route'}
          {member.view.payment?.routePrice === undefined
            ? ''
            : ` — ${member.view.payment.routePrice} base units at ${member.view.payment.connectorUrl}`}
          {member.view.problems.length > 0 && (
            <ul className="text-destructive list-disc space-y-1 pl-5">
              {member.view.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </p>
      ))}
      <p className="text-muted-foreground text-xs">
        {localOnly
          ? 'The one Root Secret will be sealed and kept on this machine only. Every member’s Continuation Token is derived from it under that member’s own key, so no member can act as the tenant against another (spec §6.1.1).'
          : preflight.vault.writes.ready
            ? `The one Root Secret will be sealed to this account and written to ${preflight.vault.writes.relays.join(', ')} BEFORE anything is sent — one record naming the whole set, one paid packet.`
            : (preflight.vault.writes.blockedBy ??
              'The Root Secret cannot be written anywhere right now.')}
      </p>
      {preflight.problems.length > 0 && (
        <ul className="text-destructive list-disc space-y-1 pl-5">
          {preflight.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeListing(listing: ListingView): string {
  return `${listing.name} v${listing.version} — ${listing.price} µUSDC / ${listing.leaseIntervalSeconds} s, ${listing.resources.cpuMillicores}m CPU, ${listing.resources.memoryMb} MB`;
}

/** What the spawn would do, and everything wrong with it, before it is paid. */
function Preflight({
  preflight,
  localOnly,
}: {
  preflight: PreflightView;
  localOnly: boolean;
}) {
  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border px-4 py-3 text-sm">
      {preflight.route && (
        <p>
          <span className="text-muted-foreground">Route </span>
          <code>{preflight.route}</code>
        </p>
      )}
      {preflight.payment && (
        <p className="text-muted-foreground text-xs">
          Paid at <code>{preflight.payment.connectorUrl}</code>
          {preflight.payment.chain ? ` on ${preflight.payment.chain}` : ''}
          {preflight.payment.channelId
            ? ` from channel ${preflight.payment.channelId.slice(0, 12)}…`
            : ''}
          . {preflight.payment.reason}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {localOnly
          ? 'The Root Secret will be sealed and kept on this machine only. Nothing is published, and nothing is paid for it — that is the privacy choice, not a workaround.'
          : preflight.vault.writes.ready
            ? `The Root Secret will be sealed to this account and written to ${preflight.vault.writes.relays.join(', ')} BEFORE the spawn is sent — one paid packet on ${preflight.vault.writes.destination}, ${preflight.vault.writes.price} base units, on top of the lease’s own price.`
            : (preflight.vault.writes.blockedBy ??
              'The Root Secret cannot be written anywhere right now.')}
      </p>
      {preflight.problems.length > 0 && (
        <ul className="text-destructive list-disc space-y-1 pl-5">
          {preflight.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type { ProviderView };
