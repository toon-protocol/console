#!/bin/sh
# entrypoint.sh: turns SSH_PUBLIC_KEY into a running, key-only sshd
# (TOON_Network#138).
#
# Runs once per container start, as PID 1 (via `exec` at the bottom, so
# signals reach sshd directly rather than a shell that ignores them).
#
# What it does, in order, and why:
#   1. Refuses to start at all without a key that looks like one — a
#      workload with no SSH_PUBLIC_KEY, or a private key or passphrase
#      pasted into it by mistake, must fail LOUDLY and exit non-zero rather
#      than come up unreachable or, worse, open to nobody's key.
#   2. Installs it as root's authorized key. This image's root is the
#      workload's own root shell — see README.md for why that is the right
#      account here — never the provider host's.
#   3. Generates host keys if this start is the first one to need them.
#      Never baked into the image (the Dockerfile deletes any that
#      `apk add` shipped), so a fresh image pull can never mean a shared
#      host key across every tenant who ever ran it.
#   4. Leaves /data alone. The provider mounts a tenant's volume there when
#      one was asked for (README.md "SSH." / "A volume, when asked for, is
#      mounted at /data"); this image neither reads nor writes it before
#      sshd starts serving.
set -eu

KEY_LINE=$(printf '%s' "${SSH_PUBLIC_KEY:-}" | head -n1 | tr -d '\r')

if [ -z "$KEY_LINE" ]; then
    echo "ssh-box: SSH_PUBLIC_KEY is empty — no key, no box. Refusing to start." >&2
    echo "ssh-box: pass the tenant's public key as SSH_PUBLIC_KEY (one line, as" >&2
    echo "ssh-box: \`~/.ssh/id_ed25519.pub\` holds it)." >&2
    exit 1
fi

case "$KEY_LINE" in
    ssh-*' '*|ecdsa-*' '*) ;;
    *)
        echo "ssh-box: SSH_PUBLIC_KEY does not look like an OpenSSH public key line" >&2
        echo "ssh-box: (it must start with \`ssh-\` or \`ecdsa-\`, then a space, then the" >&2
        echo "ssh-box: base64 key body). Got: $(printf '%s' "$KEY_LINE" | cut -c1-16)..." >&2
        echo "ssh-box: refusing to start — this is most likely a private key or an empty" >&2
        echo "ssh-box: box pasted by mistake, never a password (none is ever issued)." >&2
        exit 1
        ;;
esac

install -d -m 0700 -o root -g root /root/.ssh
printf '%s\n' "$KEY_LINE" > /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys
chown root:root /root/.ssh/authorized_keys

# `-A` only fills in the key types that are missing, so a re-start of the
# same container (with the same writable rootfs) that already generated
# host keys on a previous boot leaves them exactly as they were.
ssh-keygen -A >/dev/null

echo "ssh-box: host key fingerprints for this box:" >&2
for pub in /etc/ssh/ssh_host_*_key.pub; do
    [ -e "$pub" ] && ssh-keygen -lf "$pub" >&2
done

echo "ssh-box: starting sshd on :22, key-only, root by key (no password issued)" >&2
exec /usr/sbin/sshd -D -e
