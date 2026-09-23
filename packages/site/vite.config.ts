import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The public site: one static build, served by Caddy on the relay Linode for
 * now, and moved onto TOON Network behind a Workload Gateway later
 * (TOON_Network#102's stated follow-up).
 *
 * `base` is absolute and not the console UI's `'./'`: this build routes under
 * `/docs/<slug>`, so a relative base would make `/docs/concepts` ask for its
 * assets under `/docs/`. It defaults to the root of a domain and is set by
 * `SITE_BASE` where the site is served from a path instead — GitHub Pages
 * serves a project at `/<repo>/`. `site-app.tsx` reads the same value back
 * out of `BASE_URL` so its links agree with its assets.
 *
 * `fs.allow` reaches the repository root because `docs/` at the root is the
 * SOURCE of the pages and this build bundles it. That bundle is the offline
 * fallback: the site renders the published NIP-23 articles from relays, and
 * shows what it shipped with when no relay answers.
 */
export default defineConfig({
  base: process.env.SITE_BASE ?? '/',
  plugins: [react()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    fs: { allow: [resolve(import.meta.dirname, '..', '..')] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
