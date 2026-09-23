import { validateMnemonic } from '@toon-protocol/client';

import { BUILT_IN_PROFILES, SANDBOX, type NetworkProfile } from './profiles.js';
import { STAGES, STAGE_TITLES, summarize, type StageName } from './smoke-console.js';
import { runSmoke, type SmokeOptions } from './smoke-console-run.js';

/**
 * `smoke-console` — the end-to-end acceptance test for the whole console
 * (TOON_Network#101, the last ticket of Milestone 8).
 *
 * ```
 * npm run smoke:console                       # the local docker sandbox
 * npm run smoke:console -- --profile devnet   # the public test network
 * ```
 *
 * ## Which network, and what differs
 *
 * **The sandbox is the default** because it is cheap, repeatable and offline:
 * its money is anvil's, its providers are containers, and a run that goes
 * wrong costs nothing anybody minds. `--profile devnet` points the same run at
 * the public network, where the money is real test money and the providers are
 * somebody else's machines.
 *
 * Nothing else changes between them. The smoke reads the chains, the prices,
 * the providers, the Listings and the gateway from the network it was pointed
 * at, so the difference between the two runs is what those answers say — and
 * what a network cannot answer is SKIPPED, by name, with the reason.
 *
 * ## What it will not do
 *
 * It does not install, uninstall, enable, disable or restart anything. It
 * starts one daemon of its own, on a temporary data directory, on a port the
 * kernel picked, with the keystore forced to a file inside that directory —
 * so a machine already running a console ends the run exactly as it began.
 *
 * ## Why it is not in CI
 *
 * Recorded here because Milestone 8 asked for the reason rather than the fact.
 * Three things, each sufficient on its own:
 *
 * 1. **It spends.** Every run buys a lease, an extension and three relay
 *    writes on a live network. A test that moves money on every push is a test
 *    that will one day move money nobody meant to move.
 * 2. **Its sandbox is not a container this repository can start.** `make up`
 *    in `infra/sandbox` builds images from four sibling checkouts — the
 *    provider, the gateway, the store and anytoon — none of which CI has, and
 *    the stack is two chains, a relay, three connectors and two providers.
 * 3. **Devnet is shared and single-threaded.** It publishes one provider and
 *    one settlement channel per payer; two runs at once share a nonce
 *    watermark, and the loser has every later claim refused. A merge queue is
 *    exactly the thing that would run two at once.
 *
 * What CI DOES run is this file's neighbours: `smoke-console.test.ts` drives
 * the report, the skip policy and the image mapping with fixtures, so the
 * judgement about what counts as proved is tested on every push even though
 * the network is not.
 */

const USAGE = `smoke-console — drive the whole console against a live network

  --profile <id>        sandbox (default), devnet, or another built-in id
  --connector <url>     override the profile's connector edge
  --relay <url>         override the profile's relay
  --gateway <url>       override the profile's Workload Gateway connector
  --image <ref>         what the Template runs (default: ${defaultImage()})
  --provider <pubkey>   buy from this provider rather than the cheapest live one
  --listing <name>      buy this tier rather than the cheapest plain one
  --chain <key>         fund and pay on this chain, as \`GET /ilp\` spells it
  --template-relay <url>  the \`relay\` hint the published Template carries
                          (default: the chosen provider's own Relay Set)
  --deposit <units>     channel collateral, base units (default: the connector's)
  --gas <units>         native coin to leave at the payer (default: per chain)
  --state-dir <path>    keep the first daemon's data directory here, so the next
                        run re-uses this run's channel instead of stranding it.
                        The RECOVERY daemon is always a fresh directory.
  --keep                leave the lease running and the data directories behind
  --json                the report as JSON on stdout
  --stages              list the stages and stop

  TOON_SMOKE_FUNDER_MNEMONIC   the phrase whose account 0 holds test money
                               (default: the Foundry/anvil development phrase)
  TOON_SMOKE_CHAIN_SEED        re-use one Chain Seed across runs instead of
                               stranding collateral at a fresh address each
                               time. Recommended on devnet, WITH --state-dir:
                               the seed re-opens the channel and the directory
                               carries the watermark, and without the second a
                               claim is refused as a replay (F01) and billed.
  TOON_SMOKE_NSEC              re-use one account. Optional; one is generated.
  TOON_CONSOLE_SOCKS_PROXY     an Anyone Protocol SOCKS proxy, which is what
                               decides whether a Hidden Provider can be reached

It spends real test money on whichever network it is pointed at, and it says
what every stage cost. A refused paid request is billed exactly like an
accepted one (ADR 0003, TOON_Network#115).`;

/**
 * The image the Template names by default.
 *
 * An HTTP echo server: small, on every public registry, and it answers with
 * the request it saw — which is what makes a gateway's forwarding visible
 * rather than merely reported. `--image` takes any other. It is a default and
 * not a constant about this network: nothing here depends on it being this
 * one, and the Image Registry entry is built from whatever the registry serves.
 */
function defaultImage(): string {
  return 'traefik/whoami:v1.10.2';
}

/**
 * The development phrase every local chain in this fleet is seeded with.
 *
 * Foundry's and anvil's published test mnemonic, which is also what
 * `infra/sandbox` funds. It is not a secret, it holds nothing on any real
 * chain, and it is a DEFAULT — `TOON_SMOKE_FUNDER_MNEMONIC` replaces it, and
 * on any network but a local one it must.
 */
const FOUNDRY_TEST_PHRASE = 'test test test test test test test test test test test junk';

class UsageRequested extends Error {}

export interface Args extends Omit<SmokeOptions, 'log'> {
  readonly stagesOnly: boolean;
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Args {
  let profile: NetworkProfile = SANDBOX;
  let connector: string | undefined;
  let relay: string | undefined;
  let gateway: string | undefined;
  let image = defaultImage();
  let provider: string | undefined;
  let listing: string | undefined;
  let chain: string | undefined;
  let templateRelay: string | undefined;
  let deposit: string | undefined;
  let gas: string | undefined;
  let stateDir: string | undefined;
  let keep = false;
  let json = false;
  let stagesOnly = false;

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = argv[at + 1];
    const takes = (): string => {
      if (value === undefined) throw new Error(`${flag ?? ''} takes a value.`);
      at += 1;
      return value;
    };
    switch (flag) {
      case '--profile': {
        const id = takes();
        const found = BUILT_IN_PROFILES.find((candidate) => candidate.id === id);
        if (found === undefined) {
          throw new Error(
            `No profile “${id}”. Known: ` +
              `${BUILT_IN_PROFILES.map((candidate) => candidate.id).join(', ')}.`
          );
        }
        profile = found;
        break;
      }
      case '--connector':
        connector = takes();
        break;
      case '--relay':
        relay = takes();
        break;
      case '--gateway':
        gateway = takes();
        break;
      case '--image':
        image = takes();
        break;
      case '--provider':
        provider = takes();
        break;
      case '--listing':
        listing = takes();
        break;
      case '--chain':
        chain = takes();
        break;
      case '--template-relay':
        templateRelay = takes();
        break;
      case '--deposit':
        deposit = takes();
        break;
      case '--gas':
        gas = takes();
        break;
      case '--state-dir':
        stateDir = takes();
        break;
      case '--keep':
        keep = true;
        break;
      case '--json':
        json = true;
        break;
      case '--stages':
        stagesOnly = true;
        break;
      case '--help':
      case '-h':
        throw new UsageRequested();
      default:
        throw new Error(`Unknown argument “${flag ?? ''}”.\n\n${USAGE}`);
    }
  }

  const funder = env['TOON_SMOKE_FUNDER_MNEMONIC'] ?? FOUNDRY_TEST_PHRASE;
  if (!validateMnemonic(funder)) {
    throw new Error(
      'TOON_SMOKE_FUNDER_MNEMONIC is not a valid BIP-39 phrase. It is the phrase whose account ' +
        '0 holds the test money this run funds its payer from; it never opens a channel and ' +
        'never signs a claim.'
    );
  }
  const chainSeed = env['TOON_SMOKE_CHAIN_SEED'];
  if (chainSeed !== undefined && !validateMnemonic(chainSeed)) {
    throw new Error('TOON_SMOKE_CHAIN_SEED is not a valid BIP-39 phrase.');
  }

  return {
    profile: {
      ...profile,
      ...(connector === undefined ? {} : { connectorUrl: connector }),
      ...(relay === undefined ? {} : { relayUrl: relay }),
      ...(gateway === undefined ? {} : { gatewayConnectorUrl: gateway }),
    },
    image,
    ...(provider === undefined ? {} : { provider }),
    ...(listing === undefined ? {} : { listing }),
    ...(chain === undefined ? {} : { chain }),
    ...(templateRelay === undefined ? {} : { templateRelay }),
    ...(deposit === undefined ? {} : { deposit }),
    ...(gas === undefined ? {} : { gas }),
    ...(stateDir === undefined ? {} : { stateDir }),
    funder,
    ...(chainSeed === undefined ? {} : { chainSeed }),
    ...(env['TOON_SMOKE_NSEC'] === undefined ? {} : { nsec: env['TOON_SMOKE_NSEC'] }),
    keep,
    json,
    stagesOnly,
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv, env);
  } catch (error) {
    if (error instanceof UsageRequested) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (args.stagesOnly) {
    for (const stage of STAGES) {
      process.stdout.write(`  ${stage.padEnd(14)}${STAGE_TITLES[stage as StageName]}\n`);
    }
    return 0;
  }

  if (args.profile.connectorUrl.length === 0) {
    process.stderr.write(
      `The “${args.profile.label}” profile names no connector, so there is nothing to smoke. ` +
        'Pass --connector, or pick another profile.\n'
    );
    return 2;
  }

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  if (!args.json) {
    process.stdout.write(
      `smoke-console on “${args.profile.label}”\n` +
        `  connector:  ${args.profile.connectorUrl}\n` +
        `  relay:      ${args.profile.relayUrl}\n` +
        `  gateway:    ${args.profile.gatewayConnectorUrl || '(none in this profile)'}\n` +
        `  image:      ${args.image}\n\n`
    );
  }

  const report = await runSmoke({ ...args, log });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ report, log: lines }, null, 2)}\n`);
  } else {
    process.stdout.write(summarize(report));
  }
  return report.verdict === 'green' ? 0 : 1;
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
