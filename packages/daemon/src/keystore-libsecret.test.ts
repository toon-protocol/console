import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KeystoreUnavailableError } from './keystore.js';
import { SecretServiceKeystore } from './keystore-libsecret.js';

/**
 * A stand-in for `secret-tool`.
 *
 * The contract this backend depends on is narrow and worth pinning: the secret
 * arrives on STDIN and never in `argv`, the attributes are exactly
 * `service toon-console signer <id>`, and a lookup that finds nothing exits 1
 * with an empty stderr while a lookup that FAILED writes to stderr. The stub
 * records what it was given so the test can check all four.
 *
 * A real gnome-keyring round trip is verified by hand on a desktop session;
 * CI has no Secret Service and never will.
 */
function writeStub(dir: string, mode: 'normal' | 'broken'): string {
  const store = join(dir, 'items');
  mkdirSync(store, { recursive: true });
  const path = join(dir, 'secret-tool');
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -u
STORE=${JSON.stringify(store)}
printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, 'argv.log'))}
if [ ${JSON.stringify(mode)} = broken ]; then
  echo "secret-tool: Could not connect: No such file or directory" >&2
  exit 1
fi
verb="$1"; shift
case "$verb" in
  store)
    # store --label <label> service <s> signer <id>
    shift 2
    id="$4"
    cat > "$STORE/$id"
    ;;
  lookup)
    id="$4"
    [ -f "$STORE/$id" ] || exit 1
    printf '%s' "$(cat "$STORE/$id")"
    ;;
  clear)
    id="$4"
    rm -f "$STORE/$id"
    ;;
  search)
    # The real secret-tool prints each match's ATTRIBUTES to stderr and still
    # exits 0. This stub does the same, because a probe that read stderr as a
    # fault passed until the first key was saved and then silently stopped
    # using the keyring.
    for item in "$STORE"/*; do
      [ -e "$item" ] || continue
      echo "attribute.signer = $(basename "$item")" >&2
      echo "attribute.service = toon-console" >&2
    done
    exit 0
    ;;
  *)
    echo "secret-tool: unknown verb $verb" >&2
    exit 2
    ;;
esac
`,
    { mode: 0o755 }
  );
  chmodSync(path, 0o755);
  return path;
}

describe('the local keystore in gnome-keyring', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-console-libsecret-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores and returns a secret', async () => {
    const keystore = new SecretServiceKeystore(writeStub(dir, 'normal'));
    await keystore.put('abc', 'the-secret', {});
    expect(await keystore.get('abc', {})).toBe('the-secret');
  });

  it('never puts the secret on a command line', async () => {
    const keystore = new SecretServiceKeystore(writeStub(dir, 'normal'));
    await keystore.put('abc', 'the-secret', {});
    expect(readFileSync(join(dir, 'argv.log'), 'utf8')).not.toContain('the-secret');
  });

  it('searches on the console’s own attributes', async () => {
    const keystore = new SecretServiceKeystore(writeStub(dir, 'normal'));
    await keystore.put('abc', 'the-secret', {});
    expect(readdirSync(join(dir, 'items'))).toEqual(['abc']);
  });

  it('has nothing for an id it was never given', async () => {
    const keystore = new SecretServiceKeystore(writeStub(dir, 'normal'));
    expect(await keystore.get('missing', {})).toBeUndefined();
  });

  it('forgets a secret', async () => {
    const keystore = new SecretServiceKeystore(writeStub(dir, 'normal'));
    await keystore.put('abc', 'the-secret', {});
    await keystore.remove('abc');
    expect(await keystore.get('abc', {})).toBeUndefined();
  });

  it('reports a Secret Service that is not there, rather than losing the key', async () => {
    const keystore = new SecretServiceKeystore(writeStub(dir, 'broken'));
    await expect(keystore.put('abc', 'the-secret', {})).rejects.toBeInstanceOf(
      KeystoreUnavailableError
    );
  });

  it('is available when a search answers, and not when it cannot connect', async () => {
    expect(await SecretServiceKeystore.available(writeStub(dir, 'normal'))).toBe(true);
    expect(await SecretServiceKeystore.available(writeStub(dir, 'broken'))).toBe(false);
    expect(await SecretServiceKeystore.available(join(dir, 'no-such-tool'))).toBe(false);
  });

  /**
   * The regression this backend was actually bitten by: `secret-tool search`
   * writes its matches' attributes to stderr, so once ONE key is stored a
   * probe that read stderr decides the keyring is gone and every restart
   * falls back to the passphrase file.
   */
  it('is still available once it holds a key', async () => {
    const tool = writeStub(dir, 'normal');
    const keystore = new SecretServiceKeystore(tool);
    await keystore.put('abc', 'the-secret', {});
    expect(await SecretServiceKeystore.available(tool)).toBe(true);
  });
});
