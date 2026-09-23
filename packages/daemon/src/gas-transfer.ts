import { base58 } from '@scure/base';

/**
 * **The one transaction the console asks a gas station to pay for**: move
 * lamports from the station's own fee payer to this account's Solana address
 * (TOON_Network#119).
 *
 * It is compiled here, by hand, and that wants justifying.
 *
 * A kind:5096 job is a transaction *somebody else wrote* that the gas station
 * decides whether to co-sign as fee payer. In every other use of that job in
 * this fleet a third party composes it — the blob store composes an ANT spawn,
 * because it is the only party holding `@ar.io/sdk`. Here there is no third
 * party: what the console wants is the smallest transaction Solana has, one
 * `System::Transfer`, and there is nobody to ask for it. So this module
 * compiles it, and it compiles the *legacy* message format — three static
 * accounts, one instruction, no address tables — because that is the whole of
 * what a transfer needs and every byte of it is pinned by a test that reads it
 * back with the client's own `parseSolanaWireTransaction`.
 *
 * **The fee payer is the only signer, and that is the shape that makes this
 * work.** The station's gate permits a `System::Transfer` whose *source* is
 * the fee payer, counted against its own rent allowance — that is how a
 * zero-SOL client's rent gets funded on the ANT path, and it is the same lane
 * used here. The recipient signs nothing and needs no key, so this console can
 * buy gas for an address whose private half never leaves `chain-seed.ts`.
 *
 * **Nothing here is a chain fact.** The System program's id is 32 zero bytes —
 * part of the wire format of a transfer, invariant across every Solana
 * cluster, and the gas station's own whitelist lists it under
 * "cluster-invariant". There is no chain id, no token, no price and no
 * endpoint in this file; how many lamports to ask for is the caller's, and
 * what the station will actually pay is the station's, quoted.
 *
 * **The blockhash is a placeholder on purpose.** The station quotes a
 * blockhash of its own and refuses anything else (`blockhash_mismatch`), and
 * the quote's TTL and its blockhash's validity are one merged deadline. So the
 * draft built here carries 32 zero bytes where the blockhash goes, and the
 * caller moves the station's own 32 bytes into it with the client's
 * `patchSolanaRecentBlockhash` — the same in-place patch the ANT ceremony
 * makes, and for the same reason: a round trip fewer inside a 60-second
 * window.
 */

/** A draft this console refused to build. Thrown BEFORE any packet, which is the point. */
export class GasTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GasTransferError';
  }
}

export interface LamportTransfer {
  /** The gas station's own fee payer, exactly as its quote spelled it. */
  readonly feePayer: string;
  /** Where the lamports land: this account's own Solana address. */
  readonly recipient: string;
  readonly lamports: bigint;
  /**
   * Base58, from the station's quote. Omitted builds the draft that is sent to
   * the QUOTE phase, which prices the job before a blockhash exists.
   */
  readonly recentBlockhash?: string | undefined;
}

/**
 * A `System::Transfer` of `lamports`, compiled, unsigned, base64 wire format.
 *
 * Unsigned in the full sense: the one signature slot belongs to the fee payer,
 * and the fee payer is the gas station. `signatures: [64 zero bytes]` is how
 * "not signed yet" is spelled on this wire, and it is what the station fills
 * in when it decides to pay.
 */
export function buildLamportTransfer(transfer: LamportTransfer): string {
  const feePayer = decodeAddress(transfer.feePayer, 'feePayer');
  const recipient = decodeAddress(transfer.recipient, 'recipient');
  if (transfer.lamports <= 0n) {
    throw new GasTransferError(
      `A gas purchase moves a positive number of lamports, and this asks for ` +
        `${transfer.lamports}. Nothing was built and nothing was sent.`
    );
  }
  if (transfer.lamports > MAX_U64) {
    throw new GasTransferError(
      `${transfer.lamports} lamports does not fit in the 64 bits a System transfer carries.`
    );
  }
  if (sameBytes(feePayer, recipient)) {
    throw new GasTransferError(
      'A gas purchase moves lamports from the station’s fee payer to THIS account’s ' +
        'address, and the two are the same address here. The station would read its own ' +
        'key in the destination slot; nothing was built.'
    );
  }
  const blockhash =
    transfer.recentBlockhash === undefined
      ? new Uint8Array(32)
      : decodeAddress(transfer.recentBlockhash, 'recentBlockhash');

  // Account order is the compiler's, not a choice: writable signers, readonly
  // signers, writable non-signers, readonly non-signers. The fee payer is
  // account 0 — which is also what the station's inspector requires.
  const message = concat(
    // header: 1 required signature, 0 readonly signed, 1 readonly unsigned.
    Uint8Array.from([1, 0, 1]),
    compactU16(3),
    feePayer,
    recipient,
    SYSTEM_PROGRAM,
    blockhash,
    compactU16(1),
    // programIdIndex, then the accounts the instruction touches: [source, destination].
    Uint8Array.from([2]),
    compactU16(2),
    Uint8Array.from([0, 1]),
    compactU16(12),
    transferData(transfer.lamports)
  );

  return toBase64(concat(compactU16(1), new Uint8Array(64), message));
}

/**
 * The System program's id: 32 zero bytes, `11111111111111111111111111111111`.
 *
 * Written as bytes rather than decoded from that string because that is what
 * it IS — the all-zero pubkey — and a base58 literal here would read like a
 * deployment's address, which this is the opposite of.
 */
const SYSTEM_PROGRAM = new Uint8Array(32);

const MAX_U64 = (1n << 64n) - 1n;

/** `System::Transfer` is instruction 2, and its argument is a little-endian u64. */
function transferData(lamports: bigint): Uint8Array {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return data;
}

/**
 * A base58 pubkey, as 32 bytes.
 *
 * Thrown on rather than coerced: every address here arrives from a gas
 * station's quote or from this account's own Chain Seed, so one that is not 32
 * bytes is a bug in this repository or an answer that did not come from a gas
 * station — and building a transaction around it would spend a paid packet to
 * be told so.
 */
function decodeAddress(value: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    throw new GasTransferError(
      `${what} is not base58: ${JSON.stringify(value)}. Nothing was built.`
    );
  }
  if (bytes.length !== 32) {
    throw new GasTransferError(
      `${what} decodes to ${bytes.length} bytes and a Solana address is 32. Nothing was built.`
    );
  }
  return bytes;
}

/**
 * Solana's compact-u16: 7 bits per byte, low group first, high bit set while
 * more follow. Every length on this wire is one.
 */
function compactU16(value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  for (;;) {
    const group = rest & 0x7f;
    rest >>>= 7;
    if (rest === 0) {
      bytes.push(group);
      break;
    }
    bytes.push(group | 0x80);
  }
  return Uint8Array.from(bytes);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, at) => byte === right[at]);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
