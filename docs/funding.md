---
d: funding
title: Funding
summary: Deposit addresses, payment channels, what a relay write costs — and the one thing no faucet on this network gives you.
order: 3
published_at: 2026-09-23
tags: [toon-network, funding, payments]
---

# Funding

Every request you pay for on TOON Network — a spawn, an extension, a relay write — is a
sealed packet against an open **payment channel**. Opening that channel is the only thing
that touches a chain. Everything after it is off-chain and takes milliseconds.

## Where the keys come from

Your **Account** is a Nostr identity. Your money is not.

On first sign-in the Console mints a **Chain Seed**: a random BIP-39 mnemonic, NIP-44
sealed to your own Nostr key, published as one record on your relays and cached locally.
Your payer keys on every settlement chain are derived from it — EVM at `m/44'/60'/0'/0/0`,
Solana at `m/44'/501'/0'/0'`, using `@toon-protocol/client`'s own derivation.

The seed is _not_ derived from your Nostr key, and that is deliberate. A NIP-46 remote
signer never reveals its private key, and its signatures are randomized, so nothing
deterministic can be squeezed out of it. Deriving chain keys from the Nostr key would shut
out exactly the accounts following Nostr's own custody advice. Sealing a random seed to the
key works with every signer.

Consequences, stated plainly:

- **Your npub unlocks your funds, and nothing else does.** There is no export of the Chain
  Seed. No reveal-once-at-mint. No route that could grow one. If you lose your Nostr key,
  the funds at your payer addresses are gone.
- **A relay learns you have one sealed record.** It does not learn what is in it.
- **Two machines that both mint while offline leave two seeds.** The Console warns loudly,
  shows both sets of addresses, and neither merges them nor keeps deriving from the loser.

## Two chains, two addresses

The Funds tab shows a deposit address on **Base Sepolia** and one on **Solana devnet**,
each with a QR code. Use whichever you can fund. You only need one.

Nothing in the Console hard-codes a chain id, a token address or a settlement address.
Those facts come from the connector's own `GET /ilp` at runtime, because the connector is
the authority on its own terms and a copy in the app would be a staler one.

## Mock USDC

Devnet settles in a **mock USDC** with six decimals. Prices are quoted in its base unit,
µUSDC:

| What                            | Price      |
| ------------------------------- | ---------- |
| One hour on the `basic` listing | 1000 µUSDC |
| One hour on the `ci` listing    | 5000 µUSDC |
| One relay write                 | 1 µUSDC    |

The devnet faucet gives you mock USDC. The Console links to it from the Funds tab when the
active profile has one.

## The gas problem

Here is the thing nobody can hand you:

> **No faucet on TOON Network gives you native gas.** Opening a payment channel is an
> on-chain transaction. On Base Sepolia it costs ETH; on Solana devnet it costs SOL. The
> devnet faucet mints mock USDC and nothing else. You have to get the native token from a
> public testnet faucet yourself.

For Base Sepolia, use a public Sepolia ETH faucet and bridge, or a Base Sepolia faucet
directly. For Solana devnet, `solana airdrop 1 <your address> --url devnet` usually works
and is sometimes rate-limited to nothing for hours.

The Console shows your native balance beside your USDC balance and refuses to open a
channel it can see you cannot pay gas for, rather than sending a transaction that reverts.
If both faucets are dry, wait. This is a testnet and that is what testnets are like.

## Buying the next chain's gas

The paragraph above is true of your **first** chain and no longer true of the rest.

A **gas station** is a TOON app that spends its own native token on somebody else's
transaction — and it is paid over a payment channel. A claim signed against a channel is
not a transaction and costs no gas on any chain, so once you hold ONE funded channel, the
Console can buy native gas for a chain you cannot transact on at all. The Funds tab offers
it on any chain that is blocked, shows you the station's own quote first, and pays for the
quote it showed you.

The gas lands at **your** address — the one your Chain Seed derives — and the blocked chain
then opens a channel with no help from anywhere.

Four things worth knowing before you press it:

- **The first channel on the first chain still has no route through this.** Paying a gas
  station needs a channel; opening a channel needs gas. The Console says so in those words
  whenever you hold no channel anywhere, and offers no button that pretends otherwise.
- **It works on Solana and not on EVM, and that is a decision rather than a gap.** A gas
  station's EVM job relays a call _you_ signed and pays the miner for it; its target must be
  the connector's own payment-channel contract, and the native value it may carry is zero.
  One that sent ETH to any address that asked would be a faucet, and would be emptied by the
  first caller. So Base Sepolia's ETH still has to come from a wallet that holds some.
- **A quote is a paid packet, and so is a refusal.** A purchase is two packets at the
  connector's own price — on devnet, 1000 µUSDC each — plus one more the first time, to
  learn the station's fee-payer address. Every one of them is reported with what it cost,
  including the ones that came back empty.
- **It may ask you to open a second channel.** A connector publishes a route's price and
  never says which of a station's doors it terminates at, so which door takes a quote and
  which takes an execute is learned from a refusal. When the channel you hold cannot reach
  the door, the Console says so and offers to open one with the gas station's own connector,
  which terminates all of them.

## Opening a channel

From the Funds tab, choose a chain and a deposit amount and open. The deposit is a whole
number of base units — not a decimal — because how many decimals the token has is the
connector's to state, and rounding it twice is how a figure stops matching.

Opening locks collateral on chain. The Console answers as soon as the transaction is in
flight and shows the channel as `opening`; it polls rather than pretending to hurry a
confirmation.

After that, a paid request signs a balance proof against the channel and seals a packet to
the connector. No transaction, no block, no wait.

## What a relay write costs, and why there is one

Your **Chain Seed** record and every **Lease Vault** record is a write to a relay. On TOON
Network a relay write is a paid packet, quoted by the connector at 1 µUSDC, and a TOON
relay answers a plain unpaid websocket write with `restricted: writes require ILP payment`.
The Console pays for every one of them from your channel. There is no free fallback and no
flag that turns one on.

Two consequences worth knowing before they surprise you:

- **A refused paid request is still billed.** TOON bills for an answer, and a refusal is an
  answer. So the Console verifies an event's own signature before it pays to publish it,
  because a relay refuses a bad one with `422` _after_ taking the money.
- **You cannot publish your first Chain Seed record until you have a channel.** The key
  that pays is derived from the seed that is being published. The Console mints the seed,
  holds it locally, tells you it is not yet recoverable, and publishes it the moment you
  have funds.

## Budgets and runway

Each workload card shows its **runway**: how long your current funds and your extension
settings keep it alive. Automatic extension has a budget you set. When runway drops under
24 hours the Console sends a desktop notification.

## Next

- [Your first workload](first-workload) — the whole path, in order.
- [Gateways](gateways) — a stable hostname for what you just bought.
