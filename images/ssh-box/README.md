# ssh-box

A minimal Alpine image whose only job is to give a tenant an SSH shell into
the workload they rented — nothing else runs, nothing else listens
(TOON_Network#138).

## Why this exists

A TOON Network provider forwards `access.ssh_port` to a workload's container
port 22 and hands the tenant's public key in as the environment variable
`SSH_PUBLIC_KEY` (provider/README.md, "SSH."). It never writes a file into
the image, never sets an entrypoint of its own, and issues no password. A
Template also cannot set entrypoint/args (`packages/daemon/src/template-spawn.ts`).
So an image is only SSH-able if it does the whole job itself: install sshd,
read the key, and start serving. The only Template on devnet before this one
was an HTTP echo server with no sshd — this image is what fills that gap.

## What it does

1. `entrypoint.sh` refuses to start if `SSH_PUBLIC_KEY` is empty or does not
   look like an OpenSSH public key line (`ssh-*` or `ecdsa-*`, a space, then
   the base64 body) — loudly, on stderr, with a non-zero exit. That catches
   the two mistakes a person actually makes: forgetting the key, or pasting
   a private key or a passphrase into the field by mistake. No password is
   ever accepted as a fallback.
2. It writes that key to `/root/.ssh/authorized_keys` (mode 0600, directory
   0700).
3. It generates host keys with `ssh-keygen -A`, which only fills in the key
   types that are missing. The Dockerfile deletes any host keys `apk add`
   shipped, so the *image* never carries one — a host key is only ever
   generated inside a running container, at its first start, which is what
   stops every tenant who ever pulled this image from sharing one.
4. It execs `sshd -D -e` on port 22 (foreground, logs to stderr, replaces
   the entrypoint as PID 1 so signals reach it directly).
5. It never touches `/data`. The provider mounts a tenant's volume there
   when one is asked for; this image has no reason to read or write it
   before sshd starts.

## Design choices, and why

**Base image.** `alpine:3.20.10`, pinned by digest (a multi-arch index, so
the same `FROM` line resolves the right manifest for both amd64 and arm64
builds). Alpine's `openssh-server` package is a few megabytes and the whole
image is ~14 MB.

**Account: root, by key only.** `sshd_config` sets
`PermitRootLogin prohibit-password` — a signed key gets in, no password or
keyboard-interactive method ever will (both are turned off network-wide as
well, belt and braces). The alternative the spec for this ticket named was a
non-root user with `sudo`; root was chosen instead because:

- `docker.rs`'s `run_args` — the actual `docker run` argv the provider
  builds for an ordinary workload — carries `--cpus`, `--memory`, the SSH
  port forward, `-e SSH_PUBLIC_KEY=…`, and nothing that restricts the
  container's own root: **no** `--user`, **no** `--cap-drop`, **no**
  `--read-only`, **no** `--userns`. Those are exactly the flags a *tenant's*
  own capability request is refused for (`DockerBackend`'s
  `PRIVILEGE_FLAGS` list, checked against the spawn content before a
  container is ever created) — a workload never carries them regardless of
  what the tenant asked for. So this image's root is only ever root of the
  *container's own, unprivileged, namespaced* filesystem and process tree —
  never of the provider's host, which the container has no more access to
  than any other unprivileged Docker container.
- A rented, throwaway compute box (the whole point of this Template) is one
  a tenant expects to administer in full — install packages, bind low
  ports, change ownership of files under `/data` — and a non-root-plus-sudo
  setup only reproduces root's own privileges through an extra hop while
  adding nothing a capability the container does not already lack would
  have stopped.
- sshd itself works the same way root-privileged elsewhere: OpenSSH's own
  privilege-separation model expects a root parent process regardless of
  which account eventually logs in, so "non-root sudo user" would still
  mean the *sshd daemon* runs as root inside this same, equally
  unprivileged container — the account difference is only about who lands
  in the shell.

If a future revision wants a non-root login (say, to run a *second*
process inside the box that must not be able to touch the first), add a
user, give it `NOPASSWD` `sudo`, and change `PermitRootLogin` to `no` — the
entrypoint's key-install step only has to target that user's
`~/.ssh/authorized_keys` instead of root's.

**No password, ever.** `PasswordAuthentication`, `KbdInteractiveAuthentication`
and `ChallengeResponseAuthentication` are all `no`. The provider issues no
password for any workload; an image that fell back to one would contradict
that promise.

**Host keys generated at first start.** Never baked in — see above.

**Small.** One Alpine layer plus `openssh-server` and the two files this
image adds; the apk cache is removed in the same layer it is populated in.

## Testing it

`test.sh` builds the image and runs three checks against a real Docker
daemon:

1. **No `SSH_PUBLIC_KEY`** — the container must exit non-zero with a clear
   message, not hang and not accept anyone.
2. **A throwaway ed25519 key**, run with the same flags `docker.rs` builds
   for an ordinary workload (`--cpus`, `--memory`, `-p <port>:22/tcp`,
   `-e SSH_PUBLIC_KEY=…`) — must let a real `ssh` session in and run
   `id; uname -a; echo ok`.
3. **A password-only attempt** — must be refused.

It cleans up every container, the image it built and the throwaway key
afterwards, on success or failure alike:

```sh
images/ssh-box/test.sh
```

CI (`.github/workflows/ssh-box.yml`) runs the same script on every pull
request and push that touches this directory.
