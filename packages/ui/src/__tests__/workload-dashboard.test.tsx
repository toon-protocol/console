import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type {
  Dashboard,
  Health,
  LeaseVaultStatus,
  SessionStatus,
  WorkloadCard,
} from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The dashboard, as a person meets it (TOON_Network#93).
 *
 * Five things this file exists to hold down, and each of them is a way a
 * dashboard could cost somebody money or mislead them about their workload.
 *
 * **A silent provider does not read as an error.** The card says the provider
 * is not answering and that the workload may be fine, and it does not offer to
 * spend an interval finding out.
 *
 * **The three endings stay three endings.** Eviction says Eviction, and says
 * that the provider ended it.
 *
 * **Extend is priced on its own button** and disabled, with the reason, when
 * the daemon says the request would be refused — because §6.3's refusals are
 * billed at the full interval price.
 *
 * **Terminate asks twice**, and says what it destroys.
 *
 * **A budget takes a confirmation and a figure.** Nothing is armed by a
 * checkbox, and the button says the whole amount it is agreeing to.
 */

const PROVIDER = 'd'.repeat(64);
const WORKLOAD = 'a'.repeat(64);

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

const vault: LeaseVaultStatus = {
  state: 'ready',
  pubkey: 'b'.repeat(64),
  leases: [],
  writes: {
    relays: ['wss://own.relay.test'],
    plan: [{ url: 'wss://own.relay.test', ready: true, price: '1' }],
    ready: true,
    price: '1',
    totalPrice: '1',
  },
  unreadable: 0,
  checkedAt: '2026-09-23T10:00:00.000Z',
};

function card(overrides: Partial<WorkloadCard> = {}): WorkloadCard {
  return {
    workloadId: WORKLOAD,
    lease: {
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
      image: { reference: 'traefik/whoami', digest: `sha256:${'c'.repeat(64)}` },
      ports: [],
      envKeys: [],
      sshOffered: true,
      createdAt: '2026-09-23T10:00:00.000Z',
      localOnly: false,
      source: 'relays',
      relays: ['wss://own.relay.test'],
      recordId: '1'.repeat(64),
    },
    provider: {
      pubkey: PROVIDER,
      ilpAddress: 'g.toon.provider',
      connectorUrl: 'https://provider.test/ilp',
      hidden: false,
      liveness: 'live',
      inDirectory: true,
    },
    status: {
      kind: 'read',
      life: { phase: 'running' },
      role: 'standalone',
      expiresAt: 1_790_003_600,
      access: { host: '203.0.113.7', ssh_port: 40000 },
      readAt: '2026-09-23T10:00:00.000Z',
    },
    runway: {
      state: 'computed',
      listingPrice: 1000,
      leaseIntervalSeconds: 3600,
      pricePerInterval: '1000',
      payAt: 'https://provider.test/ilp',
      available: '10000',
      affordableIntervals: 10,
      paidSeconds: 1800,
      seconds: 1800 + 10 * 3600,
      until: '2026-09-24T00:30:00.000Z',
      readAt: '2026-09-23T10:00:00.000Z',
    },
    extend: {
      ok: true,
      problems: [],
      route: {
        route: 'g.toon.provider.basic.v1.extend',
        payAt: 'https://provider.test/ilp',
        via: 'provider-connector',
        reason: 'it terminates its own routes',
        price: '1000',
      },
    },
    members: [
      {
        pubkey: PROVIDER,
        index: 0,
        role: 'standalone',
        provider: {
          ilpAddress: 'g.toon.provider',
          connectorUrl: 'https://provider.test/ilp',
          hidden: false,
          liveness: 'live',
          inDirectory: true,
        },
        listing: {
          name: 'basic',
          version: 1,
          address: `30432:${PROVIDER}:basic`,
          lease_interval_s: 3600,
          price: 1000,
        },
        status: {
          kind: 'read',
          life: { phase: 'running' },
          role: 'standalone',
          expiresAt: 1_790_003_600,
          readAt: '2026-09-23T10:00:00.000Z',
        },
        extend: {
          ok: true,
          op: 'extend',
          problems: [],
          route: {
            route: 'g.toon.provider.basic.v1.extend',
            payAt: 'https://provider.test/ilp',
            via: 'provider-connector',
            reason: 'it terminates its own routes',
            price: '1000',
          },
        },
        runningNow: true,
        selfStopped: false,
        vaultState: 'live',
        known: true,
      },
    ],
    set: { members: 1, warm: false, pricePerInterval: '1000' },
    ...overrides,
  };
}

function dashboardOf(one: WorkloadCard): Dashboard {
  return {
    state: 'ready',
    pubkey: 'b'.repeat(64),
    profileId: 'devnet',
    cards: [one],
    unreadable: 0,
    checkedAt: '2026-09-23T10:00:00.000Z',
  };
}

function answer(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('the workload dashboard', () => {
  let posted: { path: string; body: unknown; method?: string }[];
  let dashboard: Dashboard;
  let extendAnswer: unknown;
  let terminateAnswer: unknown;
  let armAnswer: { body: unknown; status: number };

  beforeEach(() => {
    posted = [];
    dashboard = dashboardOf(card());
    extendAnswer = {
      sent: true,
      problems: [],
      cost: '1000',
      expiresAt: 1_790_007_200,
      card: card(),
    };
    terminateAnswer = {
      sent: true,
      problems: [],
      ended: 'termination',
      card: card({
        status: {
          kind: 'read',
          life: { phase: 'ended', ending: 'termination' },
          readAt: '2026-09-23T10:01:00.000Z',
        },
        endedAs: 'termination',
      }),
    };
    armAnswer = {
      status: 200,
      body: card({
        autoExtend: {
          armed: true,
          budget: '3000',
          spent: '0',
          remaining: '3000',
          extensions: 0,
          agreedPrice: '1000',
          leadSeconds: 900,
          armedAt: '2026-09-23T10:00:00.000Z',
        },
      }),
    };
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method !== undefined && init.method !== 'GET') {
          posted.push({
            path,
            method: init.method,
            body: init.body ? JSON.parse(String(init.body)) : undefined,
          });
        }
        if (path.startsWith('/api/health')) return Promise.resolve(answer(health));
        if (path.startsWith('/api/profiles')) {
          return Promise.resolve(answer({ activeId: 'devnet', profiles: [health.profile] }));
        }
        if (path === '/api/account') return Promise.resolve(answer(signedIn));
        if (path.startsWith('/api/directory')) {
          return Promise.resolve(answer({ state: 'unconfigured', reason: 'not this test' }));
        }
        if (path === '/api/leases' || path === '/api/leases/refresh') {
          return Promise.resolve(answer(vault));
        }
        // Every card carries a gateway panel now (TOON_Network#97). This
        // suite is about the dashboard, so the hostname answers its empty
        // state and the gateway's own cases live in `gateway-panel.test.tsx`.
        if (path.includes('/gateway')) {
          return Promise.resolve(
            answer({
              workloadId: WORKLOAD,
              held: false,
              problems: [],
              ok: true,
              ports: [],
              checkedAt: '2026-09-23T10:00:00.000Z',
            })
          );
        }
        // And a rotation panel (TOON_Network#96), which reads on mount and
        // sends nothing. Its own cases live in `rotation-panel.test.tsx`.
        if (path.endsWith('/rotation')) {
          return Promise.resolve(
            answer({
              workloadId: WORKLOAD,
              underWay: false,
              ok: true,
              problems: [],
              members: [],
              confirmed: 0,
              of: 1,
              vault: { relays: [], ready: true },
              localOnly: false,
            })
          );
        }
        if (path.endsWith('/extend')) return Promise.resolve(answer(extendAnswer));
        if (path.endsWith('/terminate')) return Promise.resolve(answer(terminateAnswer));
        if (path.endsWith('/auto-extend')) {
          return Promise.resolve(answer(armAnswer.body, armAnswer.status));
        }
        if (path.startsWith('/api/workloads')) return Promise.resolve(answer(dashboard));
        return Promise.resolve(answer({}, 404));
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetLaunchToken();
  });

  const open = async () => {
    const person = userEvent.setup();
    render(<ConsoleApp />);
    await person.click(await screen.findByRole('button', { name: 'Workloads' }));
    return person;
  };

  /* ---------------------------------------------------------------------- */

  it('shows the lease’s state, its expiry and its runway', async () => {
    await open();

    expect(await screen.findByText('running')).toBeInTheDocument();
    expect(screen.getByText(/standalone/u)).toBeInTheDocument();
    // 1800 s paid plus ten intervals of 3600 s: a day and a half of runway.
    expect(screen.getByText('Runway 10 h 30 min')).toBeInTheDocument();
    expect(screen.getByText(/10 more interval\(s\)/u)).toBeInTheDocument();
  });

  /**
   * A lease on a Hidden Provider (TOON_Network#98, spec §10, ADR 0008).
   *
   * The distinction the window has to get right is between the two kinds of
   * address in play. A Hidden Provider's own location is never shown, because
   * the console never learns it. The LEASE's per-lease `.anyone` address is
   * shown in full, because it is the only way a tenant reaches its own
   * workload — §10 says a tenant dials it exactly as it would an IP.
   */
  it('shows a hidden lease’s own `.anyone` address, and no host for the provider', async () => {
    const leaseHost = `${'b'.repeat(56)}.anyone`;
    dashboard = dashboardOf(
      card({
        provider: {
          pubkey: PROVIDER,
          ilpAddress: 'g.toon.provider-hs',
          connectorUrl: `http://${'a'.repeat(56)}.anyone/ilp`,
          hidden: true,
          liveness: 'live',
          inDirectory: true,
        },
        status: {
          kind: 'read',
          life: { phase: 'running' },
          role: 'standalone',
          expiresAt: 1_790_003_600,
          access: { host: leaseHost, ssh_port: 40000 },
          readAt: '2026-09-23T10:00:00.000Z',
        },
      })
    );
    await open();

    expect(await screen.findByText('Hidden Provider')).toBeInTheDocument();
    expect(screen.getByText('Lease address')).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(leaseHost, 'u')).length).toBeGreaterThan(0);
    expect(screen.queryByText('203.0.113.7')).not.toBeInTheDocument();
  });

  it('says so when a provider that calls itself hidden is not', async () => {
    dashboard = dashboardOf(
      card({
        provider: {
          pubkey: PROVIDER,
          ilpAddress: 'g.toon.provider',
          connectorUrl: 'https://provider.test/ilp',
          hidden: true,
          liveness: 'live',
          inDirectory: true,
          notHidden:
            'This provider declares itself hidden, but the connector its Profile publishes ' +
            'is a clearnet address.',
        },
      })
    );
    await open();

    expect(await screen.findByText(/declares itself hidden, but/u)).toBeInTheDocument();
  });

  it('says a runway cannot be computed rather than showing a zero', async () => {
    dashboard = dashboardOf(
      card({
        runway: {
          state: 'unknown',
          listingPrice: 1000,
          leaseIntervalSeconds: 3600,
          reason: 'This account holds no payment channel with that connector.',
          readAt: '2026-09-23T10:00:00.000Z',
        },
      })
    );
    await open();

    expect(await screen.findByText(/Runway: not known/u)).toBeInTheDocument();
    expect(screen.getByText(/no payment channel/u)).toBeInTheDocument();
    expect(screen.queryByText(/Runway 0/u)).not.toBeInTheDocument();
  });

  it('shows a silent provider as silent, not as an error', async () => {
    dashboard = dashboardOf(
      card({
        status: {
          kind: 'silent',
          reason: 'The packet was sent and nothing came back.',
          readAt: '2026-09-23T10:00:00.000Z',
        },
        extend: {
          ok: false,
          problems: ['This provider is not answering, so nothing was sent.'],
          route: {
            route: 'g.toon.provider.basic.v1.extend',
            payAt: 'https://provider.test/ilp',
            via: 'provider-connector',
            reason: 'x',
            price: '1000',
          },
        },
      })
    );
    await open();

    expect(await screen.findByText('provider not answering')).toBeInTheDocument();
    expect(screen.getByText(/may be running perfectly/u)).toBeInTheDocument();
    // Nothing red, and nothing that would spend to find out.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Extend — /u })).toBeDisabled();
  });

  it('keeps Eviction, Termination and Expiry apart', async () => {
    dashboard = dashboardOf(
      card({
        status: {
          kind: 'read',
          life: { phase: 'ended', ending: 'eviction' },
          readAt: '2026-09-23T10:00:00.000Z',
        },
        extend: { ok: false, problems: ['This lease has ended (Eviction).'] },
      })
    );
    await open();

    expect(await screen.findByText('ended — eviction')).toBeInTheDocument();
    expect(screen.getByText(/its provider ended it/u)).toBeInTheDocument();
    // No terminate button on a lease that has already ended.
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument();
  });

  it('prices the extend button, and sends the price it showed', async () => {
    const person = await open();

    const extend = await screen.findByRole('button', {
      name: 'Extend — 1000 base units for 3600 s',
    });
    await person.click(extend);

    await waitFor(() => {
      expect(posted.some((call) => call.path.endsWith('/extend'))).toBe(true);
    });
    const sent = posted.find((call) => call.path.endsWith('/extend'));
    expect(sent?.body).toEqual({ maxPrice: '1000' });
    expect(await screen.findByText('One Lease Interval bought.')).toBeInTheDocument();
    expect(screen.getByText(/It cost 1000 base units/u)).toBeInTheDocument();
  });

  it('will not let an extension be pressed that the daemon would refuse', async () => {
    dashboard = dashboardOf(
      card({
        extend: {
          ok: false,
          problems: ['That Listing has been republished at v2 (wrong_listing_version).'],
        },
      })
    );
    await open();

    expect(await screen.findByText(/wrong_listing_version/u)).toBeInTheDocument();
    // No route at all, so no price to put on the button — and still disabled.
    expect(screen.getByRole('button', { name: 'Extend' })).toBeDisabled();
    expect(posted.some((call) => call.path.endsWith('/extend'))).toBe(false);
  });

  it('reports a refusal that was billed anyway', async () => {
    extendAnswer = {
      sent: true,
      problems: [],
      providerError: 'no_capacity',
      cost: '1000',
      message: 'It was billed 1000 base units anyway.',
      card: card(),
    };
    const person = await open();
    await person.click(await screen.findByRole('button', { name: /^Extend — /u }));

    expect(
      await screen.findByText('The provider refused this extension: no_capacity')
    ).toBeInTheDocument();
    expect(screen.getByText(/billed 1000 base units/u)).toBeInTheDocument();
  });

  it('asks twice before it terminates, and says what that destroys', async () => {
    const person = await open();

    await person.click(await screen.findByRole('button', { name: 'Terminate' }));
    expect(
      screen.getByText(/destroys the workload immediately and there is no refund/u)
    ).toBeInTheDocument();
    // Nothing has been sent on the first press.
    expect(posted.some((call) => call.path.endsWith('/terminate'))).toBe(false);

    await person.click(screen.getByRole('button', { name: 'Yes — destroy this workload' }));

    await waitFor(() => {
      expect(posted.some((call) => call.path.endsWith('/terminate'))).toBe(true);
    });
    expect(await screen.findByText('This lease has ended.')).toBeInTheDocument();
    expect(await screen.findByText('ended — termination')).toBeInTheDocument();
  });

  it('arms a budget only from an amount, with what it means stated', async () => {
    const person = await open();

    await person.click(
      await screen.findByRole('button', {
        name: /Set up automatic extension, within a budget/u,
      })
    );
    expect(screen.getByText(/spends money with nobody present/u)).toBeInTheDocument();
    // Nothing to press until there is a figure.
    expect(screen.getByRole('button', { name: 'Set a budget' })).toBeDisabled();

    await person.type(screen.getByLabelText('Budget, in base units'), '3000');
    await person.click(
      screen.getByRole('button', { name: 'Spend up to 3000 base units without asking' })
    );

    await waitFor(() => {
      expect(posted.some((call) => call.path.endsWith('/auto-extend'))).toBe(true);
    });
    const sent = posted.find((call) => call.path.endsWith('/auto-extend'));
    expect(sent?.body).toEqual({ budget: '3000', agreedPrice: '1000', confirm: true });
    expect(await screen.findByText(/Extending automatically/u)).toBeInTheDocument();
  });

  /* ------------------------------------------------------------------- */
  /* A Standby Set (TOON_Network#95, spec §7)                             */
  /* ------------------------------------------------------------------- */

  const STANDBY = 'f'.repeat(64);

  /** The same card, as a set of two with the standby still Reserved. */
  function warmSet(overrides: Partial<WorkloadCard> = {}): WorkloadCard {
    const base = card();
    const reserved: WorkloadCard['members'][number] = {
      pubkey: STANDBY,
      index: 1,
      role: 'standby',
      provider: {
        ilpAddress: 'g.toon.provider2',
        connectorUrl: 'https://provider2.test/ilp',
        hidden: false,
        liveness: 'live',
        inDirectory: true,
      },
      listing: {
        name: 'warm',
        version: 1,
        address: `30432:${STANDBY}:warm`,
        lease_interval_s: 600,
        price: 1000,
      },
      status: {
        kind: 'read',
        life: { phase: 'reserved' },
        role: 'standby',
        expiresAt: 1_790_003_600,
        readAt: '2026-09-23T10:00:00.000Z',
      },
      extend: {
        ok: true,
        op: 'standby.extend',
        problems: [],
        route: {
          route: 'g.toon.provider2.warm.v1.standby.extend',
          payAt: 'https://provider2.test/ilp',
          via: 'provider-connector',
          reason: 'x',
          price: '400',
        },
      },
      runningNow: false,
      selfStopped: false,
      vaultState: 'live',
      known: true,
    };
    const primary = base.members[0];
    if (primary === undefined) throw new Error('no primary');
    return {
      ...base,
      members: [{ ...primary, role: 'primary' }, reserved],
      set: { members: 2, warm: true, pricePerInterval: '1400', runningMember: PROVIDER },
      ...overrides,
    };
  }

  it('lists a Standby Set’s members, and prices each on its own route', async () => {
    dashboard = dashboardOf(warmSet());
    await open();

    expect(await screen.findByText('2 members')).toBeInTheDocument();
    expect(screen.getByText('reserved')).toBeInTheDocument();
    // §6.3: a reservation is paid on `.standby.extend` at the standby price,
    // never on `.extend` — which refuses it and bills at the running price.
    expect(
      screen.getByRole('button', { name: /Extend on \.standby\.extend — 400 base units/u })
    ).toBeEnabled();
    expect(
      screen.getByText(/holds capacity for this workload and runs nothing/u)
    ).toBeInTheDocument();
  });

  it('extends the RESERVATION at the member the button names', async () => {
    dashboard = dashboardOf(warmSet());
    extendAnswer = {
      sent: true,
      problems: [],
      member: STANDBY,
      op: 'standby.extend',
      cost: '400',
      expiresAt: 1_790_004_200,
      card: warmSet(),
    };
    const person = await open();

    await person.click(
      await screen.findByRole('button', { name: /Extend on \.standby\.extend/u })
    );

    await waitFor(() => {
      expect(posted.some((call) => call.path.endsWith('/extend'))).toBe(true);
    });
    expect(posted.find((call) => call.path.endsWith('/extend'))?.body).toEqual({
      maxPrice: '400',
      member: STANDBY,
    });
  });

  it('shows a Takeover: who runs it now, and when it was announced', async () => {
    dashboard = dashboardOf(
      warmSet({
        set: {
          members: 2,
          warm: true,
          pricePerInterval: '2000',
          runningMember: STANDBY,
          takeover: {
            winner: STANDBY,
            from: PROVIDER,
            rounds: 1,
            announcedAt: '2026-09-23T10:15:23.000Z',
            firstSeenAt: '2026-09-23T10:20:00.000Z',
            seenBy: 'claim',
          },
        },
      })
    );
    await open();

    expect(await screen.findByText('Takeover.')).toBeInTheDocument();
    expect(screen.getByText(/runs this workload now/u)).toBeInTheDocument();
    expect(screen.getByText(/in the winner’s own signed claim/u)).toBeInTheDocument();
    // ADR 0010: the standby starts from the image, and no state moves.
    expect(screen.getByText(/No workload state moved/u)).toBeInTheDocument();
  });

  it('tells a SELF-STOPPED primary from an expired lease', async () => {
    const set = warmSet();
    const primary = set.members[0];
    if (primary === undefined) throw new Error('no primary');
    const stoppedStatus: WorkloadCard['status'] = {
      kind: 'read',
      life: { phase: 'stopped' },
      role: 'primary',
      expiresAt: 1_790_003_600,
      readAt: '2026-09-23T10:00:00.000Z',
    };
    dashboard = dashboardOf({
      ...set,
      status: stoppedStatus,
      members: [
        { ...primary, status: stoppedStatus, selfStopped: true, runningNow: false },
        set.members[1] as WorkloadCard['members'][number],
      ],
    });
    await open();

    // The lease STANDS: paid to its expiry, extendable at the running price,
    // swept like any other. An expired lease is over and cannot be restarted,
    // and the card must never show one as the other (§6.7, §7.1).
    expect(await screen.findByText(/This is a self-stop, not an ending/u)).toBeInTheDocument();
    expect(screen.getByText(/still paid to its expiry/u)).toBeInTheDocument();
    expect(screen.getByText('self-stopped')).toBeInTheDocument();
    expect(screen.queryByText(/no payment bought another Lease Interval/u)).toBeNull();
  });

  it('counts the runway across the whole set, and names what bounds it', async () => {
    dashboard = dashboardOf(
      warmSet({
        runway: {
          state: 'computed',
          listingPrice: 1000,
          leaseIntervalSeconds: 600,
          paidSeconds: 300,
          setPricePerInterval: '1400',
          rounds: 5,
          boundBy: STANDBY,
          seconds: 300 + 5 * 600,
          until: '2026-09-23T11:00:00.000Z',
          readAt: '2026-09-23T10:00:00.000Z',
        },
      })
    );
    await open();

    expect(await screen.findByText(/Runway 55 min/u)).toBeInTheDocument();
    expect(
      screen.getByText(/for the whole Standby Set: 5 more round\(s\)/u)
    ).toBeInTheDocument();
    expect(screen.getByText(/EVERY member is paid/u)).toBeInTheDocument();
  });

  it('shows a budget that stopped, and why', async () => {
    dashboard = dashboardOf(
      card({
        autoExtend: {
          armed: false,
          budget: '3000',
          spent: '3000',
          remaining: '0',
          extensions: 3,
          agreedPrice: '1000',
          leadSeconds: 900,
          armedAt: '2026-09-23T10:00:00.000Z',
          stoppedBecause:
            'The budget is spent: 3000 of 3000 base units has gone on 3 extension(s).',
        },
      })
    );
    await open();

    expect(await screen.findByText('Automatic extension is off')).toBeInTheDocument();
    expect(screen.getByText(/It stopped: The budget is spent/u)).toBeInTheDocument();
  });

  /* ------------------------------------------------------------------- */
  /* Showing SSH only when it was offered (TOON_Network#138)              */
  /* ------------------------------------------------------------------- */

  it('shows the SSH command when the lease was spawned with a key', async () => {
    await open();

    expect(await screen.findByText('SSH')).toBeInTheDocument();
    expect(screen.getByText('ssh -p 40000 tenant@203.0.113.7')).toBeInTheDocument();
  });

  it('hides the SSH command and offers the HTTP port instead when no key was sent', async () => {
    const base = card();
    dashboard = dashboardOf({
      ...base,
      lease: { ...base.lease, sshOffered: false },
      status: {
        kind: 'read',
        life: { phase: 'running' },
        role: 'standalone',
        expiresAt: 1_790_003_600,
        access: {
          host: '203.0.113.7',
          ssh_port: 40000,
          ports: [{ container_port: 80, host_port: 30080 }],
        },
        readAt: '2026-09-23T10:00:00.000Z',
      },
    });
    await open();

    await screen.findByText('running');
    expect(screen.queryByText(/ssh -p 40000/u)).not.toBeInTheDocument();
    expect(screen.getByText(/no SSH key/u)).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('http://203.0.113.7:30080')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------------- */
  /* Expired, and forgetting (TOON_Network#138)                             */
  /* ---------------------------------------------------------------------- */

  it('shows an expired lease as expired, and how to keep one alive', async () => {
    dashboard = dashboardOf(
      card({
        status: {
          kind: 'read',
          life: { phase: 'ended', ending: 'expired' },
          expiresAt: 1_790_003_600,
          readAt: '2026-09-23T10:00:00.000Z',
        },
        extend: { ok: false, problems: ['This lease has ended (Expired).'] },
        endedAs: 'expired',
      })
    );
    await open();

    expect(await screen.findByText('ended — expired')).toBeInTheDocument();
    expect(screen.getByText(/the paid time ran out/u)).toBeInTheDocument();
    expect(screen.getByText(/Extend it/u)).toBeInTheDocument();
    expect(screen.getByText(/only way to get it back/u)).toBeInTheDocument();
    // Dim, not the alert styling `role="alert"` would carry.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminate' })).not.toBeInTheDocument();
  });

  it('keeps the ending after a provider sweeps an expired or terminated lease away', async () => {
    dashboard = dashboardOf(
      card({
        status: {
          kind: 'refused',
          code: 'unknown_workload',
          message: 'this provider holds no lease with that workload_id',
          readAt: '2026-09-23T10:05:00.000Z',
        },
        endedAs: 'expired',
      })
    );
    await open();

    // The badge AND the message both say `unknown_workload` (one in the
    // header badge, one in the `<code>` inside `Life`'s sentence).
    expect((await screen.findAllByText('unknown_workload')).length).toBeGreaterThan(0);
    expect(
      await screen.findByText(/This console last saw this lease end by/u)
    ).toBeInTheDocument();
    // `card.endedAs` itself, in its own `<span>` at the end of that
    // sentence.
    expect(screen.getByText('expired')).toBeInTheDocument();
  });

  it('hides ended workloads once something is still live, and a button brings them back', async () => {
    const running = card();
    const ended = card({
      workloadId: 'b'.repeat(64),
      lease: { ...card().lease, workloadId: 'b'.repeat(64) },
      status: {
        kind: 'read',
        life: { phase: 'ended', ending: 'termination' },
        readAt: '2026-09-23T10:00:00.000Z',
      },
      endedAs: 'termination',
    });
    dashboard = { ...dashboardOf(running), cards: [running, ended] };
    const person = await open();

    // The live one is shown; the ended one starts hidden.
    await screen.findByText('running');
    expect(screen.queryByText('ended — termination')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Show ended/u });

    await person.click(toggle);
    expect(await screen.findByText('ended — termination')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide ended' })).toBeInTheDocument();
  });
});
