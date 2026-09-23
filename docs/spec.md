---
d: spec
title: The specification
summary: Where the normative rules live, what each numbered section covers, and which decisions are written down as ADRs.
order: 7
published_at: 2026-09-23
tags: [toon-network, specification, reference]
---

# The specification

These docs are an introduction. The **specification** is the normative document: when the
two disagree, the specification is right and this page is a bug.

It lives in <https://github.com/toon-protocol/TOON_Network>, together with the vocabulary
(`CONTEXT.md`) and every architecture decision record (`docs/adr/`).

## Reading it

The specification is one document with numbered sections. The ones these docs lean on:

| Section | What it settles                                                         |
| ------- | ----------------------------------------------------------------------- |
| §3      | Parties: Provider, Tenant, Payer, and the separation between them       |
| §4      | The Provider Directory: Profiles, Listings, Liveness, relay sets        |
| §5      | Paid routes: what a request costs and who is billed for what            |
| §6      | Leases: the spawn request, root secrets, continuation tokens, extension |
| §7      | Standby sets: reservations, takeover, self-stop                         |
| §8      | Registries: image entries, Blob Records, Templates                      |
| §10     | Hidden Providers: ingress, egress and settlement                        |
| §12     | The Workload Gateway: handover, grants, withdrawal                      |

## The decisions

An ADR records one decision and why the alternatives were rejected. The ones that shape
what you see in the Console:

| ADR  | The decision                                           |
| ---- | ------------------------------------------------------ |
| 0003 | One payment buys one lease interval                    |
| 0007 | Liveness is a paid replaceable event                   |
| 0008 | A hidden provider hides ingress, egress and settlement |
| 0010 | Takeover on liveness expiry, without state             |
| 0013 | Hostnames and TLS live in a Workload Gateway           |
| 0016 | A provider authenticates continuity, not identity      |
| 0018 | A token is revoked by replacing it                     |
| 0019 | The Console is a local app, not a website              |
| 0020 | An account's chain keys come from a seed sealed to it  |
| 0021 | Root secrets are vaulted on the account's own relays   |

## The code

| Repository                   | What it is                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| `toon-protocol/TOON_Network` | The specification, the vocabulary, the ADRs, and every ticket in the fleet |
| `toon-protocol/console`      | This Console: the daemon, the UI, this site and these docs                 |
| `toon-protocol/provider`     | The provider: it sells the leases                                          |
| `toon-protocol/gateway`      | The Workload Gateway                                                       |

## These docs

The Markdown for every page here is in `docs/` in the Console repository. Each page is
published as a **NIP-23 long-form article** (kind 30023) from TOON Network's npub, so you
can read it in any Nostr client, not only here. The `d` tag on each article is its
identity: re-publishing an edited page replaces the article rather than adding a second
copy.

The Console bundles the same Markdown and falls back to it when it cannot reach a relay, so
the docs work on a plane.

## Next

- [Concepts](concepts) — the vocabulary, if you skipped it.
