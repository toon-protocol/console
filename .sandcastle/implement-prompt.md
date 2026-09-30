/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers how to run things and the house rules. This repo has no `CONTEXT.md`
  or `docs/adr/`: the vocabulary and the decisions live in `toon-protocol/TOON_Network`.
  A ticket that cites an ADR or a TOON_Network issue means to be read against it
  (`gh issue view <n> -R toon-protocol/TOON_Network`).
- Line numbers cited in older issues drift. Check that a `file.ts:123` reference still
  points at what the text claims before relying on it.
- Two toolchains live here. The npm workspaces (`packages/daemon`, `packages/ui`,
  `packages/site`) are the daemon, the web UI and the site. `tui/` is a Rust crate, the
  terminal UI. `tui/tests/fixture_contract.rs` reads the API fixtures committed under
  `packages/daemon/fixtures/api/`, so a change to a daemon response shape touches both.
- Chain facts come from a connector's `GET /ilp`, never from a constant, and every write to a
  relay goes through `packages/daemon/src/relay-write.ts`. `CLAUDE.md` says why.
- After you finish, the runner runs CI's gate itself and won't open a PR while it is red.
  For a change under `packages/`, `packaging/` or the root npm files: `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run test:packaging` and `npm run build`. For a
  change under `tui/`, from inside `tui/`: `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test`. Run the ones that apply
  before you commit. Never weaken, skip or `#[ignore]` a test, and never loosen a lint,
  to get green.
- The sandbox has no display and no funded key. A ticket that needs a live
  relay or a funded account is one to stop on, below.

## When you cannot finish

Stop only when a genuinely new decision is needed and nothing in the ticket or its spec
covers it, the action is irreversible, it touches real funds, or it needs a credential the
sandbox does not have. In that case, commit nothing and explain what blocks you in a comment
on the issue (`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits
to `needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.

If you stopped because you're blocked, output <promise>BLOCKED</promise> instead, after your
comment on the issue. The runner then ends the run. Otherwise it starts another session, which
hits the same blocker and posts the same comment again.
