import { randomUUID } from 'node:crypto';

import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { npubEncode } from 'nostr-tools/nip19';

import {
  accountKeyFromMnemonic,
  accountKeyFromNsec,
  generateAccountKey,
  toNsec,
  wipe,
  type AccountKey,
} from './account-key.js';
import { readAccountProfile, type AccountProfile } from './account-metadata.js';
import type { Keystore, Unlock } from './keystore.js';
import { connectToBunker, inviteSigner, RemoteSignerError } from './remote-signer.js';
import type { NostrConnectInvitation } from './remote-signer.js';
import {
  LocalKeySigner,
  SealingError,
  SignerClosedError,
  type AccountSigning,
  type ConsoleSigner,
  type SignerRecord,
} from './signer.js';
import type { SignerIndex } from './signer-index.js';

/**
 * Who is signed in, and how they got there.
 *
 * This is the module the API talks to, and the only one that ever holds both a
 * secret and a network connection at once. Everything it knows falls into
 * three lifetimes, and keeping them apart is most of the design:
 *
 * - **The session** — the live `ConsoleSigner`, the account's pubkey, its
 *   kind-0 — lives in this process and dies with it. A restart signs out. That
 *   is not an oversight: the UI's launch token is minted per launch too, so a
 *   restarted daemon has no window to hand a session back to, and a console
 *   that came back signed in would be one an unlocked laptop signs for.
 * - **The signer list** — which accounts this machine knows — outlives the
 *   daemon in `signers.json`, so signing back in is one click and not a
 *   re-import.
 * - **The secrets** — a local key, or the client key and bunker pointer of a
 *   remote signer — outlive it in the keystore, under gnome-keyring or a
 *   passphrase.
 *
 * Nothing that leaves this module carries key material. `status()` is what the
 * API returns, and it is built from records and pubkeys only.
 */

export type ProfileState = 'loading' | 'ready' | 'none';

export interface AccountView {
  readonly pubkey: string;
  readonly npub: string;
  readonly signerId: string;
  readonly signerKind: 'local' | 'remote';
  readonly signerLabel: string;
  readonly signedInAt: string;
  readonly profileState: ProfileState;
  readonly profile?: AccountProfile | undefined;
}

export interface InvitationView {
  readonly uri: string;
  readonly state: 'waiting' | 'failed';
  readonly expiresAt: string;
  readonly error?: string | undefined;
}

export interface SessionStatus {
  readonly signedIn: boolean;
  readonly account?: AccountView | undefined;
  /** Signers this machine can sign back in with, newest use first. */
  readonly signers: readonly SignerRecord[];
  readonly keystore: {
    readonly backend: 'libsecret' | 'file';
    readonly location: string;
    readonly needsPassphrase: boolean;
  };
  /** A `nostrconnect://` waiting to be accepted, when one is outstanding. */
  readonly invitation?: InvitationView | undefined;
}

export class SessionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.status = status;
  }
}

/** What the keystore holds under a signer's id. Never leaves this module. */
type SealedSigner =
  | { readonly v: 1; readonly kind: 'local'; readonly nsec: string }
  | {
      readonly v: 1;
      readonly kind: 'remote';
      readonly clientNsec: string;
      readonly bunker: { relays: string[]; pubkey: string; secret: string | null };
    };

export interface SessionDeps {
  readonly keystore: Keystore;
  readonly signers: SignerIndex;
  /** The active network profile's relays — the fallback for a kind-0 read. */
  readonly relays: () => readonly string[];
  readonly now?: (() => Date) | undefined;
  /** Test seam: the kind-0 / NIP-65 read. */
  readonly readProfile?: typeof readAccountProfile | undefined;
}

interface LiveSession {
  readonly signer: ConsoleSigner;
  readonly record: SignerRecord;
  readonly signedInAt: Date;
  profileState: ProfileState;
  profile?: AccountProfile;
}

export class AccountSession {
  readonly #deps: SessionDeps;
  #live: LiveSession | undefined;
  #invitation: (InvitationView & { handle: NostrConnectInvitation }) | undefined;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
  }

  status(): SessionStatus {
    const keystore = {
      backend: this.#deps.keystore.backend,
      location: this.#deps.keystore.location,
      needsPassphrase: this.#deps.keystore.needsPassphrase,
    };
    const invitation = this.#invitation
      ? {
          uri: this.#invitation.uri,
          state: this.#invitation.state,
          expiresAt: this.#invitation.expiresAt,
          ...(this.#invitation.error === undefined ? {} : { error: this.#invitation.error }),
        }
      : undefined;
    return {
      signedIn: this.#live !== undefined,
      ...(this.#live ? { account: view(this.#live) } : {}),
      signers: [...this.#deps.signers.list()].sort(byMostRecent),
      keystore,
      ...(invitation ? { invitation } : {}),
    };
  }

  /**
   * Generate a key, import an nsec, or import a NIP-06 mnemonic — then sign in
   * with it.
   *
   * The three are one method because they differ only in where the thirty-two
   * bytes come from. Everything after that — seal, index, sign in, read the
   * kind-0 — is identical, and three copies of it would be three chances to
   * forget the `wipe`.
   */
  async addLocalSigner(request: {
    mode: 'generate' | 'nsec' | 'nip06';
    nsec?: string;
    mnemonic?: string;
    mnemonicPassphrase?: string;
    accountIndex?: number;
    label?: string;
    passphrase?: string;
  }): Promise<SessionStatus> {
    const key = this.#materialize(request);
    try {
      const sealed: SealedSigner = { v: 1, kind: 'local', nsec: toNsec(key) };
      const record = await this.#seal(
        {
          id: randomUUID(),
          kind: 'local',
          label: request.label?.trim() || shortNpub(key.npub),
          pubkey: key.pubkey,
          npub: key.npub,
          backend: this.#deps.keystore.backend,
          origin: key.origin,
          createdAt: this.#at().toISOString(),
        },
        sealed,
        { passphrase: request.passphrase }
      );
      // A fresh copy of the bytes for the signer: `wipe` below zeroes the ones
      // the caller's parse produced, and a signer that shared them would be
      // signing with zeroes a line later.
      await this.#open(new LocalKeySigner(Uint8Array.from(key.secretKey), key.pubkey), record);
      return this.status();
    } finally {
      wipe(key.secretKey);
    }
  }

  /** Dial a `bunker://` URI and sign in through whatever answers. */
  async addBunkerSigner(request: {
    uri: string;
    label?: string;
    passphrase?: string;
  }): Promise<SessionStatus> {
    const connection = await connectToBunker(request.uri);
    const npub = npubEncode(connection.signer.pubkey);
    const sealed: SealedSigner = {
      v: 1,
      kind: 'remote',
      clientNsec: connection.clientNsec,
      bunker: {
        relays: connection.pointer.relays,
        pubkey: connection.pointer.pubkey,
        secret: connection.pointer.secret,
      },
    };
    const record = await this.#seal(
      {
        id: randomUUID(),
        kind: 'remote',
        label: request.label?.trim() || shortNpub(npub),
        pubkey: connection.signer.pubkey,
        npub,
        backend: this.#deps.keystore.backend,
        bunkerRelays: connection.pointer.relays,
        bunkerPubkey: connection.pointer.pubkey,
        createdAt: this.#at().toISOString(),
      },
      sealed,
      { passphrase: request.passphrase }
    ).catch(async (error: unknown) => {
      await connection.signer.close();
      throw error;
    });
    await this.#open(connection.signer, record);
    return this.status();
  }

  /**
   * Offer a `nostrconnect://` for a signer to come to, and wait in the
   * background.
   *
   * The passphrase, when the file keystore needs one, is held for the life of
   * the invitation and no longer — there is no other moment at which the
   * console could seal what the handshake produces, since the handshake is
   * what produces it.
   */
  invite(request: { label?: string; passphrase?: string } = {}): SessionStatus {
    this.#cancelInvitation();
    const relays = this.#deps.relays();
    const handle = inviteSigner(relays);
    const expiresAt = new Date(this.#at().getTime() + 180_000).toISOString();
    const pending = { uri: handle.uri, state: 'waiting' as const, expiresAt, handle };
    this.#invitation = pending;

    void handle.accepted.then(
      async (connection) => {
        if (this.#invitation !== pending) {
          await connection.signer.close();
          return;
        }
        const npub = npubEncode(connection.signer.pubkey);
        try {
          const record = await this.#seal(
            {
              id: randomUUID(),
              kind: 'remote',
              label: request.label?.trim() || shortNpub(npub),
              pubkey: connection.signer.pubkey,
              npub,
              backend: this.#deps.keystore.backend,
              bunkerRelays: connection.pointer.relays,
              bunkerPubkey: connection.pointer.pubkey,
              createdAt: this.#at().toISOString(),
            },
            {
              v: 1,
              kind: 'remote',
              clientNsec: connection.clientNsec,
              bunker: {
                relays: connection.pointer.relays,
                pubkey: connection.pointer.pubkey,
                secret: connection.pointer.secret,
              },
            },
            { passphrase: request.passphrase }
          );
          this.#invitation = undefined;
          await this.#open(connection.signer, record);
        } catch (error) {
          await connection.signer.close();
          this.#invitation = { ...pending, state: 'failed', error: messageOf(error) };
        }
      },
      (error: unknown) => {
        if (this.#invitation !== pending) return;
        this.#invitation = { ...pending, state: 'failed', error: messageOf(error) };
      }
    );

    return this.status();
  }

  cancelInvitation(): SessionStatus {
    this.#cancelInvitation();
    return this.status();
  }

  /** Sign in again with a signer this machine already knows. */
  async resume(request: { id: string; passphrase?: string }): Promise<SessionStatus> {
    const record = this.#deps.signers.find(request.id);
    if (!record) {
      throw new SessionError(
        'unknown_signer',
        'This machine has no signer with that id.',
        404
      );
    }
    const sealed = await this.#unseal(record.id, { passphrase: request.passphrase });
    if (!sealed) {
      throw new SessionError(
        'secret_missing',
        `The keystore holds nothing for ${record.label}. It may have been cleared; import the key again.`,
        409
      );
    }
    if (sealed.kind === 'local') {
      const key = accountKeyFromNsec(sealed.nsec);
      await this.#open(new LocalKeySigner(key.secretKey, key.pubkey), record);
      return this.status();
    }
    const uri = bunkerUri(sealed.bunker);
    const connection = await connectToBunker(uri, { clientNsec: sealed.clientNsec });
    if (connection.signer.pubkey !== record.pubkey) {
      await connection.signer.close();
      throw new SessionError(
        'different_account',
        'That signer now signs as a different account. Connect it again to add it as a new one.',
        409
      );
    }
    await this.#open(connection.signer, record);
    return this.status();
  }

  async signOut(): Promise<SessionStatus> {
    const live = this.#live;
    this.#live = undefined;
    this.#cancelInvitation();
    if (live) await live.signer.close();
    return this.status();
  }

  /** Forget a signer: its secret leaves the keystore and its row the index. */
  async forget(id: string): Promise<SessionStatus> {
    if (this.#live?.record.id === id) await this.signOut();
    await this.#deps.keystore.remove(id);
    this.#deps.signers.remove(id);
    return this.status();
  }

  /**
   * Sign an event through whatever signer is connected.
   *
   * The one place the rest of the console will reach for. For a local key it
   * returns in microseconds; for a remote signer it is a relay round trip that
   * a person may have to approve on a phone, and it can be refused.
   */
  async sign(template: EventTemplate): Promise<VerifiedEvent> {
    return this.#throughSigner((signer) => signer.signEvent(template));
  }

  /**
   * Seal something to the account itself, and open it again (NIP-44).
   *
   * Used by the Chain Seed (ADR 0020) and, later, the Lease Vault (ADR 0021).
   * Routed through the session rather than the raw signer for the same reason
   * `sign` is: a remote signer's refusal, a closed session and a ciphertext
   * that is not this account's are three different answers, and the API turns
   * each into a different thing for a person to do.
   */
  async sealToSelf(plaintext: string): Promise<string> {
    return this.#throughSigner((signer) => signer.sealToSelf(plaintext));
  }

  async unsealFromSelf(ciphertext: string): Promise<string> {
    return this.#throughSigner((signer) => signer.unsealFromSelf(ciphertext));
  }

  /**
   * The signed-in account's key, as the three operations its own records need.
   *
   * `undefined` when nobody is signed in, so a caller decides what that means
   * — for the Chain Seed it is a view state, not an error.
   */
  signingPort(): AccountSigning | undefined {
    const live = this.#live;
    if (!live) return undefined;
    return {
      pubkey: live.signer.pubkey,
      sign: (template) => this.sign(template),
      sealToSelf: (plaintext) => this.sealToSelf(plaintext),
      unsealFromSelf: (ciphertext) => this.unsealFromSelf(ciphertext),
    };
  }

  async #throughSigner<T>(work: (signer: ConsoleSigner) => Promise<T>): Promise<T> {
    const live = this.#live;
    if (!live) {
      throw new SessionError('not_signed_in', 'No account is signed in.', 409);
    }
    try {
      const done = await work(live.signer);
      this.#deps.signers.touch(live.record.id, this.#at());
      return done;
    } catch (error) {
      if (error instanceof SignerClosedError) {
        throw new SessionError('not_signed_in', error.message, 409);
      }
      if (error instanceof RemoteSignerError) {
        throw new SessionError(error.code, error.message, 502);
      }
      // A `SealingError` is about the ciphertext, not the session; the Chain
      // Seed distinguishes "this record is not mine" from every other fault.
      if (error instanceof SealingError) throw error;
      throw error;
    }
  }

  /** Read the account's kind-0 again, for the refresh button. */
  async refreshProfile(): Promise<SessionStatus> {
    const live = this.#live;
    if (!live) return this.status();
    live.profileState = 'loading';
    await this.#readProfileInto(live);
    return this.status();
  }

  #materialize(request: {
    mode: 'generate' | 'nsec' | 'nip06';
    nsec?: string;
    mnemonic?: string;
    mnemonicPassphrase?: string;
    accountIndex?: number;
  }): AccountKey {
    if (request.mode === 'generate') return generateAccountKey();
    if (request.mode === 'nsec') {
      if (!request.nsec) throw new SessionError('invalid_request', 'No nsec was given.');
      return accountKeyFromNsec(request.nsec);
    }
    if (!request.mnemonic) throw new SessionError('invalid_request', 'No mnemonic was given.');
    return accountKeyFromMnemonic(request.mnemonic, {
      ...(request.mnemonicPassphrase === undefined
        ? {}
        : { passphrase: request.mnemonicPassphrase }),
      ...(request.accountIndex === undefined ? {} : { accountIndex: request.accountIndex }),
    });
  }

  /**
   * Seal the secret FIRST, then write the row.
   *
   * The order is the whole of it. The keystore is what can refuse — a missing
   * passphrase, a keyring that went away — and a row written before that
   * refusal is a signer on the sign-in screen with nothing behind it, which a
   * person can only clear by guessing that "Forget" is the fix. Writing the
   * row second leaves the list exactly as it was.
   *
   * The id has to be settled before either write, because re-importing an
   * account must overwrite the secret it already has rather than orphan it
   * under a new id.
   */
  async #seal(
    record: SignerRecord,
    sealed: SealedSigner,
    unlock: Unlock
  ): Promise<SignerRecord> {
    const existing = this.#deps.signers
      .list()
      .find(
        (candidate) => candidate.pubkey === record.pubkey && candidate.kind === record.kind
      );
    const stored: SignerRecord = existing ? { ...record, id: existing.id } : record;
    await this.#deps.keystore.put(stored.id, JSON.stringify(sealed), unlock);
    return this.#deps.signers.put(stored);
  }

  async #unseal(id: string, unlock: Unlock): Promise<SealedSigner | undefined> {
    const raw = await this.#deps.keystore.get(id, unlock);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as SealedSigner;
    } catch {
      throw new SessionError(
        'secret_unreadable',
        'The keystore returned something this console cannot read. Import the key again.',
        409
      );
    }
  }

  async #open(signer: ConsoleSigner, record: SignerRecord): Promise<void> {
    const previous = this.#live;
    this.#live = {
      signer,
      record,
      signedInAt: this.#at(),
      profileState: 'loading',
    };
    this.#deps.signers.touch(record.id, this.#at());
    if (previous) await previous.signer.close();
    // Not awaited: a sign-in must not wait on a relay, and an account with no
    // kind-0 anywhere would make every sign-in pay the full deadline.
    void this.#readProfileInto(this.#live);
  }

  async #readProfileInto(live: LiveSession): Promise<void> {
    const read = this.#deps.readProfile ?? readAccountProfile;
    try {
      const profile = await read(live.signer.pubkey, this.#deps.relays());
      if (this.#live !== live) return;
      live.profile = profile;
      live.profileState = profile.metadata ? 'ready' : 'none';
    } catch {
      if (this.#live !== live) return;
      // A relay that would not answer is not a failed sign-in. The account is
      // signed in; it simply has no name to show.
      live.profileState = 'none';
    }
  }

  #cancelInvitation(): void {
    this.#invitation?.handle.cancel();
    this.#invitation = undefined;
  }

  #at(): Date {
    return (this.#deps.now ?? (() => new Date()))();
  }
}

function view(live: LiveSession): AccountView {
  return {
    pubkey: live.signer.pubkey,
    npub: live.record.npub,
    signerId: live.record.id,
    signerKind: live.record.kind,
    signerLabel: live.record.label,
    signedInAt: live.signedInAt.toISOString(),
    profileState: live.profileState,
    ...(live.profile ? { profile: live.profile } : {}),
  };
}

function byMostRecent(a: SignerRecord, b: SignerRecord): number {
  return (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt);
}

function bunkerUri(bunker: {
  relays: string[];
  pubkey: string;
  secret: string | null;
}): string {
  const query = bunker.relays.map((relay) => `relay=${encodeURIComponent(relay)}`);
  if (bunker.secret) query.push(`secret=${encodeURIComponent(bunker.secret)}`);
  return `bunker://${bunker.pubkey}?${query.join('&')}`;
}

function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
