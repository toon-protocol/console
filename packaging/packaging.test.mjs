// A guard on the install bundle.
//
// Nothing else runs these files in CI: they are bash and an INI file, and a
// typo in either is only discovered on someone's desktop. So the shape they
// have to keep is asserted here — the same reason gateway/deploy has its own
// bundle test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
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
