import { base58 } from '@scure/base';
import { parseSolanaWireTransaction, patchSolanaRecentBlockhash } from '@toon-protocol/client';
import { describe, expect, it } from 'vitest';

import { GasTransferError, buildLamportTransfer } from './gas-transfer.js';

/**
 * The bytes, read back by somebody else's parser.
 *
 * Every assertion here goes through `@toon-protocol/client`'s
 * `parseSolanaWireTransaction` rather than through this module's own idea of
 * what it wrote. A test that decoded the transaction with the same beliefs
 * that encoded it would pass on a transaction no validator would take, and
 * the way this one fails is the way the real thing fails: the gas station's
 * inspector reads these bytes with a third decoder again, and refuses.
 */

/** Three distinct, valid 32-byte addresses, spelled the way a chain spells them. */
const FEE_PAYER = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => at + 1));
const RECIPIENT = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => at + 64));
const BLOCKHASH = base58.encode(Uint8Array.from({ length: 32 }, (_, at) => 255 - at));

describe('the transaction a gas station is asked to pay for', () => {
  it('compiles a System transfer the client’s own parser reads back', () => {
    const wire = buildLamportTransfer({
      feePayer: FEE_PAYER,
      recipient: RECIPIENT,
      lamports: 10_000_000n,
      recentBlockhash: BLOCKHASH,
    });

    const parsed = parseSolanaWireTransaction(wire);
    expect(parsed.version).toBe('legacy');
    // The fee payer is account 0 and the only signer — which is what the
    // station's inspector requires, and what lets this console buy gas for an
    // address whose key it never has to touch.
    expect(parsed.signers).toEqual([FEE_PAYER]);
    expect(parsed.staticAccounts[0]).toBe(FEE_PAYER);
    expect(parsed.staticAccounts[1]).toBe(RECIPIENT);
    // The System program: 32 zero bytes, cluster-invariant.
    expect(parsed.staticAccounts[2]).toBe(base58.encode(new Uint8Array(32)));
    expect(parsed.recentBlockhash).toBe(BLOCKHASH);
  });

  it('leaves the one signature slot empty, because it is the station’s to fill', () => {
    const parsed = parseSolanaWireTransaction(
      buildLamportTransfer({
        feePayer: FEE_PAYER,
        recipient: RECIPIENT,
        lamports: 1n,
        recentBlockhash: BLOCKHASH,
      })
    );
    // A zero-filled slot is how "not signed yet" is spelled on this wire. The
    // station reads it, co-signs it as fee payer, and broadcasts.
    expect(parsed.unsigned).toEqual([FEE_PAYER]);
  });

  it('carries the instruction as a System transfer of exactly the lamports asked for', () => {
    const wire = buildLamportTransfer({
      feePayer: FEE_PAYER,
      recipient: RECIPIENT,
      lamports: 9_876_543n,
      recentBlockhash: BLOCKHASH,
    });
    const bytes = Buffer.from(wire, 'base64');
    // The instruction's 12 data bytes are the last thing on the wire: a
    // little-endian u32 discriminator of 2, then a little-endian u64.
    const data = bytes.subarray(bytes.length - 12);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(9_876_543n);
  });

  it('builds a draft with no blockhash, for the quote that has not named one yet', () => {
    // The first quote of a ceremony prices the job before a blockhash exists.
    // The draft carries 32 zero bytes, and the client's in-place patch moves
    // the station's own 32 bytes in afterwards — never a recompile, because a
    // rebuilt message is a message no signature covers.
    const draft = buildLamportTransfer({
      feePayer: FEE_PAYER,
      recipient: RECIPIENT,
      lamports: 5n,
    });
    expect(parseSolanaWireTransaction(draft).recentBlockhash).toBe(
      base58.encode(new Uint8Array(32))
    );

    const patched = patchSolanaRecentBlockhash(draft, BLOCKHASH);
    expect(parseSolanaWireTransaction(patched).recentBlockhash).toBe(BLOCKHASH);
    // And the rest of the message is untouched, which is what makes the patch
    // safe to use instead of a second round trip.
    expect(parseSolanaWireTransaction(patched).staticAccounts).toEqual(
      parseSolanaWireTransaction(draft).staticAccounts
    );
  });

  it('is byte-identical whether the blockhash was built in or patched in', () => {
    const built = buildLamportTransfer({
      feePayer: FEE_PAYER,
      recipient: RECIPIENT,
      lamports: 7n,
      recentBlockhash: BLOCKHASH,
    });
    const patched = patchSolanaRecentBlockhash(
      buildLamportTransfer({ feePayer: FEE_PAYER, recipient: RECIPIENT, lamports: 7n }),
      BLOCKHASH
    );
    expect(patched).toBe(built);
  });

  it('refuses to build anything it would have to pay a packet to be told is wrong', () => {
    const good = { feePayer: FEE_PAYER, recipient: RECIPIENT, lamports: 1n };
    expect(() => buildLamportTransfer({ ...good, lamports: 0n })).toThrow(GasTransferError);
    expect(() => buildLamportTransfer({ ...good, lamports: -1n })).toThrow(GasTransferError);
    expect(() =>
      buildLamportTransfer({ ...good, feePayer: 'not base58 at all: 0OIl' })
    ).toThrow(GasTransferError);
    expect(() =>
      buildLamportTransfer({ ...good, recipient: base58.encode(new Uint8Array(31)) })
    ).toThrow(/32/u);
    // The station would read its own key in the destination slot and answer
    // `dvm_key_misplaced`, at the route's full price.
    expect(() => buildLamportTransfer({ ...good, recipient: FEE_PAYER })).toThrow(
      GasTransferError
    );
    expect(() => buildLamportTransfer({ ...good, recentBlockhash: 'nonsense' })).toThrow(
      GasTransferError
    );
  });
});
