import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RotationPanel } from '@/app/rotation-panel';
import type { RotationResult, RotationView } from '@/lib/daemon';
import { adoptLaunchToken, forgetLaunchToken } from '@/lib/launch-token';

/**
 * The rotation panel, as a person meets it (TOON_Network#96, spec §6.8).
 *
 * Four things this file holds down, and each is a way the panel could mislead
 * somebody whose token has leaked.
 *
 * **It says what rotating ENDS before it is pressed.** Every Gateway Grant of
 * the old token stops working at once, with no grace period (ADR 0018).
 *
 * **It asks twice**, because that is what it breaks.
 *
 * **`unavailable` reads as retryable, never as rotated.** The provider could
 * not persist: nothing changed and the old token still works. Showing that as
 * a rotated member would tell somebody a leaked token was dead when it is not
 * (TOON_Network#78).
 *
 * **A partially rotated set is a state with a button, not an error.** §6.8
 * makes it a valid one, and finishing it is the same call again.
 */

const WORKLOAD = 'a'.repeat(64);
const PRIMARY = 'd'.repeat(64);
const STANDBY = 'e'.repeat(64);

function view(overrides: Partial<RotationView> = {}): RotationView {
  return {
    workloadId: WORKLOAD,
    underWay: false,
    ok: true,
    problems: [],
    members: [
      {
        pubkey: PRIMARY,
        index: 0,
        role: 'primary',
        confirmed: false,
        ok: true,
        problems: [],
        route: {
          route: 'g.toon.provider.rotate',
          payAt: 'https://provider.example/ilp',
          via: 'provider-connector',
          reason: 'free where it is free',
          price: '0',
        },
      },
      {
        pubkey: STANDBY,
        index: 1,
        role: 'standby',
        confirmed: false,
        ok: true,
        problems: [],
        route: {
          route: 'g.toon.provider2.rotate',
          payAt: 'https://provider2.example/ilp',
          via: 'provider-connector',
          reason: 'free where it is free',
          price: '0',
        },
      },
    ],
    confirmed: 0,
    of: 2,
    vault: {
      relays: ['wss://relay.test'],
      plan: [{ url: 'wss://relay.test', ready: true, price: '1' }],
      ready: true,
      price: '1',
      totalPrice: '1',
    },
    localOnly: false,
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

describe('the rotation panel', () => {
  let current: RotationView;
  let ran: RotationResult;
  let posted: { path: string; body: unknown }[];

  beforeEach(() => {
    posted = [];
    current = view();
    ran = {
      workloadId: WORKLOAD,
      started: true,
      rotated: true,
      problems: [],
      confirmed: 2,
      of: 2,
      cost: '0',
      vaultCost: '3',
      members: [
        { pubkey: PRIMARY, index: 0, role: 'primary', sent: true, rotated: true },
        { pubkey: STANDBY, index: 1, role: 'standby', sent: true, rotated: true },
      ],
      view: view({
        rotatedAt: '2026-09-23T10:00:00.000Z',
        confirmed: 0,
        members: view().members,
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
        if (init?.method === 'POST') {
          posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
          return Promise.resolve(answer(ran));
        }
        return Promise.resolve(answer(current));
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    forgetLaunchToken();
  });

  it('says what rotating ends, and sends nothing to say it', async () => {
    render(<RotationPanel workloadId={WORKLOAD} />);

    expect(
      await screen.findByText(/every Gateway Grant derived from it/u)
    ).toBeInTheDocument();
    expect(screen.getByText(/no grace period/u)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it('asks twice, naming how many members it would rotate', async () => {
    const person = userEvent.setup();
    render(<RotationPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Rotate the token' }));

    expect(posted).toHaveLength(0);
    await person.click(
      screen.getByRole('button', { name: /rotate at 2 member\(s\) and end every grant/u })
    );

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.path).toBe(`/api/workloads/${WORKLOAD}/rotate`);
    expect(await screen.findByText(/Rotated at every member/u)).toBeInTheDocument();
    expect(screen.getByText(/rotate requests cost nothing/u)).toBeInTheDocument();
  });

  it('shows a partially rotated set as such, with a button that finishes it', async () => {
    current = view({
      underWay: true,
      startedAt: '2026-09-23T10:00:00.000Z',
      confirmed: 1,
      members: [
        { ...view().members[0]!, confirmed: true },
        {
          ...view().members[1]!,
          confirmed: false,
          ok: false,
          problems: ['it did not answer'],
        },
      ],
    });
    render(<RotationPanel workloadId={WORKLOAD} />);

    expect(
      await screen.findByText(/rotation under way — 1 of 2 confirmed/u)
    ).toBeInTheDocument();
    expect(screen.getByText(/holds the new token/u)).toBeInTheDocument();
    expect(screen.getByText(/holds the old token/u)).toBeInTheDocument();
    expect(screen.getByText(/both/iu)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish the rotation' })).toBeInTheDocument();
  });

  it('shows `unavailable` as retryable and never as rotated', async () => {
    ran = {
      ...ran,
      rotated: false,
      confirmed: 1,
      members: [
        {
          pubkey: PRIMARY,
          index: 0,
          role: 'primary',
          sent: true,
          rotated: false,
          retryable: true,
          providerError: 'unavailable',
          message:
            'The provider could not persist this rotation. NOTHING changed: the old token still works.',
        },
        { pubkey: STANDBY, index: 1, role: 'standby', sent: true, rotated: true },
      ],
      view: view({ underWay: true, confirmed: 1, startedAt: '2026-09-23T10:00:00.000Z' }),
    };
    const person = userEvent.setup();
    render(<RotationPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Rotate the token' }));
    await person.click(screen.getByRole('button', { name: /rotate at 2 member\(s\)/u }));

    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('retryable')).toBeInTheDocument();
    expect(screen.getByText(/Rotated at 1 of 2 member\(s\)/u)).toBeInTheDocument();
    expect(screen.getByText(/the old token still works/u)).toBeInTheDocument();
  });

  it('says nothing was sent when the rotation never started', async () => {
    ran = {
      ...ran,
      started: false,
      rotated: false,
      confirmed: 0,
      members: [],
      problems: ['No member of this workload’s Standby Set can be reached right now.'],
      view: view(),
    };
    const person = userEvent.setup();
    render(<RotationPanel workloadId={WORKLOAD} />);
    await person.click(await screen.findByRole('button', { name: 'Rotate the token' }));
    await person.click(screen.getByRole('button', { name: /rotate at 2 member\(s\)/u }));

    expect(await screen.findByText(/Nothing was sent/u)).toBeInTheDocument();
    expect(screen.getByText(/can be reached right now/u)).toBeInTheDocument();
  });
});
