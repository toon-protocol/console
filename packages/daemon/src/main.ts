import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountSession } from './account-session.js';
import { defaultConnectorReader, readConnectorHealth } from './connector-health.js';
import { openKeystore } from './keystore-open.js';
import {
  mintLaunchToken,
  removeLaunchRecord,
  writeLaunchRecord,
  type LaunchRecord,
} from './launch-token.js';
import { activeProfileFilePath, consolePaths, launchFilePath } from './paths.js';
import { ProfileStore } from './profile-store.js';
import { startServer } from './server.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';
import { daemonVersion } from './version.js';

/**
 * `toon-console-daemon` — what `systemd --user` starts.
 *
 * It mints this launch's token, brings up the loopback server, and writes a
 * launch record the launcher script reads to find the window's URL. On the way
 * out it removes that record, so a stale URL never outlives the daemon that
 * could answer it.
 *
 * `TOON_CONSOLE_PORT` fixes the port (the systemd unit sets it, because a
 * desktop launcher wants a stable URL); `0` asks the kernel for a free one,
 * which is what the tests use.
 */

const DEFAULT_PORT = 7797;

export async function main(): Promise<void> {
  const paths = consolePaths();
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.config, { recursive: true });
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });

  const profiles = new ProfileStore(activeProfileFilePath(paths));
  const version = daemonVersion();
  const token = mintLaunchToken();
  const reader = defaultConnectorReader();

  // Probed once, here, so that the sign-in screen can say where a key would go
  // before anyone types one in (TOON_Network#88, ADR 0020).
  const keystore = await openKeystore(paths);
  const session = new AccountSession({
    keystore,
    signers: new SignerIndex(signerIndexPath(paths)),
    // The kind-0 fallback relay is the ACTIVE profile's, read each time rather
    // than captured: switching networks switches which relay a sign-in reads.
    relays: () => [profiles.active().relayUrl].filter((url) => url.length > 0),
  });

  const port = Number(process.env.TOON_CONSOLE_PORT ?? DEFAULT_PORT);
  const recordPath = launchFilePath(paths);

  // Before binding, not after: the launch record must exist only while a
  // daemon is actually listening. A record left behind by a crashed run would
  // otherwise send the launcher to a URL that answers nothing.
  removeLaunchRecord(recordPath);

  const running = await startServer({
    token,
    uiRoot: resolveUiRoot(),
    port,
    deps: {
      profiles,
      session,
      version,
      paths,
      startedAt: new Date(),
      readHealth: (profile, options) => readConnectorHealth(profile, reader, options),
    },
  }).catch((error: unknown) => {
    if (isAddressInUse(error)) {
      throw new Error(
        `port ${port} is already taken — another console is running, or something else holds it. ` +
          `Stop it (systemctl --user stop toon-console.service), or set TOON_CONSOLE_PORT.`
      );
    }
    throw error;
  });

  const record: LaunchRecord = {
    url: running.url,
    token,
    launchUrl: `${running.url}/?t=${encodeURIComponent(token)}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeLaunchRecord(recordPath, record);

  process.stdout.write(
    `${version.name} ${version.version} listening on ${running.url}\n` +
      `active profile: ${profiles.active().label}\n` +
      `keystore: ${keystore.location}\n` +
      `open: ${record.launchUrl}\n`
  );

  const shutdown = (signal: NodeJS.Signals) => {
    process.stdout.write(`\n${signal} — stopping\n`);
    removeLaunchRecord(recordPath);
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * The built UI, `TOON_CONSOLE_UI_ROOT` first so a packager can point at
 * wherever it installed the files. The default is the sibling `ui` package's
 * `dist`, which is where both the repo checkout and the npm workspace put it.
 */
function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

function resolveUiRoot(): string | undefined {
  const override = process.env.TOON_CONSOLE_UI_ROOT;
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'ui', 'dist');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
