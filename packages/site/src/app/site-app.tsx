import { useCallback, useEffect, useState } from 'react';

import { loadDocs, type ArticlesResult } from '@/lib/articles';
import { DEFAULT_CONFIG, loadConfig, type SiteConfig } from '@/lib/config';
import { BUNDLED_DOCS, docBySlug } from '@/lib/docs';

import { DocPage } from './doc-page';
import { Landing } from './landing';
import { ThemePicker } from './theme-picker';

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
 *
 * Which network this is belongs in the nav bar and not in a strip beneath it.
 * A banner under a header is the first thing a reader learns to skip, and this
 * is the one fact the site cannot afford to have skipped; as a live chip beside
 * the name it is read as part of the name, which is what it is.
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

/** GitHub's own mark, at the size the bar wants it. */
function GitHubMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

/** X's own mark. */
function XMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z"
      />
    </svg>
  );
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
      <a className="skip" href="#start">
        Skip to the page
      </a>

      <header className="site-header">
        <div className="wrap">
          <button type="button" className="brand" onClick={openHome}>
            TOON Network
          </button>

          <p className="chip" role="status">
            <span className="net">{config.network}</span> — a test network
          </p>

          <nav className="site-nav" aria-label="This site">
            <button type="button" onClick={() => openDoc('concepts')}>
              Docs
            </button>
            <a
              className="icon"
              href={config.xUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="TOON Network on X"
            >
              <XMark />
              <span className="visually-hidden">TOON Network on X</span>
            </a>
            <a
              className="icon"
              href={config.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Source on GitHub"
            >
              <GitHubMark />
              <span className="visually-hidden">Source on GitHub</span>
            </a>
            <a className="install" href={`${href('/')}#install`}>
              Install
            </a>
            <ThemePicker />
          </nav>
        </div>
      </header>

      {articles.fallback !== undefined && route.kind === 'doc' && (
        <p className="fallback-banner" role="status">
          <span>{articles.fallback}</span>
        </p>
      )}

      {route.kind === 'landing' ? (
        <Landing config={config} docs={articles.docs} onOpenDoc={openDoc} />
      ) : doc === undefined ? (
        <main className="landing" id="start">
          <section className="hero">
            <div className="wrap">
              <h1>No such page</h1>
              <p className="lede">
                There is no documentation page called “{route.d}”. The seven pages that do
                exist start at{' '}
                <button type="button" className="link" onClick={() => openDoc('concepts')}>
                  Concepts
                </button>
                , which defines every word the rest of them use.
              </p>
            </div>
          </section>
        </main>
      ) : (
        <DocPage doc={doc} docs={articles.docs} onOpenDoc={openDoc} />
      )}

      <footer className="site-footer">
        <div className="wrap">
          <p>
            The docs are Markdown in the console repository, published as NIP-23 long-form
            articles (kind 30023) and rendered here from relays, with the repository copy
            bundled as an offline fallback. This page is static, stores nothing about you, and
            asks no other server for anything.
          </p>
          <ul>
            <li>
              <a href={config.specUrl} target="_blank" rel="noopener noreferrer">
                Specification and ADRs
              </a>
            </li>
            <li>
              <a href={config.repoUrl} target="_blank" rel="noopener noreferrer">
                Console source
              </a>
            </li>
            {articles.pubkey !== undefined && (
              <li className="key">
                Docs key <span className="mono">{articles.pubkey.slice(0, 16)}…</span>
              </li>
            )}
          </ul>
        </div>
      </footer>
    </div>
  );
}
