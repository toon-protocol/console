import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

import { HEX_32 } from './spawn-content.js';

/**
 * The **Root Secret** and the **Continuation Token** (spec §6.1.1).
 *
 * A tenant mints one 32-byte root secret per lease and holds it. It never
 * leaves the tenant, nothing in the protocol recovers it, and everything that
 * controls the lease derives from it:
 *
 * ```
 * continuation(provider) = HKDF-SHA256(ikm  = root,
 *                                      salt = empty,
 *                                      info = "toon-network-continuation:" || provider_pubkey,
 *                                      L    = 32)
 * ```
 *
 * `provider_pubkey` is 64 **lowercase** hex characters, so the whole `info` is
 * ASCII and there is nothing about byte order or encoding to guess. A key
 * spelled any other way derives a token the provider does not hold, so a
 * non-lowercase-hex key is refused here rather than normalized: a spawn is
 * paid for, and one that derived the wrong token would buy a lease nobody
 * could ever read, extend or stop (§6.1.2).
 *
 * **Why this is written out rather than imported.** The derivation is already
 * expressed twice in the fleet — the provider's `expand`
 * (`src/nostr/continuation.rs`) and the tenant tool's `continuationFor`
 * (`provider/tools/grant/handover.mjs`) — and `@toon-protocol/client` does not
 * express it at all. Neither of those is a package this console can depend on:
 * one is Rust, the other is a `.mjs` file in a repository the console does not
 * vendor. What keeps this third copy honest is not discipline but the spec's
 * own golden vector: `continuation.test.ts` derives Appendix B's
 * `continuation.vector.json` and requires the byte-for-byte answer, against
 * the same fixture the provider's CI checks itself against. A copy that drifts
 * fails there before it can spend anything.
 *
 * `gatewaySub` — §6.5.1's Gateway Grant — is deliberately NOT here. It belongs
 * to the handover ticket (#97), and a derivation with no caller is a derivation
 * with no test.
 */

/** The HKDF `info` prefix a Continuation Token is derived under (spec §6.1.1). */
export const CONTINUATION_DOMAIN = 'toon-network-continuation:';

export class ContinuationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContinuationError';
    this.code = code;
  }
}

/**
 * A fresh 32-byte Root Secret, as 64 lowercase hex characters.
 *
 * From the platform's CSPRNG. This is the one value in a lease that nothing
 * can recreate: it is minted here, sealed into the Lease Vault before the
 * spawn that uses it is sent (ADR 0021), and never logged, echoed or returned
 * over the API.
 */
export function mintRootSecret(): string {
  return bytesToHex(randomBytes(32));
}

/**
 * A fresh `request_id`: 32 random bytes, as hex (spec §6.1).
 *
 * Beside `newWorkloadId` in `spawn-content.ts` rather than sharing it, because
 * they are different fields of different objects that happen to have the same
 * shape: a `request_id` keys the provider's replay set for one request, and a
 * `workload_id` names a lease for its whole life. One of them changing shape
 * later must not silently change the other.
 */
export function mintRequestId(): string {
  return bytesToHex(randomBytes(32));
}

/**
 * The Continuation Token this root secret derives for one provider.
 *
 * @param rootSecret 64 lowercase hex characters.
 * @param providerPubkey the provider's x-only Nostr key, 64 lowercase hex.
 * @throws {ContinuationError} when either is not spelled that way.
 */
export function continuationFor(rootSecret: string, providerPubkey: string): string {
  if (!HEX_32.test(rootSecret)) {
    // Never the VALUE: a refusal must not quote a secret back, not into a log
    // line and not into an API answer.
    throw new ContinuationError(
      'invalid_root_secret',
      'A root secret is 32 bytes as 64 lowercase hex characters (spec §6.1.1).'
    );
  }
  if (!HEX_32.test(providerPubkey)) {
    throw new ContinuationError(
      'invalid_provider',
      `${JSON.stringify(providerPubkey)} is not a provider key: 64 lowercase hex characters. ` +
        'The key is spelled into the derivation exactly as the provider spells it, so an npub, ' +
        'or the same key in upper case, derives a token the provider does not hold (spec §6.1.1).'
    );
  }
  // RFC 5869 with an EMPTY salt, which HKDF then extracts with 32 zero bytes —
  // `@noble/hashes` takes `undefined` for that, and passing 32 explicit zero
  // bytes would be the same extraction spelled a second way.
  return bytesToHex(
    hkdf(
      sha256,
      hexToBytes(rootSecret),
      undefined,
      `${CONTINUATION_DOMAIN}${providerPubkey}`,
      32
    )
  );
}
