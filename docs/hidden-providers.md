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

One thing, once: you run an `anon` daemon and tell the Console where its SOCKS port is.

```sh
# in the Console's systemd unit, or wherever its environment is set
TOON_CONSOLE_SOCKS_PROXY=socks5h://127.0.0.1:9050
```

`socks5h`, not `socks5`. The trailing `h` is what makes the **proxy** resolve the
destination's name. Under plain `socks5` your own machine resolves it first, which for an
`.anyone` address means putting the hidden service you are about to talk to into a
plaintext DNS query — the one fact the address exists to withhold.

The Console does not start the daemon for you and never will. A background process it
cannot supervise, holding the circuits every packet depends on, is not something to spawn
behind your back; and a console that half-started one would be a console that sometimes
worked. **Health** says whether a circuit is available before you pick a provider.

After that, almost nothing. Tick **hidden** in the Provider Directory filters and you see
the hidden providers. Spawn on one exactly as you would on any other: the daemon reaches
its `.anyone` address through the client library's hidden-service transport, and the
lease's status, extensions and termination all go the same way for as long as it lives.

**If no circuit can be built, the Console refuses.** It does not try the clearnet, and it
does not try whatever host a profile happened to leak. A silent fallback would be a
deanonymisation rather than a convenience, and it is the one thing this part of the
Console may never do. You will see the reason and what to start.

This is also one of the three reasons the Console is a local daemon and not a hosted
website: a browser cannot reach an `.anyone` address at all. See [ADR 0019] in the
specification repository for the other two.

## Your own chain reads ride the circuit too

Paying a hidden provider means opening a payment channel with **its** connector, on the
chain that connector settles on. The Console sends that chain traffic through the same
proxy as the packets — because a console that paid over a circuit while reading its own
channel on the clearnet would broadcast your settlement address, from your own IP, timed
either side of every paid request.

The exception is a chain endpoint that is already private: your own node on loopback, or
the local sandbox's. `anon` builds no circuit to such an address, so proxying it would fail
rather than hide anything — the packet never crosses a network anyone outside can watch.
The Console decides that by where the endpoint **is**, not by a setting, so no flag can
leave it uncovered by mistake.

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

## What the Console shows, and what it never shows

A Hidden Provider's Profile publishes no host, and where one is published anyway — §4.1
forbids it, and nothing enforces it — the Console **drops it**. It is not displayed, not
stored in your Lease Vault record, not written to a log and not returned by the local API.

What the Console does show is your lease's **own** address: the per-lease `.anyone` host
the provider gave it at spawn, on the same SSH and forwarded ports the access details name.
That is not a leak, it is the whole point — §10 says a tenant dials it exactly as it would
an IP.

Two of the five conditions above are visible from your side: the connector a Profile
publishes, and the address your lease answers on. Where either contradicts a `hidden: true`
declaration, the workload card says so plainly. The other three — egress, the settlement
RPC, and whether the provider also answers somewhere else — nobody outside the provider can
check, and the Console does not pretend to.

## On devnet

Devnet has no hidden provider. The Console's filter, the directory's flag and the hidden
transport are all wired and tested, but there is nothing on devnet to lease from — so the
end-to-end path is proven against the **local docker sandbox**, whose `hs` profile runs a
whole hidden provider behind its own `anon` daemon (`make up-hs` in `infra/sandbox`). Point
the Console at the Local sandbox profile, set `TOON_CONSOLE_SOCKS_PROXY` to that sandbox's
buyer proxy, and the directory, the spawn, the status, the extension and the termination
all work over the overlay.

If you run a hidden provider on devnet, publish its Profile to the devnet relay and it will
appear.

## Next

- [Failover](failover) — standby sets, which work the same way with hidden members.
- [The specification](spec) — §10 and ADR 0008 for the normative rules.
