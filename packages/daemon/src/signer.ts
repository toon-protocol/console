import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';

import { wipe } from './account-key.js';
import type { KeyOrigin } from './account-key.js';
import type { KeystoreBackend } from './keystore.js';

/**
 * A **Signer**: whatever holds the account's Nostr key and signs for it.
 *
 * The whole console is written against this interface and never against a key,
 * which is ADR 0020's ruling made structural. A remote signer cannot hand over
 * a key even in principle, so any code that reached for one would work with
 * half the accounts and fail the other half at runtime. There is no `secretKey`
 * on this type and there must never be one.
 *
 * Two implementations: the local keystore's key, held in this process for as
 * long as a session lasts; and a NIP-46 remote signer, where `signEvent` is a
 * round trip to Amber, nsec.app or `nak bunker` and this process holds only
 * the ephemeral client key it talks to the bunker with.
 */

export type SignerKind = 'local' | 'remote';

export interface ConsoleSigner {
  readonly kind: SignerKind;
  /** The ACCOUNT's pubkey — for a remote signer, the one the bunker signs as. */
  readonly pubkey: string;
  signEvent(template: EventTemplate): Promise<VerifiedEvent>;
  /**
   * NIP-44-seal something to the account itself, and open it again.
   *
   * To SELF, with no counterparty argument, because that is the only sealing
   * the console does: ADR 0020's Chain Seed and ADR 0021's Lease Vault are
   * both records an account writes for its own later self, and a method that
   * took a recipient would invite a caller to seal an account's chain seed to
   * somebody else's key — which is to say, to give away its funds. A signer
   * that cannot be asked cannot be asked wrongly.
   *
   * On the local keystore this is a conversation key with itself, computed in
   * the daemon. On a remote signer it is `nip44_encrypt` / `nip44_decrypt`,
   * two more relay round trips that the account may have to approve, so every
   * caller has to allow for the same latency and refusal as `signEvent`.
   */
  sealToSelf(plaintext: string): Promise<string>;
  unsealFromSelf(ciphertext: string): Promise<string>;
  /** Drop whatever is held: the key bytes, or the bunker subscription. */
  close(): Promise<void>;
}

/**
 * What an account's OWN records need from the session: sign, seal, unseal.
 *
 * A `ConsoleSigner` minus its lifecycle. The Chain Seed (ADR 0020) and the
 * Lease Vault (ADR 0021) both want exactly these three, both want them wrapped
 * in the session's error handling rather than the raw signer's, and neither
 * should be able to sign a person out. `AccountSession.signingPort()` is what
 * hands one over.
 */
export interface AccountSigning {
  readonly pubkey: string;
  sign(template: EventTemplate): Promise<VerifiedEvent>;
  sealToSelf(plaintext: string): Promise<string>;
  unsealFromSelf(ciphertext: string): Promise<string>;
}

/** What a saved signer looks like on the sign-in screen. No secret here. */
export interface SignerRecord {
  readonly id: string;
  readonly kind: SignerKind;
  /** What a person called it, or a name made from the npub. */
  readonly label: string;
  readonly pubkey: string;
  readonly npub: string;
  /** Which keystore backend holds this signer's secret. */
  readonly backend: KeystoreBackend;
  /** Local signers only: how the key got here. */
  readonly origin?: KeyOrigin | undefined;
  /** Remote signers only: the relays the bunker is reached on. Not a secret. */
  readonly bunkerRelays?: readonly string[] | undefined;
  /** Remote signers only: the bunker's own pubkey. Not a secret. */
  readonly bunkerPubkey?: string | undefined;
  readonly createdAt: string;
  readonly lastUsedAt?: string | undefined;
}

/**
 * The local keystore's signer.
 *
 * It holds the bytes because it must — nothing else can produce a BIP-340
 * signature from them — and it holds them for exactly one session. `close()`
 * overwrites them rather than dropping the reference: a freed `Uint8Array` is
 * still a private key sitting in the heap until something else happens to
 * reuse the page, and a core dump does not care that nobody points at it.
 */
export class LocalKeySigner implements ConsoleSigner {
  readonly kind: SignerKind = 'local';
  readonly pubkey: string;
  #secretKey: Uint8Array | undefined;

  constructor(secretKey: Uint8Array, pubkey: string) {
    this.#secretKey = secretKey;
    this.pubkey = pubkey;
  }

  signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const secretKey = this.#secretKey;
    if (!secretKey) return Promise.reject(new SignerClosedError());
    return Promise.resolve(finalizeEvent(template, secretKey));
  }

  sealToSelf(plaintext: string): Promise<string> {
    const key = this.#conversationKey();
    if (!key) return Promise.reject(new SignerClosedError());
    try {
      return Promise.resolve(encrypt(plaintext, key));
    } finally {
      key.fill(0);
    }
  }

  unsealFromSelf(ciphertext: string): Promise<string> {
    const key = this.#conversationKey();
    if (!key) return Promise.reject(new SignerClosedError());
    try {
      return Promise.resolve(decrypt(ciphertext, key));
    } catch (error) {
      return Promise.reject(
        new SealingError(
          'seal_unreadable',
          `This account's key does not open that record: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    } finally {
      key.fill(0);
    }
  }

  /**
   * The NIP-44 conversation key with itself, derived per call and zeroed after.
   *
   * Not cached. It is as good as the private key for everything the console
   * seals, and a cached copy would outlive the one operation that needed it
   * for no saving a person could measure.
   */
  #conversationKey(): Uint8Array | undefined {
    const secretKey = this.#secretKey;
    if (!secretKey) return undefined;
    return getConversationKey(secretKey, this.pubkey);
  }

  close(): Promise<void> {
    if (this.#secretKey) wipe(this.#secretKey);
    this.#secretKey = undefined;
    return Promise.resolve();
  }
}

/**
 * A seal could not be made or opened.
 *
 * Distinct from a refusal by a remote signer, which is `RemoteSignerError`:
 * this one means the ciphertext itself is wrong for this account — a record
 * sealed to a different key, or one a relay corrupted — and the answer to it
 * is never "try again".
 */
export class SealingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SealingError';
    this.code = code;
  }
}

export class SignerClosedError extends Error {
  readonly code = 'signer_closed';
  constructor() {
    super('This signer has been signed out. Sign in again to sign anything else.');
    this.name = 'SignerClosedError';
  }
}
