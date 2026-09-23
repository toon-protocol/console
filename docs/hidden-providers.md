---
d: hidden-providers
title: Hidden Providers
summary: A provider whose network location nothing it publishes or serves reveals — and what that costs on both sides.
order: 6
published_at: 2026-09-23
tags: [toon-network, privacy, hidden-provider]
---

# Hidden Providers

A **Hidden Provider** is a provider whose network location is not revealed to tenants or
observers by anything it publishes or serves. It sells leases like any other provider. You
find it in the same Provider Directory, filtered by a flag, and you pay for it the same
way.

## Three things have to hide, not one

A provider that only hid its inbound address would still be found. Hiding is all three of
these or it is none:

- **Ingress.** The address you reach it on is not an address on the clearnet. Its Provider
  Profile publishes an `.anyone` address instead of a host and port.
- **Egress.** Everything the provider itself dials goes out the same way. A hidden provider
  that fetched an image over the clearnet, or published its liveness to a relay directly,
  would have named its own host to whoever was watching.
- **Settlement.** Its payment channel and its chain RPC do not name it either. Its
  settlement RPC has to be near — on its own loopback or its own private network — because
  there is no circuit to build to a chain node.

A provider that gets two of the three right is not hidden. It is a provider with a slower
network.

## What you do differently

Almost nothing.

In the Console, tick **hidden** in the Provider Directory filters and you see the hidden
providers. Spawn on one exactly as you would on any other. The daemon reaches its
`.anyone` address through the client library's hidden-service transport; you do not
configure a proxy and you do not install anything extra.

This is one of the three reasons the Console is a local daemon and not a hosted website: a
browser cannot reach an `.anyone` address at all. See [ADR 0019] in the specification
repository for the other two.

## What it costs

- **Latency.** Every packet goes through a circuit. Spawns take longer and SSH feels it.
- **No direct SSH from your laptop**, unless your laptop can reach the same address space.
- **The provider cannot fetch from its own network.** A hidden provider pulls image bytes
  through the same egress everything else uses, and it does not shortcut to a nearby
  clearnet mirror.

## What it does not do

It does not hide _you_. Tenant privacy is a different mechanism and you already have it: a
tenant has no published identity and signs nothing, and a provider learns only that the
same party is asking again. A hidden provider protects the **provider's** location from
**you** and from everyone watching.

It also does not make a provider trustworthy. A hidden provider can evict you, go silent,
or serve you badly, exactly like a visible one. [Failover](failover) is the answer to that
in both cases.

## With a gateway

A [Workload Gateway](gateways) can front a workload running on a hidden provider. The
gateway reaches the member the way that member's profile says to — over the hidden
transport — and serves your hostname on the clearnet. The workload gets a public name; the
machine running it keeps its address.

## On devnet

Devnet's provider is not hidden. The Console's filter, the directory's flag and the
client's hidden transport are all wired and testable; what is missing is somebody running a
hidden provider for you to lease from. If you run one, publish its profile to the devnet
relay and it will appear.

## Next

- [Failover](failover) — standby sets, which work the same way with hidden members.
- [The specification](spec) — §10 and ADR 0008 for the normative rules.
