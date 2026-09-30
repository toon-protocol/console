# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**, and its vocabulary and decisions live in
`toon-protocol/TOON_Network`, not here.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root: how to run things, and the house rules.
- **`README.md`**: what the console is.
- **`docs/`**: the user-facing pages the site publishes (`concepts.md`, `funding.md`,
  `gateways.md`, `first-workload.md`, and so on), and `docs/spec.md`.
- **TOON_Network's `CONTEXT.md`** (the **Console** section: Console, Account, Signer, Chain Seed,
  Lease Vault) and **`docs/adr/`** (0019, 0020 and 0021 for the console; 0028 for the terminal UI).
  Read them on GitHub (`toon-protocol/TOON_Network`) when a ticket cites one.

There is no `CONTEXT.md`, `CONTEXT-MAP.md` or `docs/adr/` in this repo, and no per-package
context. The npm workspaces under `packages/*` and the Cargo crate under `tui/` are build units,
not separate bounded contexts. Use TOON_Network's terms; do not start a second glossary here.

If a file above can't be read, **proceed silently**. Don't flag its absence.

## File structure

```
/
├── CLAUDE.md
├── README.md
├── docs/         ← user-facing pages and spec
├── packages/     ← npm workspaces: daemon, ui, site
├── packaging/    ← desktop, systemd, AUR, Omarchy
└── tui/          ← Rust terminal UI
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as TOON_Network's `CONTEXT.md` defines it. Don't drift to synonyms.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0020 (key material lives in a Signer) — but worth reopening because…_
