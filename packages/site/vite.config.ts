import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The public site: one static build, served by Caddy on the relay Linode for
 * now, and moved onto TOON Network behind a Workload Gateway later
 * (TOON_Network#102's stated follow-up).
 *
 * `base: '/'` and not the console UI's `'./'`: this build is served at the
 * root of a domain and routes under `/docs/<slug>`, so a relative base would
 * make `/docs/concepts` ask for its assets under `/docs/`.
 *
 * `fs.allow` reaches the repository root because `docs/` at the root is the
 * SOURCE of the pages and this build bundles it. That bundle is the offline
 * fallback: the site renders the published NIP-23 articles from relays, and
 * shows what it shipped with when no relay answers.
 */
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    fs: { allow: [resolve(import.meta.dirname, '..', '..')] },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
