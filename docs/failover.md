---
d: failover
title: Failover
summary: Warm standbys, takeover on liveness expiry, and why a standby cannot impersonate you to the primary.
order: 5
published_at: 2026-09-23
tags: [toon-network, failover, standby]
---

# Failover

One provider is one machine on one power supply. TOON Network's answer is a **Standby
Set**: a primary lease and its warm standby leases, serving one workload across several
providers under one workload id you chose.

## Warm standbys

A **Warm Standby** is a provider holding capacity to take over your workload if the
provider running it goes silent. What it holds is a **Reservation**: capacity that is paid
for and on which nothing runs until takeover.

You pay for a standby. It is an ordinary lease on an ordinary listing, at that listing's
ordinary price. A standby on `basic` costs the same 1000 µUSDC an hour as the primary,
because the provider really is holding the resources.

In the Console, standbys are a toggle on a workload, not a separate thing to manage. Add
one, pick a listing on another provider, and the card starts showing two leases where it
showed one.

## What triggers a takeover

**Liveness** is a provider's short-lived published statement that it is up, which expires
unless renewed. A **Takeover** is the moment a warm standby starts running the workload of
a lease whose provider went silent — that is, whose liveness expired.

There is no consensus round, no lock service and no shared state. A standby watches the
relays for the primary's liveness, and when it stops arriving, it starts.

The primary's side of the bargain is **Self-stop**: a primary that can no longer publish
liveness to a majority of its relay set stops its own workload. The lease stays paid and
nothing runs. That is what keeps two copies from serving at once — the primary gives up
before a standby can conclude it is gone.

## What a takeover does not carry

**A takeover carries no state.** The standby starts your workload from its image, with the
settings your lease named. Anything the old workload had written to its own disk is not
there.

This is stated bluntly because it decides what you can put behind a standby set. A
stateless HTTP service, a worker pulling from a queue, a build runner: fine. A database
with its data on the workload's local disk: not fine, and no amount of standby capacity
makes it fine.

## Why a standby cannot pretend to be you

Each provider gets its **own** continuation token, derived from the lease's root secret for
that provider and no other. So no member of a standby set holds a token that works against
another member. A standby that turned hostile can act on its own lease and cannot touch the
primary's.

This is also why the **Lease Vault** matters more once you have a standby set: the root
secret is the one thing from which every one of those tokens is derived, and there is now
more than one lease depending on it.

## Rotation across a set

**Rotation** replaces a lease's continuation token at one provider. Across a standby set you
rotate every member, and the order matters:

1. The new root secret goes into your Lease Vault **first**, before any rotate request.
2. Both roots are kept until every member has confirmed.
3. Only then is the old one dropped.

The Console does this for you from the workload card. The reason for the order is that a
crash between minting a new root and recording it would lose the lease — and nothing in the
protocol can recover a lost root secret.

## With a gateway

A takeover moves the workload to another provider's address. A [Workload
Gateway](gateways) resolves your workload id rather than an address, so the hostname
follows the workload across the takeover. Without a gateway, you find the new address in
the Console and tell your clients yourself.

## What to expect on devnet

Devnet has one provider today. You can see the mechanism in the Console — the standby
toggle, the set, the liveness countdown — but you need a second provider to see a real
takeover. Running one is [next on the roadmap](spec) for the Console itself.

## Next

- [Hidden Providers](hidden-providers) — failover to a provider whose location nobody knows.
- [The specification](spec) — the normative rules for takeover, self-stop and rotation.
