# The TOON Console

The console for [TOON Network][spec]: a **local daemon plus a web UI**, opened as an
Omarchy web app. It is not a website. A `systemd --user` service runs
[`@toon-protocol/client`][client], serves the UI on `127.0.0.1`, and — in the tickets after
this one — holds the account's keys and manages its workloads. Nothing about an account
lives on a server anyone else operates ([ADR 0019][adr19]).

It installs, starts and opens, it knows which network it is pointed at, it can tell you what
that network's connector says about itself, it browses the Provider Directory, an
**Account** can sign in with its **Signer** and seal itself a **Chain Seed** ([#89][i89]),
that account can deposit, open a payment channel and watch its balances ([#90][i90]),
it browses **Templates** and expands one into the spawn it would send ([#94][i94]),
and that account can **spawn a workload** and keep its Root Secret in the **Lease Vault**
([#92][i92]). The workload dashboard ([#93][i93] onward) builds on it.

## What is here

| Path | What it is |
| --- | --- |
| `packages/daemon` | Node/TypeScript daemon: the local JSON API, the loopback server, the network profiles |
| `packages/ui` | React 19 + Vite + Tailwind 4 + shadcn, built to `dist/` and served by the daemon |
| `packaging` | The `systemd --user` unit, the launcher, and the install/uninstall scripts |

## Running it from a checkout

```bash
npm install
npm run build

# In the foreground, for development:
npm start
# -> @toon-protocol/console-daemon 0.1.0 listening on http://127.0.0.1:7797
#    active profile: Devnet
#    open: http://127.0.0.1:7797/?t=<this launch's token>
```

Open the `open:` URL. The token is the only thing that gets the UI past the daemon's API,
and the page takes it out of the address bar as soon as it has it.

For UI work, `npm run dev` starts Vite with `/api` proxied to the daemon; open the dev
server's port with the same `?t=` the daemon printed.

## Installing it as an app

```bash
npm run build
packaging/bin/toon-console-install
```

That enables `toon-console.service` for your user and registers a **TOON Console** web app
through `omarchy-webapp-install`. `SUPER + SPACE` launches it; launching again focuses the
window that is already open rather than opening a second one. On a desktop without Omarchy
you get a plain `.desktop` entry instead.

`packaging/bin/toon-console-uninstall` removes both. It never touches
`~/.local/share/toon-console`, which is where channel state — and later the Lease Vault
cache — lives, nor the keystore.

## Signing in

An **Account** is a Nostr identity, and the console never becomes its key's owner
([ADR 0020][adr20]). Two ways in:

**A NIP-46 remote signer** — Amber, nsec.app, `nak bunker`. Paste the `bunker://` URI the
signer gives you, or let the console print a `nostrconnect://` for the signer to come to.
The private key never leaves the signer; every signature is a round trip to it, which means
a signature can take a moment and can be refused.

```bash
# A signer and a relay to reach it on, both locally:
nak serve --port 10547
nak bunker --sec $(nak key generate) ws://127.0.0.1:10547
# -> bunker://<pubkey>?relay=ws%3A%2F%2F127.0.0.1%3A10547&secret=…
```

**The console's local keystore** — generate a key, import an `nsec`, or import a NIP-06
mnemonic. The secret goes into **gnome-keyring through libsecret** when a Secret Service
answers on the session bus, and into a **passphrase-encrypted file** (scrypt + AES-256-GCM,
`~/.config/toon-console/keystore.json`, mode 0600) when none does. The header line the
daemon prints at startup says which you have; `TOON_CONSOLE_KEYSTORE=file` forces the
fallback.

Either way, `~/.config/toon-console/signers.json` lists the signers this machine knows —
label, npub, and a bunker's relays — and holds **no secret**, so the sign-in screen can say
what it would be unlocking before it asks.

The account's kind-0 name and avatar are read from its own NIP-65 relays when it publishes
a list, and otherwise from the relay the active network profile names. Reads are free, and
a relay that does not answer costs a name on screen and nothing else.

A **restart signs you out and forgets nothing else**: the session lives in the daemon
process, the signers and their secrets outlive it. That is deliberate — the UI's launch
token is minted per launch too, so a restarted daemon has no window to hand a session back
to.

## Networks

Three profiles, switchable from the header: **devnet** (the default), a **local sandbox**
(`infra/sandbox` on loopback), and **mainnet**, which is present and deliberately empty —
there is no public mainnet connector yet, and a guessed endpoint would be worse than none.

A profile names endpoints and **nothing else**. Every chain fact the console shows — the
ILP addresses a connector answers to, the chains it settles on, the token each chain
settles in, what a route costs — is read from that connector's own free `GET /ilp` when the
health view is opened. There is no chain id, token address or settlement address anywhere
in this repository, and `packages/daemon/src/profiles.test.ts` fails if one appears.

## Funds

The **Funds** view takes an account from empty to a payment channel it can pay a provider
from ([#90][i90]). One card per chain the active connector settles on, and every chain fact
on it — which chains those are, in which token, at how many decimals, against which
settlement address — is read from that connector's own `GET /ilp`.

- **A deposit address per chain, with a QR code**, derived from the Chain Seed at the paths
  `@toon-protocol/client` owns. The address and its derivation path are shown; the phrase
  is not, and there is no route in this daemon that would answer one ([ADR 0020][adr20]).
- **The faucet**, on a network that has one. The console reads its `/api/info` and repeats
  what it says about itself — what it drips, on which chains, how often — rather than
  describing it from memory, and asks it for a drip in place.
- **Balances**, on chain and in the channel, re-read on demand.
- **Open a channel** to the active profile's connector, through `@toon-protocol/client`.
  Channel state goes into the console's own data directory through the client's
  `channelStore` seam, one store per network: `~/.local/share/toon-console/channels/<profile>/`.
- **Prices are the connector's**, repeated. The suggested collateral is *n* packets at the
  price the connector quoted for its dearest route, and a route that meters by size carries
  its per-kibibyte rate unmultiplied. The console never works a price out for itself: the
  client and the connector round that charge differently and the connector is the one that
  decides ([TOON_Network#82][i82]).

### Native gas is the obstacle, and the view says so first

Opening a payment channel is a **transaction on a chain**, so it is paid for in that
chain's own coin — ETH on Base, SOL on Solana — which is not the token this network is
priced in and which no part of TOON Network can mint. A fresh Chain Seed has none of it on
either chain, and today nothing can hand it over:

- the devnet faucet gives the settlement token and **reports no ETH of its own to give**
  (`faucetBalances.eth: null`, which the console reads rather than assuming);
- the public Solana devnet airdrop is capped per day and answers `429` once it is;
- Base Sepolia has no ungated faucet.

So the daemon reaches a **gas verdict per chain before anything else**, and the view leads
with it — above the deposit address, not below a failed transaction. The Open button is
disabled with `blockedBy` written beside it whenever the chain cannot pay for the
transaction, and the sentence that goes with it is built from what the chains and the
faucet actually reported, so a network whose faucet started giving gas changes it without
anyone editing a screen.

The one thing that always works is the same address both sums go to: send a little of the
chain's own coin to the deposit address from a wallet that already holds some. The view
says that in those words, and hands a Solana account the `solana airdrop` command to copy.

### A reading that would be a lie says "unknown" instead

Three shapes exist so a bad answer cannot be rounded up into a good one:

| It happened | It reads as | It never reads as |
| --- | --- | --- |
| The RPC endpoint did not answer | `unknown`, with no figures at all | `0` |
| The opening transaction is in flight | `opening`, with the reason that waiting is the remedy | `failed` |
| This console holds no channel here | `none` — *no record of one* | "you have nothing" |
| Nobody has asked this account's relays for its Chain Seed yet | a look, and then whatever the look found | "you have no Chain Seed, mint one" |

That last row is the costly one: telling an account with a sealed seed on a relay that it has
none is how it ends up minting a second, and ADR 0020 says the console must never merge or
recover the loser. So the view looks before it says, and a look that could not happen leaves
the question open rather than closing it the wrong way.

A `watermarkUncertain` channel shows its figures and is not called a balance. The Open
button is off for an `unknown` chain as well as an empty one: not knowing whether a
transaction can be paid for is not permission to try.

Refreshing this view **uses no key material at all** — balances are address reads and
channel state comes from the console's own store — so an account on a NIP-46 remote signer
can leave it open without being asked to approve anything. The payer keys are derived
inside one call frame for one open and zeroed when it returns.

```bash
curl -H "authorization: Bearer $TOKEN" 'http://127.0.0.1:7797/api/funding?refresh=1'
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"chain":"evm:31337","deposit":"100000"}' \
  http://127.0.0.1:7797/api/funding/channel
```

`POST /api/funding/channel` answers as soon as the transaction is in flight, with the
channel reported as `opening`. A request held open for the length of a confirmation would
leave a caller unable to tell a slow chain from a dead daemon.

## The Provider Directory

The **Providers** view reads the directory — **Provider Profiles** (kind `10432`),
**Listings** (`30432`) and **Liveness** (`10433`) — free, over NIP-01, and shows them
together ([#91][i91], spec §4). Nothing is spent and no key is needed: a relay read is
free, so browsing costs nothing and the console holds no lease to do it.

- It starts at the relay the active profile names, then goes back to **each provider's own
  Relay Set**, which only that provider's Profile can tell it.
- A relay is not trusted. Every event has its id re-derived and its signature checked
  before it is shown, and a Listing whose Profile is on no relay read is not purchasable.
- Filters — isolation, arch, GPU, capabilities and hidden — go to the relay as the `l` and
  `t` tag filters §4.4 defines, and every one of them is checked again locally. "Not
  hidden" has no relay filter at all: a provider that is not hidden carries no `hidden:`
  label, and absence is not something a filter can ask for.
- Only the **current** version of a Listing is shown; older ones are counted and set aside
  (ADR 0009). Prices are shown per **Lease Interval**, in the µUSDC the Listing published —
  never converted.
- **Liveness** is live or stale, decided against the clock. The badge counts the provider's
  own `expiration` down in the browser and flips itself over when it passes, with no
  refetch and no new event (ADR 0007).

Paying a provider needs a channel, which is **Funds** above; choosing a tier and
spawning on it is [#92][i92].

```bash
curl -H "authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7797/api/directory?arch=amd64&capability=docker'
```

## Templates

The **Templates** view reads published **Templates** (kind `30436`) and shows each one's
image **by its content address** ([#94][i94], spec §8.3). A Template is a publisher's
signed description of a spawn — an image, its ports, the settings it fixes and the settings
a tenant may set — and it **grants no capability** (ADR 0004): what a lease may do comes
from its Listing and from nowhere else.

- **The tenant expands it.** In v1 the tenant, not the provider, turns a Template into a
  spawn; `template` in a spawn is informational and a provider never reads one (§8.3, §11
  item 5). "Preview the spawn" shows the §6.2 content that would be sent, and it is built
  by the same `buildSpawnContent` a manual spawn uses — `template-spawn.test.ts` compares
  the two field by field, which is what "the same result as the equivalent manual spawn"
  has to mean.
- **Only what the Template marks tenant-settable can be edited.** The fixed settings are
  shown and have no input; setting one is refused by the daemon, not merely hidden by the
  window. The daemon re-reads the publisher's signed event on every expansion, so nothing
  the browser says about the Template is believed.
- **A Template whose image cannot be resolved is shown as unavailable, with the reason,**
  and cannot be expanded. Resolution follows §8.4 as far as the RECORDS go and no further:
  the Image Registry entry (`30434`) must be on a relay, be the signer its address names,
  and be about the same digest, with a known source for every blob; a digest-alone Template
  needs a well-formed Blob Record (`30435`) found by `#x`. The console fetches **no image
  bytes** — the provider does, and verifies every one of them against the digest
  ([ADR 0006][adr6], §8.4). Each card says which of those was checked.

`POST /api/templates/spawn` expands and then buys: it hands the content to the same
`LeaseStore` the form below uses, so a Template is a convenience and not a second protocol.

```bash
curl -H "authorization: Bearer $TOKEN" 'http://127.0.0.1:7797/api/templates'
```

## Workloads

The **Workloads** view is where the console first **spends**. It holds the **Lease Vault**
and the spawn form.

A spawn buys one **Lease Interval** at the listing's price, there are no refunds, and a
request the provider refuses is billed exactly like one it accepts ([ADR 0003][adr3],
§5). So `POST /api/leases/preflight` exists: it is free, it sends nothing, and it answers
with the route, the price, the connector that will collect and **every problem with the
request** — the image's form, the ports, a volume the listing cannot fit, an SSH key that
is really a private one. The button is not live until it says `ok`.

### The Root Secret goes into the vault first

A lease is bound to a **Continuation Token** derived from a 32-byte **Root Secret** the
tenant mints (§6.1.1). Lose the secret and the lease is lost — not merely inaccessible:
nothing in the protocol can produce the token again. So the console seals the secret to the
account and **publishes it before the spawn is sent** ([ADR 0021][adr21]):

- one NIP-78 record per workload, kind `30078`, `d` = `toon-console/lease/<workload id>`,
  NIP-44-sealed to the account itself;
- written to the account's NIP-65 **write** relays, with a local cache;
- a write no relay accepted **aborts the spawn**, so nothing is paid for a lease whose
  secret only one disk would hold.

A lease may be marked **local only**. It is still sealed and signed, and it is kept here
and nowhere else — no relay learns the workload exists, and if this disk goes the lease
goes with it.

Sign in on another machine and the vault comes back from the relays, access details and
all. If the account's relay list is not on the network's own relay — and on a TOON network
it will not be, because that relay charges for writes — name one to look on from the
Account tab first, exactly as for the Chain Seed.

### What a refusal leaves behind

| What happened | What the vault does |
| --- | --- |
| The provider answered with an `error` code, or the packet was rejected | The record is taken back: a tombstone replaces it and a NIP-09 deletion goes out |
| The spawn never left (the payer keys could not be borrowed) | The record is taken back; nothing was paid |
| The packet went out and nothing came back | **The record is kept.** A workload may be running behind it, and this secret is the only thing that could ever stop it |

The provider's own code is what you are shown — `no_capacity` is "try elsewhere",
`refused_image` is "not that image here" — never a sentence this console made up about it.

### Which connector collects

A spawn is addressed to the provider's ILP route and sealed to its connector's pinned key
(§4.1, [ADR 0011][adr11]). Who takes the payment is read from the two self-descriptions
the console can fetch: the **active profile's connector** when it publishes a route
carrying the provider's prefix — the local sandbox's hub does — and the **provider's own
connector** otherwise, which always terminates its own routes. Devnet is the second case
today.

A spawn never opens a channel: opening locks collateral on chain and pays that chain's own
gas, and neither is a thing to do to somebody who pressed "spawn". It refuses with
somewhere to go instead, and `POST /api/funding/channel` takes a `connector` so the channel
can be opened with the right one. A spawn may also name the `chain` to pay on, which
matters when you hold channels on two: a connector that has to convert refuses a packet
whose amount converts to nothing at the rate it declares — at full price.

```bash
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:7797/api/leases
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"<pubkey>","listing":"basic","image":{"reference":"traefik/whoami","digest":"sha256:…"},"ports":[{"containerPort":80}],"sshPublicKey":"ssh-ed25519 …"}' \
  http://127.0.0.1:7797/api/leases/preflight
```

## Security

The daemon binds `127.0.0.1` and refuses a request whose `Host` is not a loopback name. The
UI's files are public and served to anyone on the machine who asks; the **API is not** —
every `/api/*` call carries a bearer token minted fresh at each launch and handed to the
window once, on the URL. A restart invalidates it. There is no long-lived credential on
disk.

Key material is held by the daemon and by the keystore, and by nothing else. **A private
key never appears in an API response, in a log line, or in the UI's storage** — the only
thing the window keeps is the launch token, in `sessionStorage`. An nsec, a mnemonic and a
keystore passphrase travel one way: typed into a form, posted once over loopback under the
launch token, and sealed. `api-account.test.ts` and `sign-in.test.tsx` are the tests that
say so.

The **Chain Seed** is held the same way ([ADR 0020][adr20]). It is sealed to the account
and never revealed: there is no route that exports it, no answer that carries it, and
recovery is the Nostr key alone. The payer keys an open needs are derived inside one call
frame, lent to that one transaction and zeroed when it returns —
`packages/daemon/src/api-funding.test.ts` is the test that says no funding answer carries
key material, and `funding.test.ts` is the one that says the keys come back wiped.

A lease's **Root Secret** is held the same way ([ADR 0021][adr21]). It is minted in the
daemon, sealed to the account and published; the type the API answers with has no field
for it, so no route can return one by forgetting to strip it.
`packages/daemon/src/api-leases.test.ts` and `lease-vault.test.ts` are the tests that say
so — on a spawn that worked, a spawn that was refused, and a read of the whole vault.

## Development

```bash
npm run lint         # eslint 9, flat config
npm run typecheck    # tsc, both packages
npm test             # vitest, both packages
npm run test:packaging  # node --test, guards on the install bundle
```

The vocabulary — **Console**, **Account**, **Signer**, **Chain Seed**, **Lease Vault** — is
defined in [TOON_Network's `CONTEXT.md`][context]. A Tenant signs nothing and has no
published identity; nothing in this repository should suggest otherwise.

[spec]: https://github.com/toon-protocol/TOON_Network
[context]: https://github.com/toon-protocol/TOON_Network/blob/main/CONTEXT.md
[client]: https://www.npmjs.com/package/@toon-protocol/client
[adr3]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0003-one-payment-buys-one-lease-interval.md
[adr6]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0006-image-bytes-are-verified-by-digest-wherever-they-are-stored.md
[adr11]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0011-a-profile-pins-its-connectors-sealing-key.md
[adr19]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0019-the-console-is-a-local-app-not-a-website.md
[adr20]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0020-an-accounts-chain-keys-come-from-a-seed-sealed-to-it.md
[adr21]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0021-root-secrets-are-vaulted-on-the-accounts-own-relays.md
[i89]: https://github.com/toon-protocol/TOON_Network/issues/89
[i90]: https://github.com/toon-protocol/TOON_Network/issues/90
[i91]: https://github.com/toon-protocol/TOON_Network/issues/91
[i92]: https://github.com/toon-protocol/TOON_Network/issues/92
[i93]: https://github.com/toon-protocol/TOON_Network/issues/93
[i94]: https://github.com/toon-protocol/TOON_Network/issues/94
[i82]: https://github.com/toon-protocol/TOON_Network/issues/82
