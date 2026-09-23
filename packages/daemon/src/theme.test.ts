import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME,
  omarchyThemeDir,
  readTheme,
  THEME_FILE,
  THEME_VARIABLES,
} from './theme.js';

/**
 * The theme is read off the desktop, and what is read is re-emitted rather
 * than injected (TOON_Network#99).
 *
 * The cases below are the ones that decide whether a window is usable: a
 * desktop with no Omarchy at all, a rendered template, a template older than
 * this build, and a file that is not what it should be.
 */

const homes: string[] = [];

function fakeHome(rendered?: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'toon-theme-'));
  homes.push(home);
  const env = { HOME: home } as NodeJS.ProcessEnv;
  if (rendered !== undefined) {
    mkdirSync(omarchyThemeDir(env), { recursive: true });
    writeFileSync(join(omarchyThemeDir(env), THEME_FILE), rendered);
    writeFileSync(join(home, '.local/state/omarchy/current/theme.name'), 'tokyo-night\n');
  }
  return env;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('readTheme', () => {
  it('falls back to the default theme where Omarchy has rendered nothing', () => {
    const theme = readTheme(fakeHome());

    expect(theme.source).toBe('default');
    expect(theme.name).toBe('default');
    // Still a complete rule: a window on another desktop must be readable.
    for (const variable of THEME_VARIABLES) {
      expect(theme.css).toContain(`--${variable}: ${DEFAULT_THEME[variable]};`);
    }
    expect(theme.reason).toMatch(/Omarchy/u);
  });

  it('takes every colour from the rendered template, and the theme its name', () => {
    const theme = readTheme(
      fakeHome(
        ':root {\n  --mode: light;\n  --background: #ffffff;\n  --foreground: #111111;\n}'
      )
    );

    expect(theme.source).toBe('omarchy');
    expect(theme.name).toBe('tokyo-night');
    expect(theme.mode).toBe('light');
    expect(theme.css).toContain('color-scheme: light;');
    expect(theme.css).toContain('--background: #ffffff;');
    expect(theme.css).toContain('--foreground: #111111;');
  });

  it('falls back one variable at a time, so an old template still opens', () => {
    const theme = readTheme(fakeHome(':root { --background: #001122; }'));

    expect(theme.source).toBe('omarchy');
    expect(theme.css).toContain('--background: #001122;');
    expect(theme.css).toContain(`--ring: ${DEFAULT_THEME.ring};`);
  });

  it('moves when the colours move, and not otherwise', () => {
    const one = readTheme(fakeHome(':root { --background: #001122; }'));
    const same = readTheme(fakeHome(':root {\n\n  --background:#001122;\n}'));
    const other = readTheme(fakeHome(':root { --background: #110022; }'));

    // Whitespace is not a theme change: a hook that fires on a re-render of
    // the same colours must wake nobody.
    expect(same.revision).toBe(one.revision);
    expect(other.revision).not.toBe(one.revision);
  });

  it('lets through no property the UI does not read', () => {
    const theme = readTheme(
      fakeHome(':root { --background: #001122; --font-family: "Comic Sans"; }')
    );

    expect(theme.css).not.toContain('font-family');
  });

  it('drops a value that could close the style block', () => {
    // The file is generated on this machine, but it reaches the window as CSS
    // inside the page, so it is treated as input like anything else.
    const theme = readTheme(
      fakeHome(
        ':root { --background: #001122} </style><script>alert(1)</script><style>{x: y; }'
      )
    );

    expect(theme.css).not.toContain('<');
    expect(theme.css).not.toContain('script');
    expect(theme.css).toContain(`--background: ${DEFAULT_THEME.background};`);
  });

  it('is the default theme when the file carries nothing it reads', () => {
    const theme = readTheme(fakeHome('/* nothing here */\n'));

    expect(theme.source).toBe('default');
  });
});
