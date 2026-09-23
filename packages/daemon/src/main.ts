import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountSession } from './account-session.js';
import { ChainSeedStore } from './chain-seed.js';
import { FileChainSeedCache } from './chain-seed-cache.js';
import { defaultConnectorReader, readConnectorHealth } from './connector-health.js';
import { readDirectory } from './directory.js';
import { FundingStore } from './funding.js';
import { LiveChainPort } from './funding-chain.js';
import { LeaseStore } from './lease.js';
import { LiveProviderPort } from './lease-route.js';
import { LeaseVault } from './lease-vault.js';
import { PaidRelayWriter } from './relay-write.js';
import { LiveRelayWritePort } from './relay-write-route.js';
import { FileLeaseVaultCache } from './lease-vault-cache.js';
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
import { readTemplates } from './templates.js';
import { daemonVersion } from './version.js';
import { AutoExtender, FileAutoExtendStore } from './auto-extend.js';
import { WorkloadStore } from './workload.js';
import { FileWorkloadNoteStore } from './workload-cache.js';

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

/**
 * How often every armed budget is looked at.
 *
 * A minute, against a Lease Interval measured in hours and a lead window of at
 * least sixty seconds, so a window is never missed by more than one tick. It
 * costs one free `status` per armed lease per minute at the provider — and
 * nothing at all for a lease with no budget, which is every lease until
 * somebody arms one.
 */
const AUTO_EXTEND_TICK_MS = 60_000;

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

  // The Chain Seed follows whoever is signed in: the store holds no key of its
  // own, asks the session for one each time, and drops everything when the
  // account changes (TOON_Network#89, ADR 0020).
  //
  // The seed and the writer need each other, and the cycle is the ticket's
  // subject rather than an accident of wiring: a relay write is paid for with
  // a key derived from the Chain Seed, and the Chain Seed's own record is one
  // of the things written (TOON_Network#120). The seed is given the writer as
  // a thunk, so whichever is constructed second is the one that exists by the
  // time either is used.
  const seedCache = new FileChainSeedCache(paths);
  const chainSeed: ChainSeedStore = new ChainSeedStore({
    signer: () => session.signingPort(),
    // The profile's relay is a SEED for discovery, not where a seed is kept:
    // the account's own NIP-65 write relays are, when it has named any.
    seedRelays: () => [profiles.active().relayUrl].filter((url) => url.length > 0),
    cache: seedCache,
    writer: () => writer,
  });

  // The one writer. Every event this console puts on a relay is bought here,
  // as a paid TOON packet on the route the connector publishes, over the
  // carriage that route pins (TOON_Network#120).
  const writer: PaidRelayWriter = new PaidRelayWriter({
    profile: () => profiles.active(),
    readHealth: (profile) => readConnectorHealth(profile, reader),
    payerKeys: (use) => chainSeed.usePayerKeys(use),
    paths,
    port: new LiveRelayWritePort(),
  });

  /**
   * Where to START looking for an account's own records.
   *
   * The network profile's relay, plus every relay this console has already
   * seen this account on. The second half matters and is easy to miss: on
   * every TOON network the profile's relay is a TOON relay, which charges for
   * writes — so an account that published a NIP-65 list at all published it
   * somewhere ELSE, and a console that only ever asked the profile's relay
   * would never find that list again after a restart. The Chain Seed's cache
   * is where those relays are already remembered (#89), and it is the right
   * place for them: a Chain Seed is published before anything can be spawned,
   * so by the time there is a lease to vault, that list has been written.
   */
  const accountRelays = () => {
    const pubkey = session.signingPort()?.pubkey;
    return [
      profiles.active().relayUrl,
      ...(pubkey === undefined ? [] : (seedCache.read(pubkey)?.relays ?? [])),
    ].filter((url) => url.length > 0);
  };

  // Funding follows the ACTIVE PROFILE and the signed-in account together: a
  // deposit address is the account's, a channel is the profile's, and neither
  // means anything without the other (TOON_Network#90).
  const funding = new FundingStore({
    profile: () => profiles.active(),
    chainSeed,
    readHealth: (profile) => readConnectorHealth(profile, reader),
    chains: new LiveChainPort(),
    paths,
  });

  // The Lease Vault follows the account, exactly as the Chain Seed does: one
  // sealed record per lease on the account's own relays, with a local cache
  // (TOON_Network#92, ADR 0021). The records it finds belong to the ACCOUNT
  // and not to the network — each one says which network its lease was bought
  // on — so the only thing the profile contributes is somewhere to start
  // looking.
  const vault = new LeaseVault({
    signer: () => session.signingPort(),
    seedRelays: accountRelays,
    cache: new FileLeaseVaultCache(paths),
    writer,
  });

  // Spawning: the first route this console pays somebody else for
  // (TOON_Network#92). It reads the directory for the provider's Profile and
  // its Listing, the connectors for who collects, and the account's own
  // channel store for what pays.
  const leases = new LeaseStore({
    profile: () => profiles.active(),
    vault,
    chainSeed,
    readHealth: (profile) => readConnectorHealth(profile, reader),
    readDirectory: (profile) => readDirectory({ profile }),
    provider: new LiveProviderPort(),
    paths,
  });

  // The dashboard: the module a person lives in after a spawn
  // (TOON_Network#93). It shares the provider port with the spawn above —
  // `status`, `extend` and `terminate` are the same kind of packet on the same
  // kind of route — and takes its own note store, which caches nothing but the
  // answers to a FREE read (§6.5) so that a card opens with what it knew and
  // an ending survives the provider's own sweep.
  const notes = new FileWorkloadNoteStore(paths);
  const workloads = new WorkloadStore({
    profile: () => profiles.active(),
    vault,
    chainSeed,
    readHealth: (profile) => readConnectorHealth(profile, reader),
    readDirectory: (profile) => readDirectory({ profile }),
    provider: new LiveProviderPort(),
    paths,
    notes,
    autoExtend: () => budgets,
  });

  // Budgets: the one thing here that spends with nobody present. It is armed
  // per lease, never by default, and `auto-extend.ts` lists the nine rules
  // that can each stop it on its own.
  const budgets: AutoExtender = new AutoExtender({
    store: new FileAutoExtendStore(paths),
    workloads,
    pubkey: () => session.signingPort()?.pubkey,
    profileId: () => profiles.active().id,
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
      chainSeed,
      funding,
      vault,
      leases,
      version,
      paths,
      startedAt: new Date(),
      readHealth: (profile, options) => readConnectorHealth(profile, reader, options),
      readDirectory: (profile, filters) => readDirectory({ profile, filters }),
      readTemplates: (profile) => readTemplates({ profile }),
      // The seam #94 left: a Template is expanded into a §6.2 content there,
      // and bought here. Both paths end at the same `buildSpawnContent` and
      // then at the same `LeaseStore`, so "spawning from a Template produces
      // the same result as the equivalent manual spawn" is true by
      // construction rather than by two builders agreeing.
      spawnFromTemplate: (request) => leases.spawnFromTemplate(request),
      workloads,
      autoExtend: budgets,
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

  // Every armed budget, once a minute. `unref` so a tick never keeps the
  // process alive: a daemon that has been asked to stop must stop, and a lease
  // that missed one minute's window catches it on the next.
  const ticker = setInterval(() => {
    void budgets.tick().catch((error: unknown) => {
      process.stderr.write(
        `automatic extension: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  }, AUTO_EXTEND_TICK_MS);
  ticker.unref();

  const shutdown = (signal: NodeJS.Signals) => {
    clearInterval(ticker);
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
