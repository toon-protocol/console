The TOON Console: a local daemon plus a web UI, opened as an Omarchy web app. See
`README.md`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`toon-protocol/console`, via the `gh` CLI). See
`docs/agents/issue-tracker.md`. The fleet's specs and cross-repo tickets live in
`toon-protocol/TOON_Network` (ADR 0001); a console change cites its TOON_Network issue number.

### Triage labels

The five canonical triage labels, names unchanged. See `docs/agents/triage-labels.md`.
`ready-for-agent` is also the AFK factory's queue: `agent-implement.yml` builds each unblocked
`ready-for-agent` issue with `/implement` then `/code-review`, runs this repo's CI gate
(`.sandcastle/run-gate.ts`, the commands of `ci.yml`'s `build` and `tui` jobs, path-aware), and
opens a PR labelled `ready-for-human`. `npm run sandcastle:test` covers the runner.

### Domain docs

Single-context, with the vocabulary and the decisions in TOON_Network: `CONTEXT.md` (the
**Console** section: Console, Account, Signer, Chain Seed, Lease Vault) and `docs/adr/` (0019,
0020 and 0021 for the console). Use those terms here; do not start a second glossary. See
`docs/agents/domain.md`.

## House rules

- Chain facts come from a connector's `GET /ilp`, never from a constant. A chain id, token
  address or settlement address in this repository is a bug, and
  `packages/daemon/src/profiles.test.ts` is the test that says so.
- The daemon binds `127.0.0.1` only, and every `/api/*` route is behind the per-launch
  token.
- **Every write to a relay is a paid TOON packet**, and `packages/daemon/src/relay-write.ts`
  is the only writer (TOON_Network#120). A relay on this network refuses a plain websocket
  write outright (`restricted: writes require ILP payment`), so a module that wants to
  publish an event asks that writer for it and is told what it cost. Reads stay free over
  NIP-01 in `relay-pool.ts`, which reads and only reads.
- A private key never reaches a log line, an API response or the UI's storage. Key material
  lives in a **Signer** — a NIP-46 remote signer, or the local keystore in libsecret or the
  passphrase-encrypted file (ADR 0020). Write against `ConsoleSigner`, never against a key;
  `packages/daemon/src/api-account.test.ts` is the test that says so.
- `npm run lint && npm run typecheck && npm test && npm run test:packaging` before a PR, and
  `npm run sandcastle:typecheck && npm run sandcastle:test` too when you touch `.sandcastle/`
  (`npm run typecheck` does not cover it; `agent-image.yml` does).
