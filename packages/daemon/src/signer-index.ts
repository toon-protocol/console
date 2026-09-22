import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConsolePaths } from './paths.js';
import type { SignerRecord } from './signer.js';

/**
 * The list of signers this machine knows about — and not one secret.
 *
 * Kept apart from the keystore on purpose. The keystore holds the material
 * that must never be read without a passphrase or a keyring prompt; this holds
 * what the sign-in screen has to show BEFORE either of those can happen: which
 * accounts are here, what they are called, whether each is a remote signer or
 * a local key. A list that could only be read after unlocking would mean a
 * console that cannot say what it would be unlocking.
 *
 * So the rule for this file is exact: an npub, a label, a bunker's relays and
 * pubkey — all public by construction — and nothing else. No nsec, no bunker
 * secret, no passphrase. `signer-index.test.ts` is the test that says so.
 */

export function signerIndexPath(paths: ConsolePaths): string {
  return join(paths.config, 'signers.json');
}

interface IndexFile {
  readonly version: 1;
  readonly signers: SignerRecord[];
}

export class SignerIndex {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  list(): readonly SignerRecord[] {
    return this.#read().signers;
  }

  find(id: string): SignerRecord | undefined {
    return this.#read().signers.find((record) => record.id === id);
  }

  /**
   * Add a signer, or replace the one already there for the same account.
   *
   * Keyed by pubkey rather than id so that connecting the same account twice
   * — a bunker re-paired, an nsec imported again — updates one entry instead
   * of growing a second identical row. The id of the existing row is kept, so
   * whatever the keystore holds under it stays reachable.
   */
  put(record: SignerRecord): SignerRecord {
    const file = this.#read();
    const existing = file.signers.find(
      (candidate) => candidate.pubkey === record.pubkey && candidate.kind === record.kind
    );
    const merged: SignerRecord = existing ? { ...record, id: existing.id } : record;
    this.#write({
      version: 1,
      signers: [...file.signers.filter((candidate) => candidate.id !== merged.id), merged],
    });
    return merged;
  }

  touch(id: string, at: Date): void {
    const file = this.#read();
    const record = file.signers.find((candidate) => candidate.id === id);
    if (!record) return;
    this.#write({
      version: 1,
      signers: file.signers.map((candidate) =>
        candidate.id === id ? { ...record, lastUsedAt: at.toISOString() } : candidate
      ),
    });
  }

  remove(id: string): void {
    const file = this.#read();
    this.#write({
      version: 1,
      signers: file.signers.filter((candidate) => candidate.id !== id),
    });
  }

  #read(): IndexFile {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<IndexFile>;
      if (parsed.version === 1 && Array.isArray(parsed.signers)) {
        return { version: 1, signers: parsed.signers };
      }
    } catch {
      // No file yet, or one this version cannot read: no saved signers.
    }
    return { version: 1, signers: [] };
  }

  #write(file: IndexFile): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
