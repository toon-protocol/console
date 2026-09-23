import { describe, expect, it } from 'vitest';

import { handleApi, type ApiDeps } from './api.js';
import { DesktopState } from './desktop.js';
import type { ThemeReading } from './theme.js';

/**
 * `/api/desktop` (TOON_Network#99).
 *
 * The route the theme-set hook and the Omarchy menu entries reach the window
 * through. Like every other route here it is behind the per-launch token —
 * `server.ts` checks that before any of this runs — so what is asserted below
 * is the shape, not the guard.
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

function deps(desktop?: DesktopState): ApiDeps {
  return { ...({} as ApiDeps), ...(desktop === undefined ? {} : { desktop }) };
}

const ask = (given: ApiDeps, method: string, path: string, body?: unknown) =>
  handleApi(given, { method, path, query: new URLSearchParams(), body });

describe('GET /api/desktop', () => {
  it('answers with the theme this machine is wearing', async () => {
    const answer = await ask(
      deps(new DesktopState({ read: () => theme('abc123') })),
      'GET',
      '/api/desktop'
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ theme: { name: 'tokyo-night', revision: 'abc123' } });
  });

  it('says so rather than pretending when nothing wired a desktop', async () => {
    const answer = await ask(deps(), 'GET', '/api/desktop');

    expect(answer.status).toBe(501);
    expect(answer.body).toMatchObject({ error: 'desktop_unwired' });
  });

  it('holds the request open until the theme moves', async () => {
    let revision = 'aaaaaa';
    const desktop = new DesktopState({ read: () => theme(revision), recheckMs: 60_000 });
    const seq = desktop.current().seq;
    const held = handleApi(deps(desktop), {
      method: 'GET',
      path: '/api/desktop',
      query: new URLSearchParams({ wait: '1', since: String(seq), timeout: '5000' }),
    });

    revision = 'bbbbbb';
    desktop.refreshTheme();

    expect((await held).body).toMatchObject({ theme: { revision: 'bbbbbb' } });
  });
});

describe('POST /api/desktop/view', () => {
  it('carries what the Omarchy menu asked for through to the window', async () => {
    const desktop = new DesktopState({ read: () => theme('abc123') });
    const given = deps(desktop);

    const posted = await ask(given, 'POST', '/api/desktop/view', { view: 'funds' });
    expect(posted.status).toBe(200);

    const read = await ask(given, 'GET', '/api/desktop');
    expect(read.body).toMatchObject({ open: 'funds' });
  });

  it('refuses a view it does not have', async () => {
    const answer = await ask(
      deps(new DesktopState({ read: () => theme('abc123') })),
      'POST',
      '/api/desktop/view',
      { view: 'the-moon' }
    );

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: 'invalid_request' });
  });
});

describe('POST /api/desktop/theme', () => {
  it('re-reads the rendered file and takes nothing from the caller', async () => {
    let revision = 'aaaaaa';
    const desktop = new DesktopState({ read: () => theme(revision), recheckMs: 60_000 });
    const given = deps(desktop);

    revision = 'dddddd';
    // The hook says only "look again"; the colours are read off the file that
    // Omarchy rendered, never taken out of the request.
    const answer = await ask(given, 'POST', '/api/desktop/theme', {
      css: ':root { --background: red; }',
    });

    expect(answer.body).toMatchObject({ theme: { revision: 'dddddd' } });
    expect(JSON.stringify(answer.body)).not.toContain('red');
  });
});
