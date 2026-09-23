import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import { directoryQuery } from '@/lib/daemon';
import type { Directory, Health, ProviderView } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The directory, as a person meets it.
 *
 * The bodies below are the shape the devnet provider really publishes —
 * `basic` and `ci`, the latter granting `docker`, one Liveness renewed every
 * 60 seconds — so what this file asserts is what that provider looks like on
 * screen, filters included.
 */

const PUBKEY = 'd0b8b59e576fe5584e064e90f2f3b236abc36e5bd16234fe3398de5cc27d24a6';
const RELAY = 'wss://relay.test';
const NOW = Date.parse('2026-09-22T12:00:00Z');

const provider = (expiresAt: number): ProviderView => ({
  pubkey: PUBKEY,
  profile: {
    ilpAddress: 'g.toon.provider',
    connectorUrl: 'https://proxy.provider.test/ilp',
    connectorSealKey: '0x04',
    relays: [RELAY],
    settlement: [{ chain: 'evm:84532', token: '0xtoken', decimals: 6 }],
    isolation: 'shared-kernel',
    hidden: false,
    host: '203.0.113.7',
    livenessCadenceSeconds: 60,
    publishedAt: '2026-09-22T11:00:00.000Z',
    eventId: 'a'.repeat(64),
  },
  liveness: {
    state: 'live',
    publishedAt: '2026-09-22T11:59:00.000Z',
    expiresAt: new Date(expiresAt).toISOString(),
    secondsUntilExpiry: Math.round((expiresAt - NOW) / 1000),
    cadenceSeconds: 60,
  },
  listings: [
    {
      name: 'basic',
      address: `30432:${PUBKEY}:basic`,
      version: 1,
      resources: { cpuMillicores: 500, memoryMb: 512, storageGb: 5 },
      arch: 'amd64',
      isolation: 'shared-kernel',
      hidden: false,
      leaseIntervalSeconds: 3600,
      price: 1000,
      standbyPrice: 400,
      capabilities: [],
      unspecifiedCapabilities: [],
      publishedAt: '2026-09-22T11:00:00.000Z',
      eventId: 'b'.repeat(64),
      available: 3,
    },
    {
      name: 'ci',
      address: `30432:${PUBKEY}:ci`,
      version: 1,
      resources: { cpuMillicores: 1000, memoryMb: 1024, storageGb: 10 },
      arch: 'amd64',
      isolation: 'shared-kernel',
      hidden: false,
      leaseIntervalSeconds: 3600,
      price: 5000,
      capabilities: ['docker'],
      unspecifiedCapabilities: [],
      publishedAt: '2026-09-22T11:00:00.000Z',
      eventId: 'c'.repeat(64),
      available: 1,
    },
  ],
  relaysRead: [RELAY],
  supersededListings: 1,
  rejectedListings: [],
});

const directoryFor = (query: string, expiresAt: number): Directory => {
  const only = new URLSearchParams(query);
  const wanted = only.getAll('capability');
  const listings = provider(expiresAt).listings.filter((listing) => {
    if (only.get('arch') && listing.arch !== only.get('arch')) return false;
    if (only.get('gpu') && listing.resources.gpu === undefined) return false;
    return wanted.every((capability) => listing.capabilities.includes(capability));
  });
  return {
    state: 'ok',
    relays: { seed: [RELAY], read: [{ url: RELAY, state: 'read', events: 4 }] },
    filters: {},
    providers: listings.length === 0 ? [] : [{ ...provider(expiresAt), listings }],
    listingsWithoutProfile: 0,
    rejectedEvents: 0,
    readAt: '2026-09-22T12:00:00.000Z',
  };
};

const health: Health = {
  daemon: {
    name: '@toon-protocol/console-daemon',
    version: '0.1.0',
    node: 'v22.0.0',
    pid: 1,
    startedAt: '2026-09-22T00:00:00.000Z',
    uptimeSeconds: 1,
  },
  profile: {
    id: 'devnet',
    label: 'Devnet',
    description: 'devnet',
    connectorUrl: 'https://connector.test/ilp',
    relayUrl: RELAY,
    gatewayDomain: 'gw.test',
    gatewayConnectorUrl: 'https://gateway.test/ilp',
    rpc: {},
    origin: 'built-in',
    configured: true,
    active: true,
  },
  connector: { state: 'unconfigured', reason: 'not what this file tests' },
  storage: { data: '/d', config: '/c', runtime: '/r', channels: '/d/channels.json' },
  checkedAt: '2026-09-22T12:00:00.000Z',
};

let expiresAt = NOW + 60_000;
let asked: string[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('browsing the Provider Directory', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    expiresAt = NOW + 60_000;
    asked = [];
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/directory')) {
          const query = url.slice(url.indexOf('?') + 1);
          asked.push(url.includes('?') ? query : '');
          return Promise.resolve(jsonResponse(directoryFor(query, expiresAt)));
        }
        if (url.startsWith('/api/profiles')) {
          return Promise.resolve(
            jsonResponse({ activeId: 'devnet', profiles: [health.profile] })
          );
        }
        if (url.startsWith('/api/health')) return Promise.resolve(jsonResponse(health));
        // Signed out: the Chain Seed has nothing to show and nothing to ask.
        if (url.startsWith('/api/chain-seed')) {
          return Promise.resolve(
            jsonResponse({
              state: 'signed_out',
              relayList: {
                state: 'unknown',
                read: [],
                write: [],
                writeTargets: [],
                writeTargetSource: 'none',
              },
              warning: { text: 'whoever holds the key holds the funds' },
              supersededSeeds: 0,
              checkedAt: '2026-09-22T00:00:00.000Z',
            })
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const open = async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ConsoleApp />);
    await screen.findByText('daemon 0.1.0');
    await user.click(screen.getByRole('button', { name: 'Providers' }));
    await screen.findByText('g.toon.provider');
    return user;
  };

  it('shows a provider with its tiers, its price per Lease Interval and its liveness', async () => {
    await open();

    const card = screen.getByText('g.toon.provider').closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);

    expect(scope.getByText('basic')).toBeInTheDocument();
    expect(scope.getByText('ci')).toBeInTheDocument();
    // µUSDC per Lease Interval, in the unit the Listing published.
    expect(scope.getByText(/1,000 µUSDC/)).toBeInTheDocument();
    expect(scope.getAllByText(/\/ 1h/).length).toBeGreaterThan(0);
    expect(scope.getByText(/standby 400 µUSDC/)).toBeInTheDocument();
    // `ci` publishes no `standby_price` at all, which is not a price of zero.
    expect(scope.getByText('no warm standby')).toBeInTheDocument();
    expect(scope.getByText('docker')).toBeInTheDocument();
    expect(scope.getByText(/live/)).toBeInTheDocument();
    // The Profile's own Relay Set, not the console's.
    expect(scope.getAllByText(RELAY, { selector: 'dd' }).length).toBe(2);
  });

  it('says a superseded Listing version was set aside', async () => {
    const user = await open();
    await user.click(screen.getByText('What was set aside'));
    expect(screen.getByText(/1 older Listing version\(s\) superseded/)).toBeInTheDocument();
  });

  it('goes stale on its own, with no refresh and no new event', async () => {
    await open();
    expect(screen.getByText(/^live/)).toBeInTheDocument();
    const reads = asked.length;

    // Nothing is refetched. What changed is the clock.
    await vi.advanceTimersByTimeAsync(61_000);
    await waitFor(() => expect(screen.getByText(/^stale/)).toBeInTheDocument());
    expect(asked).toHaveLength(reads);
  });

  it('asks the daemon for the filter a person chose, and shows what comes back', async () => {
    const user = await open();

    await user.selectOptions(screen.getByLabelText('Arch'), 'arm64');
    await waitFor(() => expect(asked).toContain('arch=arm64'));
    await screen.findByText(/No provider on this network publishes a Listing that matches/);

    await user.selectOptions(screen.getByLabelText('Arch'), 'amd64');
    await waitFor(() => expect(asked).toContain('arch=amd64'));
    expect(await screen.findByText('g.toon.provider')).toBeInTheDocument();
  });

  it('takes each capability as a further demand, not an alternative', async () => {
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: /docker/ }));
    await waitFor(() => expect(asked).toContain('capability=docker'));
    const card = (await screen.findByText('g.toon.provider')).closest('[data-slot="card"]');
    expect(within(card as HTMLElement).queryByText('basic')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: /nesting/ }));
    await waitFor(() => expect(asked).toContain('capability=docker&capability=nesting'));
    await screen.findByText(/No provider on this network publishes a Listing that matches/);
  });
});

describe('the directory query string', () => {
  it('spells each capability as its own entry, and hidden as three values', () => {
    expect(directoryQuery({ capabilities: ['docker', 'nesting'] })).toBe(
      '?capability=docker&capability=nesting'
    );
    expect(directoryQuery({ hidden: false })).toBe('?hidden=false');
    expect(directoryQuery({ hidden: true })).toBe('?hidden=true');
    expect(directoryQuery({})).toBe('');
  });
});
