#!/usr/bin/env bash
# test.sh: proves ssh-box actually works, against a real Docker daemon
# (TOON_Network#138).
#
# Builds the image, then runs it three ways that together cover what the
# provider actually does and what a tenant actually needs:
#
#   1. A good key: `docker run` with the same flags docker.rs's `run_args`
#      builds for an ordinary (non-hidden, non-docker-in-docker) workload —
#      `--cpus`, `--memory`, `-p <host>:22/tcp` and `-e SSH_PUBLIC_KEY=…`,
#      nothing else (no --user, --cap-drop, --read-only or --userns: those
#      are the flags a tenant's own request for them is REFUSED, so an
#      ordinary workload never carries them either) — must let a real `ssh`
#      in with a throwaway key.
#   2. No key at all: the container must exit non-zero with a message that
#      says why, not hang or silently accept anyone.
#   3. A password: must be refused. No password is ever issued for a
#      workload (provider/README.md "SSH."), so the box must not offer one.
#
# Run from anywhere; it always builds from this directory's Dockerfile.
# Leaves nothing behind: every container, the image this run built and the
# throwaway key all get removed in a trap, whether the checks passed or not.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="ssh-box:test-$$-$(date +%s)"
CONTAINER_GOOD="ssh-box-test-good-$$"
CONTAINER_NOKEY="ssh-box-test-nokey-$$"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ssh-box-test.XXXXXX")"
KEY="$SCRATCH/id_ed25519"

log() { printf '[ssh-box/test.sh] %s\n' "$1"; }
fail() { printf '[ssh-box/test.sh] FAIL: %s\n' "$1" >&2; exit 1; }

cleanup() {
  local status=$?
  docker rm -f "$CONTAINER_GOOD" "$CONTAINER_NOKEY" >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
  if [ "$status" -eq 0 ]; then
    log "cleaned up: containers, image ($IMAGE_TAG) and the throwaway key are all gone"
  fi
  exit "$status"
}
trap cleanup EXIT

log "building $IMAGE_TAG from $HERE"
docker build -t "$IMAGE_TAG" "$HERE" >"$SCRATCH/build.log" 2>&1 \
  || { cat "$SCRATCH/build.log"; fail "docker build failed"; }

log "generating a throwaway ed25519 key in $SCRATCH (never used anywhere else)"
ssh-keygen -t ed25519 -N '' -C 'ssh-box-test' -f "$KEY" -q
PUBKEY="$(cat "$KEY.pub")"

# --- 1. Missing key: must exit loudly, not hang, not accept anyone -------

log "check: no SSH_PUBLIC_KEY at all"
docker rm -f "$CONTAINER_NOKEY" >/dev/null 2>&1 || true
if docker run --name "$CONTAINER_NOKEY" "$IMAGE_TAG" >"$SCRATCH/nokey.log" 2>&1; then
  cat "$SCRATCH/nokey.log"
  fail "the container exited 0 with no SSH_PUBLIC_KEY — it must refuse to start"
fi
EXIT_CODE="$(docker inspect "$CONTAINER_NOKEY" --format '{{.State.ExitCode}}')"
[ "$EXIT_CODE" != "0" ] || fail "docker reports exit code 0 with no key"
docker logs "$CONTAINER_NOKEY" 2>&1 | tee "$SCRATCH/nokey.log" | grep -qi 'SSH_PUBLIC_KEY is empty' \
  || fail "the container's log does not say plainly that SSH_PUBLIC_KEY was empty"
log "  ok: exited $EXIT_CODE with a clear message:"
sed 's/^/    /' "$SCRATCH/nokey.log"

# --- 2. A good key: replicate the provider's actual docker-run flags -----

log "check: SSH_PUBLIC_KEY set, run with the provider's own flags"
docker rm -f "$CONTAINER_GOOD" >/dev/null 2>&1 || true
# `-p 127.0.0.1::22` asks Docker for a free host port rather than this
# script guessing one and racing another process for it; `docker port`
# below reads back whichever one it picked. --cpus/--memory stand in for
# docker.rs's `limit_flags`; nothing else is on an ordinary workload's argv.
docker run -d --name "$CONTAINER_GOOD" \
  --cpus 0.5 --memory 256m \
  -p 127.0.0.1::22/tcp \
  -e "SSH_PUBLIC_KEY=$PUBKEY" \
  "$IMAGE_TAG" >/dev/null

PORT="$(docker port "$CONTAINER_GOOD" 22/tcp | head -n1 | sed 's/.*://')"
[ -n "$PORT" ] || fail "docker did not publish a host port for 22/tcp"
log "  container up, port 22 forwarded to 127.0.0.1:$PORT"

SSH_OPTS=(-p "$PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o BatchMode=yes -o ConnectTimeout=3)

log "  waiting for sshd to accept connections"
READY=0
for _ in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" root@127.0.0.1 true 2>"$SCRATCH/wait.log"; then
    READY=1
    break
  fi
  if ! docker inspect "$CONTAINER_GOOD" --format '{{.State.Running}}' | grep -q true; then
    docker logs "$CONTAINER_GOOD" || true
    fail "the container exited before sshd ever accepted a connection"
  fi
  sleep 1
done
[ "$READY" -eq 1 ] || { cat "$SCRATCH/wait.log"; fail "sshd never accepted the throwaway key within 30s"; }

log "  running: ssh -p $PORT -i <throwaway key> -o StrictHostKeyChecking=no root@127.0.0.1 'id; uname -a; echo ok'"
SESSION_OUT="$(ssh "${SSH_OPTS[@]}" root@127.0.0.1 'id; uname -a; echo ok')"
echo "$SESSION_OUT" | sed 's/^/    /'
echo "$SESSION_OUT" | grep -q '^uid=0(root)' || fail "the session did not report uid=0(root)"
echo "$SESSION_OUT" | grep -q '^ok$' || fail "the session did not echo back ok — it did not complete"
log "  ok: a real ssh session ran id, uname -a and echo ok over the throwaway key"

# --- 3. Password login: must be refused, because none is ever issued -----

log "check: password authentication is refused"
set +e
PASSWORD_OUT="$(ssh -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PubkeyAuthentication=no -o PreferredAuthentications=password -o BatchMode=yes \
  -o ConnectTimeout=3 root@127.0.0.1 true 2>&1)"
PASSWORD_STATUS=$?
set -e
[ "$PASSWORD_STATUS" -ne 0 ] || fail "a password-only ssh attempt SUCCEEDED — no password may ever work"
echo "$PASSWORD_OUT" | grep -qi 'permission denied' \
  || fail "expected \"Permission denied\" from a password-only attempt, got: $PASSWORD_OUT"
log "  ok: password auth refused ($PASSWORD_OUT)"

log "all checks passed"
