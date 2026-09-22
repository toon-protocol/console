import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The UI is built to `dist/` and served by the daemon from there, so the paths
 * are relative (`base: './'`) — the daemon may be asked to serve the same
 * build from a package-installed directory, and an absolute base would pin it
 * to one layout.
 *
 * The dev server proxies `/api` to the daemon so that `npm run dev` talks to a
 * real daemon rather than a mock. The token still comes from the launch URL:
 * start the daemon, copy the `open:` line it prints, and swap the port for the
 * dev server's.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.TOON_CONSOLE_PORT ?? 7797}`,
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
