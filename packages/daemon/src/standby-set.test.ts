import { describe, expect, it } from 'vitest';

import { checkStandbySet, routeOpFor, setRunway, type RunwayMember } from './standby-set.js';

/**
 * The Standby Set's rules and its arithmetic (TOON_Network#95, spec §7).
 *
 * Everything here is pure, and that is the point: each of these answers costs
 * real money to get wrong at a provider. A `standby_set` that repeats a
 * provider is `invalid_request` at EVERY member and billed at each of them
 * (§6.2 step 3, ADR 0003); a reservation extended on `.extend` is
 * `not_running` and billed at the running price (§6.3); and a runway that
 * counted only the primary would let a Warm Standby's reservation lapse while
 * telling a person their workload was protected for a week.
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('a Standby Set’s shape (§6.2 step 3, §7)', () => {
  it('accepts a primary and one Warm Standby', () => {
    expect(checkStandbySet([A, B])).toEqual([]);
  });

  it('refuses a set of one: that is a standalone lease, which carries no list', () => {
    expect(checkStandbySet([A]).join(' ')).toContain('at least one Warm Standby');
  });

  it('refuses a provider named twice: two positions is two roles', () => {
    expect(checkStandbySet([A, B, A]).join(' ')).toContain('named twice');
  });

  it('refuses anything that is not a 64-hex provider key', () => {
    // The key is spelled into the Continuation Token's derivation (§6.1.1), so
    // any other spelling derives a token that provider does not hold.
    expect(checkStandbySet([A.toUpperCase(), B]).join(' ')).toContain('public key');
  });
});

describe('which route keeps a member alive (§6.3)', () => {
  it('pays a Reserved Warm Standby on `.standby.extend`', () => {
    expect(routeOpFor('reserved')).toBe('standby.extend');
  });

  it('pays everything else that is still a lease on `.extend`', () => {
    // Including a primary that stopped ITSELF under §7.1: the lease stands,
    // and `.extend` still adds an interval at the running price.
    expect(routeOpFor('running')).toBe('extend');
    expect(routeOpFor('stopped')).toBe('extend');
    expect(routeOpFor('provisioning')).toBe('extend');
  });

  it('pays an ended lease on neither: §6.3 answers `expired` on both', () => {
    expect(routeOpFor('ended')).toBeUndefined();
  });
});

describe('the runway of a whole Standby Set (§7)', () => {
  const member = (overrides: Partial<RunwayMember> & { pubkey: string }): RunwayMember => ({
    index: 0,
    leaseIntervalSeconds: 600,
    ...overrides,
  });

  it('adds up what one ROUND of extensions costs, primary and standbys alike', () => {
    const runway = setRunway([
      member({
        pubkey: A,
        index: 0,
        paidSeconds: 300,
        pricePerInterval: '1000',
        op: 'extend',
        channelKey: 'hub|evm|0x1',
        available: '7000',
      }),
      member({
        pubkey: B,
        index: 1,
        paidSeconds: 300,
        pricePerInterval: '400',
        op: 'standby.extend',
        channelKey: 'hub|evm|0x1',
        available: '7000',
      }),
    ]);

    expect(runway.state).toBe('computed');
    // 1000 + 400 a round, out of one shared channel holding 7000: five whole
    // rounds, never five-and-a-bit — §6.3 sells whole intervals.
    expect(runway.pricePerInterval).toBe('1400');
    expect(runway.rounds).toBe(5);
    expect(runway.seconds).toBe(300 + 5 * 600);
  });

  it('counts money per CHANNEL: two connectors are two balances', () => {
    const runway = setRunway([
      member({
        pubkey: A,
        index: 0,
        paidSeconds: 0,
        pricePerInterval: '1000',
        channelKey: 'hub-a|evm|0x1',
        available: '10000',
      }),
      member({
        pubkey: B,
        index: 1,
        paidSeconds: 0,
        pricePerInterval: '400',
        channelKey: 'hub-b|evm|0x2',
        available: '800',
      }),
    ]);

    // The first channel buys ten rounds and the second buys two. The set stops
    // being a set after two, so two is the answer.
    expect(runway.rounds).toBe(2);
    expect(runway.seconds).toBe(2 * 600);
  });

  it('is bounded by the member that runs out first, and names it', () => {
    const runway = setRunway([
      member({
        pubkey: A,
        index: 0,
        paidSeconds: 5000,
        pricePerInterval: '1000',
        channelKey: 'hub|evm|0x1',
        available: '1000',
      }),
      member({
        pubkey: B,
        index: 1,
        paidSeconds: 100,
        pricePerInterval: '400',
        channelKey: 'hub|evm|0x1',
        available: '1000',
      }),
    ]);

    // One round is affordable (1400 > 1000 leaves none, in fact zero rounds),
    // so the set lives as long as its shortest member's paid time.
    expect(runway.rounds).toBe(0);
    expect(runway.seconds).toBe(100);
    expect(runway.boundBy).toBe(B);
  });

  it('answers `unknown` with a reason rather than a zero', () => {
    const runway = setRunway([
      member({
        pubkey: A,
        index: 0,
        paidSeconds: 300,
        pricePerInterval: '1000',
        channelKey: 'hub|evm|0x1',
        available: '7000',
      }),
      member({ pubkey: B, index: 1, unknown: 'has no route this console can price' }),
    ]);

    expect(runway.state).toBe('unknown');
    expect(runway.reason).toContain('has no route this console can price');
    expect(runway.seconds).toBeUndefined();
  });

  it('leaves an ended member out of the sum entirely', () => {
    const runway = setRunway([
      member({
        pubkey: A,
        index: 0,
        paidSeconds: 600,
        pricePerInterval: '1000',
        channelKey: 'hub|evm|0x1',
        available: '2000',
      }),
      member({ pubkey: B, index: 1, ended: true }),
    ]);

    // An ended lease costs nothing and buys nothing: §6.3 refuses an extension
    // on one as `expired` and bills for the refusal.
    expect(runway.state).toBe('computed');
    expect(runway.pricePerInterval).toBe('1000');
    expect(runway.rounds).toBe(2);
    expect(runway.boundBy).toBe(A);
  });

  it('says so when every member has ended', () => {
    const runway = setRunway([
      member({ pubkey: A, index: 0, ended: true }),
      member({ pubkey: B, index: 1, ended: true }),
    ]);

    expect(runway.state).toBe('unknown');
    expect(runway.reason).toContain('has ended');
  });

  it('is `unbounded` only when every route really costs nothing', () => {
    const runway = setRunway([
      member({ pubkey: A, index: 0, paidSeconds: 60, pricePerInterval: '0' }),
      member({ pubkey: C, index: 1, paidSeconds: 60, pricePerInterval: '0' }),
    ]);

    expect(runway.state).toBe('unbounded');
  });
});
