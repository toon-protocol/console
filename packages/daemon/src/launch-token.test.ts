import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  bearerToken,
  mintLaunchToken,
  removeLaunchRecord,
  tokenMatches,
  writeLaunchRecord,
} from './launch-token.js';

describe('the launch token', () => {
  it('is a fresh secret on every launch', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => mintLaunchToken()));
    expect(tokens.size).toBe(64);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('matches only itself, and never throws on a wrong length', () => {
    const token = mintLaunchToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}x`)).toBe(false);
    expect(tokenMatches(token, 'x')).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });

  it('reads a bearer header, and nothing else', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('  Bearer abc  ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it('writes the launch record where only this user can read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toon-console-launch-'));
    const path = join(dir, 'run', 'launch.json');
    try {
      writeLaunchRecord(path, {
        url: 'http://127.0.0.1:7797',
        token: 'tok',
        launchUrl: 'http://127.0.0.1:7797/?t=tok',
        pid: 1,
        startedAt: '2026-09-22T00:00:00.000Z',
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ token: 'tok' });

      // A stale URL must not outlive the daemon that could answer it.
      removeLaunchRecord(path);
      expect(() => statSync(path)).toThrow();
      expect(() => removeLaunchRecord(path)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
