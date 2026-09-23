---
d: gateways
title: Gateways
summary: A Workload Gateway fronts your workload at a stable hostname on TLS, and follows it when it moves.
order: 4
published_at: 2026-09-23
tags: [toon-network, gateway, networking]
---

# Gateways

A lease gives you a workload on one provider, at that provider's address. That is enough
for SSH and not much else. A **Workload Gateway** is what turns it into a hostname.

## What a gateway is

A Workload Gateway is a TOON app that fronts a workload at a stable hostname, resolving
your **workload id** to whichever provider is currently running it. It holds the TLS
certificate. It does not hold your lease, your root secret or your money.

On devnet the gateway serves everything under `gw.devnet.toonprotocol.dev`. A workload
handed to it becomes reachable at a name under that suffix, on HTTPS, from anywhere.

The word "gateway" is overloaded: the TOON store has a gateway of its own, which is a
different thing. In these docs "gateway" unqualified always means the Workload Gateway.

## Handing a workload over

From a workload's card, choose **Hand to gateway**. The Console sends a **Gateway
Handover**: the message by which a tenant chooses a gateway, carrying what the gateway
needs to serve the workload and a **Gateway Grant**.

A Gateway Grant is a delegation, and a narrow one. It lets the gateway read _one_
workload's lease state and access details, and nothing else. It expires. And it is derived
from the lease's continuation token, which means:

> **Rotating a lease's continuation token kills every gateway grant derived from it.** That
> is the revocation mechanism. There is no separate revoke call, because the grant was
> never a credential that lived on its own.

Hostnames and TLS live in the gateway and nowhere else. A provider serves plain HTTP on its
own address; it never holds a certificate for your name.

## Taking it back

**Gateway Withdrawal** is the message that stops a gateway serving a workload. It ends the
serving, not the grant — the grant runs out on its own clock, or dies on the next rotation.

## Why it survives a move

The gateway resolves a workload id, not a provider address. When a **Takeover** happens —
a **Warm Standby** starts running the workload because the primary went silent — the
gateway finds the new provider and the hostname keeps working. Your users do not learn that
anything happened.

That is the whole reason a gateway and a standby set are designed together. See
[Failover](failover).

## Choosing a gateway

A gateway is chosen by a packet, not by a publication. You send a handover to the gateway
you want; you do not register with a directory and wait. If you run your own gateway, you
send the handover to yours. Nothing about the protocol makes the devnet gateway special
except that it is the one running.

## What this does not do

- It is not a load balancer. One workload id resolves to one running workload.
- It is not a CDN. It proxies; it does not cache on your behalf.
- It does not make a **Hidden Provider** visible. A gateway can front a workload on a
  hidden provider, and reaches it the way that provider's profile says to. See
  [Hidden Providers](hidden-providers).

## Next

- [Failover](failover) — what a hostname is worth when the machine behind it dies.
- [The specification](spec) — the normative rules for handover, grants and withdrawal.
