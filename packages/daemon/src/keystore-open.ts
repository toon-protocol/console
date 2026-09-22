import type { Keystore } from './keystore.js';
import { PassphraseFileKeystore, keystoreFilePath } from './keystore-file.js';
import { SecretServiceKeystore } from './keystore-libsecret.js';
import type { ConsolePaths } from './paths.js';

/**
 * Which local keystore this machine gets.
 *
 * gnome-keyring when a Secret Service answers on the session bus, and the
 * passphrase-encrypted file when none does. Probed once at startup rather than
 * per call: the answer cannot change while the daemon runs without the desktop
 * session itself going away, and a probe on every sign-in would put a process
 * spawn in front of it.
 *
 * `TOON_CONSOLE_KEYSTORE=file` forces the fallback. It is how the fallback is
 * exercised on a machine that HAS a keyring — which is to say, on every
 * developer's machine — and it is also the escape hatch for a headless session
 * where the keyring exists but nothing will ever unlock it.
 */
export async function openKeystore(
  paths: ConsolePaths,
  env: NodeJS.ProcessEnv = process.env
): Promise<Keystore> {
  const forced = env.TOON_CONSOLE_KEYSTORE;
  if (forced === 'file') return new PassphraseFileKeystore(keystoreFilePath(paths));
  if (forced === 'libsecret') return new SecretServiceKeystore();
  if (await SecretServiceKeystore.available()) return new SecretServiceKeystore();
  return new PassphraseFileKeystore(keystoreFilePath(paths));
}
