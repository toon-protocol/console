import { mkdirSync, writeFileSync } from 'node:fs';
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
 */
export function writeApiFixture(name: string, body: unknown): void {
  const path = fileURLToPath(new URL(`../fixtures/api/${name}.json`, import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}
