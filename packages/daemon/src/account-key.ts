import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode, nsecEncode, decode } from 'nostr-tools/nip19';
import { privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06';

/**
 * Turning what a person typed into an account's key.
 *
 * Three ways in, one shape out. They are kept in ONE module because the
 * dangerous part is identical for all three — thirty-two bytes that must not
 * be logged, echoed or written anywhere but a keystore — and splitting them
 * would make three places to get that wrong instead of one.
 *
 * Nothing here returns the bytes without also returning the public key: every
 * caller needs the npub, and a helper that hands back only a secret invites a
 * caller to work out the pubkey itself and get the derivation wrong.
 *
 * NOTE on the mnemonic: this is NIP-06, the account's *Nostr* key, and it is
 * NOT the Chain Seed. The Chain Seed is a separate, random BIP-39 mnemonic
 * sealed to the account (ADR 0020, TOON_Network#89). An account may choose to
 * import the same words for both, but that is a decision it makes twice.
 */

/** How a key got into the keystore, kept for the sign-in list. */
export type KeyOrigin = 'generated' | 'nsec' | 'nip06';

export interface AccountKey {
  /** The raw private key. Held only as long as it takes to seal or to sign. */
  readonly secretKey: Uint8Array;
  readonly pubkey: string;
  readonly npub: string;
  readonly origin: KeyOrigin;
}

export class KeyMaterialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KeyMaterialError';
    this.code = code;
  }
}

export function generateAccountKey(): AccountKey {
  return describe(generateSecretKey(), 'generated');
}

/**
 * An `nsec1…`, or the 64 hex characters some tools print instead.
 *
 * @throws {KeyMaterialError} when the text is neither.
 */
export function accountKeyFromNsec(text: string): AccountKey {
  const trimmed = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return describe(hexToBytes(trimmed), 'nsec');
  }
  let decoded;
  try {
    decoded = decode(trimmed);
  } catch {
    throw new KeyMaterialError(
      'invalid_nsec',
      'That is not an nsec. It should start with `nsec1`, or be 64 hex characters.'
    );
  }
  if (decoded.type !== 'nsec') {
    throw new KeyMaterialError(
      'invalid_nsec',
      `That is an ${decoded.type}, not an nsec — a public identifier cannot sign.`
    );
  }
  return describe(decoded.data, 'nsec');
}

/**
 * A NIP-06 mnemonic, optionally with its BIP-39 passphrase and account index.
 *
 * @throws {KeyMaterialError} when the words are not a valid BIP-39 phrase.
 */
export function accountKeyFromMnemonic(
  words: string,
  options: { passphrase?: string; accountIndex?: number } = {}
): AccountKey {
  const normalized = words.trim().toLowerCase().split(/\s+/u).join(' ');
  if (!validateWords(normalized)) {
    throw new KeyMaterialError(
      'invalid_mnemonic',
      'Those are not valid BIP-39 words. Check the spelling and the word count (12 or 24).'
    );
  }
  return describe(
    privateKeyFromSeedWords(normalized, options.passphrase, options.accountIndex ?? 0),
    'nip06'
  );
}

/**
 * The secret in the form a keystore holds it.
 *
 * `nsec` rather than hex so that a person who recovers the item by hand — with
 * `secret-tool lookup`, or out of the encrypted file — gets something every
 * other Nostr app accepts, instead of a bare number they have to convert.
 */
export function toNsec(key: AccountKey): string {
  return nsecEncode(key.secretKey);
}

/** Overwrite the bytes once they are sealed or the session ends. */
export function wipe(secretKey: Uint8Array): void {
  secretKey.fill(0);
}

function describe(secretKey: Uint8Array, origin: KeyOrigin): AccountKey {
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: npubEncode(pubkey), origin };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
