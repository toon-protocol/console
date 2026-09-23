import { describe, expect, it } from 'vitest';

import type { ApiDeps } from './api.js';
import { DesktopState } from './desktop.js';
import { startServer, type RunningServer } from './server.js';
import type { ThemeReading } from './theme.js';

/**
 * The daemon's shutdown path, pinned end to end over a real socket
 * (TOON_Network#128).
 *
 * `systemctl --user stop` was taking 90 seconds and ending in a `SIGKILL`,
 * because `/api/desktop`'s long poll — `wait=1&since=<seq>` — is in flight by
 * design (TOON_Network#99), and `server.close()` will not finish while a
 * request is in flight. A daemon holding one had nothing that told it to
 * stop waiting.
 *
 * What is asserted here is the actual mechanism, not a unit in isolation:
 * a real HTTP request held open against a real listening socket, closed the
 * way `main.ts`'s signal handler actually closes it.
 */

const TOKEN = 'a-launch-token';

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

async function withServer(
  desktop: DesktopState,
  run: (running: RunningServer) => Promise<void>
): Promise<void> {
  // A cast, like `api-desktop.test.ts` uses: this file drives `/api/desktop`
  // only, and every other route this daemon serves needs none of what is
  // left out here.
  const deps = { ...({} as ApiDeps), desktop };
  const running = await startServer({ deps, token: TOKEN, host: '127.0.0.1', port: 0 });
  try {
    await run(running);
  } finally {
    await running.close().catch(() => undefined);
  }
}

const poll = (url: string, since: number, timeoutMs = 30_000) =>
  fetch(`${url}/api/desktop?wait=1&since=${since}&timeout=${timeoutMs}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

describe('the daemon shutdown path', () => {
  it('stops in well under a second with a long poll held', async () => {
    const desktop = new DesktopState({ read: () => theme('aaaaaa'), recheckMs: 60_000 });

    await withServer(desktop, async (running) => {
      const held = poll(running.url, desktop.current().seq);
      // Give the request a moment to actually land on the socket and start
      // waiting, rather than racing our own fetch call.
      await new Promise((done) => setTimeout(done, 50));

      const began = performance.now();
      // What `main.ts`'s SIGTERM handler does, in the order it does it.
      desktop.shutdown();
      await running.close();
      const elapsed = performance.now() - began;

      // Observed on `main`: 90 seconds, then a `SIGKILL`. This is the bound
      // the fix is for.
      expect(elapsed).toBeLessThan(500);

      // The poll was answered, not aborted: the window gets a real answer
      // and re-polls, rather than seeing its connection dropped.
      const response = await held;
      expect(response.status).toBe(200);
      const body = (await response.json()) as { seq: number };
      expect(body.seq).toBe(desktop.current().seq);
    });
  });

  it('answers a poll that reconnects mid-shutdown instead of hanging it', async () => {
    // The real window never stops polling on its own — it re-issues another
    // long poll the moment one answers (`use-desktop.ts`). This is that
    // race: a second poll lands on the same kept-alive connection after
    // `shutdown()` has already run.
    const desktop = new DesktopState({ read: () => theme('aaaaaa'), recheckMs: 60_000 });

    await withServer(desktop, async (running) => {
      // Stale on purpose (below whatever `seq` starts at), so this first
      // poll is answered at once — the same way a window's very first poll
      // always is — and is not itself the thing under test.
      const first = await poll(running.url, 0);
      expect(first.status).toBe(200);
      const seenSeq = ((await first.json()) as { seq: number }).seq;

      desktop.shutdown();

      const began = performance.now();
      const second = await poll(running.url, seenSeq);
      expect(performance.now() - began).toBeLessThan(500);
      expect(second.status).toBe(200);

      await running.close();
    });
  });
});
