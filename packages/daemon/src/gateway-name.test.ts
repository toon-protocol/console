import { describe, expect, it } from 'vitest';

import {
  GatewayNameError,
  base32Lower,
  canonicalLabel,
  hostnameFor,
  probeUrlFor,
  sameHostname,
} from './gateway-name.js';

/**
 * Spec §12.2's own worked example, and the tenant-side tool's second vector.
 *
 * The first is written into the specification beside the rule; the second is
 * the one `gateway/src/hostname.mjs` checks itself against. Between them they
 * pin the alphabet (a `0` or a `1` anywhere would mean base32hex), the case
 * and the absence of padding.
 */
const VECTORS = [
  {
    workloadId: 'aa'.repeat(32),
    label: 'vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva',
  },
  {
    workloadId: '0123456789abcdef'.repeat(4),
    label: 'aerukz4jvpg66ajdivtytk6n54asgrlhrgv433ybencwpcnlzxxq',
  },
];

describe('the canonical hostname (spec §12.2)', () => {
  it('derives the spec’s own worked example', () => {
    for (const vector of VECTORS) {
      expect(canonicalLabel(vector.workloadId)).toBe(vector.label);
    }
  });

  it('gives a 52-character DNS label, in RFC 4648’s alphabet, unpadded', () => {
    for (const vector of VECTORS) {
      expect(vector.label).toHaveLength(52);
      // 52 because a DNS label may be 63 and the same id in hex would be 64.
      expect(vector.label).toMatch(/^[a-z2-7]{52}$/u);
      expect(vector.label).not.toContain('=');
    }
  });

  it('encodes the BYTES of the id, not its hex spelling', () => {
    // The mistake this catches costs a hostname nobody serves: base32 of the
    // 64 ASCII characters is 104 characters long and would not be a label.
    expect(base32Lower(new TextEncoder().encode('ab'))).toBe('mfra');
    expect(base32Lower(new Uint8Array([0x61, 0x62]))).toBe('mfra');
  });

  it('puts the label under the profile’s gateway domain, lowercased', () => {
    expect(hostnameFor(VECTORS[0]!.workloadId, 'GW.Devnet.Example.')).toBe(
      `${VECTORS[0]!.label}.gw.devnet.example`
    );
  });

  it('shows no hostname for a profile that names no gateway domain', () => {
    // Mainnet today, and any profile an operator has not finished. Not a fault.
    expect(hostnameFor(VECTORS[0]!.workloadId, '')).toBeUndefined();
    expect(hostnameFor(VECTORS[0]!.workloadId, '   ')).toBeUndefined();
  });

  it('refuses a workload id that is not 64 lowercase hex', () => {
    expect(() => canonicalLabel('AA'.repeat(32))).toThrow(GatewayNameError);
    expect(() => canonicalLabel('aa')).toThrow(GatewayNameError);
  });

  it('knocks on HTTPS everywhere but the loopback', () => {
    expect(probeUrlFor('label.gw.devnet.toonprotocol.dev')).toBe(
      'https://label.gw.devnet.toonprotocol.dev/'
    );
    // The sandbox: no certificate authority issues for `.localhost`, so the
    // gateway there publishes a plain listener beside its TLS one.
    expect(probeUrlFor('label.gw.localhost:3280')).toBe('http://label.gw.localhost:3280/');
  });

  it('compares a served hostname with a derived one as names, port and case aside (#149)', () => {
    // The sandbox's `gatewayDomain` is `gw.localhost:3280`; its gateway knows
    // its domain as `gw.localhost` and answers without the host's port.
    expect(sameHostname('label.gw.localhost', 'label.gw.localhost:3280')).toBe(true);
    expect(sameHostname('LABEL.gw.localhost.', 'label.gw.localhost')).toBe(true);
    expect(sameHostname('other.gw.localhost', 'label.gw.localhost:3280')).toBe(false);
    expect(sameHostname('label.gw.example', 'label.gw.localhost:3280')).toBe(false);
  });
});
