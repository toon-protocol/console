import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { handleApi, type ApiDeps } from './api.js';
import { bearerToken, tokenMatches } from './launch-token.js';

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
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
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

  serveStatic(uiRoot, path, response);
}

function hostIsLoopback(header: string | undefined): boolean {
  if (!header) return false;
  const hostname = header.startsWith('[')
    ? header.slice(0, header.indexOf(']') + 1)
    : (header.split(':')[0] ?? '');
  return ALLOWED_HOSTNAMES.has(hostname);
}

function serveStatic(uiRoot: string, path: string, response: ServerResponse): void {
  const file = resolveWithin(uiRoot, path);
  // Anything that is not a file on disk is the SPA's own routing, so the shell
  // answers for it. A traversal attempt lands here too, which is the point.
  const target = file && existsSync(file) && statSync(file).isFile() ? file : join(uiRoot, 'index.html');
  if (!existsSync(target)) {
    sendJson(response, 404, { error: 'not_found', message: 'No such file.' });
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
