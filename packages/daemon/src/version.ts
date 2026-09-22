import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The daemon's own version, read from its package.json.
 *
 * Read rather than baked in by the build: the health view exists so that a
 * person can say which console they are running when something is wrong, and a
 * version constant that a release forgets to bump makes that answer a lie. The
 * file sits one level above both `src/` (tests) and `dist/` (the shipped
 * build), so one relative path serves both.
 */

export interface DaemonVersion {
  readonly name: string;
  readonly version: string;
}

let cached: DaemonVersion | undefined;

export function daemonVersion(): DaemonVersion {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { name?: string; version?: string };
  cached = {
    name: parsed.name ?? '@toon-protocol/console-daemon',
    version: parsed.version ?? '0.0.0',
  };
  return cached;
}
