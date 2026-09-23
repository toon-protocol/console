import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_DOMAIN,
  ContinuationError,
  continuationFor,
  mintRequestId,
  mintRootSecret,
} from './continuation.js';
import { HEX_32 } from './spawn-content.js';

/**
 * The spec's own vector, copied from `docs/spec/fixtures/wire/continuation.vector.json`
 * in TOON_Network — which the reference provider's CI generates from
 * `tests/wire_fixtures.rs` and checks byte for byte.
 *
 * It is inlined rather than read from disk because the console does not vendor
 * the spec repository, and a test that silently skipped when a path was
 * missing would be no test at all. What matters is the numbers, and if the
 * spec ever changes them this file is the one place to correct.
 */
const VECTOR = {
  rootSecret: '1111111111111111111111111111111111111111111111111111111111111111',
  provider: '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  continuation: '13aaa05ae89d8fb81acd101b9daabd5b037135291deac980842ee8b7c282fb6d',
  otherProvider: '9ac20335eb38768d2052be1dbbc3c8f6178407458e51e6b4ad22f1d91758895b',
  otherContinuation: '6cb520deda69804e609a7acd5d2bbb6f0de422ece143d417a14e1396d75955e1',
};

describe('the Continuation Token derivation (spec §6.1.1)', () => {
  it('derives the spec fixture’s vector, byte for byte', () => {
    expect(continuationFor(VECTOR.rootSecret, VECTOR.provider)).toBe(VECTOR.continuation);
  });

  it('derives a DIFFERENT token for another provider from the same root', () => {
    // The whole of why one member of a Standby Set cannot act as the tenant
    // against another (spec §7).
    expect(continuationFor(VECTOR.rootSecret, VECTOR.otherProvider)).toBe(
      VECTOR.otherContinuation
    );
    expect(VECTOR.continuation).not.toBe(VECTOR.otherContinuation);
  });

  it('spells its domain exactly as the spec does', () => {
    expect(CONTINUATION_DOMAIN).toBe('toon-network-continuation:');
  });

  it('refuses a provider key that is not lowercase hex, rather than normalizing it', () => {
    // Upper case would derive a token the provider does not hold, and a spawn
    // is paid for: the money is gone and the lease is unreadable.
    expect(() => continuationFor(VECTOR.rootSecret, VECTOR.provider.toUpperCase())).toThrow(
      ContinuationError
    );
    expect(() => continuationFor(VECTOR.rootSecret, 'npub1whatever')).toThrow(
      ContinuationError
    );
  });

  it('refuses a malformed root secret without quoting it back', () => {
    try {
      continuationFor('not-a-secret-but-long-enough-to-be-tempting', VECTOR.provider);
      expect.unreachable('a malformed root secret must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuationError);
      expect((error as Error).message).not.toContain('tempting');
    }
  });

  it('mints 32 fresh bytes, as hex, every time', () => {
    const first = mintRootSecret();
    const second = mintRootSecret();
    expect(first).toMatch(HEX_32);
    expect(second).toMatch(HEX_32);
    expect(first).not.toBe(second);
    expect(mintRequestId()).toMatch(HEX_32);
  });
});
