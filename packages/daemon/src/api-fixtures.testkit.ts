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
 * every run. A route under test here routinely answers with a process id, an
 * uptime counter, a `Date.now()`-derived timestamp, this run's `mkdtemp`
 * directory, and — because spawning a lease or a Chain Seed genuinely needs
 * fresh, unpredictable key material rather than a checked-in "test" secret —
 * a freshly generated keypair's own pubkey, address and derived ids. All of
 * that is real but different every run, and a fixture that changed on every
 * `npm test` for no reason a person did defeats the point of committing it.
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
/** A stand-in expiry, one placeholder each for a seconds- and a
 * milliseconds-resolution epoch (distinguished by digit count below). */
const PLACEHOLDER_EXPIRES_SECONDS = 1_893_456_000;
const PLACEHOLDER_EXPIRES_MS = 1_893_456_000_000;

// A timestamp embedded inside a longer sentence (a gateway "keeps the grant
// until <date>" message, say) needs a substring replace, not a whole-string
// one — this single global regex covers both: run once per string, it
// leaves a string with no match untouched and rewrites every match in one
// that has several.
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

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
  'g'
);
const PLACEHOLDER_TEMP_DIR = `${tmpdir()}/toon-console-fixture`;

/**
 * Shapes of the random-but-opaque identifiers a route hands back: a Nostr
 * pubkey/event id/workload id/record id (lowercase hex, several lengths in
 * practice), an EVM address, a bech32 `npub`, a UUID (a signer id), a
 * base58 Solana address, and a Workload Gateway hostname (a base32 label —
 * `format::gatewayHostnameFor`'s own output — in front of the profile's
 * `gatewayDomain`). Checked in this order because a couple overlap in the
 * characters they allow (hex is a subset of what the base58 pattern alone
 * would accept) and the first match wins.
 */
const IDENTIFIER_SHAPES: ReadonlyArray<{ pattern: RegExp; family: string }> = [
  { pattern: /^0x[0-9a-fA-F]{40}$/, family: 'evm' },
  {
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    family: 'uuid',
  },
  { pattern: /^npub1[a-z0-9]{20,}$/, family: 'npub' },
  { pattern: /^[a-z2-7]{40,}\.[a-z0-9.-]+$/, family: 'hostname' },
  { pattern: /^[0-9a-f]{40,90}$/, family: 'hex' },
  { pattern: /^[1-9A-HJ-NP-Za-km-z]{25,50}$/, family: 'base58' },
];

/** Chosen so the placeholder is valid in every shape's own alphabet: a
 * lowercase hex digit, a valid base58 character, and inside the bech32
 * charset `npub1` addresses use. */
const FILLER = 'a';

function placeholderFor(original: string, family: string, index: number): string {
  const suffix = index.toString(16).padStart(4, '0');
  switch (family) {
    case 'evm':
      return '0x' + FILLER.repeat(Math.max(0, original.length - 2 - suffix.length)) + suffix;
    case 'uuid':
      // Keep the hyphens where a UUID must have them; only the digit groups
      // vary, and only the last one carries the distinguishing suffix.
      return `${FILLER.repeat(8)}-${FILLER.repeat(4)}-${FILLER.repeat(4)}-${FILLER.repeat(4)}-${FILLER.repeat(8)}${suffix}`;
    case 'hostname': {
      const dot = original.indexOf('.');
      const label = original.slice(0, dot);
      const domain = original.slice(dot); // includes the leading '.'
      return FILLER.repeat(Math.max(0, label.length - suffix.length)) + suffix + domain;
    }
    default:
      // hex, npub, base58: a flat run of the filler with the suffix at the
      // end is valid in all three alphabets and keeps the original length.
      return FILLER.repeat(Math.max(0, original.length - suffix.length)) + suffix;
  }
}

/**
 * Deep-clones `value`, replacing every known-volatile field with a fixed
 * placeholder that keeps the original's JSON type and, for a string, its
 * approximate shape — so the result still deserializes into the same Rust
 * type the real response did:
 * - a `pid`/`uptimeSeconds`/`expiresAt` number,
 * - an ISO-8601 timestamp, wherever one appears (a field-name allowlist
 *   would miss the next route's own `publishedAt`/`checkedAt`/`startedAt`/
 *   ...), including one embedded inside a longer sentence,
 * - a path under this run's own temp directory,
 * - an opaque random identifier — a pubkey, an address, a workload or
 *   record id, a signer id, a gateway hostname — recognised by SHAPE
 *   (`IDENTIFIER_SHAPES`) rather than by field name, for the same reason as
 *   the timestamps.
 *
 * Two passes: the first walks the tree replacing everything above and, for
 * an identifier, remembers `original -> placeholder` in `seen` (the same
 * original value always gets the same placeholder, so two fields that must
 * agree — a lease's `workloadId` repeated on its own card, say — still
 * agree afterwards); the second walks the ALREADY-normalised tree once more
 * substituting any of those exact substrings still sitting inside a longer
 * string (a hostname quoted inside a free-text `message`, an address
 * inside a faucet `command`) — a plain field-by-field pass alone would miss
 * those, since they are not themselves one whole field's value.
 */
function normalise(value: unknown): unknown {
  const seen = new Map<string, string>();
  const nextIndex: Record<string, number> = {};

  function identifierPlaceholder(text: string): string | undefined {
    const already = seen.get(text);
    if (already !== undefined) {
      return already;
    }
    for (const { pattern, family } of IDENTIFIER_SHAPES) {
      if (pattern.test(text)) {
        const index = nextIndex[family] ?? 0;
        nextIndex[family] = index + 1;
        const placeholder = placeholderFor(text, family, index);
        seen.set(text, placeholder);
        return placeholder;
      }
    }
    return undefined;
  }

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'pid' && typeof item === 'number') {
          out[key] = PLACEHOLDER_PID;
        } else if (key === 'uptimeSeconds' && typeof item === 'number') {
          out[key] = PLACEHOLDER_UPTIME_SECONDS;
        } else if (key === 'expiresAt' && typeof item === 'number') {
          out[key] = item >= 1e12 ? PLACEHOLDER_EXPIRES_MS : PLACEHOLDER_EXPIRES_SECONDS;
        } else {
          out[key] = walk(item);
        }
      }
      return out;
    }
    if (typeof node === 'string') {
      // `.replace()` with a global regex always rescans a string from the
      // start on its own, unlike `.test()`/`.exec()` — sharing these two
      // `RegExp` objects across every string in the tree is safe precisely
      // because `.replace()` is the only method ever called on them here.
      const deVolatiled = node
        .replace(ISO_TIMESTAMP, PLACEHOLDER_TIMESTAMP)
        .replace(TEMP_DIR, PLACEHOLDER_TEMP_DIR);
      return identifierPlaceholder(deVolatiled) ?? deVolatiled;
    }
    return node;
  }

  const first = walk(value);
  if (seen.size === 0) {
    return first;
  }

  function substituteEmbedded(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(substituteEmbedded);
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        out[key] = substituteEmbedded(item);
      }
      return out;
    }
    if (typeof node === 'string') {
      let out = node;
      for (const [original, placeholder] of seen) {
        if (out.includes(original)) {
          out = out.split(original).join(placeholder);
        }
      }
      return out;
    }
    return node;
  }

  return substituteEmbedded(first);
}
