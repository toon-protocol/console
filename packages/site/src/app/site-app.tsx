import { useCallback, useEffect, useState } from 'react';

import { loadDocs, type ArticlesResult } from '@/lib/articles';
import { DEFAULT_CONFIG, loadConfig, type SiteConfig } from '@/lib/config';
import { BUNDLED_DOCS, docBySlug } from '@/lib/docs';

import { DocPage } from './doc-page';
import { Landing } from './landing';

/**
 * The site's shell (TOON_Network#102).
 *
 * Routing is the History API and `/docs/<slug>`, which needs the server to
 * answer any path under `/docs/` with `index.html` — the Caddy block in
 * `deploy/` does exactly that and nothing else. Real paths rather than hashes,
 * because a documentation page is a thing people link to.
 *
 * It renders the BUNDLED pages immediately and swaps in the published ones
 * when the relays answer. That ordering is the point: the first paint needs no
 * network beyond the page itself, and a visitor on a bad connection reads the
 * docs instead of a spinner.
 */

interface Route {
  readonly kind: 'landing' | 'doc';
  readonly d?: string;
}

/**
 * Where this build is served from, without its trailing slash: `''` at the
 * root of a domain, `'/console'` under GitHub Pages' project path. Vite sets
 * `BASE_URL` from the `base` the build was made with, so the routes below are
 * written as the site's own paths and the prefix is added and removed here.
 * A build whose base is wrong therefore breaks loudly at the first link,
 * rather than serving a page that cannot link to its siblings.
 */
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/u, '');

/** A location's path as this site names it, with the deploy prefix removed. */
function ownPath(pathname: string): string {
  if (BASE !== '' && pathname.startsWith(BASE)) return pathname.slice(BASE.length) || '/';
  return pathname;
}

/** One of this site's own paths, as the browser must be told it. */
function href(path: string): string {
  return `${BASE}${path}`;
}

function routeOf(pathname: string): Route {
  const path = ownPath(pathname);
  const match = /^\/docs\/([^/]+)\/?$/u.exec(path);
  if (match?.[1] !== undefined) return { kind: 'doc', d: decodeURIComponent(match[1]) };
  if (path === '/docs' || path === '/docs/') return { kind: 'doc', d: 'concepts' };
  return { kind: 'landing' };
}

export function SiteApp({
  initialPath = typeof window === 'undefined' ? '/' : window.location.pathname,
  loadSiteConfig = loadConfig,
  loadArticles = loadDocs,
}: {
  initialPath?: string;
  loadSiteConfig?: typeof loadConfig;
  loadArticles?: typeof loadDocs;
} = {}) {
  const [route, setRoute] = useState<Route>(() => routeOf(initialPath));
  const [config, setConfig] = useState<SiteConfig>(DEFAULT_CONFIG);
  const [articles, setArticles] = useState<ArticlesResult>({ docs: BUNDLED_DOCS });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadSiteConfig();
      if (cancelled) return;
      setConfig(loaded);
      const result = await loadArticles({
        npub: loaded.docsNpub,
        relays: loaded.relays,
      });
      if (!cancelled) setArticles(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSiteConfig, loadArticles]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next: Route, path: string) => {
    setRoute(next);
    if (typeof window !== 'undefined') window.history.pushState({}, '', path);
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, []);

  const openDoc = useCallback(
    (d: string) => go({ kind: 'doc', d }, href(`/docs/${encodeURIComponent(d)}`)),
    [go]
  );
  const openHome = useCallback(() => go({ kind: 'landing' }, href('/')), [go]);

  const doc = route.kind === 'doc' ? docBySlug(articles.docs, route.d ?? '') : undefined;

  return (
    <div className="site">
      <header className="site-header">
        <button type="button" className="brand" onClick={openHome}>
          TOON Network
        </button>
        <nav>
          <button type="button" onClick={() => openDoc('concepts')}>
            Docs
          </button>
          <a href={config.specUrl} target="_blank" rel="noopener noreferrer">
            Specification
          </a>
          <a href={config.repoUrl} target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </nav>
      </header>

      <div className="network-banner" role="status">
        <strong>{config.network}</strong> — a test network. There is no public mainnet provider
        yet, and the money is mock money.
      </div>

      {articles.fallback !== undefined && route.kind === 'doc' && (
        <p className="fallback-banner" role="status">
          {articles.fallback}
        </p>
      )}

      {route.kind === 'landing' ? (
        <Landing config={config} docs={articles.docs} onOpenDoc={openDoc} />
      ) : doc === undefined ? (
        <main className="landing">
          <section className="hero">
            <h1>No such page</h1>
            <p className="lede">
              There is no documentation page called “{route.d}”.{' '}
              <button type="button" className="link" onClick={() => openDoc('concepts')}>
                Start at Concepts
              </button>
              .
            </p>
          </section>
        </main>
      ) : (
        <DocPage doc={doc} docs={articles.docs} onOpenDoc={openDoc} />
      )}

      <footer className="site-footer">
        <p>
          The docs are Markdown in the console repository, published as NIP-23 long-form
          articles (kind 30023) and rendered here from relays, with the repository copy bundled
          as an offline fallback.
        </p>
        <p>
          <a href={config.specUrl} target="_blank" rel="noopener noreferrer">
            Specification and ADRs
          </a>
          {' · '}
          <a href={config.repoUrl} target="_blank" rel="noopener noreferrer">
            Console source
          </a>
          {articles.pubkey !== undefined && (
            <>
              {' · '}
              <span className="mono">{articles.pubkey.slice(0, 16)}…</span>
            </>
          )}
        </p>
      </footer>
    </div>
  );
}
