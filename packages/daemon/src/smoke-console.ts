/**
 * `smoke-console` — what the whole console is worth, on a live network
 * (TOON_Network#101, Milestone 8's testing decisions).
 *
 * This file is the part with no sockets in it: the report a run builds, the
 * plan that decides which stages a network can actually prove, and the printer
 * that says what happened. `smoke-console-run.ts` drives the daemon;
 * `main-smoke-console.ts` parses the arguments. The split is the same one the
 * rest of this package uses — policy where it can be tested, endpoints next
 * door — and it matters more here than usual, because the one thing a smoke
 * must never do is report success for something it did not prove. That
 * judgement is a pure function, and `smoke-console.test.ts` is the test that
 * pins it.
 *
 * ## The three outcomes, and why there are three
 *
 * A stage **passes** when the network answered and the answer was asserted.
 * It **fails** when an assertion did not hold. And it is **skipped** when the
 * network this run was pointed at cannot carry it at all — devnet publishes
 * one provider, so no Standby Set can be sold there; the sandbox runs no
 * Workload Gateway unless `make up-gateway` did; a Hidden Provider exists on
 * the sandbox and nowhere else today.
 *
 * A skip is never a pass. It is printed as its own word, counted separately,
 * and the summary ends with an explicit list of what this run did NOT prove,
 * so that a green sandbox run cannot be mistaken for a green everything.
 */

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

export type StageState = 'passed' | 'skipped' | 'failed';

/** Every stage this smoke knows, in the order it runs them. */
export const STAGES = [
  'daemon',
  'signin',
  'chain-seed',
  'directory',
  'funds',
  'gas-station',
  'publish-seed',
  'template',
  'spawn',
  'dashboard',
  'extend',
  'rotate',
  'standby-set',
  'hidden',
  'gateway',
  'terminate',
  'recover',
  'clean',
] as const;

export type StageName = (typeof STAGES)[number];

/** One line each, so `--help` and the printer say the same thing. */
export const STAGE_TITLES: Readonly<Record<StageName, string>> = {
  daemon: 'a daemon on a private data directory',
  signin: 'sign in with a local key',
  'chain-seed': 'seal a Chain Seed to the account',
  directory: 'read the Provider Directory',
  funds: 'fund the payer and open every channel that will collect',
  'gas-station': "buy a blocked chain's gas, and open its channel unaided",
  'publish-seed': 'publish the sealed seed — one paid relay write',
  template: 'a Template on the relay, and its expansion',
  spawn: 'spawn from the Template, Root Secret vaulted first',
  dashboard: 'the workload card: state, expiry and runway',
  extend: 'buy one more Lease Interval',
  rotate: "replace the lease's Continuation Token",
  'standby-set': 'a Standby Set can be bought here',
  hidden: 'a Hidden Provider is reachable, or refused out loud',
  gateway: 'hand the workload to a Workload Gateway',
  terminate: 'end the lease',
  recover: 'a FRESH data directory recovers the vault',
  clean: 'nothing left running, and what the run cost',
};

export interface StageResult {
  readonly name: StageName;
  readonly state: StageState;
  /**
   * One sentence. For a pass, what it proved; for a skip, why this network
   * cannot carry it; for a failure, what did not hold.
   */
  readonly detail: string;
  /** The assertions that held, one line each. Empty on a skip. */
  readonly facts: readonly string[];
  /** Base units of the settlement token this stage spent. */
  readonly cost: string;
  readonly ms: number;
}

export interface SmokeReport {
  readonly profile: string;
  readonly connectorUrl: string;
  readonly relayUrl: string;
  /** The chain the channel was opened on, once one is. */
  readonly chain?: string | undefined;
  /** The settlement token's base units are what every `cost` here counts. */
  readonly token?: string | undefined;
  readonly stages: readonly StageResult[];
  readonly passed: number;
  readonly skipped: number;
  readonly failed: number;
  /** Everything spent, in base units. */
  readonly spent: string;
  /** What is left in the channel, and therefore what a re-run can still buy. */
  readonly residual?: string | undefined;
  readonly verdict: 'green' | 'red';
  readonly startedAt: string;
  readonly ms: number;
}

/** An assertion that did not hold. Thrown by a stage, caught by the runner. */
export class SmokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeFailure';
  }
}

/** A stage this network cannot carry. Thrown by a stage, caught by the runner. */
export class SmokeSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeSkip';
  }
}

/**
 * The one assertion helper.
 *
 * `message` says what was expected in the words a reader of the output needs,
 * because it is the sentence the failure line carries. "the card reads running"
 * is a useful failure; "expected true" is not.
 */
export function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

/** The same, for a value that must be there. Returns it, narrowed. */
export function present<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new SmokeFailure(message);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Keeping the tally                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The running report.
 *
 * A class rather than an accumulator passed around, because a stage must be
 * unable to finish without saying which of the three things happened to it:
 * `run` is the only way in, and it records one of `passed`, `skipped` or
 * `failed` for every stage it is given, including the ones that threw
 * something nobody expected.
 */
export class SmokeRun {
  readonly #stages: StageResult[] = [];
  readonly #startedAt = new Date();
  readonly #began = Date.now();
  readonly #log: (line: string) => void;
  #spent = 0n;
  #chain: string | undefined;
  #token: string | undefined;
  #residual: string | undefined;

  constructor(
    readonly profile: string,
    readonly connectorUrl: string,
    readonly relayUrl: string,
    log: (line: string) => void = () => undefined
  ) {
    this.#log = log;
  }

  /** What the channel settles in, once the funding stage has read it. */
  settles(chain: string, token: string): void {
    this.#chain = chain;
    this.#token = token;
  }

  /** What is left in the channel, read at the end. */
  leaves(residual: string): void {
    this.#residual = residual;
  }

  /**
   * Run one stage.
   *
   * The stage collects its own assertions by calling `fact`, and says what it
   * cost by calling `spent`. Whatever it returns is handed back to the caller,
   * so a stage that produces something the next one needs — a workload id, a
   * Template address — reads as an ordinary assignment. A skipped or failed
   * stage returns `undefined`, and the runner decides whether that is fatal.
   */
  async run<T>(
    name: StageName,
    body: (step: StageTools) => Promise<T>
  ): Promise<T | undefined> {
    const began = Date.now();
    const facts: string[] = [];
    let cost = 0n;
    const tools: StageTools = {
      fact: (line) => {
        facts.push(line);
      },
      spent: (amount) => {
        if (amount === undefined) return;
        const units = BigInt(amount);
        cost += units;
        this.#spent += units;
      },
      skip: (why) => {
        throw new SmokeSkip(why);
      },
    };

    try {
      const value = await body(tools);
      this.#record(name, 'passed', detailOf(facts), facts, cost, began);
      return value;
    } catch (error) {
      if (error instanceof SmokeSkip) {
        this.#record(name, 'skipped', error.message, [], cost, began);
        return undefined;
      }
      const message =
        error instanceof SmokeFailure
          ? error.message
          : `${error instanceof Error ? error.message : String(error)}`;
      this.#record(name, 'failed', message, facts, cost, began);
      return undefined;
    }
  }

  get failed(): boolean {
    return this.#stages.some((stage) => stage.state === 'failed');
  }

  /** Did this stage pass? Asked by a later stage that depends on it. */
  passed(name: StageName): boolean {
    return this.#stages.some((stage) => stage.name === name && stage.state === 'passed');
  }

  report(): SmokeReport {
    const counted = (state: StageState) =>
      this.#stages.filter((stage) => stage.state === state).length;
    return {
      profile: this.profile,
      connectorUrl: this.connectorUrl,
      relayUrl: this.relayUrl,
      chain: this.#chain,
      token: this.#token,
      stages: [...this.#stages],
      passed: counted('passed'),
      skipped: counted('skipped'),
      failed: counted('failed'),
      spent: this.#spent.toString(),
      residual: this.#residual,
      verdict: this.failed ? 'red' : 'green',
      startedAt: this.#startedAt.toISOString(),
      ms: Date.now() - this.#began,
    };
  }

  #record(
    name: StageName,
    state: StageState,
    detail: string,
    facts: readonly string[],
    cost: bigint,
    began: number
  ): void {
    const stage: StageResult = {
      name,
      state,
      detail,
      facts: [...facts],
      cost: cost.toString(),
      ms: Date.now() - began,
    };
    this.#stages.push(stage);
    this.#log(stageLine(stage));
    for (const fact of state === 'failed' ? facts : []) this.#log(`         · ${fact}`);
  }
}

export interface StageTools {
  /** Record an assertion that held. */
  readonly fact: (line: string) => void;
  /** Record base units spent. `undefined` is "nothing was reported", not zero. */
  readonly spent: (amount: string | undefined) => void;
  /** This network cannot carry this stage. Never called for a failure. */
  readonly skip: (why: string) => never;
}

/** A passed stage's headline: its last assertion, which is its conclusion. */
function detailOf(facts: readonly string[]): string {
  return facts[facts.length - 1] ?? 'nothing was asserted';
}

/* -------------------------------------------------------------------------- */
/* What a network can carry                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What this run's network offers, as the stages need to know it.
 *
 * Read from the network itself — the profile's endpoints, the directory it
 * serves, the connector's own `GET /ilp` — and never from a table of which
 * network is which. A second provider appearing on devnet must turn the
 * Standby Set stage on without anybody editing this file.
 */
export interface NetworkFacts {
  /** Providers whose connector this console could reach directly. */
  readonly clearnetProviders: number;
  /** Providers selling a tier that sets a `standby_price` (§7). */
  readonly standbySellers: number;
  /** Providers published as `hidden` (§10). */
  readonly hiddenProviders: number;
  /** Whether the profile names a Workload Gateway's connector at all. */
  readonly gatewayConnectorUrl: string;
  /** Whether that connector answered, and published a handover route (§12.1). */
  readonly gatewayHandoverRoute: boolean;
  /** Whether this console was given an Anyone Protocol SOCKS proxy (ADR 0008). */
  readonly socksProxy: boolean;
}

export interface StageVerdict {
  readonly run: boolean;
  /** Why not, in the words the skip line will carry. */
  readonly reason: string;
}

/**
 * Whether the three conditional stages can be proved here.
 *
 * Each answer names the fact that decided it, because "skipped" with no reason
 * is the failure mode this whole ticket exists to avoid. A reader of the output
 * must be able to tell "this network has no gateway" from "the gateway was not
 * tried".
 */
export function planConditional(
  facts: NetworkFacts
): Readonly<Record<'standby-set' | 'hidden' | 'gateway', StageVerdict>> {
  return {
    'standby-set':
      facts.standbySellers >= 2
        ? { run: true, reason: '' }
        : {
            run: false,
            reason:
              `a Standby Set is one workload bought from two providers (§7), and this ` +
              `network publishes ${facts.standbySellers} selling a tier with a ` +
              '`standby_price`. Nothing here can prove a reservation or a Takeover.',
          },
    hidden:
      facts.hiddenProviders > 0
        ? { run: true, reason: '' }
        : {
            run: false,
            reason:
              'no Provider Profile on this network is published `hidden` (§10), so there is ' +
              'no `.anyone` address for a circuit to reach.',
          },
    gateway: gatewayVerdict(facts),
  };
}

function gatewayVerdict(facts: NetworkFacts): StageVerdict {
  if (facts.gatewayConnectorUrl.length === 0) {
    return {
      run: false,
      reason:
        'this profile names no Workload Gateway connector, and a gateway is chosen by a ' +
        'packet rather than by a publication (ADR 0017) — so there is nowhere to seal a ' +
        'handover to.',
    };
  }
  if (!facts.gatewayHandoverRoute) {
    return {
      run: false,
      reason:
        `the connector at ${facts.gatewayConnectorUrl} published no ` +
        '`…workload-gateway.handover` route, so no gateway is running behind it. On the ' +
        'sandbox that is `make up-gateway`.',
    };
  }
  return { run: true, reason: '' };
}

/* -------------------------------------------------------------------------- */
/* Printing it                                                                */
/* -------------------------------------------------------------------------- */

const MARK: Readonly<Record<StageState, string>> = {
  passed: 'ok  ',
  skipped: 'skip',
  failed: 'FAIL',
};

export function stageLine(stage: StageResult): string {
  const ms = `${stage.ms}ms`.padStart(7);
  return `  ${MARK[stage.state]}  ${stage.name.padEnd(12)}${ms}  ${stage.detail}`;
}

/**
 * The ending.
 *
 * It says what was spent, what is left, and — always, even on a green run —
 * every stage that was skipped and the reason. A run with nothing skipped
 * prints "nothing was skipped", because the absence of that block would
 * otherwise be indistinguishable from a printer that forgot.
 */
export function summarize(report: SmokeReport): string {
  const lines: string[] = [''];
  const skipped = report.stages.filter((stage) => stage.state === 'skipped');
  const failed = report.stages.filter((stage) => stage.state === 'failed');

  lines.push(
    `${report.verdict === 'green' ? 'GREEN' : 'RED'} — ${report.passed} proved, ` +
      `${report.skipped} skipped, ${report.failed} failed, in ` +
      `${Math.round(report.ms / 1000)}s on “${report.profile}”.`
  );

  lines.push('');
  lines.push(
    `Spent ${report.spent} base units` +
      (report.token === undefined ? '' : ` of ${report.token}`) +
      (report.chain === undefined ? '' : ` on ${report.chain}`) +
      '.' +
      (report.residual === undefined
        ? ''
        : ` ${report.residual} base units are left in the channel.`)
  );

  // A run says three things about what it did NOT prove, and a reader must be
  // able to tell them apart: a stage this network cannot carry, a stage an
  // earlier failure stopped it reaching, and neither. The third is the only
  // one that may be said with a single cheerful sentence.
  const reached = new Set(report.stages.map((stage) => stage.name));
  const missed = STAGES.filter((stage) => !reached.has(stage));

  lines.push('');
  if (skipped.length > 0) {
    lines.push(`NOT PROVED on this network (${skipped.length}):`);
    for (const stage of skipped) {
      lines.push(`  ${stage.name} — ${STAGE_TITLES[stage.name]}`);
      lines.push(`      ${stage.detail}`);
    }
  }

  if (missed.length > 0) {
    if (skipped.length > 0) lines.push('');
    lines.push(
      `NOT REACHED (${missed.length}): the run stopped before these, so they are neither ` +
        `proved nor disproved — ${missed.join(', ')}.`
    );
  }

  if (skipped.length === 0 && missed.length === 0) {
    lines.push('Nothing was skipped: every stage this smoke knows ran here.');
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push(
      'What was spent is what each stage was TOLD it spent. A stage that failed on a paid ' +
        'route may have spent more: a refusal is billed like an acceptance (ADR 0003), and its ' +
        "price rides in the provider's own message below rather than in a field."
    );
    lines.push('');
    lines.push(`FAILED (${failed.length}):`);
    for (const stage of failed) {
      lines.push(`  ${stage.name} — ${stage.detail}`);
      for (const fact of stage.facts) lines.push(`      (held) ${fact}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
