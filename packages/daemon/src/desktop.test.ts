import { describe, expect, it } from 'vitest';

import { DesktopState, VIEW_REQUEST_TTL_MS } from './desktop.js';
import type { ThemeReading } from './theme.js';

/**
 * The channel an open window holds (TOON_Network#99).
 *
 * What is asserted here is the two promises it makes: a change reaches a
 * waiting window, and nothing that happened between two polls is lost.
 */

function theme(revision: string): ThemeReading {
  return {
    source: 'omarchy',
    name: 'tokyo-night',
    mode: 'dark',
    revision,
    css: `:root { --background: #${revision}; }`,
    readAt: '2026-09-23T00:00:00.000Z',
  };
}

describe('DesktopState', () => {
  it('answers at once when the window is behind, so nothing is missed', async () => {
    const state = new DesktopState({ read: () => theme('aaaaaa') });
    const first = state.current();

    state.requestView('funds');

    // The window is still asking about the seq it saw BEFORE the menu entry
    // ran. It must not be made to wait for the next change.
    const answer = await state.wait(first.seq, 10_000);
    expect(answer.open).toBe('funds');
    expect(answer.seq).toBeGreaterThan(first.seq);
  });

  it('wakes a waiting window the moment the theme-set hook calls', async () => {
    let revision = 'aaaaaa';
    const state = new DesktopState({ read: () => theme(revision), recheckMs: 60_000 });
    const held = state.wait(state.current().seq, 10_000);

    revision = 'bbbbbb';
    state.refreshTheme();

    const answer = await held;
    expect(answer.theme.revision).toBe('bbbbbb');
  });

  it('notices a theme change on its own where the hook is not installed', async () => {
    let revision = 'aaaaaa';
    const state = new DesktopState({ read: () => theme(revision), recheckMs: 5 });
    const held = state.wait(state.current().seq, 10_000);

    revision = 'cccccc';

    const answer = await held;
    expect(answer.theme.revision).toBe('cccccc');
  });

  it('wakes nobody for a theme whose colours did not move', async () => {
    const state = new DesktopState({ read: () => theme('aaaaaa'), recheckMs: 60_000 });
    const before = state.current().seq;

    state.refreshTheme();

    expect(state.current().seq).toBe(before);
    // ...and the window that was waiting is still waiting: it times out with
    // the same answer rather than re-applying an identical theme.
    await expect(state.wait(before, 20)).resolves.toMatchObject({ seq: before });
  });

  it('forgets a menu request too old for the window it was meant to open', () => {
    let at = new Date('2026-09-23T10:00:00Z');
    const state = new DesktopState({ read: () => theme('aaaaaa'), now: () => at });

    state.requestView('workloads');
    expect(state.current().open).toBe('workloads');

    at = new Date(at.getTime() + VIEW_REQUEST_TTL_MS + 1);
    // A window opened an hour after somebody chose "Workloads" from the menu
    // must open where it always opens, not where that click pointed.
    expect(state.current().open).toBeUndefined();
  });
});
