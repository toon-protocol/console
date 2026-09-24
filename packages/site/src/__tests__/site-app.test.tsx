import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SiteApp } from '@/app/site-app';
import { DEFAULT_CONFIG, type SiteConfig } from '@/lib/config';
import { BUNDLED_DOCS } from '@/lib/docs';

const CONFIG: SiteConfig = {
  ...DEFAULT_CONFIG,
  docsNpub: '',
  relays: ['wss://relay.test'],
  network: 'devnet',
  gatewayDomain: 'gw.devnet.toonprotocol.dev',
};

const mount = (overrides: Partial<Parameters<typeof SiteApp>[0]> = {}) =>
  render(
    <SiteApp
      initialPath="/"
      loadSiteConfig={() => Promise.resolve(CONFIG)}
      loadArticles={() => Promise.resolve({ docs: BUNDLED_DOCS })}
      {...overrides}
    />
  );

describe('the landing page', () => {
  it('leads with what the network is and what it costs', async () => {
    mount();
    // The old headline — "rent a machine from somebody you have never met" —
    // is equally true of any cloud with a credit card form, so it said nothing.
    // What is only true here is that there is no account and no company at all.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      /the whole relationship/u
    );
    expect(screen.getByText('1000 µUSDC')).toBeInTheDocument();
    expect(screen.getByText('5000 µUSDC')).toBeInTheDocument();
    expect(screen.getAllByText('3600 s')).toHaveLength(2);
  });

  it('says this is a devnet before it says anything else about the network', async () => {
    mount();
    // The ticket's own words: honest about what exists today. This is the
    // assertion that keeps it honest after somebody rewrites the copy.
    expect(await screen.findByRole('status')).toHaveTextContent(/test network/u);
    expect(screen.getByText(/no public mainnet provider/iu)).toBeInTheDocument();
  });

  it('says plainly that no faucet gives native gas', async () => {
    mount();
    expect(await screen.findByText(/no faucet gives you/iu)).toBeInTheDocument();
  });

  it('calls a visitor to install the Omarchy app', async () => {
    mount();
    const install = await screen.findByRole('link', { name: /install the console/iu });
    expect(install).toHaveAttribute('href', '#install');
    expect(screen.getByText(/yay -S toon-console/u)).toBeInTheDocument();
  });

  it('names the gateway domain a workload is reachable at', async () => {
    mount();
    expect(await screen.findByText('gw.devnet.toonprotocol.dev')).toBeInTheDocument();
  });
});

describe('the documentation', () => {
  it('covers every subject the ticket asked for, and links the spec', async () => {
    mount();
    const list = within(await screen.findByRole('list', { name: 'Documentation' }));
    for (const title of [
      'Concepts',
      'Your first workload',
      'Funding',
      'Gateways',
      'Failover',
      'Hidden Providers',
      'The specification',
    ]) {
      expect(
        list.getByRole('button', { name: new RegExp(`^${title}`, 'u') })
      ).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Specification and ADRs' })).toHaveAttribute(
      'href',
      DEFAULT_CONFIG.specUrl
    );
  });

  it('opens a page at its own URL', async () => {
    const user = userEvent.setup();
    mount();
    const list = within(await screen.findByRole('list', { name: 'Documentation' }));
    await user.click(list.getByRole('button', { name: /^Funding/u }));
    expect(window.location.pathname).toBe('/docs/funding');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Funding' })
    ).toBeInTheDocument();
  });

  it('renders a page asked for by URL directly', async () => {
    mount({ initialPath: '/docs/gateways' });
    expect(
      await within(screen.getByRole('main')).findByRole('heading', {
        level: 1,
        name: 'Gateways',
      })
    ).toBeInTheDocument();
  });

  it('follows a slug link inside a page without leaving the app', async () => {
    const user = userEvent.setup();
    mount({ initialPath: '/docs/gateways' });
    const main = within(screen.getByRole('main'));
    await main.findByRole('heading', { level: 1, name: 'Gateways' });
    await user.click(main.getAllByRole('link', { name: 'Failover' })[0]!);
    expect(
      await within(screen.getByRole('main')).findByRole('heading', {
        level: 1,
        name: 'Failover',
      })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/docs/failover');
  });

  it('says so when a page is not there', async () => {
    mount({ initialPath: '/docs/nothing-like-this' });
    expect(await screen.findByRole('heading', { name: 'No such page' })).toBeInTheDocument();
  });
});

describe('published versus bundled', () => {
  it('shows the published article, with the address a Nostr client can open', async () => {
    mount({
      initialPath: '/docs/concepts',
      loadArticles: () =>
        Promise.resolve({
          docs: BUNDLED_DOCS.map((doc) =>
            doc.d === 'concepts'
              ? {
                  ...doc,
                  markdown: '# Concepts\n\nThe published text.',
                  source: 'relays' as const,
                  address: '30023:abc:concepts',
                }
              : doc
          ),
          pubkey: 'abc',
        }),
    });
    expect(await screen.findByText('The published text.')).toBeInTheDocument();
    expect(screen.getByText('30023:abc:concepts')).toBeInTheDocument();
  });

  it('shows the bundled page with a banner saying why, when relays are down', async () => {
    mount({
      initialPath: '/docs/concepts',
      loadArticles: () =>
        Promise.resolve({ docs: BUNDLED_DOCS, fallback: 'The relays could not be reached.' }),
    });
    await waitFor(() =>
      expect(screen.getByText('The relays could not be reached.')).toBeInTheDocument()
    );
    // And the page itself is still there. That is the whole point of bundling.
    expect(screen.getByRole('heading', { level: 1, name: 'Concepts' })).toBeInTheDocument();
  });

  it('renders the bundled pages before any relay has answered', () => {
    // No `await`: the first paint needs nothing but the page it came in.
    mount({ initialPath: '/docs/funding', loadArticles: () => new Promise(() => {}) });
    const main = screen.getByRole('main');
    expect(
      within(main).getByRole('heading', { level: 1, name: 'Funding' })
    ).toBeInTheDocument();
  });
});

describe('the lease meter', () => {
  /**
   * The hero's one job is to teach that a lease is prepaid time that stops.
   * These are the two facts it must still say after somebody restyles it.
   */
  it('buys another hour when a visitor pays for one', async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('2 × 1000 µUSDC')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /pay 1000 µUSDC/u }));
    expect(screen.getByText('3 × 1000 µUSDC')).toBeInTheDocument();
    expect(screen.getByText('3 hours')).toBeInTheDocument();
  });

  it('says what happens when nobody pays for the next hour', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /stop paying/u }));
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(screen.getByText(/nobody cancelled it/iu)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /take a new lease/u })).toBeInTheDocument();
  });
});

describe('the nav bar', () => {
  it('carries which network this is, as a live status', async () => {
    mount();
    const chip = await screen.findByRole('status');
    expect(chip).toHaveTextContent(/devnet/u);
    expect(chip).toHaveTextContent(/test network/u);
  });

  it('keeps install one click away from any page', async () => {
    mount({ initialPath: '/docs/funding' });
    const nav = within(await screen.findByRole('navigation', { name: 'This site' }));
    expect(nav.getByRole('link', { name: 'Install' })).toHaveAttribute('href', '/#install');
  });

  it('carries the project itself: its source, and where it posts', async () => {
    mount();
    const nav = within(await screen.findByRole('navigation', { name: 'This site' }));
    expect(nav.getByRole('link', { name: /on GitHub/iu })).toHaveAttribute(
      'href',
      DEFAULT_CONFIG.repoUrl
    );
    expect(nav.getByRole('link', { name: /on X/iu })).toHaveAttribute(
      'href',
      DEFAULT_CONFIG.xUrl
    );
  });
});

describe('the theme', () => {
  /**
   * Omarchy is a desktop you re-dress, and the console follows whichever theme
   * the desktop is in (ADR 0019). A page that explains that and cannot be
   * re-dressed itself is making a claim it does not keep.
   */
  /**
   * jsdom under Node 22 has no `localStorage` — Node's own experimental global
   * shadows it — so one lives here for the length of these tests. The site
   * itself guards every access and works without it; what is under test is
   * that it uses one when there is one.
   */
  let store: Record<string, string> = {};
  const fake = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => void (store[key] = value),
    removeItem: (key: string) => {
      store = Object.fromEntries(Object.entries(store).filter(([at]) => at !== key));
    },
  };

  beforeEach(() => {
    store = {};
    Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('wears an Omarchy theme when one is chosen, and remembers it', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /change the theme/iu }));
    await user.click(screen.getByRole('menuitemradio', { name: /gruvbox/iu }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('gruvbox');
    expect(store['toon-site-theme']).toBe('gruvbox');
  });

  it('steps to the next theme on T, the key Omarchy itself uses', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /change the theme/iu });
    await user.keyboard('t');
    expect(document.documentElement.getAttribute('data-theme')).toBe('tokyo-night');
    await user.keyboard('t');
    expect(document.documentElement.getAttribute('data-theme')).toBe('catppuccin');
  });

  it('hands the choice back to the browser', async () => {
    const user = userEvent.setup();
    store['toon-site-theme'] = 'nord';
    mount();
    await user.click(await screen.findByRole('button', { name: /change the theme/iu }));
    await user.click(screen.getByRole('menuitemradio', { name: /match the browser/iu }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(store['toon-site-theme']).toBeUndefined();
  });
});
