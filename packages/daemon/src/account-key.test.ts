import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  KeyMaterialError,
  accountKeyFromMnemonic,
  accountKeyFromNsec,
  generateAccountKey,
  toNsec,
  wipe,
} from './account-key.js';

describe('the key a local signer is built from', () => {
  it('generates one that is its own npub', () => {
    const key = generateAccountKey();
    expect(key.secretKey).toHaveLength(32);
    expect(key.npub.startsWith('npub1')).toBe(true);
    expect(getPublicKey(key.secretKey)).toBe(key.pubkey);
    expect(key.origin).toBe('generated');
  });

  it('round-trips through the nsec a keystore holds', () => {
    const key = generateAccountKey();
    const back = accountKeyFromNsec(toNsec(key));
    expect(back.pubkey).toBe(key.pubkey);
    expect(back.origin).toBe('nsec');
  });

  it('accepts the bare hex some tools print instead of an nsec', () => {
    const key = generateAccountKey();
    const hex = Buffer.from(key.secretKey).toString('hex');
    expect(accountKeyFromNsec(hex).pubkey).toBe(key.pubkey);
  });

  it('refuses an npub, which cannot sign', () => {
    const key = generateAccountKey();
    expect(() => accountKeyFromNsec(key.npub)).toThrow(KeyMaterialError);
    expect(() => accountKeyFromNsec(key.npub)).toThrow(/not an nsec/u);
  });

  it('refuses words that are not BIP-39', () => {
    expect(() => accountKeyFromMnemonic('not actually a mnemonic at all')).toThrow(
      KeyMaterialError
    );
  });

  // NIP-06's own test vector: these words must derive this key, or the console
  // and every other wallet disagree about what an imported account IS.
  it('derives NIP-06 at the published vector', () => {
    const key = accountKeyFromMnemonic(
      'leader monkey parrot ring guide accident before fence cannon height naive bean'
    );
    expect(Buffer.from(key.secretKey).toString('hex')).toBe(
      '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a'
    );
    expect(key.origin).toBe('nip06');
  });

  it('takes the same words in any spacing or case', () => {
    const spaced = accountKeyFromMnemonic(
      '  Leader  monkey PARROT ring guide accident before fence cannon height naive bean '
    );
    const plain = accountKeyFromMnemonic(
      'leader monkey parrot ring guide accident before fence cannon height naive bean'
    );
    expect(spaced.pubkey).toBe(plain.pubkey);
  });

  it('separates accounts by index', () => {
    const words =
      'leader monkey parrot ring guide accident before fence cannon height naive bean';
    expect(accountKeyFromMnemonic(words, { accountIndex: 1 }).pubkey).not.toBe(
      accountKeyFromMnemonic(words, { accountIndex: 0 }).pubkey
    );
  });

  it('leaves nothing behind when wiped', () => {
    const key = generateAccountKey();
    wipe(key.secretKey);
    expect([...key.secretKey].every((byte) => byte === 0)).toBe(true);
  });
});
