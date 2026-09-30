import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixPrompt, NPM_STEPS, stepsForFiles, TUI_STEPS } from './run-gate.ts';

const commands = (files: string[]) => stepsForFiles(files).map((s) => s.command);

describe('the gate mirrors ci.yml', () => {
  it('runs the build job in order: lint, typecheck, test, test:packaging, build', () => {
    assert.deepEqual(
      NPM_STEPS.map((s) => s.command),
      [
        'npm run lint',
        'npm run typecheck',
        'npm test',
        'npm run test:packaging',
        'npm run build',
      ]
    );
  });

  it('runs the tui job in order, inside tui/', () => {
    assert.deepEqual(
      TUI_STEPS.map((s) => s.command),
      [
        'cd tui && cargo fmt --check',
        'cd tui && cargo clippy --all-targets -- -D warnings',
        'cd tui && cargo test',
      ]
    );
  });
});

describe('the gate is path-aware', () => {
  it('a tui-only change does not pay for the npm gate', () => {
    assert.deepEqual(commands(['tui/src/main.rs']), TUI_STEPS.map((s) => s.command));
    assert.deepEqual(commands(['tui/Cargo.lock']), TUI_STEPS.map((s) => s.command));
  });

  it('an npm-only change does not pay for the tui gate', () => {
    for (const file of [
      'packages/ui/src/App.tsx',
      'packaging/packaging.test.mjs',
      'package.json',
      'package-lock.json',
      'eslint.config.js',
    ]) {
      assert.deepEqual(commands([file]), NPM_STEPS.map((s) => s.command), file);
    }
  });

  it('a change to the committed API fixtures runs both, since the tui reads them', () => {
    assert.equal(stepsForFiles(['packages/daemon/fixtures/api/status.json']).length, 8);
  });

  it('a change under packages/ and tui/ runs both, npm first', () => {
    const got = commands(['tui/src/main.rs', 'packages/daemon/src/index.ts']);
    assert.deepEqual(got, [...NPM_STEPS, ...TUI_STEPS].map((s) => s.command));
  });

  it('a change to ci.yml runs both', () => {
    assert.equal(stepsForFiles(['.github/workflows/ci.yml']).length, 8);
  });

  it('docs and runner changes run nothing', () => {
    assert.deepEqual(stepsForFiles(['docs/spec.md', '.sandcastle/run-gate.ts', 'README.md']), []);
  });

  it('an empty file list runs everything rather than skipping silently', () => {
    assert.equal(stepsForFiles([]).length, 8);
  });
});

describe('fixPrompt', () => {
  it('names the failing command and forbids weakening the gate', () => {
    const text = fixPrompt(
      { step: 'npm lint', command: 'npm run lint', exitCode: 1, output: 'boom' },
      1,
      2
    );
    assert.match(text, /attempt 1 of 2/);
    assert.match(text, /npm run lint/);
    assert.match(text, /Do NOT weaken/);
  });
});
