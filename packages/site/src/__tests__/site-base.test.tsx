import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * The site served from a path rather than from the root of a domain
 * (TOON_Network#102's GitHub Pages deployment, where a project lives at
 * `/<repo>/`).
 *
 * The prefix is read once, at module load, out of Vite's `BASE_URL` — so these
 * tests stub it and import the shell afresh. Without this the failure is quiet
 * and total: every link would point above the site's own root, and a visitor
 * would leave it by clicking anything.
 */
const BASE = '/console/';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('BASE_URL', BASE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
});

async function mount(initialPath: string) {
  const { SiteApp } = await import('@/app/site-app');
  const { DEFAULT_CONFIG } = await import('@/lib/config');
  return render(
    <SiteApp
      initialPath={initialPath}
      loadSiteConfig={() => Promise.resolve(DEFAULT_CONFIG)}
      loadArticles={() => new Promise(() => {})}
    />
  );
}

test('a deep link under the prefix opens the page it names', async () => {
  await mount('/console/docs/gateways');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/gateway/iu);
});

test('the prefix root is the landing page, not a missing doc', async () => {
  await mount('/console/');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  expect(document.body.textContent).not.toMatch(/no such page/iu);
});

test('opening a doc writes a path that still carries the prefix', async () => {
  await mount('/console/');
  const link = await screen.findByRole('button', { name: /funding/iu });
  await userEvent.click(link);
  await waitFor(() => expect(window.location.pathname).toBe('/console/docs/funding'));
});
