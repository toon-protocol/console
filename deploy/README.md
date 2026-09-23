# Deploying the site, and publishing the docs

Two separate things, done by a human, in this order:

1. **The site** is a static build served by Caddy on the relay Linode.
2. **The docs** are published as NIP-23 articles, which costs money and needs a key.

The site works before step 2 — it renders the Markdown it was built with and says so in a
banner. Step 2 is what makes the pages readable in any Nostr client, and what lets them be
corrected without a redeploy.

Nothing here is run by CI, and nothing in this repository deploys itself. The fleet is
GitOps and a box refuses a dirty tree, so every command below is one a person types.

---

## 1. Build the site

From a clean checkout of `toon-protocol/console` at the commit you want live:

```bash
npm ci
npm run build -w @toon-protocol/console-site
```

The build lands in `packages/site/dist`. It contains `index.html`, a content-hashed
`assets/` directory, `favicon.svg`, `robots.txt` and `site-config.json`.

Check it locally first — this serves the same files Caddy will:

```bash
npm run preview -w @toon-protocol/console-site
```

## 2. Copy it onto the relay Linode

```bash
# On the box, once:
sudo mkdir -p /srv/toon-site
sudo chown "$USER" /srv/toon-site

# From this machine, for each release:
rsync -a --delete packages/site/dist/ <relay-host>:/srv/toon-site/
```

`--delete` is deliberate: the asset filenames are content-hashed, so without it every
release leaves its predecessor's bundle behind forever.

## 3. Add the Caddy site block

`deploy/Caddyfile.site` in this repository is the block. **It is not applied from here.**
Put it into the relay host's Caddy configuration in the `infra` repository, in a pull
request, and let the fleet's own deploy apply it:

```bash
# In the infra checkout, on a branch:
cp <console-checkout>/deploy/Caddyfile.site \
   <wherever-that-host's-caddy-snippets-live>/toon-site.caddy
# then: commit, PR, merge, and let the box converge.
```

Then, on the box, after the configuration has landed:

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

DNS: `toonprotocol.dev` and `www.toonprotocol.dev` must both point at the relay Linode
before Caddy can get a certificate for them. Note the stale records already recorded in
TOON_Network#84 — `*.pay.toonprotocol.dev`, `connector.toonprotocol.xyz` and
`relay-ws.toonprotocol.xyz` point at an address that is not in the account — and do not
add to them.

## 4. Check it

```bash
curl -sSI https://toonprotocol.dev/ | head -1
curl -sS  https://toonprotocol.dev/site-config.json
# The routing rule that is easy to get wrong: a deep link must not 404.
curl -sSI https://toonprotocol.dev/docs/funding | head -1
```

---

## 5. Mint the documentation key

**Once, ever.** This prints a key and stores it nowhere:

```bash
npm run build -w @toon-protocol/console-daemon
node packages/daemon/dist/main-docs-publish.js --new-key
```

It prints an `npub` and an `nsec`. Put the **nsec** in a password manager. It is the
identity every documentation article is signed with; whoever holds it can rewrite the
docs, and nobody can recover it.

Then give the npub to the two things that read the articles:

```bash
# The site, on the box — no rebuild needed:
sudo sed -i 's|"docsNpub": ""|"docsNpub": "npub1..."|' /srv/toon-site/site-config.json

# The console, in its systemd --user unit or environment:
systemctl --user set-environment TOON_CONSOLE_DOCS_NPUB=npub1...
```

Until the npub is set, both render the bundled Markdown and say so in a banner. That is a
working state, not a broken one.

## 6. Fund the publisher

Publishing is a **paid relay write**: one TOON packet per page, at the price the connector
quotes (1 µUSDC on devnet). A refused paid request is still billed. The publisher **never
opens a channel** — it refuses with somewhere to go instead of locking collateral on chain
— so the channel has to exist first.

The easiest way to get one is the console itself, signed in as the publishing account:

1. Open the console, sign in, let it seal a Chain Seed.
2. Fund the Base Sepolia or Solana devnet address it shows you with mock USDC from the
   devnet faucet, and with **native gas from a public testnet faucet** — no faucet on this
   network gives you gas.
3. Open a channel from the Funds tab.

The publisher derives its payer keys from a BIP-39 phrase you give it, at account index 0,
exactly as the console derives an Account's. Use the same phrase and it uses the same
channel.

> **Never use a box's settlement key for this**, and never rotate one. The publisher has no
> route that reads one, and adding one would be a bug.

## 7. Publish

```bash
export TOON_DOCS_NSEC=nsec1...              # signs the articles
export TOON_DOCS_PAYER_MNEMONIC="word ..."  # pays for the writes

# What it WOULD do, spending nothing:
node packages/daemon/dist/main-docs-publish.js --dry-run

# Do it:
node packages/daemon/dist/main-docs-publish.js

# Read them back and check each `d` tag replaced rather than duplicated:
node packages/daemon/dist/main-docs-publish.js --verify
```

`--verify` prints one line per page: the article's address, how many events the relays hold
at it, and whether the current one is this repository's text. Exit status is non-zero if
any page is wrong.

Against the local docker sandbox instead of devnet:

```bash
node packages/daemon/dist/main-docs-publish.js --profile sandbox --dry-run
```

## Editing a page afterwards

1. Edit the Markdown in `docs/`.
2. `npm test` — the daemon and the site both assert facts about those files.
3. Merge.
4. Re-run the build and the rsync above, so the offline fallback matches.
5. `node packages/daemon/dist/main-docs-publish.js` — it writes **only** the pages that
   changed, and each one replaces its article rather than adding a second copy. Kind 30023
   is addressable and the `d` tag is the identity; the slug never changes.

Changing a page's `d` publishes a **new** article and orphans the old one. If a page has to
be renamed, publish under the new `d` and delete the old article by hand from a Nostr
client — there is no retraction path in the publisher, deliberately, because a deletion is
not something a release script should be able to do by accident.
