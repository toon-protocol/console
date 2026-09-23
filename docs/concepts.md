---
d: concepts
title: Concepts
summary: Provider, Tenant, Lease, Workload, Listing, Liveness — the nine words the rest of the documentation is written in.
order: 1
published_at: 2026-09-23
tags: [toon-network, concepts, getting-started]
---

# Concepts

TOON Network is a compute marketplace with no company in the middle. Nine words carry it.
Learn them here and the rest of these docs read as plain sentences.

## The two parties

A **Provider** is an operator who sells leases on workloads running on hardware they
control. A provider has a published identity: a Nostr key, a **Provider Profile** saying
how it is reached and paid, and one or more **Listings** saying what it sells.

A **Tenant** is the holder of a lease's continuation token. A tenant has no published
identity and signs nothing. That is not an accident of the implementation — it is the
point. A provider never learns who you are, only that whoever asks again is the same party
that took the lease.

The **Payer** is the channel identity a payment was collected from. A payer need not be the
tenant. In the Console they are the same person, but nothing a provider sees links them.

## The thing you buy

A **Workload** is what a provider runs for you. A **Lease** is your prepaid right to one
workload on one provider, until it expires.

A **Listing** is one sellable tier: the resources a lease gets, the capabilities it grants,
and its prices. The devnet provider publishes two:

| Listing | Price      | Lease Interval | What it grants                                                   |
| ------- | ---------- | -------------- | ---------------------------------------------------------------- |
| `basic` | 1000 µUSDC | 3600 s         | An ordinary workload                                             |
| `ci`    | 5000 µUSDC | 3600 s         | The **Docker Capability**: a Docker daemon of the workload's own |

µUSDC is a millionth of a USDC — the token's base unit. 1000 µUSDC is a tenth of a cent
per hour. On devnet the USDC is a mock token and the faucet gives it away.

A **Lease Interval** is the fixed period one payment buys — 3600 seconds on both devnet
listings. A **Spawn** is the paid request that starts a lease and buys its first interval.
An **Extension** is a paid request that adds one more. A lease with no extension reaches
**Expiry** and the workload stops.

A **Capability** is a privilege beyond an ordinary workload. The `ci` listing grants the
Docker Capability, which is why it costs five times as much: the provider is handing your
workload a Docker daemon scoped to your lease.

## The secret that is the lease

When you spawn, you mint a **Root Secret** — a random value you keep and never send. From
it you derive a **Continuation Token** for each provider, and you present that token on
every later request. That is how a provider knows the same party is asking again, without
ever learning a name.

Lose the root secret and the lease is gone. Nothing in the protocol can recover it. This is
why the Console keeps every root secret in your **Lease Vault**, sealed to your Account and
kept on your own relays. See [Funding](funding) for what the Account is and
[Failover](failover) for what the vault makes possible.

**Rotation** replaces a lease's continuation token at one provider. The old token stops
working, and so does every gateway grant derived from it.

## Finding a provider

The **Provider Directory** is the set of published profiles, listings and liveness that you
search to find a provider. It is not a registry anybody runs: it is what is on the relays.

**Liveness** is a provider's short-lived published statement that it is up, which expires
unless renewed. A provider that stops publishing liveness is, as far as the network is
concerned, gone — and that is exactly what a **Warm Standby** watches for.

## Where the words come from

This vocabulary is normative. It is defined in TOON Network's `CONTEXT.md` and used
unchanged in the protocol specification, the provider, the gateway and the Console. If a
word here disagrees with a word there, the specification wins — see
[The specification](spec).

## Next

- [Your first workload](first-workload) — spawn something, from nothing.
- [Funding](funding) — where the money comes from, and the one thing no faucet gives.
