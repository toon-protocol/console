import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAccountKey, toNsec } from './account-key.js';
import { AccountSession, SessionError } from './account-session.js';
import { WrongPassphraseError } from './keystore.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { consolePaths, type ConsolePaths } from './paths.js';
import { SignerIndex, signerIndexPath } from './signer-index.js';

/**
 * The session, driven the way the API drives it.
 *
 * The file keystore rather than libsecret because it is the backend CI has,
 * and because every assertion here is about the session and not about where
 * the bytes ended up. A libsecret round trip is its own test and its own
 * by-hand check on a desktop.
 */

const PASSPHRASE = 'a passphrase for the test';

function sessionOn(paths: ConsolePaths): AccountSession {
  return new AccountSession({
    keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
    signers: new SignerIndex(signerIndexPath(paths)),
    relays: () => [],
  });
}

describe('signing in', () => {
  let home: string;
  let paths: ConsolePaths;
  let session: AccountSession;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'toon-console-session-'));
    paths = consolePaths({ HOME: home } as NodeJS.ProcessEnv);
    session = sessionOn(paths);
  });

  afterEach(async () => {
    await session.signOut();
    rmSync(home, { recursive: true, force: true });
  });

  it('starts with nobody signed in and nothing saved', () => {
    const status = session.status();
    expect(status.signedIn).toBe(false);
    expect(status.signers).toEqual([]);
    expect(status.keystore.backend).toBe('file');
    expect(status.keystore.needsPassphrase).toBe(true);
  });

  it('generates a key and signs in with it', async () => {
    const status = await session.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    expect(status.signedIn).toBe(true);
    expect(status.account?.npub.startsWith('npub1')).toBe(true);
    expect(status.account?.signerKind).toBe('local');
    expect(status.signers).toHaveLength(1);
    expect(status.signers[0]?.origin).toBe('generated');
  });

  it('signs an event that verifies against the account', async () => {
    const status = await session.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const signed = await session.sign({
      kind: 27_235,
      content: 'console sign-in check',
      tags: [],
      created_at: 1_758_000_000,
    });
    expect(signed.pubkey).toBe(status.account?.pubkey);
    expect(verifyEvent(signed)).toBe(true);
  });

  it('imports an nsec as the same account it came from', async () => {
    const key = generateAccountKey();
    const status = await session.addLocalSigner({
      mode: 'nsec',
      nsec: toNsec(key),
      passphrase: PASSPHRASE,
    });
    expect(status.account?.pubkey).toBe(key.pubkey);
    expect(status.signers[0]?.origin).toBe('nsec');
  });

  it('imports a NIP-06 mnemonic', async () => {
    const status = await session.addLocalSigner({
      mode: 'nip06',
      mnemonic:
        'leader monkey parrot ring guide accident before fence cannon height naive bean',
      passphrase: PASSPHRASE,
    });
    expect(status.account?.npub).toBe(
      'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu'
    );
    expect(status.signers[0]?.origin).toBe('nip06');
  });

  /**
   * Found by hand on a real daemon: the row used to be written before the
   * keystore was asked, so a refused passphrase left a signer on the sign-in
   * screen that nothing could ever open.
   */
  it('leaves no signer behind when the keystore refuses', async () => {
    await expect(session.addLocalSigner({ mode: 'generate' })).rejects.toThrow();
    expect(session.status().signers).toEqual([]);
    expect(session.status().signedIn).toBe(false);
  });

  it('refuses to sign when nobody is signed in', async () => {
    await expect(
      session.sign({ kind: 1, content: '', tags: [], created_at: 1 })
    ).rejects.toThrow(SessionError);
  });

  it('clears the session on sign-out but keeps the signer', async () => {
    await session.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const status = await session.signOut();
    expect(status.signedIn).toBe(false);
    expect(status.account).toBeUndefined();
    expect(status.signers).toHaveLength(1);
    await expect(
      session.sign({ kind: 1, content: '', tags: [], created_at: 1 })
    ).rejects.toThrow(/No account is signed in/u);
  });

  it('comes back signed OUT after a restart, with the signer still listed', async () => {
    const first = await session.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const id = first.signers[0]?.id;

    // A new daemon on the same data directory: the process died, the files did
    // not.
    const restarted = sessionOn(paths);
    expect(restarted.status().signedIn).toBe(false);
    expect(restarted.status().signers.map((signer) => signer.id)).toEqual([id]);

    const back = await restarted.resume({ id: id ?? '', passphrase: PASSPHRASE });
    expect(back.signedIn).toBe(true);
    expect(back.account?.pubkey).toBe(first.account?.pubkey);
    await restarted.signOut();
  });

  it('will not sign back in on the wrong passphrase', async () => {
    const status = await session.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const restarted = sessionOn(paths);
    await expect(
      restarted.resume({ id: status.signers[0]?.id ?? '', passphrase: 'not it' })
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('keeps one row per account when the same key is imported twice', async () => {
    const key = generateAccountKey();
    await session.addLocalSigner({ mode: 'nsec', nsec: toNsec(key), passphrase: PASSPHRASE });
    const again = await session.addLocalSigner({
      mode: 'nsec',
      nsec: toNsec(key),
      label: 'renamed',
      passphrase: PASSPHRASE,
    });
    expect(again.signers).toHaveLength(1);
    expect(again.signers[0]?.label).toBe('renamed');
  });

  it('forgets a signer’s secret as well as its row', async () => {
    const status = await session.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const id = status.signers[0]?.id ?? '';
    const after = await session.forget(id);
    expect(after.signers).toEqual([]);
    expect(after.signedIn).toBe(false);
    expect(readFileSync(keystoreFilePath(paths), 'utf8')).not.toContain(id);
  });

  it('never carries key material in what the API returns', async () => {
    const key = generateAccountKey();
    const nsec = toNsec(key);
    const status = await session.addLocalSigner({
      mode: 'nsec',
      nsec,
      passphrase: PASSPHRASE,
    });
    const rendered = JSON.stringify(status);
    expect(rendered).not.toContain(nsec);
    expect(rendered).not.toContain(Buffer.from(key.secretKey).toString('hex'));
    expect(rendered).not.toContain(PASSPHRASE);
  });

  it('never writes key material into the signer list', async () => {
    const key = generateAccountKey();
    const nsec = toNsec(key);
    await session.addLocalSigner({ mode: 'nsec', nsec, passphrase: PASSPHRASE });
    const index = readFileSync(signerIndexPath(paths), 'utf8');
    expect(index).not.toContain(nsec);
    expect(index).not.toContain(PASSPHRASE);
    expect(index).toContain(key.npub);
  });

  it('reads the account’s kind-0 once signed in', async () => {
    const withProfile = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => ['wss://relay.example'],
      readProfile: (pubkey, relays) =>
        Promise.resolve({
          metadata: { name: 'ada', picture: 'https://pic/1' },
          relays: [...relays],
          relaySource: 'profile' as const,
          readAt: new Date(0).toISOString(),
        }),
    });
    await withProfile.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const status = await withProfile.refreshProfile();
    expect(status.account?.profileState).toBe('ready');
    expect(status.account?.profile?.metadata?.name).toBe('ada');
    await withProfile.signOut();
  });

  it('stays signed in when no relay will answer', async () => {
    const withoutProfile = new AccountSession({
      keystore: new PassphraseFileKeystore(keystoreFilePath(paths)),
      signers: new SignerIndex(signerIndexPath(paths)),
      relays: () => ['wss://relay.example'],
      readProfile: () => Promise.reject(new Error('the relay refused')),
    });
    await withoutProfile.addLocalSigner({ mode: 'generate', passphrase: PASSPHRASE });
    const status = await withoutProfile.refreshProfile();
    expect(status.signedIn).toBe(true);
    expect(status.account?.profileState).toBe('none');
    await withoutProfile.signOut();
  });
});
