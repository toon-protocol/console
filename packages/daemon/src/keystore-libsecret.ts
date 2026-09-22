import { spawn } from 'node:child_process';

import {
  KeystoreUnavailableError,
  type Keystore,
  type KeystoreBackend,
  type Unlock,
} from './keystore.js';

/**
 * The local keystore in gnome-keyring, through libsecret.
 *
 * It shells out to `secret-tool` rather than binding libsecret natively, and
 * that is a deliberate trade. A native binding would be one process fewer and
 * a great deal more: a compiler on every machine that installs the console, a
 * prebuilt for every Node ABI, and a build step in CI that has nothing to do
 * with the console. `secret-tool` is a 40 KB binary from the same project as
 * the library, it is already installed wherever gnome-keyring is, and the
 * three verbs the console needs are its whole command set.
 *
 * The secret goes in on STDIN, never in `argv`: every process on the machine
 * can read `/proc/<pid>/cmdline`, and a key on a command line is a key
 * published to the machine.
 *
 * The attributes — `service=toon-console`, `signer=<id>` — are what
 * `secret-tool` searches on, and they are also what a person sees in
 * Seahorse. Nothing secret goes in an attribute; attributes are indexed in
 * the clear.
 */

const SERVICE = 'toon-console';
const TOOL = 'secret-tool';

export class SecretServiceKeystore implements Keystore {
  readonly backend: KeystoreBackend = 'libsecret';
  readonly location = 'gnome-keyring (libsecret)';
  readonly needsPassphrase = false;
  readonly #tool: string;

  constructor(tool: string = TOOL) {
    this.#tool = tool;
  }

  /**
   * Whether a Secret Service is answering on this session bus.
   *
   * `search` and not `lookup`, and the EXIT CODE and nothing else:
   *
   * - a `lookup` that finds nothing exits 1, which is indistinguishable from
   *   one that could not connect;
   * - a `search` exits 0 whether or not it matched, and 1 only when it could
   *   not reach the service;
   * - and `search` prints each match's ATTRIBUTES to stderr, so "stderr is
   *   empty" is not a health check — it is a check for "this account has
   *   never stored a key", which is the opposite of what is being asked.
   *
   * That last line is not a guess: an earlier version of this probe tested
   * stderr, and it worked perfectly until the first key was saved, at which
   * point every restart quietly fell back to the file keystore.
   */
  static async available(tool: string = TOOL): Promise<boolean> {
    try {
      return (await run(tool, ['search', 'service', SERVICE])).code === 0;
    } catch {
      return false;
    }
  }

  async put(id: string, secret: string, _unlock: Unlock): Promise<void> {
    const result = await run(
      this.#tool,
      ['store', '--label', `TOON Console — ${id}`, 'service', SERVICE, 'signer', id],
      secret
    );
    if (result.code !== 0) throw unavailable('store', result.stderr);
  }

  async get(id: string, _unlock: Unlock): Promise<string | undefined> {
    const result = await run(this.#tool, ['lookup', 'service', SERVICE, 'signer', id]);
    if (result.code === 0) {
      // `secret-tool lookup` adds no newline of its own, but a secret stored
      // by another tool may carry one. Trim the trailing newline only.
      return result.stdout.replace(/\n$/u, '');
    }
    // Exit 1 with nothing on stderr is "no such item", which is not a fault.
    if (result.stderr.trim().length === 0) return undefined;
    throw unavailable('lookup', result.stderr);
  }

  async remove(id: string): Promise<void> {
    const result = await run(this.#tool, ['clear', 'service', SERVICE, 'signer', id]);
    if (result.code !== 0 && result.stderr.trim().length > 0) {
      throw unavailable('clear', result.stderr);
    }
  }
}

function unavailable(verb: string, stderr: string): KeystoreUnavailableError {
  return new KeystoreUnavailableError(
    `gnome-keyring refused to ${verb} the secret: ${stderr.trim() || 'no reason given'}`
  );
}

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(tool: string, args: readonly string[], stdin?: string): Promise<ToolResult> {
  return new Promise((done, fail) => {
    const child = spawn(tool, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
