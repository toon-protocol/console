import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { deriveFullIdentity, validateMnemonic } from '@toon-protocol/client';
import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate } from 'nostr-tools/core';

import { accountKeyFromMnemonic, accountKeyFromNsec, wipe } from './account-key.js';
import { defaultConnectorReader, readConnectorHealth } from './connector-health.js';
import type { NostrEvent } from './nostr.js';
import { consolePaths } from './paths.js';
import { BUILT_IN_PROFILES, SANDBOX, type NetworkProfile } from './profiles.js';
import { PaidRelayWriter, type RelayWriteTargets } from './relay-write.js';
import { LiveRelayWritePort } from './relay-write-route.js';
import {
  planTemplatePublish,
  publishTemplatePlan,
  readTemplateInputFile,
  resolveOciEntry,
  type TemplatePublishPlan,
} from './template-publish.js';

/**
 * `toon-template-publish` — publish an Image Registry entry and a Template
 * for a workload image (TOON_Network#138).
 *
 * **Most people should reach for the console's own "Publish a Template"
 * action first** (New workload's Gallery, `p`) rather than this CLI: it
 * publishes AS whoever is signed in, paying from that account's own relay
 * channel, with no key ever leaving the daemon — the same way the Chain Seed
 * publishes. This tool exists for the case the console cannot cover: signing
 * with a key that has never been (and will never be) imported into a
 * console session, e.g. a CI job or a key held only as `TOON_TEMPLATE_NSEC`.
 * If the account publishing a Template was generated inside the console, it
 * holds neither an nsec nor a Chain Seed mnemonic to hand this tool, and the
 * console action is the only way to publish as it.
 *
 * ```
 * npm run template:publish -- --file images/ssh-box/template.json \
 *   --image ghcr.io/toon-protocol/ssh-box@sha256:… --dry-run
 * ```
 *
 * **A separate program from the console daemon, on the same reasoning
 * `toon-docs-publish` already sets out** (`main-docs-publish.ts`): the daemon
 * signs as whoever is signed in on this machine and pays from that Account's
 * open channel, and it exposes no route that signs or sends an ARBITRARY
 * event — `POST /api/account/sign` signs one for the signed-in session, but
 * there is no route that then pays a relay for it, because `relay-write.ts`
 * ("the only writer", per the console's house rules) is a `PaidRelayWriter`
 * built with a payer's raw chain keys, which a session route has no way to
 * hand over without doing the one thing ADR 0020 forbids: a private key
 * leaving the daemon. So this tool never talks to a running daemon at all —
 * not on port 7797, not its keystore, not its keyring — and instead builds
 * its own `PaidRelayWriter`, exactly as `toon-docs-publish` already does for
 * the documentation's own key, taking its Nostr key from `TOON_TEMPLATE_NSEC`
 * / `TOON_TEMPLATE_MNEMONIC` and its payer keys from
 * `TOON_TEMPLATE_PAYER_MNEMONIC`. Running it is a human decision and it
 * spends real money (two paid relay writes) each time it is NOT run with
 * `--dry-run`.
 *
 * **`--dry-run` sends nothing and asks for nothing to be sent.** It builds
 * the exact two events a real publish would sign (`template-publish.ts`'s
 * `planTemplatePublish` — the SAME function a real run calls, so dry and
 * real can never disagree about what would be published) and prints them in
 * full. For the price, it reads the target relay's connector over
 * `GET /ilp` (`RelayWriter.targets()` — the same free, unauthenticated
 * self-description `toon-docs-publish` prints before it spends, and a read
 * and not a payment: nothing here probes the network with an actual ILP
 * packet). Without `--dry-run`, it asks for typed confirmation unless
 * `--yes` is given.
 */

interface Args {
  readonly file: string;
  readonly image: string;
  readonly arch: string;
  readonly relay?: string | undefined;
  readonly profile: NetworkProfile;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly json: boolean;
}

const USAGE = `toon-template-publish — publish an Image Registry entry (30434) and a
Template (30436) for a workload image

Prefer the console's own "Publish a Template" action first (New workload's
Gallery, p): it signs and pays as the signed-in account, with no key ever
leaving the daemon. Reach for this CLI only for a key the console does not
(and for a console-generated account, cannot) hold — it has no nsec or Chain
Seed mnemonic to give this tool.

  --file <path>        the Template's template.json (required)
  --image <ref>         the image, by digest: registry/repo@sha256:… (required)
  --arch <arch>         which platform manifest to resolve (default: amd64)
  --relay <url>          the registry_entry relay hint the Template carries
  --profile <id>         sandbox (default), devnet, or another built-in id
  --dry-run              print the exact events and the quoted price; send nothing
  --yes                  skip the confirmation prompt (only without --dry-run)
  --json                 machine-readable output on stdout
  --help                 this text

  TOON_TEMPLATE_NSEC / TOON_TEMPLATE_MNEMONIC   the key the EVENTS are signed with
  TOON_TEMPLATE_PAYER_MNEMONIC                  the phrase the PAYER keys come from
                                                 (unused, and never read, with --dry-run)

Every write is a paid TOON packet. A refused one is still billed (ADR 0003).
This tool never touches a running console daemon, its keystore or its keyring.`;

class UsageRequested extends Error {}

export function parseArgs(argv: readonly string[]): Args {
  let file: string | undefined;
  let image: string | undefined;
  let arch = 'amd64';
  let relay: string | undefined;
  let profile: NetworkProfile = SANDBOX;
  let dryRun = false;
  let yes = false;
  let json = false;

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    switch (flag) {
      case '--file':
        file = value;
        at += 1;
        break;
      case '--image':
        image = value;
        at += 1;
        break;
      case '--arch':
        if (value !== undefined) arch = value;
        at += 1;
        break;
      case '--relay':
        relay = value;
        at += 1;
        break;
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
      case '--dry-run':
        dryRun = true;
        break;
      case '--yes':
        yes = true;
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

  if (file === undefined) throw new Error(`--file is required.\n\n${USAGE}`);
  if (image === undefined) throw new Error(`--image is required.\n\n${USAGE}`);

  return {
    file,
    image,
    arch,
    ...(relay === undefined ? {} : { relay }),
    profile,
    dryRun,
    yes,
    json,
  };
}

/** The publishing key, from whichever spelling the environment holds. */
export function templateKey(env: NodeJS.ProcessEnv): { pubkey: string; secretKey: Uint8Array } {
  const nsec = env['TOON_TEMPLATE_NSEC'];
  if (nsec) {
    const key = accountKeyFromNsec(nsec);
    return { pubkey: key.pubkey, secretKey: key.secretKey };
  }
  const mnemonic = env['TOON_TEMPLATE_MNEMONIC'];
  if (mnemonic) {
    const key = accountKeyFromMnemonic(mnemonic);
    return { pubkey: key.pubkey, secretKey: key.secretKey };
  }
  throw new Error(
    'No publishing key. Set TOON_TEMPLATE_NSEC (or TOON_TEMPLATE_MNEMONIC) to the key the ' +
      'Image Registry entry and the Template are signed with.'
  );
}

function printPlan(plan: TemplatePublishPlan, write: (line: string) => void): void {
  write(`Publishing as ${plan.npub}\n`);
  write(`  image           ${plan.image}\n`);
  write(`  image digest    ${plan.imageDigest}\n\n`);
  write(`  ${plan.entryAddress}  (kind ${plan.entryEvent.kind}, Image Registry entry)\n`);
  write(`${JSON.stringify(JSON.parse(plan.entryEvent.content), null, 2)}\n\n`);
  write(`  ${plan.templateAddress}  (kind ${plan.templateEvent.kind}, Template)\n`);
  write(`${JSON.stringify(JSON.parse(plan.templateEvent.content), null, 2)}\n\n`);
}

function printQuote(targets: RelayWriteTargets, write: (line: string) => void): void {
  if (!targets.ready) {
    write(
      `Quoted price: unavailable — ${targets.blockedBy ?? 'the profile\'s connector could not be read'}.\n` +
        'This is a free, read-only quote (GET /ilp); nothing was sent either way.\n'
    );
    return;
  }
  for (const entry of targets.plan) {
    write(
      entry.ready
        ? `  ${entry.url}\n      ${entry.destination} at ${entry.price} base units per write\n`
        : `  ${entry.url}\n      NOT PAYABLE (${entry.code}): ${entry.reason}\n`
    );
  }
  const perEvent = targets.totalPrice ?? targets.price ?? '0';
  write(
    `\nQuoted price: ${perEvent} base units per event, two events, ` +
      `across ${targets.relays.length} relay(s). Two writes: roughly ` +
      `${doubled(perEvent)} base units total. Nothing was sent — this ` +
      'is a free, read-only quote (GET /ilp), and the real price is only fixed by the write ' +
      'itself.\n'
  );
}

function doubled(price: string): string {
  try {
    return (BigInt(price) * 2n).toString();
  } catch {
    return `2×${price}`;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: { readonly write: (line: string) => void; readonly confirm: () => Promise<boolean> } = {
    write: (line) => process.stdout.write(line),
    confirm: defaultConfirm,
  }
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageRequested) {
      io.write(`${USAGE}\n`);
      return 0;
    }
    io.write(`${messageOf(error)}\n`);
    return 2;
  }

  const relays = [args.profile.relayUrl].filter((url) => url.length > 0);
  if (relays.length === 0) {
    io.write(`The “${args.profile.label}” profile names no relay. Pass --relay.\n`);
    return 2;
  }

  let key: { pubkey: string; secretKey: Uint8Array };
  try {
    key = templateKey(env);
  } catch (error) {
    io.write(`${messageOf(error)}\n`);
    return 2;
  }

  let plan: TemplatePublishPlan;
  try {
    const raw: unknown = JSON.parse(readFileSync(args.file, 'utf8'));
    const file = readTemplateInputFile(raw);
    const { ref, entry } = await resolveOciEntry(args.image, args.arch);
    plan = planTemplatePublish({
      pubkey: key.pubkey,
      file,
      entry,
      ref,
      image: args.image,
      relay: args.relay,
    });
  } catch (error) {
    wipe(key.secretKey);
    io.write(`Could not build the Template: ${messageOf(error)}\n`);
    return 2;
  }

  const reader = defaultConnectorReader();
  const targets = async (): Promise<RelayWriteTargets> => {
    const writer = new PaidRelayWriter({
      profile: () => args.profile,
      readHealth: (profile) => readConnectorHealth(profile, reader),
      readHealthAt: (connectorUrl) =>
        readConnectorHealth({ ...args.profile, connectorUrl }, reader),
      payerKeys: () => {
        throw new Error('a quote never pays, so no payer key is ever asked for');
      },
      paths: consolePaths(env),
      port: new LiveRelayWritePort(),
    });
    return writer.targets();
  };

  if (args.dryRun) {
    wipe(key.secretKey);
    if (args.json) {
      io.write(`${JSON.stringify({ plan, quote: await safeTargets(targets) }, null, 2)}\n`);
      return 0;
    }
    printPlan(plan, io.write);
    printQuote(await safeTargets(targets), io.write);
    io.write('\nNothing was sent (--dry-run).\n');
    return 0;
  }

  if (!args.yes) {
    printPlan(plan, io.write);
    printQuote(await safeTargets(targets), io.write);
    io.write('\nThis WILL spend real money (two paid relay writes). Type "yes" to continue: ');
    const confirmed = await io.confirm();
    if (!confirmed) {
      wipe(key.secretKey);
      io.write('Not confirmed. Nothing was sent.\n');
      return 1;
    }
  }

  const payer = env['TOON_TEMPLATE_PAYER_MNEMONIC'];
  if (!payer || !validateMnemonic(payer)) {
    wipe(key.secretKey);
    io.write(
      'TOON_TEMPLATE_PAYER_MNEMONIC must be a valid BIP-39 phrase: every relay write is a ' +
        'paid TOON packet, and this is the phrase the payer keys come from. Its channel must ' +
        'already be open — this tool never opens one.\n'
    );
    return 2;
  }

  const writer = new PaidRelayWriter({
    profile: () => args.profile,
    readHealth: (profile) => readConnectorHealth(profile, reader),
    readHealthAt: (connectorUrl) =>
      readConnectorHealth({ ...args.profile, connectorUrl }, reader),
    // Derived inside the borrow and wiped when it returns (ADR 0020) — the
    // same pattern `main-docs-publish.ts` and `smoke-console-run.ts` use.
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

  try {
    const report = await publishTemplatePlan(plan, {
      sign: (template: EventTemplate) =>
        Promise.resolve(finalizeEvent(template, key.secretKey) as unknown as NostrEvent),
      writer,
    });
    wipe(key.secretKey);
    if (args.json) {
      io.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const outcome of report.outcomes) {
        io.write(
          `  ${outcome.what.padEnd(11)} ${outcome.address}  ${outcome.eventId.slice(0, 16)}…` +
            `${outcome.cost === undefined ? '' : `  ${outcome.cost} base units`}\n`
        );
      }
      io.write(`\n${report.cost} base units spent in total.\n`);
    }
    return 0;
  } catch (error) {
    wipe(key.secretKey);
    io.write(`Publishing failed: ${messageOf(error)}\n`);
    return 3;
  }
}

async function safeTargets(fn: () => Promise<RelayWriteTargets>): Promise<RelayWriteTargets> {
  try {
    return await fn();
  } catch (error) {
    return { relays: [], plan: [], ready: false, blockedBy: messageOf(error) };
  }
}

async function defaultConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
