// A guard on the install bundle.
//
// Nothing else runs these files in CI: they are bash and an INI file, and a
// typo in either is only discovered on someone's desktop. So the shape they
// have to keep is asserted here — the same reason gateway/deploy has its own
// bundle test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

/**
 * The environment an installer script may be run in, and the ONE way to build
 * one.
 *
 * `HOME` and the XDG variables send everything a script writes into a
 * throwaway tree. `systemctl` does not read any of them: `systemctl --user`
 * talks to the session bus, so a test that runs the real
 * `toon-console-uninstall` with only a fake `HOME` reaches out of its sandbox
 * and stops and disables the console the person at this desk is running. That
 * happened, repeatedly, before this helper existed — every `npm run
 * test:packaging` left the desktop's own service `inactive` and `disabled`.
 *
 * So a stub `systemctl` goes on `PATH` first, records what it was asked to do,
 * and does none of it. The recording is the point twice over: it is what
 * `fakePrefixInstall`'s callers assert the unit was enabled and restarted with,
 * and it is what makes "nothing real was touched" checkable rather than hoped
 * for.
 */
function sandboxEnv({ dir, home, config, data, binHome }) {
  const stub = join(dir, 'stub-bin');
  mkdirSync(stub, { recursive: true });
  const log = join(dir, 'systemctl.log');
  writeFileSync(
    join(stub, 'systemctl'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >>${JSON.stringify(log)}\nexit 0\n`,
    { mode: 0o755 }
  );
  return {
    env: {
      ...process.env,
      HOME: home,
      ...(config === undefined ? {} : { XDG_CONFIG_HOME: config }),
      ...(data === undefined ? {} : { XDG_DATA_HOME: data }),
      ...(binHome === undefined ? {} : { XDG_BIN_HOME: binHome }),
      PATH: `${stub}:${process.env.PATH}`,
    },
    systemctl: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}

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

test('a menu entry tells the daemon the view before it opens the tui', () => {
  // Focusing is all Omarchy can do to a window that is already open, so a
  // menu entry that only focused would open whatever view was last used. A
  // TUI that is not open yet needs the post to land before it starts, too --
  // its own first poll of GET /api/desktop is what picks the view up
  // (tui/src/desktop.rs).
  const launcher = read('bin/toon-console');
  const mainBody = launcher.slice(launcher.indexOf('main() {'));
  assert.ok(
    mainBody.indexOf('post_api /api/desktop/view') < mainBody.indexOf('open_tui'),
    'the launcher opens the tui before it says which view to open'
  );
  for (const view of ['workloads', 'new-workload', 'funds']) {
    assert.ok(read('omarchy/menu.jsonc').includes(`--view ${view}`), `no menu entry for ${view}`);
  }
});

/* -------------------------------------------------------------------------- */
/* The TUI launcher (TOON_Network#140, ADR 0028)                              */
/* -------------------------------------------------------------------------- */

test('with no arguments the launcher opens the tui, not the web app', () => {
  const launcher = read('bin/toon-console');
  const mainBody = launcher.slice(launcher.indexOf('main() {'));
  // The `--web` branch is the only place open_window runs; everything else
  // (no arguments, --view) falls to open_tui.
  assert.match(mainBody, /if \[\[ \$web == true \]\]; then\s*\n\s*open_window "\$url"\s*\n\s*else\s*\n\s*open_tui/);
});

test('the tui opens through omarchy-launch-or-focus-tui with a stable app id', () => {
  // The app id is what lets a second launch find and focus the SAME
  // terminal window rather than opening another one -- so it has to be a
  // literal, not derived from argv the way omarchy-launch-or-focus-tui's own
  // default naming would.
  const launcher = read('bin/toon-console');
  assert.match(
    launcher,
    /exec omarchy-launch-or-focus-tui "--app-id=\$TUI_APP_ID" "\$TUI_BIN"/
  );
  assert.match(launcher, /^TUI_APP_ID="org\.toon\.console"$/m);
  assert.match(launcher, /^TUI_BIN="toon-console-tui"$/m);
});

test('off Omarchy the tui falls back to xdg-terminal-exec, then $TERMINAL', () => {
  const launcher = read('bin/toon-console');
  const openTui = launcher.slice(launcher.indexOf('open_tui() {'), launcher.indexOf('main() {'));
  assert.match(openTui, /exec xdg-terminal-exec -- "\$TUI_BIN"/);
  assert.match(openTui, /exec "\$TERMINAL" -e "\$TUI_BIN"/);
  // In that order: xdg-terminal-exec is tried and used before $TERMINAL is
  // ever run.
  assert.ok(
    openTui.indexOf('exec xdg-terminal-exec') < openTui.indexOf('exec "$TERMINAL"'),
    'xdg-terminal-exec must be tried before $TERMINAL'
  );
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

    const { env, systemctl } = sandboxEnv({ dir, home, config: join(home, '.config') });
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
    // And it asked a systemctl that recorded rather than acted. Without this
    // the same line reaches the session bus and stops the console the person
    // at this desk is running.
    assert.match(systemctl(), /disable --now toon-console\.service/);
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
    const { env } = sandboxEnv({ dir, home, config });
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

/* -------------------------------------------------------------------------- */
/* The AUR package (TOON_Network#100)                                         */
/* -------------------------------------------------------------------------- */

const PKGBUILD = 'aur/PKGBUILD';

test('the PKGBUILD and its install file are bash, and parse', () => {
  for (const file of [PKGBUILD, 'aur/toon-console.install']) {
    execFileSync('bash', ['-n', join(here, file)]);
  }
});

test('the package version is the version that is built', () => {
  // pkgver is what the AUR shows and what `#tag=v$pkgver` fetches. A pkgver
  // that has drifted from the workspace would build one version and claim
  // another, and the health view — which reads the daemon's own package.json
  // — would be the only place the difference showed.
  const workspace = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  const daemon = JSON.parse(
    readFileSync(join(here, '..', 'packages', 'daemon', 'package.json'), 'utf8')
  );
  const pkgver = /^pkgver=(.+)$/m.exec(read(PKGBUILD))?.[1];
  assert.equal(pkgver, workspace.version);
  assert.equal(pkgver, daemon.version);
});

test('the source is one pinned tag, not a moving branch', () => {
  const pkgbuild = read(PKGBUILD);
  assert.match(pkgbuild, /#tag=v\$pkgver/);
  assert.doesNotMatch(pkgbuild, /#branch=/);
  // A `-git` package would be a different package with a different name.
  assert.match(pkgbuild, /^pkgname=toon-console$/m);
});

/** A bash file with its comments and its printed messages taken out. */
const codeOf = (name) =>
  read(name)
    .replace(/cat <<'MESSAGE'[\s\S]*?\nMESSAGE\n/g, '')
    .replace(/^\s*#.*$/gm, '');

test('the package never names the account data directory', () => {
  // THE guarantee of this ticket: an upgrade and a removal leave the account's
  // channel state, Chain Seed cache, Lease Vault cache and keystore alone.
  // It is not enforced by a backup() line or by a clever hook — it is enforced
  // by a file list that never mentions the directory, so pacman cannot touch
  // it. This test is that file list staying that way. (What the install file
  // PRINTS about that directory is another matter, and is the point.)
  for (const file of [PKGBUILD, 'aur/toon-console.install']) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /XDG_DATA_HOME/, `${file} reaches into the data directory`);
    assert.doesNotMatch(code, /\.local\/share/, `${file} reaches into the data directory`);
    assert.doesNotMatch(code, /backup=/, `${file} declares a backup file under $HOME`);
  }
});

test('the install file prints and does nothing else', () => {
  // It runs as root, at package time, possibly in a chroot, with no session
  // and no idea whose machine this is. Anything it did to a person's files it
  // would be doing as the wrong user, at the wrong time — so with the messages
  // taken out there is nothing left in it but three empty functions.
  const code = codeOf('aur/toon-console.install')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(code, [
    'post_install() {',
    '}',
    'post_upgrade() {',
    '}',
    'pre_remove() {',
    '}',
  ]);
  // ...and it tells the person the one command that does the per-user half.
  const text = read('aur/toon-console.install');
  assert.match(text, /toon-console-install/);
  assert.match(text, /toon-console-uninstall/);
});

test('the PKGBUILD substitutes every placeholder the unit and the desktop entry carry', () => {
  // The same contract the checkout installer is held to: a placeholder nobody
  // replaces reaches systemd as a literal `@NODE@` and the unit never starts.
  const pkgbuild = read(PKGBUILD);
  const sources = [
    read('systemd/toon-console.service'),
    read('desktop/toon-console.desktop'),
    read('desktop/toon-console-web.desktop'),
  ];
  for (const source of sources) {
    for (const placeholder of source.match(/@[A-Z_]+@/g) ?? []) {
      assert.ok(
        pkgbuild.includes(`s|${placeholder}|`),
        `the PKGBUILD leaves ${placeholder} in what it installs`
      );
    }
  }
});

test('the package installs every file the console needs, from this tree', () => {
  // Each path the PKGBUILD copies out of the checkout has to be a path that
  // exists in it. A renamed asset otherwise fails at `makepkg` time on a
  // stranger's machine rather than here.
  const pkgbuild = read(PKGBUILD);
  const referenced = [
    ...[...pkgbuild.matchAll(/install -Dm\d+ (packaging\/\S+|LICENSE)/g)].map((m) => m[1]),
    ...[...pkgbuild.matchAll(/cp -a (packages\/\w+\/dist\S*|docs|packaging\/\S+)/g)].map(
      (m) => m[1]
    ),
    ...[...pkgbuild.matchAll(/install -Dm\d+ "\$srcdir\/[^"]+" \\?\s*\n?\s*"\$pkgdir[^"]+"/g)].map(
      () => null
    ),
  ].filter(Boolean);
  const built = new Set(['packages/daemon/dist/.', 'packages/ui/dist']);
  for (const path of referenced) {
    if (built.has(path)) continue; // only exists after `npm run build`
    accessSync(join(here, '..', path), constants.R_OK);
  }
  // And the two it can only have after a build are the two the build makes.
  assert.ok(pkgbuild.includes('packages/daemon/dist/.'));
  assert.ok(pkgbuild.includes('packages/ui/dist'));
});

test('the PKGBUILD builds and installs the TUI (TOON_Network#140, ADR 0028)', () => {
  const pkgbuild = read(PKGBUILD);
  assert.match(
    pkgbuild,
    /\(cd tui && cargo build --release --locked\)/,
    'the tui crate is built with --locked, pinned to its own Cargo.lock'
  );
  assert.match(pkgbuild, /^makedepends=\(.*'rust'.*\)$/m);
  assert.match(pkgbuild, /^makedepends=\(.*'cargo'.*\)$/m);
  // Runtime `depends` names none of it: the crate is compiled away by the
  // time the package is built, and nothing at runtime needs a toolchain.
  assert.doesNotMatch(read(PKGBUILD).match(/^depends=\([^)]*\)/m)[0], /rust|cargo/);
  assert.match(
    pkgbuild,
    /install -Dm755 tui\/target\/release\/toon-console-tui "\$pkgdir\/usr\/bin\/toon-console-tui"/
  );
});

test('the package ships the runtime tree only, with no link into the build directory', () => {
  const pkgbuild = read(PKGBUILD);
  // vite, vitest, typescript and eslint built the console, and react, radix
  // and lucide were compiled into the UI's dist. What ships is the DAEMON's
  // production tree, resolved from the same lockfile that built it.
  assert.match(pkgbuild, /--omit=dev --include-workspace-root --workspace @toon-protocol\/console-daemon/);
  // The workspace link points back into $srcdir and would be dangling the
  // moment the package is installed.
  assert.match(pkgbuild, /find node_modules -xtype l -delete/);
});

test('the daemon gets a package.json beside its dist, or none of its imports work', () => {
  // node decides ESM-vs-CommonJS from the nearest package.json, and
  // version.ts reads the console's name and version out of exactly that path.
  const pkgbuild = read(PKGBUILD);
  assert.match(pkgbuild, /"\$lib\/package\.json"/);
  assert.match(pkgbuild, /packages\/daemon\/package\.json/);
  const version = readFileSync(
    join(here, '..', 'packages', 'daemon', 'src', 'version.ts'),
    'utf8'
  );
  assert.match(
    version,
    /join\(here, '\.\.', 'package\.json'\)/,
    'version.ts no longer reads the package.json one level above its dist'
  );
});

test('the desktop entry is one file, used by the package and by a checkout', () => {
  const entry = read('desktop/toon-console.desktop');
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec=@BIN@$/m);
  assert.match(entry, /^Icon=@ICON@$/m);
  // Exec is the launcher, never a URL: the URL that opens the console carries
  // a token minted at launch.
  assert.doesNotMatch(entry, /^Exec=.*http/m);
  // The installer renders the same file rather than keeping a second copy of
  // it in a heredoc.
  assert.match(read('bin/toon-console-install'), /packaging\/desktop\/toon-console\.desktop/);
  assert.doesNotMatch(read('bin/toon-console-install'), /\[Desktop Entry\]/);
});

test('a second desktop entry opens the web app (TOON_Network#140)', () => {
  const entry = read('desktop/toon-console-web.desktop');
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Name=TOON Console \(web\)$/m);
  assert.match(entry, /^Exec=@BIN@ --web$/m);
  assert.match(entry, /^Icon=@ICON@$/m);
  assert.match(read('bin/toon-console-install'), /packaging\/desktop\/toon-console-web\.desktop/);
});

test('the launcher entry comes from the package, or from a checkout, never both', () => {
  const installer = read('bin/toon-console-install');
  // A second webapp entry would be a duplicate launcher pacman cannot remove,
  // so the one call there is belongs to the checkout branch alone.
  assert.equal((installer.match(/omarchy-webapp-install \\\n/g) ?? []).length, 1);
  const packaged = installer
    .slice(installer.indexOf("# The package's own"))
    .replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(packaged, /omarchy-webapp-install/);
  assert.match(installer, /LAYOUT == checkout/);
});

test('the post-update hook restarts a running console and starts no other', () => {
  const hook = read('omarchy/post-update.d/toon-console');
  // `try-restart` is exactly "restart it if it is running". `restart` would
  // start a console the person had stopped, in the middle of a system update.
  assert.match(hook, /systemctl --user try-restart toon-console\.service/);
  assert.doesNotMatch(hook, /systemctl --user (start|restart) /);
  // It must do nothing at all once the package is gone.
  assert.match(hook, /\[\[ -x @INSTALL@ \]\] \|\| exit 0/);
  // And the installer has to resolve that placeholder, for the same reason
  // the theme-set hook's is resolved: the hook runs with omarchy-hook's PATH.
  assert.match(read('bin/toon-console-install'), /s\|@INSTALL@\|/);
});

test('the theme is re-rendered only when the template actually changed', () => {
  // The post-update hook runs this on every `omarchy update`, and
  // omarchy-theme-set re-themes the whole desktop.
  const installer = read('bin/toon-console-install');
  assert.match(installer, /before != "\$after" \|\| ! -r \$rendered/);
});

test('uninstalling removes the post-update hook and the copy of itself', () => {
  const uninstall = read('bin/toon-console-uninstall');
  assert.match(uninstall, /hooks\/post-update\.d\/toon-console/);
  assert.match(uninstall, /rm -f "\$BIN_DIR\/toon-console-uninstall"/);
  // ...and still nothing under the data directory.
  assert.match(uninstall, /Its data is untouched/);
});

/**
 * A packaged install, into a throwaway prefix and a throwaway HOME, with a
 * systemctl that records rather than acts.
 *
 * This is the half of the AUR package that `makepkg` cannot show: what the
 * person's own directories look like after `pacman -S` and `toon-console-install`,
 * and after `pacman -R` and `toon-console-uninstall`. Nothing real is
 * installed, no real service is touched, and the fake prefix stands in for
 * /usr exactly as `pacman -U --root` would.
 */
function fakePrefixInstall(run) {
  const dir = mkdtempSync(join(tmpdir(), 'toon-packaged-'));
  try {
    const prefix = join(dir, 'usr');
    const home = join(dir, 'home');
    const config = join(home, '.config');
    const data = join(home, '.local', 'share');

    // What the package put in /usr.
    mkdirSync(join(prefix, 'lib', 'toon-console', 'daemon'), { recursive: true });
    writeFileSync(join(prefix, 'lib', 'toon-console', 'daemon', 'main.js'), '');
    mkdirSync(join(prefix, 'lib', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(prefix, 'lib', 'systemd', 'user', 'toon-console.service'), '');
    mkdirSync(join(prefix, 'share', 'toon-console', 'ui'), { recursive: true });
    mkdirSync(join(prefix, 'share', 'applications'), { recursive: true });
    cpSync(join(here, 'omarchy'), join(prefix, 'share', 'toon-console', 'omarchy'), {
      recursive: true,
    });
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    for (const name of ['toon-console', 'toon-console-install', 'toon-console-uninstall']) {
      cpSync(join(here, 'bin', name), join(prefix, 'bin', name));
      chmodSync(join(prefix, 'bin', name), 0o755);
    }

    // The person's directories, with state in them that must survive.
    mkdirSync(join(config, 'omarchy'), { recursive: true });
    mkdirSync(join(data, 'toon-console', 'accounts', 'a'), { recursive: true });
    writeFileSync(join(data, 'toon-console', 'accounts', 'a', 'leases.json'), '{"keep":true}');

    const { env, systemctl } = sandboxEnv({
      dir,
      home,
      config,
      data,
      binHome: join(home, '.local', 'bin'),
    });
    const exec = (script, args = []) =>
      execFileSync('bash', [script, ...args], { env, encoding: 'utf8' });

    run({ dir, prefix, home, config, data, env, exec, systemctl });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a packaged install enables the package unit and writes only under $HOME', () => {
  fakePrefixInstall(({ prefix, home, config, data, exec, systemctl }) => {
    const out = exec(join(prefix, 'bin', 'toon-console-install'));

    // The service is enabled from the package's unit; no second unit is
    // written where it would shadow it.
    assert.match(systemctl(), /enable toon-console\.service/);
    // ...and restarted, because after an upgrade the daemon that is running is
    // the build that was replaced.
    assert.match(systemctl(), /restart toon-console\.service/);
    assert.ok(!existsSync(join(config, 'systemd', 'user', 'toon-console.service')));
    // The launcher is the package's, so nothing is copied onto PATH...
    assert.ok(!existsSync(join(home, '.local', 'bin', 'toon-console')));
    // ...but the uninstaller is, because pacman will take the package's copy.
    accessSync(join(home, '.local', 'bin', 'toon-console-uninstall'), constants.X_OK);
    // The desktop entry is the package's, and no webapp duplicate was made.
    assert.ok(!existsSync(join(home, '.local', 'share', 'applications')));
    assert.match(out, /from the package/);

    // The Omarchy half, pointing at the package's launcher and installer.
    const hook = readFileSync(join(config, 'omarchy', 'hooks', 'theme-set.d', 'toon-console'), 'utf8');
    assert.ok(hook.includes(`${prefix}/bin/toon-console --theme-changed`));
    const update = readFileSync(
      join(config, 'omarchy', 'hooks', 'post-update.d', 'toon-console'),
      'utf8'
    );
    assert.ok(update.includes(`${prefix}/bin/toon-console-install --omarchy-only`));
    assert.doesNotMatch(update, /@INSTALL@/);
    const menu = readFileSync(
      join(config, 'omarchy', 'extensions', 'omarchy-menu.jsonc'),
      'utf8'
    );
    assert.ok(menu.includes(`${prefix}/bin/toon-console --view workloads`));

    // And the account's data is exactly as it was.
    assert.equal(
      readFileSync(join(data, 'toon-console', 'accounts', 'a', 'leases.json'), 'utf8'),
      '{"keep":true}'
    );
  });
});

test('installing twice changes nothing, the way an upgrade re-runs it', () => {
  fakePrefixInstall(({ prefix, config, exec }) => {
    exec(join(prefix, 'bin', 'toon-console-install'));
    const snapshot = readFileSync(
      join(config, 'omarchy', 'extensions', 'omarchy-menu.jsonc'),
      'utf8'
    );
    exec(join(prefix, 'bin', 'toon-console-install'));
    assert.equal(
      readFileSync(join(config, 'omarchy', 'extensions', 'omarchy-menu.jsonc'), 'utf8'),
      snapshot
    );
  });
});

test('removing the package leaves no launcher, hook, service or menu entry behind', () => {
  fakePrefixInstall(({ prefix, home, config, data, exec, systemctl }) => {
    exec(join(prefix, 'bin', 'toon-console-install'));

    // `pacman -R`: everything the package owned, including its uninstaller.
    rmSync(prefix, { recursive: true, force: true });

    // The copy the install left behind is what is left to run.
    exec(join(home, '.local', 'bin', 'toon-console-uninstall'));

    assert.match(systemctl(), /disable --now toon-console\.service/);
    for (const left of [
      join(config, 'omarchy', 'themed', 'toon-console.css.tpl'),
      join(config, 'omarchy', 'hooks', 'theme-set.d', 'toon-console'),
      join(config, 'omarchy', 'hooks', 'post-update.d', 'toon-console'),
      join(config, 'systemd', 'user', 'toon-console.service'),
      join(home, '.local', 'bin', 'toon-console'),
      join(home, '.local', 'bin', 'toon-console-uninstall'),
    ]) {
      assert.ok(!existsSync(left), `${left} survived the uninstall`);
    }
    const menu = readFileSync(join(config, 'omarchy', 'extensions', 'omarchy-menu.jsonc'), 'utf8');
    assert.doesNotMatch(menu, /toon-console/);
    assert.doesNotMatch(menu, /toon\.workloads/);

    // The data directory is the one thing that survives all of it.
    assert.equal(
      readFileSync(join(data, 'toon-console', 'accounts', 'a', 'leases.json'), 'utf8'),
      '{"keep":true}'
    );
  });
});

test('.SRCINFO says what the PKGBUILD says', () => {
  // The AUR refuses a push whose .SRCINFO does not match its PKGBUILD, and it
  // is a generated file that nothing but a person's memory regenerates. This
  // compares the fields that actually move; `makepkg --printsrcinfo` is what
  // writes it (packaging/aur/README.md).
  const pkgbuild = read(PKGBUILD);
  const srcinfo = read('aur/.SRCINFO');
  const field = (name) =>
    [...srcinfo.matchAll(new RegExp(`^\\t${name} = (.+)$`, 'gm'))].map((match) => match[1]);
  const declared = (name) =>
    new RegExp(`^${name}=(?:'([^']*)'|"([^"]*)"|(\\S+))$`, 'm')
      .exec(pkgbuild)
      ?.slice(1)
      .find(Boolean);

  assert.equal(field('pkgver')[0], declared('pkgver'));
  assert.equal(field('pkgrel')[0], declared('pkgrel'));
  assert.match(srcinfo, /^pkgbase = toon-console$/m);
  // The source line carries the tag, with $pkgver expanded.
  assert.equal(
    field('source')[0],
    `toon-console::git+https://github.com/toon-protocol/console.git#tag=v${declared('pkgver')}`
  );
  for (const depend of field('depends')) {
    assert.ok(
      pkgbuild.includes(`'${depend}'`),
      `.SRCINFO has a depends the PKGBUILD does not: ${depend}`
    );
  }
  assert.equal(field('install')[0], 'toon-console.install');
});
