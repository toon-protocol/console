import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type {
  Directory,
  Health,
  LeaseVaultStatus,
  PreflightView,
  SessionStatus,
} from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * Workloads, as a person meets it (TOON_Network#92).
 *
 * Three things this file is here to hold down.
 *
 * **The button is not live until the preflight says so.** A spawn spends
 * money, and a refused one spends it too (spec §5, ADR 0003), so a page that
 * let somebody press Spawn on a request the daemon already knows is wrong
 * would be charging them for the lesson.
 *
 * **A refused spawn shows the PROVIDER's code.** `no_capacity` is "try
 * somewhere else" and `refused_image` is "not that image here"; either shown
 * as "something went wrong" would hide the only useful part.
 *
 * **Nothing here ever holds a Root Secret.** The vault answers carry none —
 * the daemon's own tests pin that — and this one checks that the page asks for
 * the vault from the relays on the way in, which is what recovery looks like
 * from the window's side.
 */

const PROVIDER = 'd'.repeat(64);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const WORKLOAD = 'a'.repeat(64);
const SSH_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxvbmdlbm91Z2hmb3JhdGVzdGtleQ tenant@console';

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
    rpc: {},
    origin: 'built-in',
    configured: true,
    active: true,
  },
  connector: { state: 'unconfigured', reason: 'not this test' },
  storage: { data: '/d', config: '/c', runtime: '/r', channels: '/c/channels.json' },
  checkedAt: '2026-09-23T10:00:00.000Z',
};

const signedIn: SessionStatus = {
  signedIn: true,
  account: {
    pubkey: 'b'.repeat(64),
    npub: 'npub1test',
    signerId: 'signer-1',
    signerKind: 'local',
    signerLabel: 'npub1test…',
    signedInAt: '2026-09-23T10:00:00.000Z',
    profileState: 'none',
  },
  signers: [],
  keystore: { backend: 'file', location: '/k', needsPassphrase: false },
};

const directory: Directory = {
  state: 'ok',
  relays: { seed: ['wss://relay.test'], read: [] },
  filters: {},
  providers: [
    {
      pubkey: PROVIDER,
      profile: {
        ilpAddress: 'g.toon.provider',
        connectorUrl: 'https://provider.test/ilp',
        connectorSealKey: '0x04aa',
        relays: [],
        settlement: [],
        isolation: 'shared-kernel',
        hidden: false,
        publishedAt: '2026-09-23T09:00:00.000Z',
        eventId: 'e'.repeat(64),
      },
      liveness: { state: 'live' },
      listings: [
        {
          name: 'basic',
          address: `30432:${PROVIDER}:basic`,
          version: 1,
          resources: { cpuMillicores: 1000, memoryMb: 1024, storageGb: 10 },
          arch: 'amd64',
          isolation: 'shared-kernel',
          hidden: false,
          leaseIntervalSeconds: 3600,
          price: 1000,
          capabilities: [],
          unspecifiedCapabilities: [],
          publishedAt: '2026-09-23T09:00:00.000Z',
          eventId: 'f'.repeat(64),
        },
      ],
      relaysRead: ['wss://relay.test'],
      supersededListings: 0,
      rejectedListings: [],
    },
  ],
  listingsWithoutProfile: 0,
  rejectedEvents: 0,
  readAt: '2026-09-23T10:00:00.000Z',
};

const emptyVault: LeaseVaultStatus = {
  state: 'ready',
  pubkey: 'b'.repeat(64),
  leases: [],
  writes: {
    relays: ['wss://own.relay.test'],
    plan: [
      {
        url: 'wss://own.relay.test',
        ready: true,
        destination: 'g.toon.relay',
        payAt: 'https://connector.test/ilp',
        price: '1',
        chain: 'evm:84532',
        channelId: '0xchannel',
      },
    ],
    destination: 'g.toon.relay',
    payAt: 'https://connector.test/ilp',
    price: '1',
    totalPrice: '1',
    chain: 'evm:84532',
    channelId: '0xchannel',
    ready: true,
  },
  unreadable: 0,
  checkedAt: '2026-09-23T10:00:00.000Z',
};

const vaultWithLease: LeaseVaultStatus = {
  ...emptyVault,
  leases: [
    {
      workloadId: WORKLOAD,
      state: 'live',
      standbySet: [PROVIDER],
      members: [
        {
          pubkey: PROVIDER,
          index: 0,
          role: 'standalone',
          provider: {
            pubkey: PROVIDER,
            ilp_address: 'g.toon.provider',
            connector_url: 'https://provider.test/ilp',
            connector_seal_key: '0x04aa',
          },
          listing: {
            name: 'basic',
            version: 1,
            address: `30432:${PROVIDER}:basic`,
            lease_interval_s: 3600,
            price: 1000,
          },
          paidAt: 'https://provider.test/ilp',
          state: 'live',
          known: true,
        },
      ],
      provider: {
        pubkey: PROVIDER,
        ilp_address: 'g.toon.provider',
        connector_url: 'https://provider.test/ilp',
        connector_seal_key: '0x04aa',
      },
      paidAt: 'https://provider.test/ilp',
      listing: {
        name: 'basic',
        version: 1,
        address: `30432:${PROVIDER}:basic`,
        lease_interval_s: 3600,
        price: 1000,
      },
      profileId: 'devnet',
      image: { reference: 'traefik/whoami', digest: DIGEST },
      ports: [{ container_port: 80, protocol: 'tcp' }],
      envKeys: [],
      createdAt: '2026-09-23T10:00:00.000Z',
      localOnly: false,
      role: 'standalone',
      expiresAt: 1_790_003_600,
      access: {
        host: '203.0.113.7',
        ssh_port: 40000,
        ports: [{ container_port: 80, host_port: 41000 }],
      },
      source: 'relays',
      relays: ['wss://own.relay.test'],
      recordId: '1'.repeat(64),
    },
  ],
};

const goodPreflight: PreflightView = {
  ok: true,
  problems: [],
  provider: {
    pubkey: PROVIDER,
    ilpAddress: 'g.toon.provider',
    connectorUrl: 'https://provider.test/ilp',
    hidden: false,
    liveness: 'live',
  },
  listing: {
    name: 'basic',
    version: 1,
    leaseIntervalSeconds: 3600,
    price: 1000,
    capabilities: [],
  },
  route: 'g.toon.provider.basic.v1.spawn',
  payment: {
    connectorUrl: 'https://provider.test/ilp',
    via: 'provider-connector',
    reason: 'Devnet’s connector publishes no route carrying it.',
    chain: 'evm:84532',
    channelId: '0xchannel',
    routePrice: '1000',
  },
  vault: {
    localOnly: false,
    writes: {
      relays: ['wss://own.relay.test'],
      plan: [
        {
          url: 'wss://own.relay.test',
          ready: true,
          destination: 'g.toon.relay',
          payAt: 'https://connector.test/ilp',
          price: '1',
        },
      ],
      destination: 'g.toon.relay',
      payAt: 'https://connector.test/ilp',
      price: '1',
      totalPrice: '1',
      chain: 'evm:84532',
      channelId: '0xchannel',
      ready: true,
    },
  },
};

function answer(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('the Workloads view', () => {
  let posted: { path: string; body: unknown }[];
  let vault: LeaseVaultStatus;
  let preflight: PreflightView;
  let spawnAnswer: { body: unknown; status: number };

  beforeEach(() => {
    posted = [];
    vault = emptyVault;
    preflight = goodPreflight;
    spawnAnswer = {
      status: 200,
      body: { lease: vaultWithLease.leases[0], preflight: goodPreflight, cost: '1000' },
    };
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        }
        if (path.startsWith('/api/health')) return Promise.resolve(answer(health));
        if (path.startsWith('/api/profiles')) {
          return Promise.resolve(answer({ activeId: 'devnet', profiles: [health.profile] }));
        }
        if (path === '/api/account') return Promise.resolve(answer(signedIn));
        if (path.startsWith('/api/directory')) return Promise.resolve(answer(directory));
        if (path === '/api/leases' || path === '/api/leases/refresh') {
          return Promise.resolve(answer(vault));
        }
        // The dashboard is #93's, and this file is about the spawn form. An
        // empty one keeps the two reads honestly separate: a vault record the
        // dashboard has not caught up with is still listed, which is what the
        // "lists a vaulted workload" case below is checking.
        if (path.startsWith('/api/workloads')) {
          return Promise.resolve(
            answer({
              state: 'ready',
              pubkey: 'b'.repeat(64),
              profileId: 'devnet',
              cards: [],
              unreadable: 0,
              checkedAt: '2026-09-23T10:00:00.000Z',
            })
          );
        }
        if (path === '/api/leases/preflight') return Promise.resolve(answer(preflight));
        if (path === '/api/leases/spawn') {
          return Promise.resolve(answer(spawnAnswer.body, spawnAnswer.status));
        }
        return Promise.resolve(answer({}, 404));
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetLaunchToken();
  });

  const openWorkloads = async () => {
    const person = userEvent.setup();
    render(<ConsoleApp />);
    await person.click(await screen.findByRole('button', { name: 'Workloads' }));
    return person;
  };

  it('reads the vault from the account’s relays on the way in', async () => {
    await openWorkloads();
    // `/refresh` and not the cached read: signing in on a new machine has to
    // show the workloads, and only the relays know about them there.
    await waitFor(() => {
      expect(posted.some((call) => call.path === '/api/leases/refresh')).toBe(true);
    });
  });

  it('lists a vaulted workload with its access details', async () => {
    vault = vaultWithLease;
    await openWorkloads();

    // The host appears three times — on its own, in the SSH line and beside
    // the forwarded port — which is the point: all three are how you reach it.
    expect(await screen.findAllByText(/203\.0\.113\.7/u)).not.toHaveLength(0);
    expect(
      screen.getByText('ssh -p 40000 tenant@203.0.113.7', { selector: 'dd' })
    ).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7:41000', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('vaulted')).toBeInTheDocument();
  });

  it('says which relays a Root Secret will go to before anything is spawned', async () => {
    await openWorkloads();
    expect(
      await screen.findByText(
        /sealed to this account and written to wss:\/\/own\.relay\.test/u
      )
    ).toBeInTheDocument();
  });

  it('spawns what the form describes, and shows the access that comes back', async () => {
    const person = await openWorkloads();

    await person.selectOptions(await screen.findByLabelText('Provider'), `${PROVIDER}`);
    await person.selectOptions(await screen.findByLabelText('Listing'), 'basic');
    await person.type(screen.getByLabelText('Image reference'), 'traefik/whoami');
    await person.type(screen.getByLabelText('Image digest'), DIGEST);
    await person.type(screen.getByLabelText('SSH public key'), SSH_KEY);

    const spawn = await screen.findByRole('button', {
      name: /Spawn — 1000 µUSDC for 3600 s/u,
    });
    await waitFor(() => {
      expect(spawn).toBeEnabled();
    });
    await person.click(spawn);

    expect(await screen.findByText('Your workload is running')).toBeInTheDocument();
    const sent = posted.find((call) => call.path === '/api/leases/spawn');
    expect(sent?.body).toMatchObject({
      provider: PROVIDER,
      listing: 'basic',
      image: { reference: 'traefik/whoami', digest: DIGEST },
      ports: [{ containerPort: 80 }],
      sshPublicKey: SSH_KEY,
    });
  });

  it('will not let a spawn be pressed while the preflight has problems', async () => {
    preflight = {
      ...goodPreflight,
      ok: false,
      problems: ['`reference` carries no tag (spec §6.2).'],
    };
    const person = await openWorkloads();
    await person.selectOptions(await screen.findByLabelText('Provider'), PROVIDER);
    await person.selectOptions(await screen.findByLabelText('Listing'), 'basic');

    expect(await screen.findByText(/carries no tag/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Spawn/u })).toBeDisabled();
    // Nothing was bought to find that out.
    expect(posted.some((call) => call.path === '/api/leases/spawn')).toBe(false);
  });

  it('shows the provider’s own refusal code when a spawn is refused', async () => {
    spawnAnswer = {
      status: 502,
      body: {
        error: 'spawn_refused',
        providerError: 'no_capacity',
        message: 'The provider refused this spawn: no_capacity. nothing free here',
      },
    };
    const person = await openWorkloads();
    await person.selectOptions(await screen.findByLabelText('Provider'), PROVIDER);
    await person.selectOptions(await screen.findByLabelText('Listing'), 'basic');
    await person.type(screen.getByLabelText('Image digest'), DIGEST);
    await person.type(screen.getByLabelText('SSH public key'), SSH_KEY);

    const spawn = await screen.findByRole('button', { name: /^Spawn/u });
    await waitFor(() => {
      expect(spawn).toBeEnabled();
    });
    await person.click(spawn);

    expect(
      await screen.findByText('The provider refused this spawn: no_capacity')
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing free here/u)).toBeInTheDocument();
  });

  it('says what "local only" costs before it is chosen', async () => {
    const person = await openWorkloads();
    await person.selectOptions(await screen.findByLabelText('Provider'), PROVIDER);
    await person.selectOptions(await screen.findByLabelText('Listing'), 'basic');
    await person.click(screen.getByRole('checkbox'));

    expect(
      await screen.findByText(/kept on this machine only. Nothing is published/u)
    ).toBeInTheDocument();
  });
});
