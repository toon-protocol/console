// The no-op merge guard (.github/scripts/no-op-merge-guard.sh) fails a PR whose merge
// result changes nothing and passes one with a real diff. Each case builds a throwaway
// repo shaped like refs/pull/N/merge: HEAD is a merge commit, base first, head second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const guard = resolve(import.meta.dirname, '../.github/scripts/no-op-merge-guard.sh');

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

// The PR branch changes a.txt; `baseAlso` lands that same content on main first, so the
// merge result equals main.
function mergeResult({ baseAlso }) {
  const dir = mkdtempSync(join(tmpdir(), 'no-op-guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-qam', 'pr change');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  if (baseAlso) {
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'commit', '-qam', 'same content lands first');
  } else {
    writeFileSync(join(dir, 'b.txt'), 'other\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'unrelated');
  }
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', head);
  return { dir, head };
}

function run({ dir, head }, event = 'pull_request') {
  const summary = join(dir, 'summary.md');
  return spawnSync('bash', [guard], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_STEP_SUMMARY: summary,
      PR_HEAD_SHA: head,
      PR_BASE_REF: 'main',
      PR_NUMBER: '7',
      PR_CHANGED_FILES: '1',
    },
  });
}

test('passes a PR whose merge changes files', () => {
  const m = mergeResult({ baseAlso: false });
  try {
    const r = run(m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /changes 1 file/);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

test('fails a PR whose merge result changes zero files', () => {
  const m = mergeResult({ baseAlso: true });
  try {
    const r = run(m);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /EMPTY commit/);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

test('passes on a push, where there is no merge result to evaluate', () => {
  const m = mergeResult({ baseAlso: true });
  try {
    assert.equal(run(m, 'push').status, 0);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});
