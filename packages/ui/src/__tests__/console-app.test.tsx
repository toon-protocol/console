import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import type { Health, Profiles } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/** The devnet relay edge's real answer, trimmed to what the view reads. */
const devnetConnector = {
  state: 'ok' as const,
  endpoint: 'https://proxy.relay.devnet.toonprotocol.dev',
  ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
  settlements: [
    {
      chain: 'evm:84532',
      kind: 'evm' as const,
      settlementAddress: '0x3f43d923a611bcb2d0bfb5d6ee2c3ac3efeaf308',
      tokenAddress: '0x49bee1bca5d15fb0963117923403f9498119a9ce',
      decimals: 6,
    },
    {
      chain: 'solana',
      kind: 'solana' as const,
      settlementAddress: 'GzvGVjq3dnNM79MpWRvYCvVcAgPWzDdYisMwGxHF4u9F',
      tokenAddress: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
      decimals: 6,
    },
  ],
  routes: [{ prefix: 'g.toon.relay', price: '1' }],
  peerCarriages: [],
  supportedVersions: [1],
};

const profile = (id: string, label: string, active: boolean, configured = true) => ({
  id,
  label,
  description: `${label} profile`,
  connectorUrl: configured ? 'https://connector.example/ilp' : '',
  relayUrl: '',
  gatewayDomain: '',
  origin: 'built-in' as const,
  configured,
  active,
});

const healthFor = (id: string, label: string): Health => ({
  daemon: {
    name: '@toon-protocol/console-daemon',
    version: '0.1.0',
    node: 'v22.0.0',
    pid: 1,
    startedAt: '2026-09-22T00:00:00.000Z',
    uptimeSeconds: 42,
  },
  profile: profile(id, label, true),
  connector: id === 'mainnet' ? { state: 'unconfigured', reason: 'no connector yet' } : devnetConnector,
  storage: {
    data: '/home/a/.local/share/toon-console',
    config: '/home/a/.config/toon-console',
    runtime: '/run/user/1000/toon-console',
    channels: '/home/a/.local/share/toon-console/profiles/devnet/channels/channels.json',
  },
  checkedAt: '2026-09-22T00:00:42.000Z',
});

let activeId = 'devnet';

function profilesBody(): Profiles {
  return {
    activeId,
    profiles: [
      profile('devnet', 'Devnet', activeId === 'devnet'),
      profile('sandbox', 'Local sandbox', activeId === 'sandbox'),
      profile('mainnet', 'Mainnet', activeId === 'mainnet', false),
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the console shell', () => {
  beforeEach(() => {
    activeId = 'devnet';
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      { replaceState: () => undefined } as unknown as History
    );

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // Every API call must present this launch's token, or the real daemon
        // answers 401 and nothing renders.
        const auth = new Headers(init?.headers).get('authorization');
        if (auth !== 'Bearer test-token') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
          );
        }
        if (url.startsWith('/api/profiles/active')) {
          activeId = JSON.parse(String(init?.body)).id as string;
          return Promise.resolve(jsonResponse(profilesBody()));
        }
        if (url.startsWith('/api/profiles')) return Promise.resolve(jsonResponse(profilesBody()));
        if (url.startsWith('/api/health')) {
          const label = profilesBody().profiles.find((p) => p.id === activeId)?.label ?? '';
          return Promise.resolve(jsonResponse(healthFor(activeId, label)));
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the daemon version and the connector the active profile names', async () => {
    render(<ConsoleApp />);
    expect(await screen.findByText('daemon 0.1.0')).toBeInTheDocument();
    expect(screen.getByText('answering')).toBeInTheDocument();
    expect(screen.getByText('g.toon.relay.ephemeral')).toBeInTheDocument();
    // The settlement chains are the connector's, not the app's.
    expect(screen.getByText('evm:84532')).toBeInTheDocument();
    expect(screen.getByText('solana')).toBeInTheDocument();
  });

  it('switches profile, and re-reads the connector for the new one', async () => {
    render(<ConsoleApp />);
    await screen.findByText('daemon 0.1.0');

    await userEvent.click(screen.getByRole('button', { name: /Mainnet/ }));

    await waitFor(() => {
      expect(screen.getByText('not configured')).toBeInTheDocument();
    });
    expect(screen.getByText('no connector yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mainnet/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('says so, rather than showing nothing, when the window has no token', async () => {
    forgetLaunchToken();
    render(<ConsoleApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/launch token/i);
  });
});
