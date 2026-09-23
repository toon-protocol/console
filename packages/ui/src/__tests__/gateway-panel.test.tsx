import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayPanel } from '@/app/gateway-panel';
import type { GatewayView } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The hostname panel, as a person meets it (TOON_Network#97, spec §12).
 *
 * Four things this file holds down, and each is a way the panel could mislead
 * somebody about their own URL.
 *
 * **The hostname is shown before anything is handed over.** §12.2 derives it
 * from the workload id, so a person can see, copy and point DNS at their name
 * before they decide to hand the workload anywhere.
 *
 * **`no_grant` reads as empty, not as broken.** It is the answer a name gives
 * before its first handover and after a withdrawal.
 *
 * **A refusal says which kind it was.** `not_admitted` is about the lease;
 * `admission_failed` is about the gateway. The panel passes the daemon's own
 * words through rather than flattening them to "it failed".
 *
 * **Withdraw never says "revoked".** It ends serving, not reading (§12.7).
 */

const WORKLOAD = 'a'.repeat(64);
const HOSTNAME = 'vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva.gw.test';

function view(overrides: Partial<GatewayView> = {}): GatewayView {
  return {
    workloadId: WORKLOAD,
    hostname: HOSTNAME,
    gateway: {
      connectorUrl: 'https://gateway.test/ilp',
      ilpAddress: 'g.toon.workload-gateway',
      route: 'g.toon.workload-gateway.handover',
      price: '0',
      domain: 'gw.test',
    },
    held: false,
    problems: [],
    ok: true,
    ports: [80],
    httpPort: 80,
    checkedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

function answer(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('the gateway panel', () => {
  let current: GatewayView;
  let handed: unknown;
  let withdrawn: unknown;
  let posted: { path: string; body: unknown }[];

  beforeEach(() => {
    posted = [];
    current = view();
    handed = {
      sent: true,
      problems: [],
      hostname: HOSTNAME,
      expectedHostname: HOSTNAME,
      matches: true,
      cost: '0',
      expiresAt: 1_790_003_600,
      view: view({
        held: true,
        handover: {
          hostname: HOSTNAME,
          expiresAt: 1_790_003_600,
          httpPort: 80,
          standbySet: ['d'.repeat(64)],
          connectorUrl: 'https://gateway.test/ilp',
          route: 'g.toon.workload-gateway.handover',
          at: '2026-09-23T10:00:00.000Z',
        },
      }),
    };
    withdrawn = {
      sent: true,
      problems: [],
      hostname: HOSTNAME,
      withdrawn: true,
      message:
        'It is no longer served here. The gateway KEEPS the grant it was handed: a withdrawal ends serving, not reading (spec §12.7). Rotating this lease’s Continuation Token is what ends the reading.',
      view: view(),
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
          return Promise.resolve(answer(path.endsWith('/withdraw') ? withdrawn : handed));
        }
        return Promise.resolve(answer(current));
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetLaunchToken();
  });

  it('shows the hostname before anything has been handed over', async () => {
    render(<GatewayPanel workloadId={WORKLOAD} />);

    expect(await screen.findByText(HOSTNAME)).toBeInTheDocument();
    expect(screen.getByText('not handed over')).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('reads `no_grant` as the empty state rather than a fault', async () => {
    current = view({
      serving: {
        kind: 'no_grant',
        message:
          'names no workload this gateway holds a grant for. That is the healthy empty state',
        at: '2026-09-23T10:00:00.000Z',
      },
    });
    render(<GatewayPanel workloadId={WORKLOAD} />);

    expect(await screen.findByText(/healthy empty state/u)).toBeInTheDocument();
  });

  it('hands over with the hours and the name a person typed, and reports the cost', async () => {
    const person = userEvent.setup();
    render(<GatewayPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Hand to gateway' }));
    await person.clear(screen.getByLabelText('Grant lasts (hours)'));
    await person.type(screen.getByLabelText('Grant lasts (hours)'), '2');
    await person.type(screen.getByLabelText('Readable name (optional)'), 'blog');
    await person.click(screen.getByRole('button', { name: 'Hand it over' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.path).toBe(`/api/workloads/${WORKLOAD}/gateway/handover`);
    expect(posted[0]?.body).toEqual({ expiresIn: 7200, httpPort: 80, name: 'blog' });
    expect(await screen.findByText(/the handover cost nothing/u)).toBeInTheDocument();
  });

  it('says so when the gateway answered a hostname the console did not derive', async () => {
    handed = {
      sent: true,
      problems: [],
      hostname: 'elsewhere.gw.test',
      expectedHostname: HOSTNAME,
      matches: false,
      view: view({ held: true }),
    };
    const person = userEvent.setup();
    render(<GatewayPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Hand to gateway' }));
    await person.click(screen.getByRole('button', { name: 'Hand it over' }));

    expect(await screen.findByText(/answered a different hostname/u)).toBeInTheDocument();
  });

  it('passes a `not_admitted` refusal through in the daemon’s own words', async () => {
    handed = {
      sent: true,
      problems: [],
      gatewayError: 'not_admitted',
      message:
        'The gateway asked every member and none of them accepted the grant. Its token may have been rotated since.',
      view: view(),
    };
    const person = userEvent.setup();
    render(<GatewayPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Hand to gateway' }));
    await person.click(screen.getByRole('button', { name: 'Hand it over' }));

    expect(await screen.findByText('not_admitted')).toBeInTheDocument();
    expect(screen.getByText(/rotated since/u)).toBeInTheDocument();
  });

  it('withdraws, and says it ended serving rather than reading', async () => {
    current = view({
      held: true,
      handover: {
        hostname: HOSTNAME,
        expiresAt: 1_790_003_600,
        httpPort: 80,
        standbySet: ['d'.repeat(64)],
        connectorUrl: 'https://gateway.test/ilp',
        route: 'g.toon.workload-gateway.handover',
        at: '2026-09-23T10:00:00.000Z',
      },
    });
    const person = userEvent.setup();
    render(<GatewayPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Withdraw' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.path).toBe(`/api/workloads/${WORKLOAD}/gateway/withdraw`);
    expect(await screen.findByText(/ends serving, not reading/u)).toBeInTheDocument();
    expect(screen.queryByText(/revok/iu)).not.toBeInTheDocument();
  });

  it('knocks on the hostname only when asked', async () => {
    const person = userEvent.setup();
    render(<GatewayPanel workloadId={WORKLOAD} />);
    await screen.findByText(HOSTNAME);
    const calls = vi.mocked(fetch).mock.calls.length;

    current = view({
      serving: { kind: 'serving', status: 200, excerpt: 'Hostname: whoami-1', at: 'now' },
    });
    await person.click(screen.getByRole('button', { name: 'Check the hostname' }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls[calls]?.[0]).toBe(
        `/api/workloads/${WORKLOAD}/gateway?probe=1`
      )
    );
    expect(await screen.findByText(/Hostname: whoami-1/u)).toBeInTheDocument();
  });

  it('says a network with no gateway has no hostname, rather than showing nothing', async () => {
    current = view({
      hostname: undefined,
      gateway: undefined,
      ok: false,
      problems: ['Devnet names no Workload Gateway.'],
    });
    render(<GatewayPanel workloadId={WORKLOAD} />);

    expect(
      await screen.findByText(/no Workload Gateway, so this workload has no hostname/u)
    ).toBeInTheDocument();
  });
});
