// A guard on the install bundle.
//
// Nothing else runs these files in CI: they are bash and an INI file, and a
// typo in either is only discovered on someone's desktop. So the shape they
// have to keep is asserted here — the same reason gateway/deploy has its own
// bundle test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

const SCRIPTS = [
  'bin/toon-console',
  'bin/toon-console-install',
  'bin/toon-console-uninstall',
];

test('every script is executable and passes bash -n', () => {
  for (const script of SCRIPTS) {
    const path = join(here, script);
    accessSync(path, constants.X_OK);
    execFileSync('bash', ['-n', path]);
  }
});

test('every script fails loudly rather than continuing past an error', () => {
  for (const script of SCRIPTS) {
    assert.match(read(script), /^set -euo pipefail$/m, `${script} is missing 'set -euo pipefail'`);
  }
});

test('the launcher passes the window pattern before the URL', () => {
  // omarchy-launch-or-focus-webapp takes <window-pattern> first and passes
  // everything after it to the browser. Swapping the two opens a window
  // titled with the URL and focuses nothing on the second launch.
  assert.match(
    read('bin/toon-console'),
    /omarchy-launch-or-focus-webapp "\$WINDOW_PATTERN" "\$url"/
  );
});

test('the launcher reads the URL the daemon published, never a baked-in one', () => {
  const launcher = read('bin/toon-console');
  assert.match(launcher, /launch\.json/);
  assert.match(launcher, /launchUrl/);
  // A token in the desktop entry would be a long-lived credential on disk.
  assert.doesNotMatch(launcher, /\?t=/);
});

test('the launcher waits for the daemon rather than sleeping a fixed time', () => {
  assert.match(read('bin/toon-console'), /while \[\[ ! -s \$LAUNCH_FILE \]\]/);
});

test('the unit is a user service that starts the built daemon', () => {
  const unit = read('systemd/toon-console.service');
  assert.match(unit, /^ExecStart=@NODE@ @DAEMON@$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /^Environment=TOON_CONSOLE_UI_ROOT=@UI_ROOT@$/m);
  // A user unit must never carry User=/Group=; systemd --user refuses them.
  assert.doesNotMatch(unit, /^(User|Group)=/m);
});

test('the unit gives up instead of restarting forever', () => {
  // A daemon that cannot start at all — a taken port, a missing build — would
  // otherwise loop, and the one useful error would be buried in identical ones.
  const unit = read('systemd/toon-console.service');
  assert.match(unit, /^StartLimitBurst=\d+$/m);
  assert.match(unit, /^StartLimitIntervalSec=\d+$/m);
  // ...and the launcher must clear that limit, or a fixed cause still will not
  // start.
  assert.match(read('bin/toon-console'), /systemctl --user reset-failed/);
});

test('the installer substitutes every placeholder the unit carries', () => {
  const unit = read('systemd/toon-console.service');
  const installer = read('bin/toon-console-install');
  for (const placeholder of unit.match(/@[A-Z_]+@/g) ?? []) {
    assert.ok(
      installer.includes(`s|${placeholder}|`),
      `the installer leaves ${placeholder} in the unit it writes`
    );
  }
});

test('the installer refuses to install an unbuilt checkout', () => {
  const installer = read('bin/toon-console-install');
  assert.match(installer, /no built daemon at/);
  assert.match(installer, /no built UI at/);
});

test('uninstalling never touches the data directory', () => {
  const uninstall = read('bin/toon-console-uninstall');
  assert.doesNotMatch(uninstall, /rm .*toon-console\/profiles/);
  assert.match(uninstall, /Its data is untouched/);
});

/* -------------------------------------------------------------------------- */
/* The Omarchy half (TOON_Network#99)                                         */
/* -------------------------------------------------------------------------- */

test('the themed template asks only for properties the daemon reads', () => {
  // The template and THEME_VARIABLES are the two halves of one contract: a
  // property the template renders that the daemon does not know is a colour
  // that silently never arrives.
  const template = read('omarchy/toon-console.css.tpl');
  const theme = readFileSync(
    join(here, '..', 'packages', 'daemon', 'src', 'theme.ts'),
    'utf8'
  );
  const known = new Set(
    [...theme.matchAll(/^ {2}'([a-z-]+)',$/gm)].map((match) => match[1])
  );
  assert.ok(known.size > 10, 'THEME_VARIABLES did not parse');

  const rendered = [...template.matchAll(/^ {2}--([a-z-]+):/gm)].map((match) => match[1]);
  assert.ok(rendered.length > 10, 'the template renders nothing');
  for (const property of rendered) {
    if (property === 'mode') continue;
    assert.ok(known.has(property), `the template renders --${property}, which theme.ts drops`);
  }
  // ...and every variable the UI reads is rendered, or it silently falls back
  // to the default palette on an Omarchy desktop.
  for (const property of known) {
    assert.ok(
      rendered.includes(property),
      `theme.ts reads --${property}, which the template never renders`
    );
  }
});

test('the template takes its surfaces from mixes, not from named shades', () => {
  // Half of Omarchy's themes are light. `lighter_background` is a raised
  // surface on one and a recessed one on the other; a mix towards the
  // foreground is correct on both.
  const template = read('omarchy/toon-console.css.tpl');
  assert.match(template, /\{\{ mix background foreground \d+% \}\}/);
  assert.doesNotMatch(template, /--card:\s*\{\{ (lighter|dark|darker)_background \}\}/);
});

test('the theme-set hook never starts a daemon', () => {
  // It runs on every theme change, for everybody, whether or not the console
  // is open. Starting one would make setting a theme launch an application.
  const hook = read('omarchy/theme-set.d/toon-console');
  assert.match(hook, /--theme-changed/);
  assert.doesNotMatch(hook, /systemctl/);
  // The hook runs from omarchy-theme-set, whose PATH is not a login shell's.
  assert.match(hook, /@BIN@/);
});

test('--theme-changed posts and does nothing else', () => {
  const launcher = read('bin/toon-console');
  const body = launcher.slice(launcher.indexOf('--theme-changed" ]]'));
  const clause = body.slice(0, body.indexOf('fi'));
  assert.match(clause, /post_api \/api\/desktop\/theme/);
  assert.doesNotMatch(clause, /ensure_daemon|open_window/);
});

test('a menu entry tells the daemon the view before it focuses the window', () => {
  // Focusing is all Omarchy can do to a window that is already open, so a
  // menu entry that only focused would open whatever tab was last used.
  const launcher = read('bin/toon-console');
  assert.ok(
    launcher.indexOf('post_api /api/desktop/view') < launcher.indexOf('open_window "$url"'),
    'the launcher focuses the window before it says which view to open'
  );
  for (const view of ['workloads', 'new-workload', 'funds']) {
    assert.ok(read('omarchy/menu.jsonc').includes(`--view ${view}`), `no menu entry for ${view}`);
  }
});

test('every menu action names the launcher absolutely', () => {
  // The menu runs its action through Quickshell, not through a login shell.
  for (const [, action] of read('omarchy/menu.jsonc').matchAll(/"action":"([^"]+)"/g)) {
    assert.match(action, /^@BIN@ /, `menu action is not absolute: ${action}`);
  }
});

test('the installer puts the menu entries in and the uninstaller takes them out', () => {
  // The menu file is the person's, with their comments in it. This is the
  // test that it survives both halves byte for byte.
  const dir = mkdtempSync(join(tmpdir(), 'toon-menu-'));
  try {
    const home = join(dir, 'home');
    const menu = join(home, '.config', 'omarchy', 'extensions', 'omarchy-menu.jsonc');
    const theirs = [
      '{',
      '  // My own entries. This comment must survive.',
      '  "personal": {"icon":"","label":"Personal"},',
      '  "personal.notes": {"icon":"","label":"Notes","action":"true"}',
      '}',
      '',
    ].join('\n');
    execFileSync('mkdir', ['-p', dirname(menu)]);
    writeFileSync(menu, theirs);

    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
    const run = (args) =>
      execFileSync('bash', [join(here, 'bin', args[0]), ...args.slice(1)], { env });

    run(['toon-console-install', '--omarchy-only', '--no-retheme']);
    const merged = readFileSync(menu, 'utf8');
    assert.match(merged, /My own entries\. This comment must survive\./);
    assert.match(merged, /"toon\.workloads"/);
    // Their last entry had no trailing comma, and still has none: the block
    // goes in at the top, so removing it is a plain deletion.
    assert.match(merged, /"action":"true"\}\n/);
    assert.ok(JSON.parse(stripJsonc(merged))['toon.funds'], 'the merged file does not parse');

    // Twice is once: a reinstall must not leave two copies.
    run(['toon-console-install', '--omarchy-only', '--no-retheme']);
    assert.equal(readFileSync(menu, 'utf8'), merged);

    run(['toon-console-uninstall']);
    assert.equal(readFileSync(menu, 'utf8'), theirs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installing the Omarchy half writes the template and the hook, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toon-omarchy-'));
  try {
    const home = join(dir, 'home');
    const config = join(home, '.config');
    execFileSync('mkdir', ['-p', join(config, 'omarchy')]);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config };
    execFileSync('bash', [join(here, 'bin', 'toon-console-install'), '--omarchy-only', '--no-retheme'], { env });

    const hook = readFileSync(join(config, 'omarchy', 'hooks', 'theme-set.d', 'toon-console'), 'utf8');
    assert.doesNotMatch(hook, /@BIN@/, 'the hook still carries its placeholder');
    assert.match(hook, /toon-console --theme-changed/);
    accessSync(join(config, 'omarchy', 'themed', 'toon-console.css.tpl'), constants.R_OK);

    // No service, no launcher, no web app: --omarchy-only means the three
    // desktop files and nothing that could disturb a running console.
    assert.throws(() => accessSync(join(config, 'systemd', 'user', 'toon-console.service')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Omarchy's own reader, from shell/plugins/menu/MenuModel.js. */
function stripJsonc(raw) {
  return String(raw || '')
    .replace(/^\s*\/\/[^\n]*(\n|$)/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}
