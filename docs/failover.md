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

You pay for a standby, and at its own price. A listing that sells warm standbys publishes a
second figure beside its ordinary one — devnet's `basic` is 1000 µUSDC an hour to run and
400 µUSDC an hour to stand by — and a listing that publishes no such figure sells no
standby at all. The Console offers you only the tiers that do.

A reservation is extended on its own route too, at the standby price, and the Console picks
that route from what the lease **is** rather than from what it was bought as. That matters
because getting it wrong costs money: a provider refuses a reservation extended like a
running lease, and a refusal is an answer it charges for. After a takeover the member that
won is a running lease from that moment, so it is extended at the running price — winning
buys no time.

In the Console, standbys are part of the "New workload" form, not a separate thing to
manage. Add one, pick another provider and a tier that prices a standby, and the card shows
every member of the set: what each is doing, what keeps each alive, and which one the
workload is actually on. Your **runway** is then the set's, not the primary's — a set
protects a workload only while every member is paid, so the figure is bounded by whichever
member runs out first, and the Console names it.

Membership is fixed once the set exists. Changing it means spawning again under a new
workload id.

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

**A member that does not answer does not block the others.** Rotating is one request per
member, so a set rotated at some members and not at others is a perfectly good state: the
Console reads each member with whichever root holds it, and the card shows *1 of 2
confirmed* with a **Finish the rotation** button. Pressing it again asks only the members
that have not confirmed, with the same new root secret — never a third one.

**"Could not save" is not "rotated".** A provider that accepted the request but could not
persist it answers `unavailable`: nothing changed and your old token still works. The
Console shows that member as retryable rather than as done, because believing a leaked
token is dead when it is not is the one mistake worth going out of the way to avoid.

**Rotating ends every gateway grant of the old token**, at each member it reaches, with no
grace period. If your workload is behind a [Workload Gateway](gateways), hand it over
again afterwards and the hostname works again — the new handover carries grants derived
from the new token.

## With a gateway

A takeover moves the workload to another provider's address. A [Workload
Gateway](gateways) resolves your workload id rather than an address, so the hostname
follows the workload across the takeover. Without a gateway, you find the new address in
the Console and tell your clients yourself.

## Telling a self-stop from an expiry

These look alike at a glance and are not alike at all, so the Console keeps them apart in
words.

A **self-stopped** primary still holds its lease. It is paid to its expiry, it still holds
its capacity, and it can still be extended at the running price — it simply is not running
your workload, because it gave up the workload rather than risk running beside the standby
that took over. An **expired** lease is over: nobody paid for another interval, there is no
grace period, and nothing restarts it. A new workload is a new spawn.

## What to expect on devnet

Devnet has one provider today. You can see the mechanism in the Console — the tier's
standby price, the set as the form builds it, the liveness countdown — but a Standby Set
needs a second provider, and a real takeover needs one too. Running one is [next on the
roadmap](spec) for the Console itself. Against the local docker sandbox, which has two
providers, the whole thing works end to end.

## Next

- [Hidden Providers](hidden-providers) — failover to a provider whose location nobody knows.
- [The specification](spec) — the normative rules for takeover, self-stop and rotation.
