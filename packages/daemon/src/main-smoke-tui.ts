import { validateMnemonic, deriveFullIdentity, generateMnemonic } from '@toon-protocol/client';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';

import { consolePaths } from './paths.js';
import { findBuiltIn, type NetworkProfile } from './profiles.js';
import { planConditional } from './smoke-console.js';
import {
  funderBalances,
  gasTargetFor,
  generateSshKey,
  publishTemplate,
  randomPassphrase,
  readNetworkFacts,
  topUp,
  wipeIdentity,
  type ChainView,
} from './smoke-console-run.js';

/**
 * `main-smoke-tui` — the few things the TUI smoke (TOON_Network#149) needs
 * done that are not the console's to do.
 *
 * `cargo test --features smoke` in `tui/` drives a running daemon through the
 * TUI's OWN API client, and everything a person does in the TUI goes through
 * that client. Four things a smoke needs are not in the TUI because they are
 * not in the console at all, and `smoke:console` does each of them outside the
 * daemon too. They live here so there is one copy of each, shared with it:
 *
 * - `keys`: this run's own account key, Chain Seed, keystore passphrase and SSH
 *   key. Generated here because the Template below has to be signed by the
 *   same account the daemon signs in as, and the TUI crate has no secp256k1.
 * - `fund`: top up the payer address from the funder's account 0 — a wallet's
 *   job, not the console's (`smoke-console-run.ts`'s `topUp`, with its gas
 *   policy). `TOON_SMOKE_FUNDER_MNEMONIC` replaces the Foundry phrase, as it
 *   does for `smoke:console`.
 * - `template`: publish an Image Registry entry and a Template as the account,
 *   paid from the daemon's own channel (`publishTemplate`). The console has no
 *   route that publishes an arbitrary event, and should not grow one for a
 *   test.
 * - `plan`: whether the gateway stage can run on this network, decided by
 *   `smoke-console.ts`'s `planConditional` — the same function, so the two
 *   smokes skip for the same reason.
 *
 * Input is one JSON object on stdin, output one JSON object on stdout. Key
 * material crosses that pipe and nothing else; nothing here logs it.
 */

const FOUNDRY_TEST_PHRASE = 'test test test test test test test test test test test junk';

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function profileOf(id: unknown): NetworkProfile {
  const profile = typeof id === 'string' ? findBuiltIn(id) : undefined;
  if (profile === undefined) throw new Error(`No built-in profile ${JSON.stringify(id)}.`);
  return profile;
}

function funder(): string {
  const phrase = process.env['TOON_SMOKE_FUNDER_MNEMONIC'] ?? FOUNDRY_TEST_PHRASE;
  if (!validateMnemonic(phrase)) {
    throw new Error('TOON_SMOKE_FUNDER_MNEMONIC is not a valid BIP-39 phrase.');
  }
  return phrase;
}

async function run(command: string | undefined): Promise<unknown> {
  switch (command) {
    case 'keys': {
      const secret = generateSecretKey();
      const pubkey = getPublicKey(secret);
      const nsec = nsecEncode(secret);
      secret.fill(0);
      const mnemonic = generateMnemonic();
      const identity = deriveFullIdentity(mnemonic, { accountIndex: 0 });
      const addresses = { evm: identity.evm.address, solana: identity.solana.publicKey };
      wipeIdentity(identity);
      return {
        nsec,
        pubkey,
        npub: npubEncode(pubkey),
        mnemonic,
        passphrase: randomPassphrase(),
        sshPublicKey: generateSshKey(),
        addresses,
      };
    }
    case 'fund': {
      const input = await readStdin();
      const chain = input['chain'] as ChainView;
      const deposit = BigInt(String(input['deposit'] ?? '0'));
      const phrase = funder();
      // The same gas policy `smoke:console` applies: its default per chain
      // kind, capped at half of what the funder holds.
      const held = await funderBalances(chain, phrase);
      if (held === undefined) {
        throw new Error(`The funder's balances on ${chain.chain} could not be read.`);
      }
      return { lines: await topUp(chain, phrase, deposit, gasTargetFor(chain, held.native)) };
    }
    case 'template': {
      const input = await readStdin();
      const facts: string[] = [];
      let cost = 0n;
      const published = await publishTemplate({
        options: { profile: profileOf(input['profile']), image: String(input['image']) },
        // This process inherits the daemon's own XDG_* variables, so this is
        // the data directory whose channel pays for the two writes.
        paths: consolePaths(process.env),
        relay: String(input['relay']),
        mnemonic: String(input['mnemonic']),
        nsec: String(input['nsec']),
        pubkey: String(input['pubkey']),
        arch: String(input['arch']),
        onCost: (amount) => {
          if (amount !== undefined) cost += BigInt(amount);
        },
        onFact: (line) => facts.push(line),
      });
      return { ...published, cost: cost.toString(), facts };
    }
    case 'plan': {
      const input = await readStdin();
      const facts = await readNetworkFacts(profileOf(input['profile']), []);
      return { gateway: planConditional(facts).gateway };
    }
    default:
      throw new Error(`Unknown command ${JSON.stringify(command)}: keys, fund, template or plan.`);
  }
}

run(process.argv[2]).then(
  (answer) => {
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
