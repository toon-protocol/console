# The TOON Console

The console for [TOON Network][spec]: a **local daemon plus a web UI**, opened as an
Omarchy web app. It is not a website. A `systemd --user` service runs
[`@toon-protocol/client`][client], serves the UI on `127.0.0.1`, and — in the tickets after
this one — holds the account's keys and manages its workloads. Nothing about an account
lives on a server anyone else operates ([ADR 0019][adr19]).

It installs, starts and opens, it knows which network it is pointed at, it can tell you
what that network's connector says about itself, and an **Account** can sign in with its
**Signer**. Funds ([#89][i89]) and the workload dashboard ([#90][i90] onward) build on it.

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
say so. The Chain Seed and the Lease Vault arrive with [ADR 0020][adr20] / [ADR 0021][adr21]
and [#89][i89] onward.

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
[i89]: https://github.com/toon-protocol/TOON_Network/issues/89
[i90]: https://github.com/toon-protocol/TOON_Network/issues/90
