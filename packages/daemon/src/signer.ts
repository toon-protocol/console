import { finalizeEvent } from 'nostr-tools/pure';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';

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
  /** Drop whatever is held: the key bytes, or the bunker subscription. */
  close(): Promise<void>;
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

  close(): Promise<void> {
    if (this.#secretKey) wipe(this.#secretKey);
    this.#secretKey = undefined;
    return Promise.resolve();
  }
}

export class SignerClosedError extends Error {
  readonly code = 'signer_closed';
  constructor() {
    super('This signer has been signed out. Sign in again to sign anything else.');
    this.name = 'SignerClosedError';
  }
}
