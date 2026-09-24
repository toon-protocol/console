# toon-console-tui

The TOON Console, as a terminal UI (TOON_Network#138, ADR 0028). Same daemon,
same `/api/*` routes as `packages/ui`, drawn with `ratatui` in the terminal's
own ANSI palette so an Omarchy theme applies live.

Run it against a running daemon with `cargo run`. It reads the daemon's URL
and per-launch token from `$XDG_RUNTIME_DIR/toon-console/launch.json` (see
`src/launch.rs`) — if that file is not there, it shows the `systemctl`/
`journalctl` commands instead of a blank screen, and keeps retrying.

## Module layout

- `src/app.rs` — `View` (the seven sidebar views), `App` state, and the
  keymap (`handle_key`, `handle_mouse`). No network code.
- `src/client.rs` — `DaemonClient`, the one place an HTTP request is made.
  Handles the bearer token and the 401-then-reread-the-launch-record retry.
- `src/launch.rs` — reads and parses the launch record; the XDG path lookup
  mirrors `packages/daemon/src/paths.ts` exactly.
- `src/types.rs` — hand-kept Rust types mirroring
  `packages/ui/src/lib/daemon.ts`. Checked against the daemon's real
  responses by `tests/fixture_contract.rs`.
- `src/desktop.rs` — the `GET /api/desktop` long poll that lets an Omarchy
  menu entry switch an already-open window's view.
- `src/format.rs` — small display formatters shared by views.
- `src/ui.rs` — the shell: header, sidebar, footer, `?` help overlay. Calls
  into `views::<name>::draw` for the current view.
- `src/views/<name>.rs` — one file per sidebar view.
- `src/widgets/<name>.rs` — pieces more than one view reuses: `list.rs` is a
  filterable, `j`/`k`-navigable list's key-handling state machine, and
  `confirm.rs` is a confirmation modal that one keypress cannot pass (typing
  `yes`, not the key that opened it). A view drives these and draws around
  them; see `views/workloads.rs` (TOON_Network#143) for the pattern.
- `src/clipboard.rs` — `wl-copy` when it is there, a message saying so when
  it is not. Runs the program directly, never through a shell.
- `src/main.rs` — thin wiring only (terminal setup/teardown, the event loop).
  Nothing here is worth a unit test that `src/`'s modules don't already cover
  without a real terminal.

## Adding a view

1. Add a variant to `View` in `src/app.rs` if it is not already one of the
   seven (it probably already is — the shell lists all seven from the start
   and shows a placeholder for what is not built).
2. Create `src/views/<name>.rs` with a `pub fn draw(frame: &mut Frame, area:
   Rect, /* your data */)`. Add a unit test that renders it against
   `ratatui::backend::TestBackend` and asserts an `insta` snapshot (see
   `src/views/health.rs`).
3. Wire it into `draw_content` in `src/ui.rs`, replacing the
   `views::placeholder::draw` arm for that `View`.
4. If the view needs data from the daemon, add the hand-kept type(s) to
   `src/types.rs` and a method on `DaemonClient` (or call `client.get(...)`
   directly from `main.rs`'s wiring, the way Health does).
5. Add the daemon-side fixture and register it (next section) so the type
   is checked against the daemon's real response.

## Adding a fixture

The daemon's own API tests write each route's real response to
`packages/daemon/fixtures/api/<route>.json` via `writeApiFixture` in
`packages/daemon/src/api-fixtures.testkit.ts` — one line at the point the
test already asserts on that response:

```ts
import { writeApiFixture } from './api-fixtures.testkit.js';
// ...
writeApiFixture('workloads', body);
```

Then register the fixture's name against its Rust type in `REGISTRY` in
`tui/tests/fixture_contract.rs`:

```rust
map.insert("workloads", check::<WorkloadsDashboard> as Check);
```

`tests/fixture_contract.rs` deserializes every `.json` file under
`packages/daemon/fixtures/api/` into the type registered for it, and fails
the build on a fixture with no registry entry — so forgetting the second
step is a failing test, not a silently-unchecked file.

## Rules a change here should not break

- **No colour of its own.** Every `Style` uses one of `ratatui::style::Color`'s
  named ANSI variants (or `Modifier`s) — never `Color::Rgb` or
  `Color::Indexed`. `tests/no_colour.rs` fails the build if either appears
  anywhere under `src/`.
- **The token is never logged, printed or written** outside `src/client.rs`'s
  one `Authorization` header and `src/launch.rs`'s read of the file the
  daemon already wrote. `LaunchRecord`'s `Debug` impl is hand-written to
  redact it, on purpose — see `src/launch.rs`.
- **Health's refresh cadence matches the web UI's**: read once (on connect)
  and again only on `r` — `packages/ui/src/hooks/use-console.ts` has no
  auto-poll for Health, so neither does this.
- **Workloads polls every 30 seconds**, matching `POLL_MS` in
  `packages/ui/src/hooks/use-workloads.ts` (TOON_Network#143) — `R` asks for
  one early (capital, per ADR 0028's "R refreshes"; lowercase `r` is the
  Workloads view's own rotate action, TOON_Network#144). Extend, terminate,
  auto-extend, rotate and gateway handover/withdraw all go through
  `widgets::confirm`, never straight from their key.

## Testing

```
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`cargo test` needs `packages/daemon/fixtures/api/*.json` to exist — run
`npm test -w @toon-protocol/console-daemon` first if you have just pulled a
branch that changed a fixture-writing test, or if `fixture_contract.rs`
reports an empty directory.
