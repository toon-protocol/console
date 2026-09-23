import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

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
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      /Rent a machine/u
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
    expect(screen.getByRole('link', { name: 'Specification' })).toHaveAttribute(
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
