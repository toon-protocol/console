import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * **The window's colours, which belong to the desktop and not to this app**
 * (TOON_Network#99, ADR 0019).
 *
 * The console is an Omarchy app, so it is the wrong thing for it to have a
 * palette. Omarchy already knows what colour a surface is on this machine, and
 * it already has a way to tell an application: a template in
 * `~/.config/omarchy/themed/` is rendered against the current theme's
 * `colors.toml` every time the theme is set, and the result lands in
 * `~/.local/state/omarchy/current/theme/`. `packaging/omarchy/toon-console.css.tpl`
 * is this console's template. This module reads what it produced.
 *
 * Three things shape the code below.
 *
 * **What is read is re-emitted, never injected.** The generated file is a
 * product of this machine's own theme, but it reaches the window as CSS inside
 * the page, so it is treated as input: each declaration is matched against the
 * list of properties the UI actually reads, each value against a character set
 * that cannot close a style block, and the `:root` rule the window gets is
 * built here from what survived. A theme cannot style anything this console did
 * not ask to be styled, and cannot introduce markup at all.
 *
 * **A missing variable falls back one at a time.** A template that is older
 * than the UI — a console updated while the rendered file on disk still came
 * from the previous version — yields the variables it has and the defaults for
 * the rest, rather than an unreadable window.
 *
 * **There is exactly one palette in this repository and it is the one below.**
 * It is not a brand and it is not a preference: it is what the console looks
 * like on a desktop that is not Omarchy, which ADR 0019 says must still start.
 * Nothing in `packages/ui` carries a colour.
 */

/* -------------------------------------------------------------------------- */

/** What the theme file is called, under `themed/` as `<this>.tpl`. */
export const THEME_FILE = 'toon-console.css';

/**
 * The `<style>` the theme lives in, in the window.
 *
 * The daemon puts it into the shell it serves and the window replaces its
 * contents on every theme change, so both sides have to agree on the id.
 * `packages/ui/src/hooks/use-desktop.ts` carries the same literal — it cannot
 * import this file, because the daemon builds for Node (ADR 0019).
 */
export const THEME_STYLE_ID = 'toon-theme';

/**
 * The custom properties the UI reads, and the only ones let through.
 *
 * `packages/ui/src/globals.css` maps each of these onto a Tailwind colour, so
 * this list and that file are the two halves of one contract: a name added
 * there is added here, and a value arriving under any other name is dropped.
 */
export const THEME_VARIABLES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'border',
  'input',
  'ring',
] as const;

export type ThemeVariable = (typeof THEME_VARIABLES)[number];

/**
 * The default theme: the console on a desktop that has no Omarchy theme to
 * follow (ADR 0019's "other Linux desktops"), and the fallback for any single
 * variable a rendered template did not carry.
 *
 * A neutral zinc scale, which is the shadcn default and deliberately not a
 * brand — the console has no colours of its own to be recognised by.
 */
export const DEFAULT_THEME: Readonly<Record<ThemeVariable, string>> = {
  background: '#09090b',
  foreground: '#fafafa',
  card: '#111113',
  'card-foreground': '#fafafa',
  muted: '#1c1c1f',
  'muted-foreground': '#a1a1aa',
  accent: '#27272a',
  'accent-foreground': '#fafafa',
  primary: '#fafafa',
  'primary-foreground': '#18181b',
  secondary: '#27272a',
  'secondary-foreground': '#fafafa',
  destructive: '#ef4444',
  'destructive-foreground': '#fafafa',
  success: '#22c55e',
  'success-foreground': '#09090b',
  warning: '#f59e0b',
  'warning-foreground': '#09090b',
  border: '#27272a',
  input: '#27272a',
  ring: '#52525b',
};

export const DEFAULT_MODE = 'dark';

export type ThemeSource = 'omarchy' | 'default';

export interface ThemeReading {
  /** `omarchy` once a rendered template has been found and read. */
  readonly source: ThemeSource;
  /** The Omarchy theme's name, or `default` when there is none. */
  readonly name: string;
  /** `dark` or `light`, as the theme's `colors.toml` declares it. */
  readonly mode: 'dark' | 'light';
  /** Changes exactly when the colours do. The window watches this. */
  readonly revision: string;
  /** A `:root { … }` rule, built here. Safe to put in a `<style>`. */
  readonly css: string;
  /** Why this is the default theme, when it is. Never set on a success. */
  readonly reason?: string | undefined;
  readonly readAt: string;
}

/**
 * A value that may be written into a stylesheet.
 *
 * Hex colours, `rgb(…)`, `color-mix(…)` and the handful of words a theme might
 * reasonably use. Not `;`, not `}`, not `<`, not `@` and not `url(` — the four
 * ways a declaration stops being a declaration.
 */
const SAFE_VALUE = /^[#a-zA-Z0-9 ,.%/()+*_-]{1,96}$/u;

const DECLARATION = /--([a-z][a-z0-9-]*)\s*:\s*([^;{}]*);/giu;

/** Where Omarchy keeps the theme it has set. Its own path, not an XDG one. */
export function omarchyThemeDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  return join(home, '.local', 'state', 'omarchy', 'current', 'theme');
}

function omarchyThemeName(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? homedir();
  try {
    const name = readFileSync(
      join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'),
      'utf8'
    ).trim();
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/**
 * The current theme, read fresh.
 *
 * Cheap enough to call on every poll: one stat-sized read of a file under a
 * kilobyte. Nothing is cached here, because the thing being watched is the
 * file changing.
 */
export function readTheme(env: NodeJS.ProcessEnv = process.env): ThemeReading {
  const readAt = new Date().toISOString();
  const path = join(omarchyThemeDir(env), THEME_FILE);

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return defaultTheme(
      readAt,
      `No Omarchy theme was rendered at ${path}. Install the console's template ` +
        `(packaging/bin/toon-console-install) and set a theme, or this is not an Omarchy desktop.`
    );
  }

  const found = parseDeclarations(text);
  if (found.size === 0) {
    return defaultTheme(readAt, `${path} carried no custom properties this console reads.`);
  }

  const values: Record<string, string> = {};
  for (const variable of THEME_VARIABLES) {
    values[variable] = found.get(variable) ?? DEFAULT_THEME[variable];
  }
  const mode = found.get('mode') === 'light' ? 'light' : 'dark';
  const name = omarchyThemeName(env) ?? 'omarchy';
  const css = rootRule(values, mode);

  return {
    source: 'omarchy',
    name,
    mode,
    revision: revisionOf('omarchy', name, css),
    css,
    readAt,
  };
}

/** The theme as a `<style>`'s text, for a page that has not asked yet. */
export function defaultThemeCss(): string {
  return rootRule(DEFAULT_THEME, DEFAULT_MODE);
}

function defaultTheme(readAt: string, reason: string): ThemeReading {
  const css = defaultThemeCss();
  return {
    source: 'default',
    name: 'default',
    mode: DEFAULT_MODE,
    revision: revisionOf('default', 'default', css),
    css,
    reason,
    readAt,
  };
}

/**
 * Every `--name: value;` in the text, keeping only the names this console
 * reads and only the values that are values.
 *
 * Deliberately not a CSS parser: the file has one rule in it and this console
 * wants a dictionary out of it, so a dictionary is what is taken. Anything
 * else in the file — a comment, another rule, a declaration under a name that
 * is not on the list — is not read and therefore cannot reach the window.
 */
function parseDeclarations(text: string): Map<string, string> {
  const allowed = new Set<string>([...THEME_VARIABLES, 'mode']);
  const found = new Map<string, string>();
  for (const match of text.matchAll(DECLARATION)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (!allowed.has(name)) continue;
    if (!SAFE_VALUE.test(value)) continue;
    found.set(name, value);
  }
  return found;
}

function rootRule(values: Readonly<Record<string, string>>, mode: 'dark' | 'light'): string {
  const lines = [`  color-scheme: ${mode};`];
  for (const variable of THEME_VARIABLES) {
    lines.push(`  --${variable}: ${values[variable] ?? DEFAULT_THEME[variable]};`);
  }
  return `:root {\n${lines.join('\n')}\n}\n`;
}

function revisionOf(source: string, name: string, css: string): string {
  return createHash('sha256').update(`${source}\0${name}\0${css}`).digest('hex').slice(0, 16);
}
