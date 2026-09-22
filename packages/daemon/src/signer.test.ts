import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decrypt, getConversationKey } from 'nostr-tools/nip44';
import { describe, expect, it } from 'vitest';

import { LocalKeySigner, SealingError, SignerClosedError } from './signer.js';

/**
 * Sealing to self, on the local keystore's signer.
 *
 * This is one of the two paths ADR 0020's Chain Seed travels; the other is a
 * NIP-46 round trip, which `remote-signer.ts` implements against a bunker and
 * which is exercised by hand and by `smoke-console`. What is worth pinning
 * here is that the console's seal is ORDINARY NIP-44 to the account's own
 * pubkey — so anything else holding that key opens it — and that a signer
 * which has been closed seals nothing at all.
 */

function localSigner(secretKey = generateSecretKey()) {
  return {
    secretKey,
    pubkey: getPublicKey(secretKey),
    signer: new LocalKeySigner(Uint8Array.from(secretKey), getPublicKey(secretKey)),
  };
}

describe('sealing to self', () => {
  it('round-trips through the account’s own key', async () => {
    const { signer } = localSigner();
    const sealed = await signer.sealToSelf('the chain seed');
    expect(sealed).not.toContain('the chain seed');
    expect(await signer.unsealFromSelf(sealed)).toBe('the chain seed');
  });

  it('is plain NIP-44 to self, openable by anything holding the key', async () => {
    const { secretKey, pubkey, signer } = localSigner();
    const sealed = await signer.sealToSelf('recoverable elsewhere');
    // Not the console's own code: nostr-tools, with the same conversation key
    // any other Nostr client would compute.
    expect(decrypt(sealed, getConversationKey(secretKey, pubkey))).toBe(
      'recoverable elsewhere'
    );
  });

  it('gives a different ciphertext every time, so a relay learns nothing from two', async () => {
    const { signer } = localSigner();
    const once = await signer.sealToSelf('same words');
    const twice = await signer.sealToSelf('same words');
    expect(once).not.toBe(twice);
  });

  it('refuses another account’s ciphertext as a sealing fault, not a signer fault', async () => {
    const theirs = await localSigner().signer.sealToSelf('not yours');
    const { signer } = localSigner();
    await expect(signer.unsealFromSelf(theirs)).rejects.toBeInstanceOf(SealingError);
    await expect(signer.unsealFromSelf(theirs)).rejects.toMatchObject({
      code: 'seal_unreadable',
    });
  });

  it('seals nothing once the session is over', async () => {
    const { signer } = localSigner();
    const sealed = await signer.sealToSelf('before');
    await signer.close();
    await expect(signer.sealToSelf('after')).rejects.toBeInstanceOf(SignerClosedError);
    await expect(signer.unsealFromSelf(sealed)).rejects.toBeInstanceOf(SignerClosedError);
  });
});
