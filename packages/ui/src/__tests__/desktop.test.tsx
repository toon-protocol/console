import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleApp } from '@/app/console-app';
import { THEME_STYLE_ID } from '@/hooks/use-desktop';
import type { DesktopView, Health, SessionStatus } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The window, and the desktop around it (TOON_Network#99).
 *
 * Two claims, and they are the two acceptance criteria that cannot be checked
 * by reading the daemon's tests: an open window re-themes without restarting,
 * and an Omarchy menu entry opens the view it names.
 */

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
    rpc: {},
    origin: 'built-in',
    configured: true,
    active: true,
  },
  connector: { state: 'unconfigured', reason: 'not asked' },
  storage: { data: '/data', config: '/config', runtime: '/run', channels: '/data/channels' },
  checkedAt: '2026-09-23T10:00:00.000Z',
};

const signedOut: SessionStatus = {
  signedIn: false,
  keystore: { backend: 'file', location: '/config/keystore', needsPassphrase: true },
  signers: [],
};

function desktopView(overrides: Partial<DesktopView> = {}): DesktopView {
  return {
    seq: 1,
    theme: {
      source: 'omarchy',
      name: 'tokyo-night',
      mode: 'dark',
      revision: 'aaaa',
      css: ':root { --background: #1a1b26; }',
      readAt: '2026-09-23T10:00:00.000Z',
    },
    at: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

describe('the desktop', () => {
  let desktops: DesktopView[];

  beforeEach(() => {
    forgetLaunchToken();
    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=test-token') as unknown as Location,
      {
        replaceState: () => undefined,
      } as unknown as History
    );
    document.head.innerHTML = '';
    desktops = [desktopView()];

    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const answer = (body: unknown) =>
          Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        if (path.startsWith('/api/desktop')) {
          // The daemon holds a poll open until something changes; here the
          // queue empties and the last answer is repeated, which is what a
          // window that has caught up sees.
          return answer(desktops.length > 1 ? desktops.shift() : desktops[0]);
        }
        if (path.startsWith('/api/health')) return answer(health);
        if (path.startsWith('/api/profiles')) {
          return answer({ activeId: 'devnet', profiles: [health.profile] });
        }
        if (path.startsWith('/api/account')) return answer(signedOut);
        return answer({});
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-themes an open window when the theme changes, without reloading it', async () => {
    desktops = [
      desktopView(),
      desktopView({
        seq: 2,
        theme: {
          source: 'omarchy',
          name: 'catppuccin-latte',
          mode: 'light',
          revision: 'bbbb',
          css: ':root { --background: #eff1f5; }',
          readAt: '2026-09-23T10:01:00.000Z',
        },
      }),
    ];

    render(<ConsoleApp />);

    await waitFor(() => {
      expect(document.getElementById(THEME_STYLE_ID)?.textContent).toContain('#1a1b26');
    });
    // The same window, still mounted: only the custom property moved.
    await waitFor(() => {
      expect(document.getElementById(THEME_STYLE_ID)?.textContent).toContain('#eff1f5');
    });
    expect(document.head.querySelectorAll(`#${THEME_STYLE_ID}`)).toHaveLength(1);
  });

  it('opens the view an Omarchy menu entry asked for', async () => {
    desktops = [
      desktopView(),
      desktopView({ seq: 2, open: 'funds', openedAt: '2026-09-23T10:00:30.000Z' }),
    ];

    render(<ConsoleApp />);

    // "Funds" is a tab like any other; what the menu entry does is press it.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Funds' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });

  it('opens the Template gallery for "New workload"', async () => {
    desktops = [
      desktopView(),
      desktopView({ seq: 2, open: 'new-workload', openedAt: '2026-09-23T10:00:30.000Z' }),
    ];

    render(<ConsoleApp />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Templates' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });
});
