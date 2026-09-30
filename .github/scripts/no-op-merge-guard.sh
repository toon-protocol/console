#!/usr/bin/env bash
# No-op merge guard: a PR whose merge result changes nothing must not merge green.
#
# Copied from toon-meta's empty-pr-guard.yml (toon-meta#405), which is being retired.
# The origin: connector#1008 merged an EMPTY commit (`git show --numstat` returned zero
# files) because another PR had already landed its content. Its three-dot diff was not
# empty, so every reader of the PR page saw a normal change.
#
# A `pull_request` run checks out refs/pull/N/merge: first parent the base tip, second the
# PR head. `git diff base HEAD` is therefore the diff the squash commit would carry.
# Where the guard cannot tell (push event, conflicted PR with no merge ref, stale merge
# ref) it warns and passes; a guard that fails on "I could not tell" gets disabled.
#
# Env: PR_HEAD_SHA, PR_BASE_REF, PR_NUMBER, PR_CHANGED_FILES (the event's three-dot count;
# not recomputed, since a shallow clone has no merge base).
set -uo pipefail

# ci.yml's `no-op-merge` job runs this, and ci.yml also runs on `push`.
# There is no PR to evaluate there. Pass plainly — NOT with a
# `::warning::`, which would annotate every push to main, and NOT
# with a job-level `if:`, because a skipped job is a non-success
# result to `CI OK`, the aggregate that asserts on this job.
if [ "${GITHUB_EVENT_NAME}" != "pull_request" ]; then
  echo "event is '${GITHUB_EVENT_NAME}', not 'pull_request' — no merge result to evaluate"
  exit 0
fi

# `pull_request` runs check out refs/pull/N/merge. If HEAD is not a
# merge commit, GitHub could not compute a merge result — a
# conflicted PR is the usual reason, and a conflicted PR cannot merge
# at all. Warn, do not fail: see the header.
if ! git rev-parse --verify -q HEAD^2 >/dev/null; then
  echo "::warning::no merge ref for this PR (HEAD is not a merge commit) — the merge result could not be evaluated. A conflicted PR is the usual cause; resolve the conflict and this guard re-runs."
  exit 0
fi

P1=$(git rev-parse HEAD^1)
P2=$(git rev-parse HEAD^2)

# Parent order on refs/pull/N/merge is base-first, head-second. Assert
# it against the event payload rather than trusting it, so a change in
# that convention degrades to a warning instead of silently comparing
# the wrong two trees.
if [ "$P2" = "$PR_HEAD_SHA" ]; then
  BASE="$P1"
elif [ "$P1" = "$PR_HEAD_SHA" ]; then
  BASE="$P2"
else
  echo "::warning::neither parent of the merge ref is the PR head ($PR_HEAD_SHA) — the merge ref is probably stale. Not evaluated; push to the branch to refresh it."
  exit 0
fi

if ! git diff --quiet "$BASE" HEAD; then
  CHANGED=$(git diff --name-only "$BASE" HEAD | wc -l)
  echo "✓ merging this PR changes $CHANGED file(s) against $PR_BASE_REF"
  exit 0
fi

# Empty merge. Which of the two shapes is it? Whether the PR page
# still shows files is what decides how confusing this PR is.
BRANCH_FILES="${PR_CHANGED_FILES:-0}"

{
  echo "## ❌ Merging this PR would change nothing"
  echo ""
  echo "The merge result is byte-identical to \`$PR_BASE_REF\`, so squashing this PR"
  echo "would land an **empty commit** — a green check, a closed ticket, and no change."
  echo ""
  if [ "$BRANCH_FILES" -gt 0 ]; then
    echo "**The content is already on \`$PR_BASE_REF\`.** The Files-changed tab still shows"
    echo "$BRANCH_FILES file(s) because that is the three-dot diff against this branch's fork"
    echo "point, not against the branch tip — another PR has landed this same content since."
    echo ""
    echo "Almost certainly a duplicate PR. What to do:"
    echo ""
    echo "1. Find the PR that actually landed it: \`git log --oneline $PR_BASE_REF -- <a file this PR touches>\`."
    echo "2. **Close this PR** and point its ticket at that one."
    echo "3. If the change you meant to make is still missing from \`$PR_BASE_REF\`, it was"
    echo "   never merged by that PR either — diff the file on \`$PR_BASE_REF\` and open a"
    echo "   PR from a branch cut fresh off \`$PR_BASE_REF\`."
  else
    echo "**This branch's own commits cancel out.** Its three-dot diff against"
    echo "\`$PR_BASE_REF\` is empty too, so there was never anything to merge — usually a"
    echo "change and its revert on the same branch, or a branch cut after the work landed."
    echo ""
    echo "Close this PR, or push the change it was supposed to carry."
  fi
  echo ""
  echo "This guard exists because connector#1008 did exactly this and nobody noticed:"
  echo "it merged green, closed its ticket, and \`git show\` returned zero files."
} >> "$GITHUB_STEP_SUMMARY"

if [ "$BRANCH_FILES" -gt 0 ]; then
  echo "::error::merging PR #$PR_NUMBER would produce an EMPTY commit — its content is already on $PR_BASE_REF (the Files-changed tab shows $BRANCH_FILES file(s) only because that is the three-dot diff). This is probably a duplicate PR; close it. See the job summary."
else
  echo "::error::merging PR #$PR_NUMBER would produce an EMPTY commit — this branch's commits cancel out, so it has nothing to merge. See the job summary."
fi
exit 1
