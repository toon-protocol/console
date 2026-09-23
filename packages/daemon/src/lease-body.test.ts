import { describe, expect, it } from 'vitest';

import { LeaseBodyError, checkLeaseBody, extendBody } from './lease-body.js';

/**
 * The shape rule of spec §5, and the one refusal in this console that has to
 * happen before a packet exists (TOON_Network#115, ADR 0003, ADR 0025).
 *
 * `lease-route.test.ts` is the other half: there the same check runs where the
 * real client would be built, and the assertion is that nothing was sent.
 */
const ADDR = 'g.toon.provider';
const ID = 'a'.repeat(64);
const ENVELOPE = {
  request: {
    request_id: 'b'.repeat(64),
    op: 'status',
    provider: 'c'.repeat(64),
    expiration: 1_800_000_000,
    continuation: 'd'.repeat(64),
    content: { workload_id: ID },
  },
};

describe('extendBody', () => {
  it('is bare: one key, no Lease Request, no token', () => {
    expect(extendBody(ID)).toEqual({ workload_id: ID });
    expect(Object.keys(extendBody(ID))).toEqual(['workload_id']);
  });

  it('refuses a workload id that is not 64 lowercase hex', () => {
    for (const bad of ['toon-1000', '', ID.toUpperCase(), `${ID}00`]) {
      expect(() => extendBody(bad)).toThrow(LeaseBodyError);
    }
  });
});

describe('checkLeaseBody', () => {
  it('passes the bare body on both extension routes', () => {
    for (const route of [`${ADDR}.basic.v1.extend`, `${ADDR}.warm.v1.standby.extend`]) {
      expect(checkLeaseBody(route, extendBody(ID))).toEqual({ workload_id: ID });
    }
  });

  it('refuses the envelope on an extension route, and says nothing was sent', () => {
    // The mistake #115 was billed a full Lease Interval for.
    for (const route of [`${ADDR}.basic.v1.extend`, `${ADDR}.warm.v1.standby.extend`]) {
      expect(() => checkLeaseBody(route, ENVELOPE)).toThrow(LeaseBodyError);
      expect(() => checkLeaseBody(route, ENVELOPE)).toThrow(/BARE .*Nothing was sent/s);
      expect(() => checkLeaseBody(route, ENVELOPE)).toThrow(/FULL PRICE/);
    }
  });

  it('refuses a bare body on each of the five enveloped routes', () => {
    for (const route of [
      `${ADDR}.basic.v1.spawn`,
      `${ADDR}.warm.v1.standby`,
      `${ADDR}.status`,
      `${ADDR}.terminate`,
      `${ADDR}.rotate`,
    ]) {
      expect(checkLeaseBody(route, ENVELOPE)).toBe(ENVELOPE);
      expect(() => checkLeaseBody(route, { workload_id: ID })).toThrow(LeaseBodyError);
    }
  });

  it('leaves alone a route that is none of §5s', () => {
    // A relay write is not a lease packet, and `relay-write.ts` owns it.
    const body = { event: { kind: 30432 } };
    expect(checkLeaseBody('g.toon.relay', body)).toBe(body);
    expect(checkLeaseBody(`${ADDR}.availability`, { listing: 'basic', version: 1 })).toEqual({
      listing: 'basic',
      version: 1,
    });
  });

  it('refuses a body that is not an object at all', () => {
    expect(() => checkLeaseBody(`${ADDR}.basic.v1.extend`, undefined)).toThrow(LeaseBodyError);
    expect(() => checkLeaseBody(`${ADDR}.status`, 'workload_id')).toThrow(LeaseBodyError);
  });
});
