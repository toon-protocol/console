The TOON Console: a local daemon plus a web UI, opened as an Omarchy web app. See
`README.md`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on toon-protocol/TOON_Network (via `gh`), not in this
repository — TOON_Network holds the specs and the tickets for every repo in the fleet
(ADR 0001). A console change cites its TOON_Network issue number.

### Domain docs

The vocabulary and the decisions live in TOON_Network: `CONTEXT.md` (the **Console**
section: Console, Account, Signer, Chain Seed, Lease Vault) and `docs/adr/` (0019, 0020 and
0021 for the console). Use those terms here; do not start a second glossary.

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
- `npm run lint && npm run typecheck && npm test && npm run test:packaging` before a PR.
