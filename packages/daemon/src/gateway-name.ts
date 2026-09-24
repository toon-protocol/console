import { hexToBytes } from '@noble/hashes/utils.js';

import { HEX_32 } from './spawn-content.js';

/**
 * **The hostname a Workload Gateway serves a workload at** (spec §12.2,
 * TOON_Network#97).
 *
 * ```
 * <canonical label>.<gateway domain>
 * ```
 *
 * The canonical label is the lowercase, unpadded base32 (RFC 4648) encoding of
 * the 32-byte `workload_id`. Every part of that sentence is load-bearing and
 * none of it is a preference:
 *
 * - **base32, not hex**, because the same id in hex is 64 characters and a DNS
 *   label may be 63. Base32 of 32 bytes is 52.
 * - **RFC 4648's alphabet** (`a`–`z`, `2`–`7`), which is exactly the set a DNS
 *   label allows, and whose absence of an upper case DNS's own
 *   case-insensitivity cannot disturb.
 * - **unpadded**, because `=` is not a legal label character — and a workload
 *   id is a fixed 32 bytes, so nothing is ambiguous without the padding.
 *
 * **It is derived, never assigned.** The gateway answers a handover with the
 * hostname it will serve, and this module derives the same string from the
 * workload id alone. That is what lets the console show a person their
 * hostname *before* it sends anything, and what lets it CHECK the one the
 * gateway answered rather than believing it — the acceptance criterion "the
 * hostname shown matches what the gateway serves" is a comparison between two
 * independently produced values, not a copy.
 *
 * The domain comes from the active network profile (`gatewayDomain`) and never
 * from the handover: §12.1's message does not carry one, because the gateway
 * knows its own.
 */

/** RFC 4648's base32 alphabet, lowercased. `a`–`z` then `2`–`7`. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export class GatewayNameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GatewayNameError';
    this.code = code;
  }
}

/**
 * RFC 4648 base32 of `bytes`, lowercase and unpadded.
 *
 * Written out rather than taken from a dependency: Node has no base32, and the
 * encodings that call themselves base32 differ in exactly the two ways that
 * would produce a hostname the gateway does not serve — base32**hex** uses
 * `0`–`9a`–`v`, and Crockford's drops `i`, `l`, `o` and `u`. Naming the
 * alphabet in one line above the loop is cheaper than auditing a package for
 * which of the three it means.
 */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The 52-character label a workload id is served under (spec §12.2).
 *
 * @param workloadId 64 lowercase hex characters.
 * @throws {GatewayNameError} when it is not one. The id is not a secret, so
 *   unlike a grant it may be quoted back.
 */
export function canonicalLabel(workloadId: string): string {
  if (!HEX_32.test(workloadId)) {
    throw new GatewayNameError(
      'invalid_workload_id',
      `${JSON.stringify(workloadId)} is not a workload id: 32 bytes as 64 lowercase hex ` +
        'characters. The gateway serves its base32 encoding as one DNS label (spec §12.2).'
    );
  }
  return base32Lower(hexToBytes(workloadId));
}

/**
 * The canonical hostname, or `undefined` when this profile names no gateway
 * domain.
 *
 * `undefined` rather than a throw, because "this network has no gateway" is
 * the ordinary state of mainnet today and of any profile an operator has not
 * finished configuring. A view that has nothing to show says so; it does not
 * fail.
 */
export function hostnameFor(workloadId: string, gatewayDomain: string): string | undefined {
  const domain = gatewayDomain.trim().toLowerCase().replace(/\.$/u, '');
  if (domain.length === 0) return undefined;
  return `${canonicalLabel(workloadId)}.${domain}`;
}

/**
 * Whether the hostname a gateway answered is the one this console derived.
 *
 * Compared as NAMES: case-insensitively, and without a port. A profile's
 * `gatewayDomain` may carry one — the sandbox's is `gw.localhost:3280`, because
 * that is where its plain-HTTP listener is published on this machine — and the
 * derived hostname keeps it so a link to it works. The gateway knows its domain
 * and not the port a host mapped it to, so it answers `<label>.gw.localhost`,
 * and the port is not part of the name either one is making a claim about
 * (TOON_Network#149 found this on the sandbox).
 */
export function sameHostname(answered: string, derived: string): boolean {
  const name = (hostname: string) =>
    (hostname.trim().toLowerCase().split(':')[0] ?? '').replace(/\.$/u, '');
  return name(answered) === name(derived);
}

/**
 * Where to knock to see what the gateway is actually serving.
 *
 * `https` everywhere, because §12.2 puts TLS at the gateway and that is the
 * whole point of a hostname — with one exception the sandbox needs: a domain
 * under `localhost`, where no certificate authority can issue and the sandbox
 * therefore publishes a plain-HTTP listener beside its TLS one. The exception
 * is named on the loopback rather than on a port number so that nothing on a
 * real network can fall through it.
 */
export function probeUrlFor(hostname: string): string {
  const host = hostname.split(':')[0] ?? hostname;
  const local = host === 'localhost' || host.endsWith('.localhost');
  return `${local ? 'http' : 'https'}://${hostname}/`;
}
