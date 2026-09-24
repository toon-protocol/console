// Runs the REAL `bin/toon-console`, end to end, for the fallback chain the
// static-text checks in packaging.test.mjs cannot see: which of
// omarchy-launch-or-focus-tui, omarchy-launch-or-focus-webapp,
// xdg-terminal-exec and $TERMINAL actually gets called for each argument
// combination, and in what order relative to `post_api /api/desktop/view`.
//
// Nothing here can reach the person's real desktop or session. `command -v`
// in bash resolves against PATH, and every PATH this file builds is exactly
// one stub directory plus the directory holding the `node` binary the
// launcher itself needs (for read_launch_url and post_api) — never
// `process.env.PATH`, so a command this file did not stub (systemctl,
// omarchy-launch-or-focus-tui, xdg-terminal-exec, xdg-open, a real terminal)
// is a command the launcher simply cannot find, full stop. That is what
// makes "the launcher never opened the real web-app path" or "the launcher
// never touched systemd" a fact the test enforces rather than a hope — the
// same incident packaging.test.mjs's own sandboxEnv exists to prevent
// (console#20: a packaging test once left the desktop's own service
// `inactive` and `disabled`).

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(here, 'bin', 'toon-console');

// Resolved once, outside any sandbox: the launcher script itself is run by
// handing bash its path directly, so finding bash never depends on the
// hermetic PATH built below.
const BASH_BIN = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
// The directory holding the `node` this test (and the launcher's own
// read_launch_url/post_api) is running under. Using only this directory,
// rather than the rest of the real PATH, is what keeps /usr/bin — where
// omarchy-launch-or-focus-tui, omarchy-launch-or-focus-webapp and
// xdg-terminal-exec actually live on an Omarchy machine — out of every
// sandbox below unless a test puts a stub of its own there instead.
const NODE_DIR = dirname(process.execPath);

/**
 * A throwaway `$XDG_RUNTIME_DIR/toon-console` plus a throwaway PATH with
 * nothing on it but this test's own stub commands and `node`. `stub(name)`
 * adds one command that records the arguments it was called with and exits
 * 0 without doing anything real; a command a test never stubs is simply
 * absent, which is how the "no Omarchy" tests below prove the launcher
 * never even tried the Omarchy-only path.
 */
function launcherSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'toon-launcher-'));
  const stubDir = join(dir, 'stub-bin');
  mkdirSync(stubDir, { recursive: true });
  const runtimeDir = join(dir, 'runtime');
  const launchDir = join(runtimeDir, 'toon-console');
  mkdirSync(launchDir, { recursive: true });

  function stub(name) {
    const log = join(stubDir, `${name}.log`);
    writeFileSync(
      join(stubDir, name),
      `#!/bin/bash\nprintf '%s\\n' "$*" >>${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 }
    );
    return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  }

  function writeLaunchRecord(url = 'http://127.0.0.1:1') {
    writeFileSync(
      join(launchDir, 'launch.json'),
      JSON.stringify({
        url,
        token: 'test-token',
        launchUrl: `${url}/?t=test-token`,
        pid: 1,
        startedAt: '2026-09-24T00:00:00.000Z',
      })
    );
  }

  // Async on purpose, via the promise-returning `execFile` rather than
  // `execFileSync`: the one test below that has the launcher reach a real
  // HTTP server hosts that server IN THIS SAME node process, and a *Sync
  // spawn blocks this process's one event loop for as long as the child
  // runs -- which would starve the very server the child is trying to
  // reach and make every request to it time out. `execFile` keeps the loop
  // free to accept and answer that request while the child runs.
  function run(args, extraEnv = {}) {
    return execFileAsync(BASH_BIN, [LAUNCHER, ...args], {
      env: { PATH: `${stubDir}:${NODE_DIR}`, XDG_RUNTIME_DIR: runtimeDir, ...extraEnv },
      encoding: 'utf8',
      timeout: 10_000,
    });
  }

  return { dir, stub, writeLaunchRecord, run };
}

function cleanup(sandbox) {
  rmSync(sandbox.dir, { recursive: true, force: true });
}

/** A tiny real HTTP server, for the one test that has to see what post_api
 * actually sent (POST /api/desktop/view) rather than just that SOMETHING
 * was called. */
function startStubDaemon() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"seq":1}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('with no arguments, the launcher opens the tui and never touches the real service', async () => {
  const sandbox = launcherSandbox();
  try {
    const tui = sandbox.stub('omarchy-launch-or-focus-tui');
    const systemctl = sandbox.stub('systemctl');
    sandbox.writeLaunchRecord();

    await sandbox.run([]);

    assert.deepEqual(tui(), ['--app-id=org.toon.console toon-console-tui']);
    // `is-active` reports the unit already running (every stub call exits 0),
    // so ensure_daemon never calls start or restart at all -- the one thing
    // this whole file exists to make structurally impossible to skip.
    const calls = systemctl();
    assert.ok(calls.length > 0, 'systemctl was never even asked whether the daemon was running');
    for (const call of calls) {
      assert.doesNotMatch(call, /\b(start|restart|stop|disable|enable)\b/);
    }
  } finally {
    cleanup(sandbox);
  }
});

test('--web opens the browser web app, never the tui', async () => {
  const sandbox = launcherSandbox();
  try {
    const webapp = sandbox.stub('omarchy-launch-or-focus-webapp');
    sandbox.stub('systemctl');
    sandbox.writeLaunchRecord('http://127.0.0.1:1');

    await sandbox.run(['--web']);

    const calls = webapp();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^TOON Console http:\/\/127\.0\.0\.1:1\/\?t=test-token$/);
    // omarchy-launch-or-focus-tui was never stubbed, so if `--web` had somehow
    // fallen through to the tui path this would already have failed loudly
    // with "command not found" rather than silently passing.
  } finally {
    cleanup(sandbox);
  }
});

test('--view posts the view to the daemon before it opens the tui, and never opens the web app', async () => {
  const daemon = await startStubDaemon();
  const sandbox = launcherSandbox();
  try {
    const tui = sandbox.stub('omarchy-launch-or-focus-tui');
    sandbox.stub('systemctl');
    sandbox.writeLaunchRecord(daemon.url);

    await sandbox.run(['--view', 'funds']);

    assert.deepEqual(tui(), ['--app-id=org.toon.console toon-console-tui']);
    const posted = daemon.requests.find((r) => r.url === '/api/desktop/view');
    assert.ok(posted, 'no POST /api/desktop/view reached the daemon');
    assert.equal(posted.method, 'POST');
    assert.equal(posted.headers.authorization, 'Bearer test-token');
    assert.equal(posted.body, '{"view":"funds"}');
  } finally {
    await daemon.close();
    cleanup(sandbox);
  }
});

test('an unknown view is refused before the daemon is ever touched', async () => {
  const sandbox = launcherSandbox();
  try {
    const systemctl = sandbox.stub('systemctl');
    sandbox.stub('omarchy-launch-or-focus-tui');
    sandbox.writeLaunchRecord();

    await assert.rejects(() => sandbox.run(['--view', 'not-a-real-view']));
    assert.deepEqual(systemctl(), [], 'an invalid --view must be refused before ensure_daemon runs');
  } finally {
    cleanup(sandbox);
  }
});

test('off Omarchy, the launcher opens the tui through xdg-terminal-exec', async () => {
  const sandbox = launcherSandbox();
  try {
    // omarchy-launch-or-focus-tui is deliberately never stubbed: this PATH
    // has nothing Omarchy on it at all.
    const term = sandbox.stub('xdg-terminal-exec');
    sandbox.stub('systemctl');
    sandbox.writeLaunchRecord();

    await sandbox.run([]);

    assert.deepEqual(term(), ['-- toon-console-tui']);
  } finally {
    cleanup(sandbox);
  }
});

test('off Omarchy with no xdg-terminal-exec either, the launcher falls back to $TERMINAL', async () => {
  const sandbox = launcherSandbox();
  try {
    const myTerminal = sandbox.stub('my-terminal');
    sandbox.stub('systemctl');
    sandbox.writeLaunchRecord();

    // $TERMINAL is a full path here on purpose, the way a real shell
    // profile would set it, so bash's `exec "$TERMINAL"` never falls back to
    // a PATH lookup of its own.
    const terminalBin = join(sandbox.dir, 'stub-bin', 'my-terminal');
    await sandbox.run([], { TERMINAL: terminalBin });

    assert.deepEqual(myTerminal(), ['-e toon-console-tui']);
  } finally {
    cleanup(sandbox);
  }
});

test('off Omarchy with no terminal launcher at all, the launcher fails loudly', async () => {
  const sandbox = launcherSandbox();
  try {
    sandbox.stub('systemctl');
    sandbox.writeLaunchRecord();

    await assert.rejects(
      () => sandbox.run([]),
      /no omarchy-launch-or-focus-tui, no xdg-terminal-exec/
    );
  } finally {
    cleanup(sandbox);
  }
});

test('--theme-changed never starts the daemon and never opens a window', async () => {
  const sandbox = launcherSandbox();
  try {
    const systemctl = sandbox.stub('systemctl');
    // No tui or webapp launcher stubbed at all: this must never reach either.
    sandbox.writeLaunchRecord();

    await sandbox.run(['--theme-changed']);

    assert.deepEqual(systemctl(), [], 'the theme hook must never call systemctl');
  } finally {
    cleanup(sandbox);
  }
});
