import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { handleApi, type ApiDeps } from './api.js';
import { bearerToken, tokenMatches } from './launch-token.js';
import { THEME_STYLE_ID } from './theme.js';

/**
 * The daemon's HTTP surface: the UI's files and the local JSON API, on
 * loopback and nowhere else.
 *
 * Three guards, each for a different attacker:
 *
 * - The listener binds `127.0.0.1`, so nothing off this machine can open the
 *   socket at all.
 * - Every `/api/*` request carries the per-launch bearer token, so nothing
 *   ELSE on this machine — a page in another tab, another user's process —
 *   can drive the console.
 * - The `Host` header must name loopback. Without this, a hostile page could
 *   point a name it controls at `127.0.0.1` (DNS rebinding) and talk to the
 *   daemon from the browser as same-origin. It cannot read the token that way,
 *   but the check is one line and closes the class.
 *
 * The UI's own files are served WITHOUT the token, and that is not an
 * oversight: they are a public build with nothing in them, the browser cannot
 * put a header on its first navigation, and the token has to reach the page
 * somehow. It arrives once, as `?t=…` on the launch URL, and the page moves it
 * straight out of the address bar.
 */

export interface ServerOptions {
  readonly deps: ApiDeps;
  readonly token: string;
  /** The built UI to serve. When absent, the daemon still serves its API. */
  readonly uiRoot?: string | undefined;
  /**
   * This machine's theme, as a `:root` rule, put into the shell so that the
   * first paint is already the desktop's colours (TOON_Network#99). Read on
   * each navigation rather than captured: a theme set while the window was
   * closed is the theme the next one opens with.
   */
  readonly themeCss?: (() => string) | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

export interface RunningServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const uiRoot = options.uiRoot ? resolve(options.uiRoot) : undefined;

  const server = createServer((request, response) => {
    void route(options, uiRoot, request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.removeListener('error', fail);
      done();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${boundPort}`;

  return {
    server,
    url,
    port: boundPort,
    // `server.close()` stops accepting new connections but waits for every
    // one it already has — and a keep-alive socket does not end just because
    // its current response did: Node leaves it open, idle, for the caller to
    // reuse. `/api/desktop`'s long poll answers itself on shutdown (see
    // `desktop.ts`'s `shutdown()`), which lets the response finish, but the
    // now-idle socket underneath it is still there, and the window on the
    // other end may already be reconnecting it for another poll before we
    // get to this. `closeIdleConnections()` drops anything with no request
    // actually in flight; it never touches a socket mid-write, so an ordinary
    // API call — the one this daemon must let finish — is never cut off
    // (TOON_Network#128). Swept once immediately and then on a short tick
    // until `close()` itself reports done, so a reconnect racing the first
    // sweep is caught by the next one instead of outliving it.
    close: () =>
      new Promise<void>((done, fail) => {
        const sweep = setInterval(() => server.closeIdleConnections(), 10);
        server.close((error) => {
          clearInterval(sweep);
          if (error) fail(error);
          else done();
        });
        server.closeIdleConnections();
      }),
  };
}

async function route(
  options: ServerOptions,
  uiRoot: string | undefined,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!hostIsLoopback(request.headers.host)) {
    sendJson(response, 403, {
      error: 'bad_host',
      message: 'The console answers on loopback names only.',
    });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    if (!tokenMatches(options.token, bearerToken(request.headers.authorization))) {
      sendJson(response, 401, {
        error: 'unauthorized',
        message: 'This launch of the console expects its own token.',
      });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, {
        error: 'invalid_json',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const answer = await handleApi(options.deps, {
      method: request.method ?? 'GET',
      path,
      query: url.searchParams,
      body,
    });
    sendJson(response, answer.status, answer.body);
    return;
  }

  if (!uiRoot) {
    sendJson(response, 404, {
      error: 'no_ui',
      message: 'This daemon was started without a built UI. Run `npm run build` first.',
    });
    return;
  }

  serveStatic(uiRoot, path, response, options.themeCss);
}

function hostIsLoopback(header: string | undefined): boolean {
  if (!header) return false;
  const hostname = header.startsWith('[')
    ? header.slice(0, header.indexOf(']') + 1)
    : (header.split(':')[0] ?? '');
  return ALLOWED_HOSTNAMES.has(hostname);
}

function serveStatic(
  uiRoot: string,
  path: string,
  response: ServerResponse,
  themeCss: (() => string) | undefined
): void {
  const file = resolveWithin(uiRoot, path);
  // Anything that is not a file on disk is the SPA's own routing, so the shell
  // answers for it. A traversal attempt lands here too, which is the point.
  const target =
    file && existsSync(file) && statSync(file).isFile() ? file : join(uiRoot, 'index.html');
  if (!existsSync(target)) {
    sendJson(response, 404, { error: 'not_found', message: 'No such file.' });
    return;
  }
  if (target.endsWith('index.html') && themeCss !== undefined) {
    sendIndex(target, themeCss(), response);
    return;
  }
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    // The shell must never be cached: it carries the script hashes for a build
    // that changes whenever the daemon is updated underneath it.
    'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(target).pipe(response);
}

/**
 * The shell, with this machine's theme already in it (TOON_Network#99).
 *
 * The UI ships no colours at all, so a window that painted before its first
 * `/api/desktop` answered would flash white on a dark desktop. Putting the
 * `:root` rule into the document that carries the script removes the gap
 * entirely: the first paint is already themed. The window still watches
 * `/api/desktop` afterwards, and replaces this rule whenever the theme moves.
 *
 * The rule is built by `theme.ts` out of properties it recognises and values
 * it has checked, so nothing a theme file contains can become markup here.
 */
function sendIndex(target: string, themeCss: string, response: ServerResponse): void {
  const html = readFileSync(target, 'utf8').replace(
    '</head>',
    `  <style id="${THEME_STYLE_ID}">\n${themeCss}  </style>\n  </head>`
  );
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}

function resolveWithin(root: string, path: string): string | undefined {
  const candidate = resolve(join(root, normalize(path)));
  return candidate === root || candidate.startsWith(root + sep) ? candidate : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}
