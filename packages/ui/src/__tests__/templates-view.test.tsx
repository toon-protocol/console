import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type { ExpandedTemplate, Health, TemplateGallery, TemplateView } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The Template gallery, as a person meets it (TOON_Network#94).
 *
 * The bodies below are the shape of the spec's own golden Template —
 * `static-site`, `MODE` fixed, `SITE_TITLE` settable, an image named by
 * content address through an Image Registry entry — so what this file asserts
 * is what that Template looks like on screen.
 *
 * The two that matter: a fixed setting has no input (only the settable one
 * does), and a Template whose image could not be resolved has no form at all
 * and says why instead.
 */

const PUBLISHER = '2c0b7cf95324a07d05398b240174dc0c2be444d96b159aa6c7f7b1e668680991';
const NPUB = 'npub19s9he72nyjs86pfe3vjqzaxups47g3xedv2e4fk877c7v6rgpxgseu6h2f';
const DIGEST = 'sha256:c0a665205c6d8d1f4ee8e2e217efd7a467527df34100ca78f11cca5c17486126';
const ENTRY = `30434:${PUBLISHER}:web:1.0`;
const ADDRESS = `30436:${PUBLISHER}:static-site`;

const SSH_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@console';

const template: TemplateView = {
  name: 'static-site',
  address: ADDRESS,
  publisher: { pubkey: PUBLISHER, npub: NPUB, name: 'toonlabs' },
  version: 1,
  image: { digest: DIGEST, registryEntry: { address: ENTRY } },
  ports: [{ containerPort: 8080, protocol: 'tcp' }],
  dataPath: '/data',
  envFixed: { MODE: 'production' },
  envTenant: ['SITE_TITLE'],
  minResources: { cpuMillicores: 500, memoryMb: 256, storageGb: 4 },
  sshOffered: true,
  availability: {
    state: 'available',
    checked: 'Its Image Registry entry was read from a relay.',
    entry: {
      address: ENTRY,
      canonicalName: `${NPUB}/web:1.0`,
      digest: DIGEST,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      blobs: [
        {
          digest: DIGEST,
          size: 549,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          source: { type: 'toon-store', blobRecordTxid: 'dG9vbg' },
        },
      ],
      signer: PUBLISHER,
      publishedAt: '2026-09-23T10:00:00.000Z',
      eventId: 'e'.repeat(64),
    },
  },
  warnings: [],
  publishedAt: '2026-09-23T10:00:00.000Z',
  eventId: 'f'.repeat(64),
};

const unresolvable: TemplateView = {
  ...template,
  name: 'ghost-app',
  address: `30436:${PUBLISHER}:ghost-app`,
  envTenant: [],
  availability: {
    state: 'unavailable',
    reason: `Its Image Registry entry \`${ENTRY}\` was on none of the relays read.`,
  },
};

const gallery = (templates: TemplateView[]): TemplateGallery => ({
  state: 'ok',
  relays: {
    seed: ['wss://relay.test'],
    read: [{ url: 'wss://relay.test', state: 'read', events: 2 }],
  },
  templates,
  rejected: [],
  rejectedEvents: 0,
  readAt: '2026-09-23T10:05:00.000Z',
});

const expansion: ExpandedTemplate = {
  template: ADDRESS,
  spawn: {
    workload_id: 'd2'.repeat(32),
    image: { digest: DIGEST, registry_entry: { address: ENTRY } },
    env: { MODE: 'production', SITE_TITLE: 'a small site' },
    ports: [{ container_port: 8080, protocol: 'tcp' }],
    ssh_public_key: SSH_KEY,
    template: ADDRESS,
  },
  sshOffered: true,
  warnings: [],
};

const health: Health = {
  daemon: {
    name: '@toon-protocol/console-daemon',
    version: '0.1.0',
    node: 'v22.0.0',
    pid: 1,
    startedAt: '2026-09-23T09:00:00.000Z',
    uptimeSeconds: 60,
  },
  profile: {
    id: 'devnet',
    label: 'Devnet',
    description: 'test',
    connectorUrl: 'https://connector.test/ilp',
    relayUrl: 'wss://relay.test',
    gatewayDomain: 'gw.test',
    gatewayConnectorUrl: 'https://gateway.test/ilp',
    gasConnectorUrl: 'https://gas.test/ilp',
    overriddenFields: [] as string[],
    rpc: {},
    origin: 'built-in',
    configured: true,
    active: true,
  },
  connector: { state: 'unconfigured', reason: 'not this test' },
  storage: { data: '/d', config: '/c', runtime: '/r', channels: '/c/channels.json' },
  checkedAt: '2026-09-23T10:00:00.000Z',
};

function answer(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('the Template gallery', () => {
  let posted: { path: string; body: unknown }[];

  beforeEach(() => {
    posted = [];
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (path.startsWith('/api/health')) return Promise.resolve(answer(health));
        if (path.startsWith('/api/profiles')) {
          return Promise.resolve(answer({ activeId: 'devnet', profiles: [health.profile] }));
        }
        if (path === '/api/account') {
          return Promise.resolve(
            answer({
              signedIn: false,
              signers: [],
              keystore: { backend: 'file', location: '/k', needsPassphrase: false },
            })
          );
        }
        if (path === '/api/templates') {
          return Promise.resolve(answer(gallery([template, unresolvable])));
        }
        if (path === '/api/templates/expand') {
          posted.push({ path, body: JSON.parse(String(init?.body)) as unknown });
          return Promise.resolve(answer(expansion));
        }
        return Promise.resolve(answer({}, 404));
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetLaunchToken();
  });

  const open = async () => {
    render(<ConsoleApp />);
    await userEvent.click(await screen.findByRole('button', { name: 'Templates' }));
    return screen.findByRole('region', { name: 'Template gallery' });
  };

  it('lists a Template with its publisher and its image by content address', async () => {
    const region = await open();
    const card = (await within(region).findByText('static-site')).closest('li');
    expect(card).not.toBeNull();
    const shown = within(card as HTMLElement);
    expect(shown.getByText(/toonlabs/u)).toBeInTheDocument();
    // The digest in full, not a friendly name: the content address is what a
    // provider verifies (ADR 0006).
    expect(shown.getByText(DIGEST)).toBeInTheDocument();
    expect(shown.getByText(new RegExp(`${NPUB}/web:1\\.0`, 'u'))).toBeInTheDocument();
  });

  it('shows a fixed setting without an input, and a settable one with one', async () => {
    const region = await open();
    await within(region).findByText('static-site');
    expect(within(region).getByText('MODE=production')).toBeInTheDocument();
    expect(within(region).queryByLabelText('MODE')).not.toBeInTheDocument();
    expect(within(region).getByLabelText('SITE_TITLE')).toBeInTheDocument();
  });

  it('offers no form for a Template whose image cannot be resolved, and says why', async () => {
    const region = await open();
    await within(region).findByText('ghost-app');
    expect(within(region).getByText(/was on none of the relays read/u)).toBeInTheDocument();
    // One card can be spawned from, one cannot: a single preview button.
    expect(within(region).getAllByRole('button', { name: 'Preview the spawn' })).toHaveLength(
      1
    );
  });

  it('expands through the daemon, and shows the spawn it would send', async () => {
    const region = await open();
    await within(region).findByText('static-site');

    await userEvent.type(within(region).getByLabelText('SITE_TITLE'), 'a small site');
    await userEvent.type(within(region).getByLabelText('SSH public key'), SSH_KEY);
    await userEvent.click(within(region).getByRole('button', { name: 'Preview the spawn' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // The window sends which Template and what was typed — never a spawn it
    // assembled itself, and never a value for a setting it was not offered.
    expect(posted[0]?.body).toEqual({
      template: ADDRESS,
      env: { SITE_TITLE: 'a small site' },
      sshPublicKey: SSH_KEY,
    });
    expect(await within(region).findByText(/"workload_id"/u)).toBeInTheDocument();
    expect(within(region).getByText(/"template": "30436:/u)).toBeInTheDocument();
  });

  it('shows the daemon’s refusal when a setting is not the tenant’s to set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        if (path.startsWith('/api/health')) return Promise.resolve(answer(health));
        if (path.startsWith('/api/profiles')) {
          return Promise.resolve(answer({ activeId: 'devnet', profiles: [health.profile] }));
        }
        if (path === '/api/account') {
          return Promise.resolve(
            answer({
              signedIn: false,
              signers: [],
              keystore: { backend: 'file', location: '/k', needsPassphrase: false },
            })
          );
        }
        if (path === '/api/templates') return Promise.resolve(answer(gallery([template])));
        return Promise.resolve(
          answer(
            {
              error: 'not_tenant_settable',
              message: 'static-site fixes `MODE`, so it cannot be set here (§8.3).',
            },
            400
          )
        );
      })
    );

    const region = await open();
    await within(region).findByText('static-site');
    await userEvent.type(within(region).getByLabelText('SSH public key'), SSH_KEY);
    await userEvent.click(within(region).getByRole('button', { name: 'Preview the spawn' }));

    expect(await within(region).findByRole('alert')).toHaveTextContent(/fixes `MODE`/u);
  });

  /* ---------------------------------------------------------------------- */
  /* A Template that does not offer SSH (TOON_Network#138)                   */
  /* ---------------------------------------------------------------------- */

  it('asks for no SSH key when the Template does not offer it, and sends none', async () => {
    const noSsh: TemplateView = {
      ...template,
      name: 'smoke-http',
      address: `30436:${PUBLISHER}:smoke-http`,
      envTenant: [],
      sshOffered: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (path.startsWith('/api/health')) return Promise.resolve(answer(health));
        if (path.startsWith('/api/profiles')) {
          return Promise.resolve(answer({ activeId: 'devnet', profiles: [health.profile] }));
        }
        if (path === '/api/account') {
          return Promise.resolve(
            answer({
              signedIn: false,
              signers: [],
              keystore: { backend: 'file', location: '/k', needsPassphrase: false },
            })
          );
        }
        if (path === '/api/templates') return Promise.resolve(answer(gallery([noSsh])));
        if (path === '/api/templates/expand') {
          posted.push({ path, body: JSON.parse(String(init?.body)) as unknown });
          return Promise.resolve(answer({ ...expansion, sshOffered: false }));
        }
        return Promise.resolve(answer({}, 404));
      })
    );

    const region = await open();
    await within(region).findByText('smoke-http');

    expect(within(region).queryByLabelText('SSH public key')).not.toBeInTheDocument();
    expect(within(region).getByText(/does not offer SSH/u)).toBeInTheDocument();

    await userEvent.click(within(region).getByRole('button', { name: 'Preview the spawn' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({ template: `30436:${PUBLISHER}:smoke-http`, sshPublicKey: '' });
  });
});
