// The gate, run DETERMINISTICALLY by the runner, not asked of the agent.
//
// WHY THIS EXISTS
// ---------------
// `implement-prompt.md` tells the agent to run the gate before it commits. That is
// advisory prose the agent self-reports on. Verifying a build is plumbing, so the
// runner does it, the same way it does `git push`: an agent that reports COMPLETE
// has not thereby shown that CI will pass.
//
// PATH-AWARE, mirroring the two jobs of ci.yml: a `tui/`-only ticket does not pay for
// the npm gate, and an npm-only ticket does not pay for a Rust build. Commands are
// byte-identical to ci.yml's `build` and `tui` jobs, in the same order. A gate that
// runs something *similar* to CI teaches the agent the wrong lesson.

import type * as sandcastle from '@ai-hero/sandcastle';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

export interface GateStep {
  readonly name: string;
  readonly command: string;
}

export interface GateFailure {
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** Tail of combined output: enough for an agent to act on, bounded so it cannot blow a prompt. */
  readonly output: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly ran: readonly string[];
  readonly failure: GateFailure | null;
}

/** Keep fed-back output useful but bounded. A full cargo build log is megabytes. */
const MAX_OUTPUT_CHARS = 12_000;

/**
 * npm gate: the steps of ci.yml's `build` job, in the same order. `npm ci` is the
 * runner's `onSandboxReady` hook, not a step here.
 */
export const NPM_STEPS: readonly GateStep[] = [
  { name: 'npm lint', command: 'npm run lint' },
  { name: 'npm typecheck', command: 'npm run typecheck' },
  { name: 'npm test', command: 'npm test' },
  { name: 'npm test:packaging', command: 'npm run test:packaging' },
  { name: 'npm build', command: 'npm run build' },
];

/**
 * tui gate: the steps of ci.yml's `tui` job, in the same order. That job runs each with
 * `working-directory: tui`, so each command changes into it.
 */
export const TUI_STEPS: readonly GateStep[] = [
  { name: 'cargo fmt', command: 'cd tui && cargo fmt --check' },
  { name: 'cargo clippy', command: 'cd tui && cargo clippy --all-targets -- -D warnings' },
  { name: 'cargo test', command: 'cd tui && cargo test' },
];

const ALL_STEPS: readonly GateStep[] = [...NPM_STEPS, ...TUI_STEPS];

const NPM_ROOT_FILES = new Set([
  'package.json',
  'package-lock.json',
  '.npmrc',
  'eslint.config.js',
  'prettier.config.js',
]);

/**
 * Which gate steps a change to `files` needs.
 *
 * Deliberately errs toward running MORE. An empty list means the diff could not be
 * trusted, so everything runs, because skipping a gate silently is the failure this
 * module exists to prevent. Two things reach across the toolchains:
 *   - `tui/tests/fixture_contract.rs` reads the API fixtures committed under
 *     `packages/daemon/fixtures/api/`, so a change there is a tui change too.
 *   - `npm run lint` is `eslint .`, which lints `.sandcastle/` too, so a change there is an
 *     npm change.
 *   - `ci.yml` defines both gates, so a change to it runs both.
 */
export function stepsForFiles(files: readonly string[]): readonly GateStep[] {
  if (files.length === 0) return ALL_STEPS;

  const touchesTui = files.some(
    (f) =>
      f.startsWith('tui/') ||
      f.startsWith('packages/daemon/fixtures/') ||
      f === '.github/workflows/ci.yml'
  );
  const touchesNpm = files.some(
    (f) =>
      f.startsWith('packages/') ||
      f.startsWith('packaging/') ||
      f.startsWith('.sandcastle/') ||
      NPM_ROOT_FILES.has(f) ||
      f === '.github/workflows/ci.yml'
  );

  return [...(touchesNpm ? NPM_STEPS : []), ...(touchesTui ? TUI_STEPS : [])];
}

/**
 * Which gates apply, from what the branch actually changed against the base.
 * If the diff cannot be read for any reason, run everything.
 */
export async function selectSteps(
  sandbox: Sandbox,
  baseBranch: string
): Promise<readonly GateStep[]> {
  const diff = await sandbox.exec(`git diff --name-only ${baseBranch}...HEAD`);
  if (diff.exitCode !== 0) {
    console.log('  [gate] could not read the changed-file list, running BOTH gates.');
    return ALL_STEPS;
  }

  const files = diff.stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  if (files.length === 0) {
    console.log('  [gate] no files changed against the base, running BOTH gates.');
    return ALL_STEPS;
  }

  const steps = stepsForFiles(files);
  console.log(
    `  [gate] ${files.length} changed file(s): ` +
      `npm ${steps.some((s) => NPM_STEPS.includes(s)) ? 'yes' : 'no'}, ` +
      `tui ${steps.some((s) => TUI_STEPS.includes(s)) ? 'yes' : 'no'}`
  );
  if (steps.length === 0) {
    console.log('  [gate] no npm or tui sources changed, so no build gate applies.');
  }
  return steps;
}

/**
 * Run `steps` in order, stopping at the first failure.
 *
 * Failure is returned, not thrown, so the caller can decide between a fix
 * iteration and failing the job.
 */
export async function runGate(sandbox: Sandbox, steps: readonly GateStep[]): Promise<GateResult> {
  const ran: string[] = [];

  for (const step of steps) {
    console.log(`  [gate] ${step.name}: ${step.command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(step.command, {
      onLine: (line) => {
        lines.push(line);
        // Stream sparingly: full build output would bury the runner log.
        if (lines.length <= 40) console.log(`    | ${line}`);
      },
    });
    ran.push(step.name);

    if (result.exitCode !== 0) {
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output =
        combined.length > MAX_OUTPUT_CHARS
          ? `...(truncated to the last ${MAX_OUTPUT_CHARS} chars)...\n` +
            combined.slice(-MAX_OUTPUT_CHARS)
          : combined;

      console.log(`  [gate] FAILED at ${step.name} (exit ${result.exitCode}).`);
      return {
        passed: false,
        ran,
        failure: { step: step.name, command: step.command, exitCode: result.exitCode, output },
      };
    }
  }

  console.log(`  [gate] PASSED (${ran.length} step(s): ${ran.join(', ') || 'none applicable'}).`);
  return { passed: true, ran, failure: null };
}

/** The prompt handed to a fix iteration. Concrete failure, no room to reinterpret the task. */
export function fixPrompt(failure: GateFailure, attempt: number, maxAttempts: number): string {
  return [
    `The repository gate is RED. This is fix attempt ${attempt} of ${maxAttempts}.`,
    '',
    `Failing step: ${failure.step}`,
    `Command:      ${failure.command}`,
    `Exit code:    ${failure.exitCode}`,
    '',
    'Output:',
    '```',
    failure.output,
    '```',
    '',
    'Fix the cause and commit. Rules:',
    `- Re-run \`${failure.command}\` yourself and confirm it passes before you finish.`,
    '- Fix the code. Do NOT weaken, skip, delete or #[ignore] a test, and do not',
    '  loosen a lint to make this pass — if the test is genuinely wrong, say so',
    '  explicitly in the commit message and explain why.',
    '- Change only what this failure requires. Do not refactor beyond it.',
    '- If you cannot fix it, commit nothing and explain what is blocking you.',
  ].join('\n');
}
