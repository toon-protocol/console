import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';
import { isSafeHref, renderMarkdown } from '@/lib/markdown';

/**
 * The Help tab (TOON_Network#102).
 *
 * The facts worth pinning: reading needs no account, a published page says it
 * is published and shows the address a Nostr client can open, and a bundled
 * page says WHY it is bundled — offline is the state a fresh install is in,
 * and half of these pages are about getting out of it.
 */

const HEALTH = {
  daemon: {
    name: 'toon-console-daemon',
    version: '0.1.0',
    node: 'v22.0.0',
    pid: 1,
    startedAt: '2026-09-23T00:00:00.000Z',
    uptimeSeconds: 1,
  },
  profile: {
    id: 'devnet',
    label: 'Devnet',
    description: 'test',
    connectorUrl: 'https://connector.test/ilp',
    relayUrl: 'wss://relay.test',
    gatewayDomain: 'gw.devnet.toonprotocol.dev',
    gatewayConnectorUrl: 'https://gateway.test/ilp',
    rpc: {},
    origin: 'built-in',
    configured: true,
    active: true,
  },
  connector: { state: 'unconfigured', reason: 'test' },
  storage: { data: '/d', config: '/c', runtime: '/r', channels: '/ch' },
  checkedAt: '2026-09-23T00:00:00.000Z',
};

const INDEX = {
  author: {
    npub: 'npub1docs0000000000000000000000000000000000000000',
    pubkey: 'ab'.repeat(32),
  },
  relays: ['wss://relay.test'],
  read: [{ url: 'wss://relay.test', state: 'read', events: 2 }],
  readAt: '2026-09-23T00:00:00.000Z',
  docs: [
    {
      d: 'concepts',
      title: 'Concepts',
      summary: 'The nine words.',
      order: 1,
      publishedAt: '2026-09-23',
      tags: [],
      source: 'relays',
      address: `30023:${'ab'.repeat(32)}:concepts`,
    },
    {
      d: 'funding',
      title: 'Funding',
      summary: 'The money.',
      order: 2,
      publishedAt: '2026-09-23',
      tags: [],
      source: 'bundled',
    },
  ],
};

function answer(path: string): unknown {
  if (path.startsWith('/api/health')) return HEALTH;
  if (path.startsWith('/api/profiles'))
    return { activeId: 'devnet', profiles: [HEALTH.profile] };
  if (path === '/api/account') return { signedIn: false, signers: [] };
  if (path === '/api/docs') return INDEX;
  if (path === '/api/docs/concepts') {
    return {
      ...INDEX,
      doc: {
        ...INDEX.docs[0],
        markdown: '# Concepts\n\nA **Provider** sells leases.',
      },
    };
  }
  if (path === '/api/docs/funding') {
    return {
      ...INDEX,
      fallback: 'The relays could not be reached. This is the page that shipped.',
      doc: { ...INDEX.docs[1], markdown: '# Funding\n\nNo faucet gives you native gas.' },
    };
  }
  return {};
}

beforeEach(() => {
  forgetLaunchToken();
  adoptLaunchToken(
    new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
    { replaceState: () => undefined } as unknown as History
  );
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(answer(path)),
      } as unknown as Response)
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetLaunchToken();
});

async function openHelp() {
  const user = userEvent.setup();
  render(<ConsoleApp />);
  await user.click(await screen.findByRole('button', { name: 'Help' }));
  return user;
}

describe('the Help tab', () => {
  it('lists the pages without anybody signing in', async () => {
    await openHelp();
    expect(await screen.findByText('Concepts')).toBeInTheDocument();
    expect(screen.getByText('The nine words.')).toBeInTheDocument();
    expect(screen.getByText('Funding')).toBeInTheDocument();
  });

  it('says of each page whether it is published or bundled', async () => {
    await openHelp();
    await screen.findByText('Concepts');
    expect(screen.getAllByText('published')).toHaveLength(1);
    expect(screen.getAllByText('bundled')).toHaveLength(1);
  });

  it('opens a published page and shows the address a Nostr client can use', async () => {
    const user = await openHelp();
    await user.click(await screen.findByText('Concepts'));
    await waitFor(() => expect(screen.getByText(/sells leases/u)).toBeInTheDocument());
    expect(screen.getByText(`30023:${'ab'.repeat(32)}:concepts`)).toBeInTheDocument();
  });

  it('shows a bundled page with the sentence saying why', async () => {
    const user = await openHelp();
    await user.click(await screen.findByText('Funding'));
    await waitFor(() =>
      expect(screen.getByText(/relays could not be reached/u)).toBeInTheDocument()
    );
    // And the page is still readable. That is what bundling is for.
    expect(screen.getByText(/No faucet gives you native gas/u)).toBeInTheDocument();
  });
});

describe('rendering a page body', () => {
  it('drops raw HTML rather than escaping and showing it', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\nafter');
    expect(html).not.toContain('onerror');
    expect(html).toContain('after');
  });

  it('refuses a link scheme that is not http, https or mailto', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('https://toonprotocol.dev')).toBe(true);
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href');
  });
});
