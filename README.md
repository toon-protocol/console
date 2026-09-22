# The TOON Console

The console for [TOON Network][spec]: a **local daemon plus a web UI**, opened as an
Omarchy web app. It is not a website. A `systemd --user` service runs
[`@toon-protocol/client`][client], serves the UI on `127.0.0.1`, and — in the tickets after
this one — holds the account's keys and manages its workloads. Nothing about an account
lives on a server anyone else operates ([ADR 0019][adr19]).

This repository is the skeleton: it installs, starts and opens, it knows which network it
is pointed at, and it can tell you what that network's connector says about itself. Sign-in
([#88][i88]), funds ([#89][i89]) and the workload dashboard ([#90][i90] onward) build on it.

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
cache — lives.

## Networks

Three profiles, switchable from the header: **devnet** (the default), a **local sandbox**
(`infra/sandbox` on loopback), and **mainnet**, which is present and deliberately empty —
there is no public mainnet connector yet, and a guessed endpoint would be worse than none.

A profile names endpoints and **nothing else**. Every chain fact the console shows — the
ILP addresses a connector answers to, the chains it settles on, the token each chain
settles in, what a route costs — is read from that connector's own free `GET /ilp` when the
health view is opened. There is no chain id, token address or settlement address anywhere
in this repository, and `packages/daemon/src/profiles.test.ts` fails if one appears.

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

Choosing a tier and spawning on it is [#90][i90].

```bash
curl -H "authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7797/api/directory?arch=amd64&capability=docker'
```

## Security

The daemon binds `127.0.0.1` and refuses a request whose `Host` is not a loopback name. The
UI's files are public and served to anyone on the machine who asks; the **API is not** —
every `/api/*` call carries a bearer token minted fresh at each launch and handed to the
window once, on the URL. A restart invalidates it. There is no long-lived credential on
disk, and **this skeleton holds no key material at all**: signers, the Chain Seed and the
Lease Vault arrive with [#88][i88] and [ADR 0020][adr20] / [ADR 0021][adr21].

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
[adr19]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0019-the-console-is-a-local-app-not-a-website.md
[adr20]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0020-an-accounts-chain-keys-come-from-a-seed-sealed-to-it.md
[adr21]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0021-root-secrets-are-vaulted-on-the-accounts-own-relays.md
[i88]: https://github.com/toon-protocol/TOON_Network/issues/88
[i89]: https://github.com/toon-protocol/TOON_Network/issues/89
[i90]: https://github.com/toon-protocol/TOON_Network/issues/90
[i91]: https://github.com/toon-protocol/TOON_Network/issues/91
