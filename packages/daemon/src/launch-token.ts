import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The per-launch token.
 *
 * The daemon binds to loopback, which keeps the network out but not the other
 * processes on the machine: every local user and every program they run can
 * reach `127.0.0.1`. So the API is gated on a secret minted fresh at each
 * start and handed to exactly one reader — the window the launcher opens.
 *
 * Minted per launch rather than stored: nothing has to be revoked, a restart
 * invalidates whatever leaked, and there is no long-lived credential on disk
 * for this ticket's skeleton to be careless with. It is written to the runtime
 * directory (mode 0600, wiped by the session on logout) because the launcher
 * script runs as a separate process and has to find it.
 *
 * NOTE what this token is NOT: it is not an account, not a signer and not a
 * key. The skeleton holds no key material at all (TOON_Network#87); sign-in is
 * #88.
 */

export interface LaunchRecord {
  /** The base URL the UI is served from, with no token in it. */
  readonly url: string;
  /** The secret the UI presents on every API call. */
  readonly token: string;
  /** The URL a launcher opens — the token is handed over exactly once, here. */
  readonly launchUrl: string;
  readonly pid: number;
  readonly startedAt: string;
}

export function mintLaunchToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Compare in constant time, and only after the lengths match — `timingSafeEqual`
 * throws on a length mismatch rather than returning false, which would turn a
 * wrong-length guess into a 500 instead of a 401.
 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>`, or nothing. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1];
}

export function writeLaunchRecord(path: string, record: LaunchRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function removeLaunchRecord(path: string): void {
  rmSync(path, { force: true });
}
