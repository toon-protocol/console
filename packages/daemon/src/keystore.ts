/**
 * Where the console's local keystore keeps a secret.
 *
 * ADR 0020 puts key custody in a signer, and names two: a NIP-46 remote signer
 * (which the console never gets a key from at all) and the console's own local
 * keystore. This is the port for the second one. Two backends implement it —
 * gnome-keyring through libsecret when a Secret Service is answering, and a
 * passphrase-encrypted file when none is — and NOTHING else in the daemon
 * knows which it got. That is the point of the seam: the session, the API and
 * the UI deal in "the keystore", and the only place the difference shows is
 * the backend name on the sign-in screen and the passphrase the file backend
 * asks for.
 *
 * The unit is an opaque string, not a key. A local signer's record and a
 * remote signer's client key are both secrets that must be sealed the same
 * way, and a keystore that understood nsecs would have to grow a second method
 * for the second kind.
 */

export type KeystoreBackend = 'libsecret' | 'file';

/**
 * What a backend needs before it will open. libsecret needs nothing — the
 * session keyring is already unlocked, or the desktop prompts for itself. The
 * file backend needs the passphrase it was sealed under.
 */
export interface Unlock {
  readonly passphrase?: string | undefined;
}

export interface Keystore {
  readonly backend: KeystoreBackend;
  /** One line for the sign-in screen: where a secret would be kept. */
  readonly location: string;
  /** True when this backend cannot open a record without a passphrase. */
  readonly needsPassphrase: boolean;
  put(id: string, secret: string, unlock: Unlock): Promise<void>;
  /** The secret, or `undefined` when nothing is stored under `id`. */
  get(id: string, unlock: Unlock): Promise<string | undefined>;
  remove(id: string): Promise<void>;
}

/**
 * The file backend was asked for a record without the passphrase that opens
 * it. Its own class rather than a message, because the API turns exactly this
 * into the prompt the UI shows and nothing else should trigger that prompt.
 */
export class PassphraseRequiredError extends Error {
  readonly code = 'passphrase_required';
  constructor(
    message = 'This keystore is a passphrase-encrypted file. Its passphrase opens it.'
  ) {
    super(message);
    this.name = 'PassphraseRequiredError';
  }
}

/** The passphrase did not open the record. */
export class WrongPassphraseError extends Error {
  readonly code = 'wrong_passphrase';
  constructor(message = 'That passphrase does not open this record.') {
    super(message);
    this.name = 'WrongPassphraseError';
  }
}

/** The backend itself is not usable — no Secret Service, unwritable directory. */
export class KeystoreUnavailableError extends Error {
  readonly code = 'keystore_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreUnavailableError';
  }
}
