import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_DOMAIN,
  ContinuationError,
  GATEWAY_DOMAIN,
  continuationFor,
  gatewaySub,
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

/**
 * The Gateway Grant's vector, from `docs/spec/fixtures/wire/gateway_sub.vector.json`
 * in TOON_Network — generated and checked byte for byte by the reference
 * provider's own CI, exactly as the token's is, and inlined here for the same
 * reason (TOON_Network#97, spec §6.5.1).
 *
 * The second moment is the point of the fixture as much as the first: one
 * second later is an entirely different 32 bytes. That is what makes renewing
 * a grant an ordinary re-derivation rather than a migration, and what makes
 * `expires_at` a value the gateway must carry back to the provider verbatim.
 */
const GRANT_VECTOR = {
  continuation: '13aaa05ae89d8fb81acd101b9daabd5b037135291deac980842ee8b7c282fb6d',
  expiresAt: 1700086400,
  grant: 'd86f4764fa750ebd0a7f27303878c0b31afd941de27960fe538649f376a3d10f',
  laterExpiresAt: 1700086401,
  laterGrant: '11d53bef1ff05fba7708ae428018d7cfd9b0c5fd362be0c561111a041b237430',
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

describe('the Gateway Grant derivation (spec §6.5.1)', () => {
  it('derives the spec fixture’s vector, byte for byte', () => {
    expect(gatewaySub(GRANT_VECTOR.continuation, GRANT_VECTOR.expiresAt)).toBe(
      GRANT_VECTOR.grant
    );
  });

  it('derives from the TOKEN, so the same root gives each provider its own grant', () => {
    // The whole of why a Gateway Handover carries one grant per member of the
    // Standby Set rather than one value (§12.1, ADR 0017).
    const mine = gatewaySub(
      continuationFor(VECTOR.rootSecret, VECTOR.provider),
      GRANT_VECTOR.expiresAt
    );
    const theirs = gatewaySub(
      continuationFor(VECTOR.rootSecret, VECTOR.otherProvider),
      GRANT_VECTOR.expiresAt
    );
    expect(mine).toBe(GRANT_VECTOR.grant);
    expect(theirs).not.toBe(mine);
  });

  it('gives an entirely different value one second later', () => {
    expect(gatewaySub(GRANT_VECTOR.continuation, GRANT_VECTOR.laterExpiresAt)).toBe(
      GRANT_VECTOR.laterGrant
    );
    expect(GRANT_VECTOR.laterGrant).not.toBe(GRANT_VECTOR.grant);
  });

  it('spells its domain exactly as the spec does', () => {
    expect(GATEWAY_DOMAIN).toBe('toon-network-gateway:');
  });

  it('refuses a moment that is not unpadded decimal unix seconds', () => {
    for (const bad of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => gatewaySub(GRANT_VECTOR.continuation, bad)).toThrow(ContinuationError);
    }
  });

  it('refuses a malformed token without quoting it back', () => {
    try {
      gatewaySub('not-a-token-but-long-enough-to-be-tempting', GRANT_VECTOR.expiresAt);
      expect.unreachable('a malformed Continuation Token must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuationError);
      expect((error as Error).message).not.toContain('tempting');
    }
  });
});
