# ssh-box: a workload image whose only job is to serve SSH (TOON_Network#138).
#
# The provider hands every workload the tenant's public key as the
# environment variable SSH_PUBLIC_KEY and forwards access.ssh_port to this
# container's port 22 (provider/README.md "SSH.", provider/src/docker.rs
# around the `-p host:22` and `-e SSH_PUBLIC_KEY=…` lines). It sets no
# --user, no --cap-drop, no --read-only and no --userns on an ordinary
# workload — those are exactly the flags a tenant's own capability request is
# REFUSED for (docker.rs's PRIVILEGE_FLAGS), so an ordinary run keeps
# Docker's normal default capability set, a writable rootfs and whatever
# USER this image sets. Nothing else installs sshd or forwards the key, so
# the image has to do the whole job itself: install sshd, take the key,
# generate host keys at first start, and refuse to come up without a usable
# key.
#
# Pinned by digest so a rebuild never silently changes the base: this is
# alpine:3.20.10 (a multi-arch index — the same digest resolves the right
# manifest for amd64 and arm64 builds alike).
FROM alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache openssh-server \
    && rm -rf /var/cache/apk/* \
    # Host keys are generated at first start (see entrypoint.sh), never
    # baked into the image — a baked key would be the same host key for
    # every tenant who ever ran this image.
    && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
