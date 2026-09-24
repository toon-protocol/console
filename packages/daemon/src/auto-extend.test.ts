import { beforeEach, describe, expect, it } from 'vitest';

import {
  AutoExtender,
  InMemoryAutoExtendStore,
  leadFor,
  type AutoExtendStore,
  type WorkloadOps,
} from './auto-extend.js';
import { WorkloadError, type ExtendResult, type WorkloadCard } from './workload.js';

/**
 * Automatic extension, within a budget (TOON_Network#93).
 *
 * This is the one thing in the console that spends money with nobody present,
 * so the tests are about what it REFUSES to do. The acceptance criterion —
 * "automatic extension respects a budget and stops when it is spent" — is one
 * case among nine here, and each of the others is a different way a budget
 * could drain a channel if it were written carelessly: a price that moved, a
 * provider that went quiet, a refusal retried on a timer, an extension whose
 * fate nobody reported, a lease that had already ended.
 *
 * Every one of them is checked twice: that it stopped, and that `extend` was
 * never called.
 */

const ACCOUNT = 'a'.repeat(64);
const WORKLOAD = 'b'.repeat(64);

/** A card in whatever state a case needs, with nothing real behind it. */
function card(
  overrides: {
    expiresAt?: number;
    price?: string;
    life?: WorkloadCard['status'];
    extendOk?: boolean;
    problems?: string[];
  } = {}
): WorkloadCard {
  const status: WorkloadCard['status'] = overrides.life ?? {
    kind: 'read',
    life: { phase: 'running' },
    expiresAt: overrides.expiresAt ?? 1_700_000_300,
    readAt: '2026-09-23T00:00:00.000Z',
  };
  const provider = {
    pubkey: 'd'.repeat(64),
    ilp_address: 'g.toon.provider',
    connector_url: 'https://provider.example/ilp',
    connector_seal_key: '0x04aa',
  };
  const listing = {
    name: 'basic',
    version: 1,
    address: `30432:${'d'.repeat(64)}:basic`,
    lease_interval_s: 3600,
    price: 1000,
  };
  const route = {
    route: 'g.toon.provider.basic.v1.extend',
    payAt: 'https://provider.example/ilp',
    via: 'provider-connector' as const,
    reason: 'because',
    price: overrides.price ?? '1000',
  };
  return {
    workloadId: WORKLOAD,
    lease: {
      workloadId: WORKLOAD,
      state: 'live',
      standbySet: ['d'.repeat(64)],
      members: [
        {
          pubkey: 'd'.repeat(64),
          index: 0,
          role: 'standalone',
          provider,
          listing,
          paidAt: 'https://provider.example/ilp',
          state: 'live',
          known: true,
        },
      ],
      provider: {
        pubkey: 'd'.repeat(64),
        ilp_address: 'g.toon.provider',
        connector_url: 'https://provider.example/ilp',
        connector_seal_key: '0x04aa',
      },
      paidAt: 'https://provider.example/ilp',
      listing: {
        name: 'basic',
        version: 1,
        address: `30432:${'d'.repeat(64)}:basic`,
        lease_interval_s: 3600,
        price: 1000,
      },
      profileId: 'sandbox',
      image: { digest: `sha256:${'0'.repeat(64)}` },
      ports: [],
      envKeys: [],
      sshOffered: true,
      createdAt: '2026-09-23T00:00:00.000Z',
      localOnly: false,
      source: 'relays',
      relays: [],
      recordId: 'e'.repeat(64),
    },
    provider: {
      pubkey: 'd'.repeat(64),
      ilpAddress: 'g.toon.provider',
      connectorUrl: 'https://provider.example/ilp',
      hidden: false,
      inDirectory: true,
    },
    status,
    runway: { state: 'computed', listingPrice: 1000, leaseIntervalSeconds: 3600, readAt: 'x' },
    extend: {
      ok: overrides.extendOk ?? true,
      problems: overrides.problems ?? [],
      route,
    },
    members: [
      {
        pubkey: 'd'.repeat(64),
        index: 0,
        role: 'standalone',
        provider: {
          ilpAddress: 'g.toon.provider',
          connectorUrl: 'https://provider.example/ilp',
          hidden: false,
          inDirectory: true,
        },
        listing,
        status,
        extend: {
          ok: overrides.extendOk ?? true,
          op: 'extend',
          problems: overrides.problems ?? [],
          route,
        },
        runningNow: status.kind === 'read' && status.life.phase === 'running',
        selfStopped: status.kind === 'read' && status.life.phase === 'stopped',
        vaultState: 'live',
        known: true,
      },
    ],
    set: {
      members: 1,
      warm: false,
      ...(status.kind === 'read' && status.life.phase === 'ended'
        ? { pricePerInterval: '0' }
        : { pricePerInterval: overrides.price ?? '1000' }),
    },
  };
}

class FakeOps implements WorkloadOps {
  next: WorkloadCard = card();
  answer: ExtendResult | (() => ExtendResult) = extended(1_700_003_900);
  readonly calls: {
    workloadId: string;
    maxPrice?: string | undefined;
    member?: string | undefined;
  }[] = [];

  card(): Promise<WorkloadCard> {
    return Promise.resolve(this.next);
  }

  extend(
    workloadId: string,
    options: { maxPrice?: string | undefined; member?: string | undefined } = {}
  ): Promise<ExtendResult> {
    this.calls.push({ workloadId, ...options });
    return Promise.resolve(typeof this.answer === 'function' ? this.answer() : this.answer);
  }
}

function extended(expiresAt: number, cost = '1000'): ExtendResult {
  return {
    sent: true,
    problems: [],
    member: 'd'.repeat(64),
    op: 'extend',
    cost,
    expiresAt,
    card: card(),
  };
}

describe('automatic extension within a budget', () => {
  let store: AutoExtendStore;
  let ops: FakeOps;
  let budgets: AutoExtender;
  let now: number;

  const arm = (input: { budget?: string; agreedPrice?: string; lead?: number } = {}) =>
    budgets.arm({
      workloadId: WORKLOAD,
      budget: input.budget ?? '3000',
      agreedPrice: input.agreedPrice ?? '1000',
      ...(input.lead === undefined ? {} : { leadSeconds: input.lead }),
      confirm: true,
    });

  const policy = () => store.get(ACCOUNT, WORKLOAD);

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new InMemoryAutoExtendStore();
    ops = new FakeOps();
    budgets = new AutoExtender({
      store,
      workloads: ops,
      pubkey: () => ACCOUNT,
      profileId: () => 'sandbox',
      now: () => new Date(now),
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('arming', () => {
    it('refuses without an explicit confirmation', async () => {
      await expect(
        budgets.arm({
          workloadId: WORKLOAD,
          budget: '3000',
          agreedPrice: '1000',
          confirm: false,
        })
      ).rejects.toMatchObject({ code: 'not_confirmed' });
      expect(policy()).toBeUndefined();
    });

    it('refuses a budget that is not money', async () => {
      await expect(arm({ budget: '0' })).rejects.toMatchObject({ code: 'invalid_budget' });
      await expect(arm({ budget: '3.5' })).rejects.toMatchObject({ code: 'invalid_budget' });
      expect(policy()).toBeUndefined();
    });

    it('refuses a price the account was not actually shown', async () => {
      ops.next = card({ price: '1100' });
      await expect(arm({ agreedPrice: '1000' })).rejects.toMatchObject({
        code: 'price_moved',
      });
      expect(policy()).toBeUndefined();
    });

    it('refuses a budget that buys no whole interval', async () => {
      await expect(arm({ budget: '999' })).rejects.toMatchObject({
        code: 'budget_below_price',
      });
    });

    it('arms nothing when nobody is signed in', async () => {
      budgets = new AutoExtender({
        store,
        workloads: ops,
        pubkey: () => undefined,
        profileId: () => 'sandbox',
      });
      await expect(arm()).rejects.toBeInstanceOf(WorkloadError);
    });

    it('keeps what a previous budget spent, so raising one grants no refund', async () => {
      await arm({ budget: '1000' });
      await budgets.tick();
      expect(policy()?.spent).toBe('1000');

      await arm({ budget: '5000' });
      expect(policy()?.spent).toBe('1000');
      expect(policy()?.extensions).toBe(1);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the budget', () => {
    it('extends while there is budget, and STOPS when it is spent', async () => {
      await arm({ budget: '2000' });

      const first = await budgets.tick();
      expect(first.runs[0]?.outcome).toBe('extended');
      expect(policy()?.spent).toBe('1000');

      const second = await budgets.tick();
      expect(second.runs[0]?.outcome).toBe('extended');
      expect(policy()?.spent).toBe('2000');

      // The third would take it past 2000, so nothing is sent at all.
      const calls = ops.calls.length;
      const third = await budgets.tick();
      expect(third.runs[0]?.outcome).toBe('stopped');
      expect(third.runs[0]?.reason).toContain('budget is spent');
      expect(ops.calls).toHaveLength(calls);
      expect(policy()?.armed).toBe(false);

      // And it stays stopped: a stopped policy is not reconsidered.
      const fourth = await budgets.tick();
      expect(fourth.considered).toBe(0);
      expect(ops.calls).toHaveLength(calls);
    });

    it('never overruns by one interval', async () => {
      await arm({ budget: '1500' });
      await budgets.tick();
      await budgets.tick();

      expect(policy()?.spent).toBe('1000');
      expect(policy()?.extensions).toBe(1);
      expect(BigInt(policy()!.spent)).toBeLessThanOrEqual(BigInt(policy()!.budget));
    });

    it('holds the extension to the price it agreed to', async () => {
      await arm();
      await budgets.tick();

      expect(ops.calls[0]?.maxPrice).toBe('1000');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('what stops it', () => {
    it('stops rather than paying a price that has moved', async () => {
      await arm();
      ops.next = card({ price: '1200' });

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('stopped');
      expect(report.runs[0]?.reason).toContain('ADR 0009');
      expect(ops.calls).toHaveLength(0);
    });

    it('stops on a lease that has ended', async () => {
      await arm();
      ops.next = card({
        life: {
          kind: 'read',
          life: { phase: 'ended', ending: 'eviction' },
          readAt: 'x',
        },
      });

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('stopped');
      expect(ops.calls).toHaveLength(0);
    });

    it('stops after a refusal, and charges the budget for it', async () => {
      await arm();
      ops.answer = {
        sent: true,
        problems: [],
        member: 'd'.repeat(64),
        op: 'extend',
        providerError: 'no_capacity',
        cost: '1000',
        card: card(),
      };

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('stopped');
      expect(report.runs[0]?.reason).toContain('no_capacity');
      // A refusal on a paid route is billed (ADR 0003), so it counts.
      expect(policy()?.spent).toBe('1000');
      expect(policy()?.extensions).toBe(0);
    });

    it('stops when an extension’s fate is unknown', async () => {
      await arm();
      ops.answer = {
        sent: true,
        problems: [],
        member: 'd'.repeat(64),
        op: 'extend',
        message: 'nothing came back',
        card: card(),
      };

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('stopped');
      expect(report.runs[0]?.reason).toContain('fate is unknown');
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('what makes it wait', () => {
    it('buys nothing while the provider is silent', async () => {
      await arm();
      ops.next = card({
        life: { kind: 'silent', reason: 'nothing came back', readAt: 'x' },
      });

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('waited');
      expect(report.runs[0]?.reason).toContain('nothing is bought on silence');
      expect(ops.calls).toHaveLength(0);
      // Waiting is not stopping: it tries again next tick.
      expect(policy()?.armed).toBe(true);
    });

    it('buys nothing before the lead window', async () => {
      await arm({ lead: 300 });
      ops.next = card({ expiresAt: Math.floor(now / 1000) + 3000 });

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('waited');
      expect(report.runs[0]?.reason).toContain('Not due yet');
      expect(ops.calls).toHaveLength(0);
    });

    it('buys nothing when the console is on another network', async () => {
      await arm();
      budgets = new AutoExtender({
        store,
        workloads: ops,
        pubkey: () => ACCOUNT,
        profileId: () => 'devnet',
        now: () => new Date(now),
      });

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('waited');
      expect(ops.calls).toHaveLength(0);
    });

    it('buys nothing when an extension could not be sent anyway', async () => {
      await arm();
      ops.next = card({ extendOk: false, problems: ['no channel here'] });

      const report = await budgets.tick();

      expect(report.runs[0]?.outcome).toBe('waited');
      expect(ops.calls).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('turning it off', () => {
    it('is off until it is armed, and a tick considers nothing', async () => {
      const report = await budgets.tick();
      expect(report.considered).toBe(0);
      expect(ops.calls).toHaveLength(0);
    });

    it('disarms by hand, and says so', async () => {
      await arm();
      budgets.disarm(WORKLOAD);

      const report = await budgets.tick();

      expect(report.considered).toBe(0);
      expect(budgets.view(ACCOUNT, WORKLOAD)?.armed).toBe(false);
      expect(budgets.view(ACCOUNT, WORKLOAD)?.stoppedBecause).toContain('by hand');
    });

    it('spends nothing while nobody is signed in', async () => {
      await arm();
      budgets = new AutoExtender({
        store,
        workloads: ops,
        pubkey: () => undefined,
        profileId: () => 'sandbox',
      });

      expect((await budgets.tick()).considered).toBe(0);
      expect(ops.calls).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('the lead window', () => {
    it('is bounded by the Lease Interval at one end and a minute at the other', () => {
      expect(leadFor(10, 3600)).toBe(60);
      expect(leadFor(100_000, 3600)).toBe(3600);
      expect(leadFor(900, 3600)).toBe(900);
      expect(leadFor(undefined, 3600)).toBe(900);
    });
  });

  /* ---------------------------------------------------------------------- */

  it('shows what it has spent, and what is left', async () => {
    await arm({ budget: '3000' });
    await budgets.tick();

    const view = budgets.view(ACCOUNT, WORKLOAD);
    expect(view).toMatchObject({
      armed: true,
      budget: '3000',
      spent: '1000',
      remaining: '2000',
      extensions: 1,
      agreedPrice: '1000',
    });
    expect(view?.lastRun?.outcome).toBe('extended');
  });
});
