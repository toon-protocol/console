---
d: first-workload
title: Your first workload
summary: Install the Console, sign in, fund a channel, and lease a real machine on devnet in about fifteen minutes.
order: 2
published_at: 2026-09-23
tags: [toon-network, getting-started, workload]
---

# Your first workload

This is the whole path, end to end, on **devnet**. There is no mainnet yet — see
[What exists today](#what-exists-today) at the bottom before you plan anything around it.

## 1. Install the Console

On Omarchy:

```bash
yay -S toon-console
toon-console-install
```

`toon-console-install` registers the `systemd --user` service, adds the Omarchy web-app
launcher and puts an entry in the Omarchy menu. Launch it from the menu, or:

```bash
systemctl --user start toon-console.service
toon-console
```

On another Linux desktop the same package installs a plain `.desktop` file. The Console is
a local daemon on `127.0.0.1` plus a web UI — it is not a website, and nothing about your
account reaches a server anyone else operates.

From a checkout instead:

```bash
git clone https://github.com/toon-protocol/console
cd console && npm install && npm run build && npm start
```

It prints an `open:` URL carrying this launch's token. Open that.

## 2. Sign in

The Console signs in with a **Nostr signer**. Three work today:

- a **NIP-46 remote signer** — Amber, nsec.app, or `nak bunker`. Your key never touches the
  Console.
- the Console's **local keystore**, in gnome-keyring, holding an nsec you import.
- a **NIP-06 mnemonic**, imported into the same keystore.

Your npub is your **Account**. It is how your records find you again on another machine.

## 3. Seal a Chain Seed

On first sign-in the Console mints a **Chain Seed**: a BIP-39 mnemonic, sealed to your own
Nostr key with NIP-44 and published as a record on your relays. Your payer keys on Base and
on Solana are derived from it.

The Chain Seed is never revealed. There is no export and no reveal-at-mint. Recovery is
your Nostr key and nothing else, which means:

> **Anyone who holds your Nostr key holds your funds.** An Account that loses its Nostr key
> loses everything at its payer addresses. The Console says this once, before it shows you
> an address to deposit to.

## 4. Fund it

The Funds tab shows two deposit addresses — one on **Base Sepolia**, one on **Solana
devnet** — with QR codes, and a link to the devnet faucet for mock USDC.

Then you need **native gas**, and this is the part nobody can solve for you:

> The devnet faucet gives you mock USDC. It does not give you Base Sepolia ETH or Solana
> devnet SOL. Opening a payment channel is an on-chain transaction and it costs native gas.
> You have to get that from a public faucet yourself.

[Funding](funding) says exactly which faucets and what to do when they are dry.

With gas and USDC in hand, open a channel to the connector from the Funds tab. That locks
collateral on chain. Everything after it is off-chain and instant.

## 5. Pick a listing

The Providers tab is the **Provider Directory**, read live off the relays. Filter by
isolation, architecture, GPU, capabilities and whether the provider is hidden. Each row
shows **Liveness** counting down.

On devnet you will find one provider with two listings, `basic` and `ci`. Take `basic`
unless you need Docker inside your workload.

## 6. Spawn

Open **New workload**. Either pick a **Template** — a signed, published description of a
spawn, with its image named by content address — or name an image yourself. Set the
environment, the ports and an SSH public key.

Press spawn. What happens:

1. The Console mints a **Root Secret** for this lease and derives a continuation token.
2. It writes the root secret to your **Lease Vault** — one sealed record on your relays,
   one paid relay write at 1 µUSDC.
3. It sends the paid spawn request to the provider: 1000 µUSDC for the first hour on
   `basic`.
4. The provider answers with the workload's access details.

The card that appears shows the lease, its liveness, and its **runway**: how long your
funds and your extension budget keep it alive.

## 7. Reach it

Hand the workload to the **Workload Gateway** from its card. It comes back with a hostname
under `gw.devnet.toonprotocol.dev`, on TLS, that resolves to whichever provider is running
your workload right now. See [Gateways](gateways).

SSH works directly at the provider's address, with the key you gave at spawn.

## 8. Keep it alive, or let it go

Extend by hand, or set an automatic extension with a budget you choose. Terminate when you
are done — that ends the lease before expiry and stops the charges.

## What exists today

Be clear-eyed about what you are using:

- **This is a devnet.** There is no public mainnet provider. The Console ships a mainnet
  profile with no endpoints behind it, because pointing it at a guess would be worse than
  admitting there is nothing there.
- **The money is mock money.** Devnet USDC is a mock token on Base Sepolia and Solana
  devnet. The gas is real testnet gas, which is why the faucets matter.
- **It really runs.** The devnet provider sells real leases on real hardware, the Console
  bought one, and the workload answered on its gateway hostname. It is small, and it works.

## Next

- [Funding](funding) — deposits, channels, and the gas problem in detail.
- [Gateways](gateways) — how a hostname finds a workload.
- [Failover](failover) — standby sets, and what happens when a provider goes silent.
