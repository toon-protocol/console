import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ConsolePaths } from './paths.js';
import {
  PassphraseRequiredError,
  WrongPassphraseError,
  type Keystore,
  type KeystoreBackend,
  type Unlock,
} from './keystore.js';

/**
 * The local keystore when there is no Secret Service: one file, every record
 * sealed under a passphrase.
 *
 * scrypt to stretch the passphrase and AES-256-GCM to seal the record — the
 * same shape NIP-49's `ncryptsec` uses, and for the same reason: a passphrase
 * is low entropy, so the cost of guessing has to be paid per guess, and the
 * ciphertext has to fail loudly rather than decrypt to plausible garbage.
 *
 * It is NOT `ncryptsec` itself, because NIP-49 seals exactly thirty-two bytes
 * and the console has to seal a record — a remote signer's client key travels
 * with the bunker pointer it belongs to, and a format that can hold only a
 * bare key would push that pointer into the clear.
 *
 * Every record carries its own salt and nonce, so each is sealed under the
 * passphrase it was given. That is what lets an account keep one key under one
 * passphrase and never be forced to re-key the rest to change it.
 *
 * The file itself is mode 0600 and written by rename, so a crash mid-write
 * leaves the old file rather than half of the new one. Losing a keystore to a
 * power cut is how people lose accounts.
 */

interface SealedRecord {
  readonly kdf: 'scrypt';
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface KeystoreFile {
  readonly version: 1;
  readonly records: Record<string, SealedRecord>;
}

/** ~32 MiB and ~100 ms per guess on this decade's hardware. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

export function keystoreFilePath(paths: ConsolePaths): string {
  return join(paths.config, 'keystore.json');
}

export class PassphraseFileKeystore implements Keystore {
  readonly backend: KeystoreBackend = 'file';
  readonly needsPassphrase = true;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get location(): string {
    return `${this.#path} (passphrase-encrypted)`;
  }

  async put(id: string, secret: string, unlock: Unlock): Promise<void> {
    const passphrase = passphraseOf(unlock);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await stretch(passphrase, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    // The id is authenticated but not encrypted: it is already the map key, and
    // binding it in stops a record being moved under another id in the file.
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const file = this.#read();
    this.#write({
      version: 1,
      records: {
        ...file.records,
        [id]: {
          kdf: 'scrypt',
          n: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          salt: salt.toString('base64'),
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        },
      },
    });
  }

  async get(id: string, unlock: Unlock): Promise<string | undefined> {
    const record = this.#read().records[id];
    if (!record) return undefined;
    const passphrase = passphraseOf(unlock);
    const key = await stretch(passphrase, Buffer.from(record.salt, 'base64'), record);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(id, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // GCM tells the two apart from nothing else: a wrong passphrase and a
      // tampered file both fail the tag. Report the one a person can act on.
      throw new WrongPassphraseError();
    }
  }

  async remove(id: string): Promise<void> {
    const file = this.#read();
    if (!(id in file.records)) return;
    const records = Object.fromEntries(
      Object.entries(file.records).filter(([held]) => held !== id)
    );
    this.#write({ version: 1, records });
  }

  #read(): KeystoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<KeystoreFile>;
      if (parsed.version === 1 && parsed.records && typeof parsed.records === 'object') {
        return { version: 1, records: parsed.records };
      }
    } catch {
      // No file yet, or a file this version cannot read. Either way there is
      // nothing to open, and the sign-in list will show no saved signers.
    }
    return { version: 1, records: {} };
  }

  #write(file: KeystoreFile): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

function passphraseOf(unlock: Unlock): string {
  const passphrase = unlock.passphrase;
  if (passphrase === undefined || passphrase.length === 0) throw new PassphraseRequiredError();
  return passphrase;
}

function stretch(
  passphrase: string,
  salt: Buffer,
  params: { n: number; r: number; p: number } = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }
): Promise<Buffer> {
  return new Promise((done, fail) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      32,
      { N: params.n, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (error, derived) => (error ? fail(error) : done(derived))
    );
  });
}
