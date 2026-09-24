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
([#92][i92]), and — once one chain is paid for — it can **buy the next chain's gas** through a
gas station ([#119][i119]). The workload dashboard ([#93][i93] onward) builds on it.

## What is here

| Path | What it is |
| --- | --- |
| `packages/daemon` | Node/TypeScript daemon: the local JSON API, the loopback server, the network profiles |
| `packages/ui` | React 19 + Vite + Tailwind 4 + shadcn, built to `dist/` and served by the daemon |
| `packages/site` | The public landing page and docs site: React 19 + Vite, one static build |
| `docs` | The documentation, as Markdown. The source of the site, the Help tab and the published articles |
| `deploy` | The Caddy site block, and the runbook a human follows to deploy and publish |
| `packaging` | The `systemd --user` unit, the launcher, the install/uninstall scripts, and the AUR package |

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

Two ways in, and they install the same thing in two different places. A package puts the
console in `/usr` and pacman owns it; a checkout puts it in your `$HOME` and you own it.
Either way the daemon is a `systemd --user` service and the console is opened by
`toon-console`.

### From the AUR (Arch, Omarchy)

```bash
yay -S toon-console      # or: paru -S toon-console
toon-console-install     # once, as yourself
```

> The package is `packaging/aur` in this repository and is **not published yet**: it is
> built from the tag `v$pkgver`, and this repository has no tags. Until one exists, build
> it yourself — `makepkg -si` in a copy of `packaging/aur` with `pkgver` pointing at a tag
> you made — or use the checkout path below. What publishing needs is in
> [`packaging/aur/README.md`](packaging/aur/README.md).

The package installs the daemon, the UI, the docs, the launcher, the desktop entry and the
`systemd --user` unit. `toon-console-install` does the half a package cannot: it enables
and starts the service for **your** user, and — on Omarchy — installs the themed template,
the theme-set hook, the three menu entries and a `post-update.d` hook into your
`~/.config/omarchy`. It is idempotent; run it again whenever you like.

`SUPER + SPACE` launches **TOON Console**; launching again focuses the window that is
already open rather than opening a second one.

| | Where |
| --- | --- |
| the daemon and its `node_modules` | `/usr/lib/toon-console` |
| the unit | `/usr/lib/systemd/user/toon-console.service` |
| the UI, the docs, the Omarchy sources | `/usr/share/toon-console` |
| the launcher and the two setup commands | `/usr/bin` |
| **your** channel state, Chain Seed, Lease Vault cache and keystore | `~/.local/share/toon-console` |
| **your** active profile | `~/.config/toon-console` |
| this login session's launch token | `$XDG_RUNTIME_DIR/toon-console` |

**Upgrading keeps your data.** The package names nothing under `~/.local/share` or
`~/.config`, so pacman cannot touch either: `pacman -Syu` replaces `/usr` and leaves every
account's state alone. What it cannot do is restart a user service — it runs as root,
outside your session — so after an upgrade:

```bash
systemctl --user daemon-reload
systemctl --user try-restart toon-console.service
```

(Re-running `toon-console-install` does the same thing: it restarts the service rather than
starting it, precisely so that running it after an upgrade leaves the new build running.)

On Omarchy the `post-update.d` hook does exactly that on the next `omarchy update`, and
re-applies the template, the hooks and the menu entries if the package changed them. It
re-themes only if the template it wrote actually changed, and it never starts a console you
had stopped.

**Removing it takes the lot.** Run `toon-console-uninstall` first — it stops and disables
the service and takes the Omarchy files and the menu entries back out of your `~/.config` —
then `pacman -R toon-console`. (The install left a copy of the uninstaller in
`~/.local/bin`, so the order does not actually matter.) Your data directory survives both,
on purpose; delete `~/.local/share/toon-console` yourself if you mean it.

The package is built from a git tag and lives in `packaging/aur`, with the release and
publishing runbook in [`packaging/aur/README.md`](packaging/aur/README.md).

### From a checkout (any Linux desktop)

No Arch and no AUR needed — node 22+, bash and a `systemd --user` session are the whole
list:

```bash
npm ci
npm run build
packaging/bin/toon-console-install
```

That writes the launcher to `~/.local/bin/toon-console` and the unit to
`~/.config/systemd/user/toon-console.service`, both pointing at this checkout, enables the
service and installs a launcher entry: an `omarchy-webapp-install` web app where Omarchy is
present, and a plain `~/.local/share/applications/toon-console.desktop` where it is not.
It also installs the Omarchy integration below if `~/.config/omarchy` exists, and skips it
silently if it does not.

`--omarchy-only` installs just that desktop half, leaving a running service and its
launcher alone; `--no-omarchy` leaves it out; `--no-webapp` forces the plain desktop entry.

On a desktop that is not Omarchy the console opens in your browser through `xdg-open`,
with the default theme in `packages/daemon/src/theme.ts` rather than your desktop's
colours. Everything else — the service, the API, the notifications — is the same.

`packaging/bin/toon-console-uninstall` removes all of it. It never touches
`~/.local/share/toon-console`, which is where channel state and the Lease Vault cache live,
nor the keystore.

### If your session has no keyring

The local keystore uses `secret-tool` (libsecret) when a Secret Service answers on the
session bus, and a passphrase-encrypted file when none does (ADR 0020). Nothing has to be
installed for the second; `TOON_CONSOLE_KEYSTORE=file` forces it.

## Part of the desktop

The console is an Omarchy app, not a website that happens to run locally (ADR 0019). Four
pieces of it live in your own `~/.config/omarchy` rather than in this repository or in
`/usr`, because they are yours, and each is one file:

| File | What it does |
| --- | --- |
| `~/.config/omarchy/themed/toon-console.css.tpl` | Omarchy renders it against the current theme on every theme change |
| `~/.config/omarchy/hooks/theme-set.d/toon-console` | tells a running daemon the theme moved |
| `~/.config/omarchy/hooks/post-update.d/toon-console` | after `omarchy update`: re-applies these files and restarts a running daemon |
| `~/.config/omarchy/extensions/omarchy-menu.jsonc` | three menu entries, between this package's own markers |

`toon-console-install` writes all four and `toon-console-uninstall` takes all four out; the
menu file itself is yours, so only the lines between this package's markers are touched.

### The colours are the desktop's

**There is no palette in this app.** `packages/ui` names its colours and gives none of them
a value; `packaging/omarchy/toon-console.css.tpl` maps the current Omarchy theme onto those
names, Omarchy renders it into `~/.local/state/omarchy/current/theme/toon-console.css`
whenever a theme is set, and `packages/daemon/src/theme.ts` reads the result and hands it to
the window. The daemon puts that `:root` rule into the page it serves, so the first paint is
already the right colours, and replaces it over `/api/desktop` when the theme changes under
an open window. Nothing restarts and nothing reloads: a custom property changing repaints
the page.

Surfaces are mixes towards the theme's foreground rather than named shades, because half of
Omarchy's themes are light and `lighter_background` is a raised surface on one and a
recessed one on the other. Meaning comes from the theme's own semantic colours — a
destructive button is its red.

What comes back off disk is treated as input: the daemon keeps only the properties the UI
reads, checks each value against a character set that cannot close a style block, and builds
the rule itself.

On a desktop that is not Omarchy, none of this exists and the console starts on the one
default theme in the repository, which lives in `theme.ts` and is named there as the
fallback it is.

### The menu opens a view

Each entry runs `toon-console --view <workloads|new-workload|funds>`, which posts the view to
the daemon and then hands the window to `omarchy-launch-or-focus-webapp`. The post is what
makes the entry work on a window that is **already open**: focusing is all Omarchy can do to
one, so the window is told separately and switches tab. A request older than a minute is
ignored, so a window opened an hour later opens where it always does.

### Three notifications, once per event

`omarchy-notification-send` carries exactly three things, and a card on the dashboard is
where all three come from (`packages/daemon/src/alerts.ts`):

- **runway under 24 hours** — the figure is `card.runway.seconds`, never a second sum;
- **a Takeover** — keyed by the Standby that won, so a later Takeover by another one is a
  new event;
- **an Eviction** — keyed by the workload, and it survives a restart.

An open window polls the dashboard every thirty seconds and the daemon polls it every five
minutes with none open, so an event is seen many times and announced once. What has been
said is written to `alerts.json` beside the account's other state. A runway that recovers
above the line forgets its key, so the next fall below it is news again.

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

## The dashboard

Once a lease exists, the **Workloads** view is one card per workload: what it is doing, how
long the money keeps it doing that, and the three things that can be done about it
([§6.3][spec], §6.5, §6.6, §6.7).

### What it is doing

The state and the expiry are read from the provider with the lease's **Continuation
Token**, derived inside the daemon from the Root Secret for the length of one packet. Four
answers are told apart, and the difference matters:

| | What it means |
| --- | --- |
| **read** | The provider answered. `provisioning`, `reserved`, `running`, `stopped`, or an ending |
| **silent** | No answer came back, or a hop refused the packet. **The lease may be running perfectly** |
| **refused** | The provider answered a refusal — `unknown_workload`, `not_tenant`. Something definite |
| **unread** | This console could not ask. The only one that is its own fault |

A lease can end by **Expiry** (nobody bought another interval), **Termination** (its tenant
ended it) or **Eviction** (its provider did, and must publish an Eviction Notice). The card
says which; it never flattens the three into "gone". An ending a later spec version adds is
quoted verbatim rather than guessed at.

### Runway

**How long current funds keep the workload alive**: the time already paid for, plus the
whole Lease Intervals the channel can still buy. Either half can be missing, and when one
is the card says which — never a zero standing in for "not known".

The price counted is **the paying connector's quote for this lease's `.extend` route**, not
the Listing's µUSDC figure. They are different numbers in different units: a channel's
balance is in base units of whatever that connector settles in, and a connector that
forwards adds its own fee ([TOON_Network#82][i82]: the connector decides what a packet
costs, and nothing here recomputes one). The Listing's own price is shown beside it.

### Free where it is free

`status` and `terminate` are free routes (§5) — but that is the **provider's** price. A
connector that merely forwards charges its own fee to carry them: on the local sandbox the
hub charges 100 base units for the same `status` the provider's connector prices at zero.
So the console reads both quotes and buys a free route where it is free, falling back to
[ADR 0005][adr5]'s ordinary preference and **naming the price** when no zero-priced path
exists.

### Extending

An extension buys one interval and **is not free**, and §6.3's refusals — `expired`,
`not_running`, `wrong_listing_version`, `unknown_workload` — are billed at the full price
([ADR 0003][adr3], [TOON_Network#115][i115]). So everything checkable is checked before a
packet goes out, and when a check fails the answer is `sent: false` with nothing paid:

- the Listing still exists **at this lease's version** — a retired one is
  `wrong_listing_version`;
- a free `status` says the lease has not ended, and is not a Reserved Warm Standby (that is
  `.standby.extend`, at the standby price);
- the price has not moved past what the caller agreed to;
- there is a channel with the connector that would collect, **on the chain this lease was
  bought on** — a connector forwarding to a provider's has to convert, and refuses a packet
  whose amount converts to nothing at the rate it declares, at full price.

`extend` takes its content **bare** — `{ "workload_id": "…" }`, no Lease Request and no
token, because any payer may extend any lease ([ADR 0005][adr5]) — while `status` and
`terminate` take §6.1's full request and must present the lease's own token. A Gateway
Grant admits `status` and nothing else (§6.5.1).

### Automatic extension, within a budget

The one thing in this console that **spends money with nobody present**. Nine rules can
each stop it on its own:

1. **Off until armed**, per lease. There is no global switch and no default.
2. **Arming takes an explicit confirmation** and the price being agreed to, checked against
   the connector's live quote — so a stale tab cannot arm at a price that has moved.
3. **The budget is an absolute cap** in the units the channel pays in. It never spends part
   of an interval and never overruns by one.
4. **A price that moved stops it** rather than paying it: a price change is a new Listing
   version ([ADR 0009][adr9]), which is a different offer.
5. **Silence buys nothing.** A provider that is not answering has said nothing about the
   lease.
6. **A billed refusal disarms it**, rather than spending the budget learning the same thing
   every minute.
7. **An extension whose fate is unknown disarms it**: a second might buy a second interval
   nobody asked for.
8. **It acts only inside a lead window** bounded by the Lease Interval — [ADR 0003][adr3]
   refunds nothing, so an interval bought early cannot be handed back.
9. **Every run is written down** — extended, waited or stopped — with the sentence that
   decided it. The card shows the last one.

A budget lives on **this machine**, not in the Lease Vault and not on a relay: only the
machine running the daemon can carry out a standing instruction to spend, so signing in
elsewhere arms nothing.

### Terminating

Free, immediate and irreversible, with no refund (§6.6). The card asks twice, and the
ending is remembered locally — a terminated lease is swept soon afterwards, and without
that the card would go from "Ended — Termination" to "this provider has never heard of it".

```bash
curl -H "authorization: Bearer $TOKEN" 'http://127.0.0.1:7797/api/workloads?refresh=1'
curl -X POST -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:7797/api/workloads/<workload id>/extend
curl -X POST -H "authorization: Bearer $TOKEN" \
  http://127.0.0.1:7797/api/workloads/<workload id>/terminate
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

So is every **Continuation Token** derived from one. `LeaseVault.withContinuation` lends a
token for the length of one packet and there is no getter beside it: a token that could be
fetched is a token that could be logged, echoed into an answer, or held in a variable that
outlives the request it was for, and §6.1.1 forbids all three.
`packages/daemon/src/api-workloads.test.ts` is the test that says no dashboard answer — a
card, an extension or a termination — carries either value.

## The site and the docs

The pages in `docs/` are the source, and three things read them ([#102][i102]):

- the **public site** (`packages/site`), served by Caddy at a devnet domain name;
- the console's **Help tab**, served by the daemon at `/api/docs`;
- the **published articles**, one [NIP-23][nip23] long-form event (kind 30023) per page,
  signed by TOON Network's documentation npub, readable in any Nostr client.

The site and the console both render the published articles and fall back to the bundled
Markdown when no relay answers, saying which of the two is on screen. Which npub to read is
configuration, never a constant: `TOON_CONSOLE_DOCS_NPUB` for the daemon, `docsNpub` in the
site's runtime `site-config.json`. With neither set, both show the bundle and say so.

Publishing is a command a human runs, and it **spends money**. Kind 30023 is addressable,
so re-publishing an edited page *replaces* its article rather than adding a second copy —
the `d` tag is the page's slug and never changes:

```bash
npm run build -w @toon-protocol/console-daemon
node packages/daemon/dist/main-docs-publish.js --dry-run   # the plan, spending nothing
node packages/daemon/dist/main-docs-publish.js             # one paid relay write per page
node packages/daemon/dist/main-docs-publish.js --verify    # each `d` replaced, not duplicated
```

Every write goes through `PaidRelayWriter` — the console's one paid-write path
([#120][i120]) — as a sealed TOON packet against an open payment channel. There is no
plain-websocket write anywhere in this repository, and the publisher never opens a channel:
it refuses with somewhere to go rather than locking collateral because a script ran.

[`deploy/README.md`](deploy/README.md) is the whole runbook: building, copying to the relay
Linode, the Caddy block, minting the documentation key and funding the publisher. Nothing in
CI deploys, and nothing in this repository touches a box's settlement key.

```bash
npm run dev:site          # the public site, against the bundled Markdown
```

### What the site looks like, and why

The landing page sells a lease, so a lease is the first thing on it: the hero is a meter
you can press, with the devnet provider's own prices on it. Paying lights another interval
and buys another hour; stopping darkens the whole strip and says what actually happened —
the workload stopped, nobody cancelled it, and nothing further was owed. It is the one
moving thing on the page, it only moves when somebody moves it, and it is labelled a
drawing rather than a live lease.

The rest follows from that. A **mission** band states what the project is for and is the
one surface that inverts, because it is the one claim everything under it is evidence for.
Sections are a meter's parts — hairline rules, graduation ticks and a readout — and not a
grid of identical cards; a section's heading sits in the margin the way a clause heading
does in a specification. Two accents carry meaning and nothing else is coloured: **amber**
is money and time (prices, paid intervals, commands), **steel** is a live or published fact
(the network chip in the nav bar, a gateway hostname).

The console is opened as an Omarchy web app, so the site is dressed like one, taking its
cues from [omarchy.us][om]: square corners, interface type set in a monospace, blocks
rather than pills, and a thin dither of squares over the page. That dither is
`src/dither.svg`, generated once from a seeded grid and checked in, and it is the same
grid the lease meter's intervals sit on and the same grid the **hero banner** is drawn on
— the wordmark is a seven-row bitmap face, one square per pixel, coming apart into the
dither at its right-hand end. Nothing in it is random at runtime: which pixel dims and
which comes loose is a hash of its position, so the banner is identical in every browser.
The bar itself carries no mark — the banner is the wordmark, and a second one above it was
one too many. What the bar carries instead is the project: its **source** on GitHub and
where it **posts** on X, both as their own marks, beside the install button and the theme
control. The specification is one line further down every page, in the footer.

**The palette is Omarchy's.** A theme there is `themes/<name>/colors.toml` — a background,
a selection, a muted line, four foregrounds and the sixteen terminal colours — and the
desktop is re-dressed from it. `site.css` carries eleven of those files as
`[data-theme='<name>']` blocks, mapped onto this site's roles: `background` is the page,
`selection` and `muted` are its rules, the theme's yellow is money and time, its accent or
cyan is a live fact. The inverted mission band is derived rather than written down
(`--paper: var(--ink)`), so every theme gets one for free, and a light theme inverts it the
other way without a second rule. The nav bar has the same palette button Omarchy's site
has, bound to the same key: **T** steps through the themes. The choice is remembered, and
with no choice stored `prefers-color-scheme` picks between Tokyo Night and Rosé Pine Dawn.
A swatch in that menu is painted by putting the theme's id on a `<span>` and letting its
own block colour it — no palette is written twice, so a theme cannot be listed in colours
it does not have.

Type has two faces and three roles: IBM Plex Mono is the machine speaking and anything you
could copy (headings, controls, prices, commands); IBM Plex Serif is what you read at
length — the prose, and the mission, which is the one claim made in a human voice rather
than a machine's. The faces are served from this build (`packages/site/src/fonts`,
[OFL][ofl]) — a page whose whole boast is that it needs no network should not fetch its
typeface from Google.

[om]: https://omarchy.us/

[ofl]: packages/site/src/fonts/OFL.txt

## `smoke-console`: the whole thing, on a live network

One command drives everything above end to end against a real network ([#101][i101]): it
starts a daemon of its own, signs in with a local key, seals a Chain Seed, opens every
channel that will collect, publishes a Template, spawns from it, extends, rotates, hands
the workload to a gateway, terminates — and then starts a **second daemon on a data
directory made seconds ago**, signs in as the same account, and recovers every lease from
the Lease Vault.

```bash
# The local docker sandbox (`infra/sandbox`, `make up`):
npm run smoke:console -- --chain solana

# The public test network, re-using one channel run after run:
TOON_SMOKE_CHAIN_SEED="<a phrase you keep>" \
  npm run smoke:console -- --profile devnet --deposit 6000 --state-dir ~/.cache/toon-smoke

npm run smoke:console -- --help    # every flag, and what it costs
npm run smoke:console -- --stages  # the seventeen stages, in order
```

**The sandbox is the default** because it is cheap and repeatable: anvil's money, a
Solana validator on loopback, providers in containers. `--profile devnet` points the same
run at the public network. Nothing else differs — the chains, prices, providers, Listings
and gateway are read from whichever network it was pointed at, so the difference between
the two runs is only what those answers say.

It does not install, uninstall, enable, disable or restart anything. `XDG_DATA_HOME`,
`XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` point at a temporary tree, the port is `0`, and
`TOON_CONSOLE_KEYSTORE=file` keeps this run's keys inside that tree — so a machine already
running a console ends the run exactly as it began.

### What it will not claim

A stage is **proved**, **skipped** or **failed**, and a skip is never a pass. What one
network cannot carry it says so by name, with the reason:

| | Local sandbox | Devnet |
| --- | --- | --- |
| Standby Set (§7) | proved — two providers sell a `standby_price` | **skipped**: one provider publishes one |
| Hidden Provider (§10) | proved — the `hs` profile publishes one | **skipped**: no Profile here is `hidden` |
| Gateway handover (§12) | **skipped** unless `make up-gateway` ran | proved against the devnet gateway |

The ending lists every skipped stage, and — when a failure stopped the run — every stage
it never reached, because a stage that did not run is not a stage that passed.

Two stages are deliberately *free* proofs rather than purchases. The Standby Set is a
`POST /api/leases/standby-set/preflight`, which prices and routes every member and sends
nothing: buying a second lease to watch a **Takeover** would mean stopping a provider, and
this smoke does not arrange that. The Hidden Provider stage asserts the other half of
[ADR 0008][adr8] when no circuit is configured — that the console **refuses** to dial a
`.anyone` address rather than leaking the lookup.

### What it costs, and what it leaves

Every stage reports what it spent and the ending adds it up. One run buys one lease:

| | Local sandbox | Devnet |
| --- | --- | --- |
| spawn / extend | 1100 + 1100 (the hub adds its own fee) | 1000 + 1000 at the provider's connector |
| status, rotate, terminate | 100 each at the hub — **the sandbox providers publish docker-internal connector URLs**, so a free route is bought through a hop that charges for carrying it | 0: the provider's own connector terminates them |
| relay writes | 1 each: the Chain Seed, the Image Registry entry, the Template, the vault record, the rotation | the same |
| **one run** | **2605 base units** | **2005 µUSDC** |

It leaves no lease running — the teardown ends one even when a stage failed — and it says
what is left in each channel.

Spending that rather than stranding it takes **both** `TOON_SMOKE_CHAIN_SEED` and
`--state-dir`, and the second is the one that is easy to miss. The seed decides which
address the channel belongs to; the state directory carries that channel's **watermark**,
which is local bookkeeping the connector also keeps. Re-use the seed with a fresh
directory and the console signs a claim the connector has already seen — `F01 … nonce does
not advance this channel's watermark (replay)` — and is billed for the refusal. With both,
the funding stage finds the channel open and sends nothing: a second devnet run took 18s
instead of 42s and funded nothing at all.

The **recovery** daemon always gets a fresh directory, whatever `--state-dir` says. That is
the assertion the whole smoke exists for.

`TOON_SMOKE_FUNDER_MNEMONIC` is the phrase whose account 0 the payer is topped up from. It
defaults to the development phrase every local chain in this fleet is seeded with, and it
**never opens a channel and never signs a claim** — it sends two transfers to an address
this run derived and is done. Funding a fresh address rather than re-using a shared one is
not politeness: a shared payer's channels carry a nonce watermark that earlier runs have
moved on, and the loser of that race has every later claim refused.

### Which chain, when a connector settles on two

`--chain` picks the settlement chain. It matters where a connector forwards to a peer that
settles in a **different token**: the hop has to convert, and it refuses a packet whose
amount converts to nothing at the rate it declares — at full price ([ADR 0003][adr3]). The
sandbox hub settles EVM in one token and Solana in another, and only the Solana one is what
its provider peers take, so `--chain solana` is the sandbox's spelling. Without it the
spawn is refused, billed, and the failure says so along with the other chain to try.

### It is not in CI, and this is why

Milestone 8 asked for the reason rather than the fact. Three, each sufficient alone:

1. **It spends.** Every run buys a lease, an extension and five relay writes on a live
   network. A test that moves money on every push is a test that will one day move money
   nobody meant to move.
2. **Its sandbox is not a container this repository can start.** `make up` in
   `infra/sandbox` builds images from four sibling checkouts — the provider, the gateway,
   the store and anytoon — none of which CI has.
3. **Devnet is shared and single-threaded.** One provider, and one channel per payer; two
   runs at once share a nonce watermark and the loser has every later claim refused. A
   merge queue is exactly the thing that would run two at once.

What CI *does* run is `packages/daemon/src/smoke-console.test.ts`: the report, the skip
policy, the summary's obligations and the image mapping, driven with fixtures. The
judgement about what counts as proved is tested on every push even though the network is
not.

## Development

```bash
npm run lint         # eslint 9, flat config
npm run typecheck    # tsc, every package
npm test             # vitest, every package
npm run test:packaging  # node --test, guards on the install bundle
npm run smoke:console   # the end-to-end acceptance test; it SPENDS (see above)
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
[i119]: https://github.com/toon-protocol/TOON_Network/issues/119
[i94]: https://github.com/toon-protocol/TOON_Network/issues/94
[i115]: https://github.com/toon-protocol/TOON_Network/issues/115
[adr5]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0005-tenant-identity-comes-from-the-request-not-payment-headers.md
[adr8]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0008-a-hidden-provider-hides-ingress-egress-and-settlement.md
[adr9]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0009-a-price-change-is-a-new-listing-version.md
[i82]: https://github.com/toon-protocol/TOON_Network/issues/82
[i101]: https://github.com/toon-protocol/TOON_Network/issues/101
[i102]: https://github.com/toon-protocol/TOON_Network/issues/102
[i120]: https://github.com/toon-protocol/TOON_Network/issues/120
[nip23]: https://github.com/nostr-protocol/nips/blob/master/23.md
