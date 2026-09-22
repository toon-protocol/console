import { BunkerSigner, createNostrConnectURI, parseBunkerInput } from 'nostr-tools/nip46';
import type { BunkerPointer } from 'nostr-tools/nip46';
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, decode } from 'nostr-tools/nip19';

import type { ConsoleSigner, SignerKind } from './signer.js';

/**
 * The NIP-46 remote signer: Amber, nsec.app, `nak bunker`.
 *
 * This is the custody ADR 0020 prefers, and the console is on the thin end of
 * it. It never sees the account's key. What it holds is a **client key** it
 * generated for itself, used only to encrypt the request-and-answer traffic to
 * the bunker; losing it costs a reconnection, not an account. Every signature
 * is a round trip over a relay to whatever the account approved, which is why
 * a sign can take a second and can be refused — the UI has to allow for both.
 *
 * Two entry points, because the two directions suit different signers:
 *
 * - **`bunker://`** — the signer hands the console a URI (nsec.app copies one,
 *   `nak bunker` prints one). The console dials out. Best when the signer is
 *   already running somewhere the console can be told about.
 * - **`nostrconnect://`** — the console prints a URI and waits, and the signer
 *   scans or pastes it. Best for a phone: Amber can read a QR code off the
 *   screen, and nothing has to be typed back into the console.
 *
 * Both end at the same place: a `BunkerSigner` and the account's real pubkey,
 * which is asked for rather than taken from the URI. The pubkey in a
 * `bunker://` is the BUNKER's, and on a signer that manages several accounts
 * that is not the account that will sign.
 */

export interface RemoteSignerConnection {
  readonly signer: ConsoleSigner;
  /** The bunker pointer to re-dial with. Its `secret` is key-adjacent. */
  readonly pointer: BunkerPointer;
  /** The console's own client key, as an nsec, for the keystore. */
  readonly clientNsec: string;
}

/** What the console tells a signer about itself in the connect handshake. */
const CLIENT_METADATA = {
  name: 'TOON Console',
  url: 'https://toonprotocol.dev',
};

export class RemoteSignerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RemoteSignerError';
    this.code = code;
  }
}

/**
 * Dial a `bunker://` URI (or a `name@domain` NIP-05 that points at one).
 *
 * @param clientNsec reuse a client key from the keystore; otherwise a fresh
 *   one is generated, which is what a first connection does.
 */
export async function connectToBunker(
  input: string,
  options: { clientNsec?: string | undefined; timeoutMs?: number } = {}
): Promise<RemoteSignerConnection> {
  const pointer = await parseBunkerInput(input.trim()).catch(() => null);
  if (!pointer) {
    throw new RemoteSignerError(
      'invalid_bunker_uri',
      'That is not a bunker URI. It should start with `bunker://`, or be a NIP-05 address that points at one.'
    );
  }
  if (pointer.relays.length === 0) {
    throw new RemoteSignerError(
      'invalid_bunker_uri',
      'That bunker URI names no relay, so there is nowhere to reach the signer.'
    );
  }

  const clientKey = options.clientNsec
    ? secretFromNsec(options.clientNsec)
    : generateSecretKey();
  const bunker = BunkerSigner.fromBunker(clientKey, pointer);
  return withTimeout(
    (async () => {
      await bunker.connect(CLIENT_METADATA);
      const pubkey = await bunker.getPublicKey();
      return {
        signer: new BunkerConsoleSigner(bunker, pubkey),
        pointer,
        clientNsec: nsecEncode(clientKey),
      };
    })(),
    options.timeoutMs ?? 60_000,
    () => void bunker.close(),
    'The signer did not answer. Check that it is running and connected to the same relay.'
  );
}

export interface NostrConnectInvitation {
  /** The URI to show as text and as a QR code. */
  readonly uri: string;
  /** Resolves when a signer accepts it. */
  readonly accepted: Promise<RemoteSignerConnection>;
  /** Give up waiting and drop the client key. */
  cancel(): void;
}

/**
 * Print a `nostrconnect://` and wait for a signer to come to it.
 *
 * The relays are the caller's, not a constant: the console offers the network
 * profile's relay, because that is one both ends of a devnet setup can already
 * reach, and a fixed public relay here would be exactly the kind of baked-in
 * endpoint the profile mechanism exists to avoid.
 */
export function inviteSigner(
  relays: readonly string[],
  options: { timeoutMs?: number; secret?: string } = {}
): NostrConnectInvitation {
  if (relays.length === 0) {
    throw new RemoteSignerError(
      'no_relay',
      'This network profile names no relay, so a signer would have nowhere to answer. Connect a bunker URI instead.'
    );
  }
  const clientKey = generateSecretKey();
  const secret = options.secret ?? randomSecret();
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientKey),
    relays: [...relays],
    secret,
    perms: ['sign_event', 'nip44_encrypt', 'nip44_decrypt'],
    ...CLIENT_METADATA,
  });

  // Two ways the wait ends — the person closes the dialog, or the invitation
  // expires — and `fromURI` takes one signal, so they are joined into one.
  const controller = new AbortController();
  const giveUp = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(options.timeoutMs ?? 180_000),
  ]);
  const accepted = (async () => {
    const bunker = await BunkerSigner.fromURI(clientKey, uri, {}, giveUp).catch(
      (error: unknown) => {
        throw new RemoteSignerError(
          'not_accepted',
          `Nothing accepted the invitation: ${errorText(error)}`
        );
      }
    );
    const pubkey = await bunker.getPublicKey();
    return {
      signer: new BunkerConsoleSigner(bunker, pubkey),
      pointer: bunker.bp,
      clientNsec: nsecEncode(clientKey),
    } satisfies RemoteSignerConnection;
  })();

  return { uri, accepted, cancel: () => controller.abort() };
}

/** A `BunkerSigner` behind the console's own, narrower interface. */
class BunkerConsoleSigner implements ConsoleSigner {
  readonly kind: SignerKind = 'remote';
  readonly pubkey: string;
  readonly #bunker: BunkerSigner;

  constructor(bunker: BunkerSigner, pubkey: string) {
    this.#bunker = bunker;
    this.pubkey = pubkey;
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    try {
      return await this.#bunker.signEvent(template);
    } catch (error) {
      throw new RemoteSignerError(
        'signer_refused',
        `The remote signer did not sign it: ${errorText(error)}`
      );
    }
  }

  /**
   * `nip44_encrypt` with the account's own pubkey as the third party.
   *
   * NIP-46 has no "to myself" request, so the account's key is named as the
   * counterparty — which is what NIP-44 self-sealing is: a conversation key
   * with oneself. The pubkey passed is the one the bunker told this console it
   * signs as, never one a caller supplies, so nothing here can be steered into
   * sealing an account's Chain Seed to somebody else.
   */
  async sealToSelf(plaintext: string): Promise<string> {
    try {
      return await this.#bunker.nip44Encrypt(this.pubkey, plaintext);
    } catch (error) {
      throw new RemoteSignerError(
        'signer_refused',
        `The remote signer did not seal it: ${errorText(error)}. A signer that allows ` +
          '`sign_event` may still have to be asked separately for `nip44_encrypt`.'
      );
    }
  }

  async unsealFromSelf(ciphertext: string): Promise<string> {
    try {
      return await this.#bunker.nip44Decrypt(this.pubkey, ciphertext);
    } catch (error) {
      throw new RemoteSignerError(
        'signer_refused',
        `The remote signer did not open it: ${errorText(error)}. A signer that allows ` +
          '`sign_event` may still have to be asked separately for `nip44_decrypt`.'
      );
    }
  }

  async close(): Promise<void> {
    // Closing the subscription, not logging out: a logout would revoke the
    // console's authorization at the signer, and signing out of the console is
    // not a request to be re-approved on the phone next time.
    await this.#bunker.close().catch(() => undefined);
  }
}

function secretFromNsec(nsec: string): Uint8Array {
  const decoded = decode(nsec);
  if (decoded.type !== 'nsec') {
    throw new RemoteSignerError('invalid_client_key', 'The stored client key is not an nsec.');
  }
  return decoded.data;
}

function randomSecret(): string {
  return Buffer.from(generateSecretKey()).toString('hex').slice(0, 32);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_done, fail) => {
        timer = setTimeout(() => {
          onTimeout();
          fail(new RemoteSignerError('signer_timeout', message));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
