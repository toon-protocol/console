import { deriveFullIdentity, validateMnemonic } from '@toon-protocol/client';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import type { EventTemplate } from 'nostr-tools/core';

import { accountKeyFromMnemonic, accountKeyFromNsec, wipe } from './account-key.js';
import { defaultConnectorReader, readConnectorHealth } from './connector-health.js';
import { ARTICLE_KIND, currentArticles, docsAuthorNpub } from './docs-article.js';
import { loadDocs } from './docs-content.js';
import {
  planPublication,
  publishDocs,
  verifyPublication,
  type DocsPublishReport,
} from './docs-publish.js';
import type { NostrEvent } from './nostr.js';
import { consolePaths } from './paths.js';
import { BUILT_IN_PROFILES, DEVNET, type NetworkProfile } from './profiles.js';
import { queryRelays } from './relay-pool.js';
import { PaidRelayWriter } from './relay-write.js';
import { LiveRelayWritePort } from './relay-write-route.js';

/**
 * `toon-docs-publish` — the documentation's publisher (TOON_Network#102).
 *
 * A **separate program from the console daemon on purpose**, sharing its code
 * and none of its identity. The daemon signs as whoever is signed in and pays
 * from that Account's channel; this signs as TOON Network's documentation key
 * and pays from the project's own channel. Running it is a release step, a
 * human decision, and it spends money each time — so it is a command somebody
 * types, never something a daemon does on a timer.
 *
 * What it shares is the part that must not be re-implemented: `PaidRelayWriter`
 * and `LiveRelayWritePort`, the console's one paid-write path (#120). Every
 * article leaves here as a sealed TOON packet against an open payment channel,
 * on the route the connector publishes, over the carriage that route pins.
 * There is no plain-websocket fallback anywhere in this file.
 *
 * ## Keys, and what this refuses to touch
 *
 * Two keys, deliberately different, neither generated here except on an
 * explicit `--new-key`:
 *
 * - `TOON_DOCS_NSEC` (or `TOON_DOCS_MNEMONIC`) — the **Nostr key the articles
 *   are signed with**. This is the identity readers subscribe to.
 * - `TOON_DOCS_PAYER_MNEMONIC` — the BIP-39 phrase the **payer keys** are
 *   derived from, whose channel pays for each write.
 *
 * They are separate for the same reason an Account's Chain Seed is not derived
 * from its Nostr key (ADR 0020): a signer that never reveals a key cannot be
 * turned into a wallet, and a wallet that leaks should not cost an identity.
 *
 * It reads no key belonging to any deployed box and has no route that could.
 * There is no provider or settlement key path here, and nothing that opens a
 * channel: `autoOpenChannel` is false in the live port, so an unfunded run
 * refuses with somewhere to go instead of locking collateral on chain.
 */

interface Args {
  readonly profile: NetworkProfile;
  readonly only: string[];
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly verifyOnly: boolean;
  readonly newKey: boolean;
  readonly json: boolean;
}

const USAGE = `toon-docs-publish — publish docs/ as NIP-23 articles (kind 30023)

  --profile <id>       devnet (default), sandbox, or another built-in id
  --connector <url>    override the profile's connector edge
  --relay <url>        override the profile's relay
  --only <d>           one page, repeatable (e.g. --only concepts)
  --force              re-publish pages whose article already matches
  --dry-run            print the plan and spend nothing
  --verify             read the articles back and check each \`d\` replaced
  --new-key            mint a documentation key, print it once, and exit
  --json               machine-readable output on stdout

  TOON_DOCS_NSEC / TOON_DOCS_MNEMONIC   the key the ARTICLES are signed with
  TOON_DOCS_PAYER_MNEMONIC              the phrase the PAYER keys come from
  TOON_CONSOLE_DOCS_DIR                 where the Markdown is (default: docs/)

Every write is a paid TOON packet. A refused one is still billed (ADR 0003).`;

class UsageRequested extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  let profile = DEVNET;
  let connector: string | undefined;
  let relay: string | undefined;
  const only: string[] = [];
  let force = false;
  let dryRun = false;
  let verifyOnly = false;
  let newKey = false;
  let json = false;

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    switch (flag) {
      case '--profile': {
        const found = BUILT_IN_PROFILES.find((candidate) => candidate.id === value);
        if (found === undefined) {
          throw new Error(
            `No profile “${value ?? ''}”. Known: ` +
              `${BUILT_IN_PROFILES.map((candidate) => candidate.id).join(', ')}.`
          );
        }
        profile = found;
        at += 1;
        break;
      }
      case '--connector':
        connector = value;
        at += 1;
        break;
      case '--relay':
        relay = value;
        at += 1;
        break;
      case '--only':
        if (value !== undefined) only.push(value);
        at += 1;
        break;
      case '--force':
        force = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--verify':
        verifyOnly = true;
        break;
      case '--new-key':
        newKey = true;
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        throw new UsageRequested();
      default:
        throw new Error(`Unknown argument “${flag ?? ''}”.\n\n${USAGE}`);
    }
  }

  return {
    profile: {
      ...profile,
      ...(connector === undefined ? {} : { connectorUrl: connector }),
      ...(relay === undefined ? {} : { relayUrl: relay }),
    },
    only,
    force,
    dryRun,
    verifyOnly,
    newKey,
    json,
  };
}

/**
 * The documentation key, from whichever spelling the environment holds.
 *
 * `accountKeyFromNsec` and `accountKeyFromMnemonic` are the console's own —
 * the same two paths that import a key into the local keystore (#88) — so a
 * key that works in the console works here, and neither of them accepts a
 * public key by mistake.
 */
export function docsKey(env: NodeJS.ProcessEnv): { pubkey: string; secretKey: Uint8Array } {
  const nsec = env['TOON_DOCS_NSEC'];
  if (nsec) {
    const key = accountKeyFromNsec(nsec);
    return { pubkey: key.pubkey, secretKey: key.secretKey };
  }
  const mnemonic = env['TOON_DOCS_MNEMONIC'];
  if (mnemonic) {
    const key = accountKeyFromMnemonic(mnemonic);
    return { pubkey: key.pubkey, secretKey: key.secretKey };
  }
  throw new Error(
    'No documentation key. Set TOON_DOCS_NSEC (or TOON_DOCS_MNEMONIC) to the key the ' +
      'articles are signed with, or run with --new-key to mint one.'
  );
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageRequested) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    throw error;
  }

  if (args.newKey) {
    // Printed once, to stdout, held nowhere: this writes no file and no
    // keyring entry. Whoever runs it puts the nsec somewhere that survives,
    // and never in this repository.
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    process.stdout.write(
      'A new documentation key. It is printed ONCE and stored nowhere.\n\n' +
        `  npub: ${npubEncode(pubkey)}\n` +
        `  nsec: ${nsecEncode(secretKey)}\n\n` +
        'Put the nsec in a password manager and set TOON_DOCS_NSEC to it when publishing.\n' +
        "Set TOON_CONSOLE_DOCS_NPUB, and the site's site-config.json, to the npub.\n"
    );
    wipe(secretKey);
    return 0;
  }

  const docs = loadDocs();
  const key = docsKey(env);
  const relays = [args.profile.relayUrl].filter((url) => url.length > 0);
  if (relays.length === 0) {
    wipe(key.secretKey);
    process.stderr.write(
      `The “${args.profile.label}” profile names no relay. Pass --relay.\n`
    );
    return 2;
  }

  const readArticles = async (): Promise<readonly NostrEvent[]> =>
    (
      await queryRelays({
        relays,
        filters: [{ kinds: [ARTICLE_KIND], authors: [key.pubkey] }],
      })
    ).events;

  if (args.verifyOnly) {
    const checks = verifyPublication(docs, await readArticles(), key.pubkey);
    wipe(key.secretKey);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ npub: docsAuthorNpub(key.pubkey), checks }, null, 2)}\n`
      );
    } else {
      for (const check of checks) {
        process.stdout.write(
          `${check.matches ? 'ok  ' : 'BAD '} ${check.address}  ` +
            `${check.events} event(s) at this address` +
            `${check.problem === undefined ? '' : ` — ${check.problem}`}\n`
        );
      }
    }
    return checks.every((check) => check.matches) ? 0 : 1;
  }

  if (args.dryRun) {
    const held = new Map(
      [...currentArticles(await readArticles(), key.pubkey)].map(([d, entry]) => [
        d,
        entry.article,
      ])
    );
    const plan = planPublication(docs, held, key.pubkey, {
      only: args.only,
      force: args.force,
    });
    wipe(key.secretKey);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      `Publishing as ${docsAuthorNpub(key.pubkey)} to ${relays.join(', ')}\n\n`
    );
    for (const entry of plan.entries) {
      process.stdout.write(
        `  ${entry.state.padEnd(9)} ${entry.d.padEnd(18)} ${entry.reason}\n`
      );
    }
    process.stdout.write(
      `\n${plan.writes.length} paid write(s) would be bought. Nothing was sent.\n`
    );
    return 0;
  }

  const payer = env['TOON_DOCS_PAYER_MNEMONIC'];
  if (!payer || !validateMnemonic(payer)) {
    wipe(key.secretKey);
    process.stderr.write(
      'TOON_DOCS_PAYER_MNEMONIC must be a valid BIP-39 phrase: every relay write is a paid ' +
        'TOON packet, and this is the phrase the payer keys come from. Its channel must ' +
        'already be open — this tool never opens one.\n'
    );
    return 2;
  }

  const reader = defaultConnectorReader();
  const writer = new PaidRelayWriter({
    profile: () => args.profile,
    readHealth: (profile) => readConnectorHealth(profile, reader),
    // A relay names its own paid write edge now (#121), and that edge is
    // routinely a connector other than the profile's. This publisher writes
    // its articles to the one relay it was pointed at, so the only connector
    // this ever reaches is the one that relay itself named.
    readHealthAt: (connectorUrl) =>
      readConnectorHealth({ ...args.profile, connectorUrl }, reader),
    // Derived inside the borrow and wiped when it returns, exactly as the
    // daemon's `usePayerKeys` does it (ADR 0020). Nothing holds a key between
    // packets.
    payerKeys: async (use) => {
      const identity = deriveFullIdentity(payer, { accountIndex: 0 });
      try {
        return await use(identity);
      } finally {
        identity.evm.privateKey.fill(0);
        identity.solana.secretKey.fill(0);
      }
    },
    paths: consolePaths(env),
    port: new LiveRelayWritePort(),
  });

  const targets = await writer.targets();
  if (!targets.ready) {
    wipe(key.secretKey);
    process.stderr.write(`Nothing can be published: ${targets.blockedBy ?? 'unknown'}\n`);
    return 3;
  }
  process.stdout.write(
    `Publishing as ${docsAuthorNpub(key.pubkey)}\n` +
      targets.plan
        .map((entry) =>
          entry.ready
            ? `  ${entry.url}\n` +
              `      ${entry.destination} at ${entry.price} base units per write, ` +
              `paid at ${entry.payAt} on ${entry.chain} (channel ${entry.channelId})\n`
            : `  ${entry.url}\n      NOT PAYABLE (${entry.code}): ${entry.reason}\n`
        )
        .join('') +
      `  ${targets.totalPrice ?? targets.price} base units per event, across ` +
      `${targets.relays.length} relay(s)\n\n`
  );

  let report: DocsPublishReport;
  try {
    report = await publishDocs(
      docs,
      {
        pubkey: key.pubkey,
        sign: (template: EventTemplate) =>
          Promise.resolve(finalizeEvent(template, key.secretKey) as NostrEvent),
        writer,
        readArticles,
      },
      { only: args.only, force: args.force }
    );
  } finally {
    wipe(key.secretKey);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const outcome of report.outcomes) {
      process.stdout.write(
        `  ${outcome.state.padEnd(8)} ${outcome.address}` +
          `${outcome.cost === undefined ? '' : `  ${outcome.cost} base units`}` +
          `${outcome.reason === undefined ? '' : `\n           ${outcome.reason}`}\n`
      );
    }
    process.stdout.write(
      `\n${report.written} written, ${report.skipped} unchanged, ${report.failed} failed. ` +
        `Total cost ${report.cost} base units.\n` +
        (report.written > 0
          ? 'Run again with --verify to check that each `d` tag REPLACED its article.\n'
          : '')
    );
  }
  return report.failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    }
  );
}
