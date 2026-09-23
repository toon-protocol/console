# The AUR package

`PKGBUILD` and `toon-console.install` are the console's Arch package (TOON_Network#100).
They live here, in the repository they build, and are **copied** into the AUR's own git
repository to publish — that is how every AUR package works, and it is why `.SRCINFO` is
checked in beside them.

Nothing in this directory runs in CI and nothing here publishes itself. Every command
below is one a person types.

---

## What it installs, and what it will not touch

| Path | What |
| --- | --- |
| `/usr/lib/toon-console/daemon` | the built daemon, with its runtime `node_modules` beside it |
| `/usr/lib/toon-console/package.json` | says the dist is ESM, and carries the version the health view reports |
| `/usr/lib/systemd/user/toon-console.service` | the `systemd --user` unit, with absolute paths |
| `/usr/share/toon-console/ui` | the built UI the daemon serves |
| `/usr/share/toon-console/docs` | the Markdown pages the Help tab falls back to |
| `/usr/share/toon-console/omarchy` | the theme template, the two hooks and the menu entries, **as sources** |
| `/usr/bin/toon-console` | the launcher |
| `/usr/bin/toon-console-install`, `/usr/bin/toon-console-uninstall` | the per-user half |
| `/usr/share/applications/toon-console.desktop` | the launcher entry |
| `/usr/share/icons/hicolor/{scalable,256x256}/apps/toon-console.*` | the icon |

**`$XDG_DATA_HOME/toon-console` appears nowhere in the package.** That is where an
account's channel state, Chain Seed cache, Lease Vault cache and passphrase keystore live,
and pacman can only remove what it installed — so an upgrade and a removal both leave it
exactly as it was. `packaging/packaging.test.mjs` is the test that keeps it that way.

The per-user half — enabling the user service, and the Omarchy template, hooks and menu
entries in `~/.config` — is **not** done from a pacman install script. Those scripts run as
root, at package time, possibly in a chroot, with no session and no way to know whose
machine it is. `toon-console-install`, run by the person, is what does it.

---

## Releasing

`source=` fetches `#tag=v$pkgver` from GitHub, so the only thing a release needs is a
**tag**. There is no release artifact, no tarball to upload and no checksum to record.

1. Bump the version in `package.json` and in `packages/*/package.json`, and `pkgver` in
   `PKGBUILD` to match. (A test fails if they disagree: the version in the health view is
   read from the daemon's own manifest, so a `pkgver` that has drifted would make the
   console report a version nobody can fetch.)
2. Merge that, then tag the merge commit and push the tag:
   ```bash
   git tag -a v0.1.0 -m "toon-console 0.1.0"
   git push origin v0.1.0
   ```
3. Regenerate `.SRCINFO` and commit it:
   ```bash
   cd packaging/aur && makepkg --printsrcinfo >.SRCINFO
   ```
4. Build it once from the tag, in a clean directory, before publishing:
   ```bash
   cp PKGBUILD toon-console.install /tmp/build-toon-console/
   cd /tmp/build-toon-console && makepkg -f
   namcap PKGBUILD toon-console-*.pkg.tar.zst
   ```
5. Install it on a machine that is not this one, and check the five things the ticket asks
   for: it launches from the menu, the service survives a logout and a login, an upgrade
   keeps `~/.local/share/toon-console`, a removal leaves no launcher, hook, service or menu
   entry, and the non-Omarchy path in the top-level README works.

### Publishing to the AUR

Needs an AUR account with this machine's SSH key on it, and the package name registered.

```bash
git clone ssh://aur@aur.archlinux.org/toon-console.git /tmp/aur-toon-console
cp packaging/aur/PKGBUILD packaging/aur/toon-console.install packaging/aur/.SRCINFO /tmp/aur-toon-console/
cd /tmp/aur-toon-console && git commit -am "toon-console 0.1.0" && git push
```

The AUR refuses a push whose `.SRCINFO` does not match its `PKGBUILD`, which is why step 3
is not optional.

---

## Things to know before you build it

- **`build()` reaches the network.** `npm ci` is how a source package out of an npm
  workspace gets its dependencies, so `makepkg` in a network-less chroot (`extra-x86_64-build`)
  will not build this. That is true of essentially every `nodejs` package in the AUR; the
  alternative is vendoring every dependency tarball into `source=`, which for this tree is
  several hundred entries.
- **It builds with the node in `depends`, and ships the tree `npm prune --omit=dev` leaves.**
  The dev dependencies (vite, vitest, typescript, eslint) build the console and are not
  installed.
- **A `-bin` package would need a release artifact.** If the build time ever becomes the
  problem, the shape is: a GitHub Actions release job that runs `npm ci && npm run build`,
  assembles exactly what `package()` assembles, and uploads it as a tarball on the tag; then
  a `toon-console-bin` whose `source=` is that tarball with a real `sha256sum`, whose
  `depends` drop `npm` and `git`, and whose `package()` is a copy. Until such a release
  exists there is nothing to point it at, which is why this is a source package.
