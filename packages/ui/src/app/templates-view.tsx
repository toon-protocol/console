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
import type { TemplatesState } from '@/hooks/use-templates';
import type { TemplateView } from '@/lib/daemon';

/**
 * The Template gallery (TOON_Network#94, spec §8.3).
 *
 * "New workload" starts here rather than at a blank form: a Template is a
 * publisher's signed description of a spawn, and the gallery is what an
 * account browses before it picks a provider.
 *
 * Three things on every card are there because the ticket asks for them, and
 * each of them is a claim the console can check:
 *
 * - the PUBLISHER, since a Template is somebody's, and an image nobody will
 *   own is not one to run;
 * - the image's CONTENT ADDRESS, shown in full rather than as a friendly name,
 *   because the digest is the thing the provider verifies and the name is not
 *   (ADR 0006);
 * - whether the image RESOLVES. A Template whose image cannot be resolved gets
 *   no form and no button — it is shown with the reason instead, so that a
 *   person learns why it is not on offer rather than paying to find out.
 *
 * What a person may edit is exactly what the Template marks tenant-settable.
 * The fixed settings are shown, greyed and unmissable — hiding them would let
 * a Template pin `MODE=production` where nobody could see it. The window does
 * not enforce that rule, though: it renders it. The daemon re-reads the
 * publisher's signed event and refuses anything else (`use-templates.ts`).
 *
 * Nothing here spends money. "Preview the spawn" expands the Template and
 * shows the §6.2 content that a lease would be bought with — the same content
 * a manual spawn would carry. Buying it is TOON_Network#92.
 */
export function TemplatesView({ templates }: { templates: TemplatesState }) {
  const { gallery } = templates;
  const list = gallery?.state === 'ok' ? gallery.templates : [];

  return (
    <section className="space-y-4" aria-label="Template gallery">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          A Template is a publisher&rsquo;s signed description of a spawn. It grants no
          capability &mdash; what a lease may do comes from its Listing.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={templates.refresh}
          disabled={templates.loading}
        >
          {templates.loading ? 'Reading relays…' : 'Read again'}
        </Button>
      </div>

      {gallery?.state === 'unconfigured' && (
        <p className="text-muted-foreground text-sm">{gallery.reason}</p>
      )}

      {gallery?.state === 'ok' && (
        <>
          <p className="text-muted-foreground text-xs">
            Read free over NIP-01 from {gallery.relays.read.length} relay
            {gallery.relays.read.length === 1 ? '' : 's'} at{' '}
            {new Date(gallery.readAt).toLocaleTimeString()}
            {gallery.rejected.length > 0 && (
              <> &mdash; {gallery.rejected.length} event(s) were not Templates</>
            )}
          </p>

          {list.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No Template has been published on this network yet. Reading is free, so there is
              nothing to lose by looking again later &mdash; or spawn from an image directly.
            </p>
          ) : (
            <ul className="space-y-4">
              {list.map((template) => (
                <li key={template.address}>
                  <TemplateCard template={template} templates={templates} />
                </li>
              ))}
            </ul>
          )}

          {gallery.rejected.length > 0 && (
            <details className="text-muted-foreground text-xs">
              <summary className="cursor-pointer">
                {gallery.rejected.length} published event(s) of kind 30436 were not Templates
              </summary>
              <ul className="mt-2 space-y-1">
                {gallery.rejected.map((entry) => (
                  <li key={entry.address}>
                    <code>{entry.name || entry.address}</code> &mdash; {entry.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {gallery === undefined && !templates.loading && (
        <p className="text-muted-foreground text-sm">Nothing read yet.</p>
      )}
    </section>
  );
}

function TemplateCard({
  template,
  templates,
}: {
  template: TemplateView;
  templates: TemplatesState;
}) {
  const available = template.availability.state === 'available';
  const publisher = template.publisher.displayName ?? template.publisher.name;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              {template.name}
              <Badge variant={available ? 'success' : 'destructive'}>
                {available ? 'available' : 'unavailable'}
              </Badge>
            </CardTitle>
            <CardDescription>
              Published by {publisher ? `${publisher} · ` : ''}
              <code title={template.publisher.npub}>{shortNpub(template.publisher.npub)}</code>
            </CardDescription>
          </div>
          <span className="text-muted-foreground text-xs">
            version {template.version} · {new Date(template.publishedAt).toLocaleDateString()}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        <WhatItRuns template={template} />

        {template.availability.state === 'unavailable' ? (
          <p
            className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm"
            role="note"
          >
            <strong>Not offered: </strong>
            {template.availability.reason}
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">{template.availability.checked}</p>
            <SpawnForm template={template} templates={templates} />
          </>
        )}

        {template.warnings.map((warning) => (
          <p key={warning} className="text-warning-foreground text-xs">
            {warning}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

/** The image by content address, its ports, and the floor it asks a tier for. */
function WhatItRuns({ template }: { template: TemplateView }) {
  const entry =
    template.availability.state === 'available' ? template.availability.entry : undefined;
  return (
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground">Image</dt>
      <dd>
        <code className="break-all">{template.image.digest}</code>
        {entry && (
          <span className="text-muted-foreground block text-xs break-all">
            {entry.canonicalName} · {entry.blobs.length} blob
            {entry.blobs.length === 1 ? '' : 's'}
          </span>
        )}
        {template.image.registryEntry === undefined && (
          <span className="text-muted-foreground block text-xs">
            by digest alone — found through Blob Records on relays (§8.4)
          </span>
        )}
      </dd>

      <dt className="text-muted-foreground">Ports</dt>
      <dd>
        {template.ports.length === 0
          ? 'none'
          : template.ports.map((port) => `${port.containerPort}/${port.protocol}`).join(', ')}
      </dd>

      {template.dataPath !== undefined && (
        <>
          <dt className="text-muted-foreground">Data</dt>
          <dd>
            <code>{template.dataPath}</code>
          </dd>
        </>
      )}

      {template.minResources && (
        <>
          <dt className="text-muted-foreground">Needs at least</dt>
          <dd>
            {template.minResources.cpuMillicores} mCPU · {template.minResources.memoryMb} MB ·{' '}
            {template.minResources.storageGb} GB
            {template.minResources.gpu ? ` · ${template.minResources.gpu}` : ''}
            <span className="text-muted-foreground block text-xs">
              a floor for choosing a Listing, not a rule any provider enforces
            </span>
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * The form: fixed settings shown, tenant-settable ones editable, and nothing
 * else on the card that could be typed into.
 */
function SpawnForm({
  template,
  templates,
}: {
  template: TemplateView;
  templates: TemplatesState;
}) {
  const settable = template.envTenant.filter((name) => !(name in template.envFixed));
  const [env, setEnv] = useState<Record<string, string>>({});
  const [sshPublicKey, setSshPublicKey] = useState('');
  const [volumeGb, setVolumeGb] = useState('');

  const expansion =
    templates.expansion?.template === template.address ? templates.expansion : undefined;

  const preview = () => {
    const wanted = Object.fromEntries(
      Object.entries(env).filter(([, value]) => value.length > 0)
    );
    void templates.expand(template.address, {
      ...(Object.keys(wanted).length === 0 ? {} : { env: wanted }),
      // `template.sshOffered` false means the daemon substitutes its own
      // placeholder key (TOON_Network#138) — nothing this form collects
      // would ever reach the wire, so the field is not even shown below.
      sshPublicKey: template.sshOffered ? sshPublicKey : '',
      ...(volumeGb === '' ? {} : { volumeGb: Number(volumeGb) }),
    });
  };

  return (
    <div className="space-y-3">
      {Object.keys(template.envFixed).length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs">
            Fixed by the publisher &mdash; shown, and not editable:
          </p>
          <ul className="mt-1 space-y-0.5">
            {Object.entries(template.envFixed).map(([name, value]) => (
              <li key={name}>
                <code className="text-muted-foreground">
                  {name}={value}
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {settable.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            {template.name} lets a tenant set {settable.length === 1 ? 'this' : 'these'}:
          </p>
          {settable.map((name) => (
            <div key={name} className="grid gap-1">
              <Label htmlFor={`${template.address}-${name}`}>{name}</Label>
              <Input
                id={`${template.address}-${name}`}
                value={env[name] ?? ''}
                onChange={(event) =>
                  setEnv((held) => ({ ...held, [name]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
      )}

      {template.sshOffered ? (
        <div className="grid gap-1">
          <Label htmlFor={`${template.address}-ssh`}>SSH public key</Label>
          <Input
            id={`${template.address}-ssh`}
            placeholder="ssh-ed25519 AAAA…"
            value={sshPublicKey}
            onChange={(event) => setSshPublicKey(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            The only way into the workload: no password is ever issued (§9).
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {template.name} does not offer SSH, so no key is asked for.
        </p>
      )}

      <div className="grid gap-1">
        <Label htmlFor={`${template.address}-volume`}>Volume (GB, optional)</Label>
        <Input
          id={`${template.address}-volume`}
          inputMode="numeric"
          value={volumeGb}
          onChange={(event) => setVolumeGb(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={preview} disabled={templates.expanding}>
          {templates.expanding ? 'Expanding…' : 'Preview the spawn'}
        </Button>
        <span className="text-muted-foreground text-xs">
          Expanding costs nothing. Buying the lease is the next step.
        </span>
      </div>

      {templates.expandError && (
        <p role="alert" className="text-destructive text-sm">
          {templates.expandError}
        </p>
      )}

      {expansion && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            The spawn this Template expands to &mdash; byte for byte what a manual spawn of the
            same thing would send (§6.2). The tenant expands a Template; the provider never
            reads one.
          </p>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
            {JSON.stringify(expansion.spawn, null, 2)}
          </pre>
          {expansion.warnings.map((warning) => (
            <p key={warning} className="text-warning-foreground text-xs">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** `npub1abcd…wxyz`: enough to recognise, short enough to read. */
function shortNpub(npub: string): string {
  return npub.length <= 20 ? npub : `${npub.slice(0, 10)}…${npub.slice(-6)}`;
}
