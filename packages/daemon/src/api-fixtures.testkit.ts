import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The TUI's fixture contract with this package (TOON_Network#139, ADR 0028).
 *
 * `tui/`'s hand-kept Rust types have no import from this package to keep them
 * honest against — Rust does not import TypeScript — so the honesty comes
 * from a file instead: an API test calls {@link writeApiFixture} with the
 * REAL response a route just answered, and `tui/tests/fixture_contract.rs`
 * deserializes every file this writes into the Rust type registered for it.
 * A field that drifts between the two fails that test, not a blank card.
 *
 * One line per route is the whole cost of extending this: call
 * `writeApiFixture('<route>', body)` from wherever that route's test already
 * asserts on the real response, and add the matching one-line entry to
 * `REGISTRY` in `tui/tests/fixture_contract.rs`.
 *
 * What gets WRITTEN is normalised first (see {@link normalise}) — the real
 * `body` an assertion already ran against is never mutated, only the clone
 * that reaches disk — so the committed fixture is the same byte for byte
 * every run: a process id, an uptime counter, a `Date.now()`-derived
 * timestamp and this run's `mkdtemp` directory are real but different every
 * time this suite runs, and a fixture that changed on every `npm test` for
 * no reason a person did defeats the point of committing it.
 */
export function writeApiFixture(name: string, body: unknown): void {
  const path = fileURLToPath(new URL(`../fixtures/api/${name}.json`, import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalise(body), null, 2)}\n`);
}

/** A stand-in ISO-8601 instant — shape is all the Rust side ever checks. */
const PLACEHOLDER_TIMESTAMP = '2026-01-01T00:00:00.000Z';
/** A stand-in process id, distinguishable from a real one at a glance. */
const PLACEHOLDER_PID = 424242;
/** A stand-in uptime, in seconds. */
const PLACEHOLDER_UPTIME_SECONDS = 3600;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Every `mkdtempSync(join(tmpdir(), 'toon-<something>-'))` in this package's
 * tests names its own prefix, but they all start with `toon-` right after
 * the OS temp directory — matching on that shared convention, rather than
 * hard-coding one test's own prefix, catches every one of them without a
 * per-caller allowlist. Escapes `tmpdir()` itself since on some platforms it
 * is a regex-meaningful string.
 */
const TEMP_DIR = new RegExp(
  `${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/toon-[A-Za-z0-9_-]+`,
  'g',
);
const PLACEHOLDER_TEMP_DIR = `${tmpdir()}/toon-console-fixture`;

/**
 * Deep-clones `value`, replacing known-volatile fields with fixed
 * placeholders: a `pid`/`uptimeSeconds` number, an ISO-8601 timestamp
 * string (wherever it appears — a field name allowlist would miss the next
 * route's own `publishedAt`/`checkedAt`/`startedAt`/...), or a path under
 * this run's own temp directory. Every placeholder keeps the original
 * value's JSON type, so the result still deserializes into the same Rust
 * type the real response did.
 */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalise(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'pid' && typeof item === 'number') {
        out[key] = PLACEHOLDER_PID;
      } else if (key === 'uptimeSeconds' && typeof item === 'number') {
        out[key] = PLACEHOLDER_UPTIME_SECONDS;
      } else {
        out[key] = normalise(item);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP.test(value)) {
      return PLACEHOLDER_TIMESTAMP;
    }
    // `.replace()` with a global regex always rescans from the start on its
    // own, unlike `.test()`/`.exec()` — sharing this one `RegExp` object
    // across every string in the tree is safe precisely because this is the
    // only method ever called on it. A string with no match comes back
    // unchanged.
    return value.replace(TEMP_DIR, PLACEHOLDER_TEMP_DIR);
  }
  return value;
}
