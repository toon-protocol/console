import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The docs, as Markdown files in this repository (TOON_Network#102).
 *
 * `docs/` at the repository root is the **source**. Everything else is a copy
 * of it: the NIP-23 articles the publisher puts on relays (`docs-article.ts`),
 * what the public site bundles, and what this daemon serves to the console
 * window when a relay cannot be reached. One source, three carriages, and a
 * person editing a page edits Markdown in a pull request like any other change.
 *
 * Front matter is deliberately a handful of scalars and one bracketed list,
 * parsed here in thirty lines rather than by pulling a YAML engine into a
 * daemon that holds keys. Anything a page needs that this cannot express is a
 * sign the page wants a different shape, not that this wants a parser.
 *
 * The `d` field is the important one: it is the NIP-23 article's `d` tag, and
 * therefore the article's IDENTITY. Two files may not claim the same `d`, and
 * changing a file's `d` publishes a new article rather than replacing the old
 * one — which is why `loadDocs` refuses a duplicate rather than picking a
 * winner.
 */

/** One page: its front matter, and the Markdown body under it. */
export interface BundledDoc {
  /** The NIP-23 `d` tag. The article's identity, and the site's URL slug. */
  readonly d: string;
  readonly title: string;
  readonly summary: string;
  /** Where it sits in the reading order. */
  readonly order: number;
  /** The date the page first claimed, as `YYYY-MM-DD`. */
  readonly publishedAt: string;
  readonly tags: readonly string[];
  /** The body, front matter removed. */
  readonly markdown: string;
}

export class DocsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocsError';
    this.code = code;
  }
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

/** The front matter block and the body, split. Never throws on a missing block. */
export function splitFrontMatter(source: string): {
  fields: Record<string, string>;
  body: string;
} {
  const match = FRONT_MATTER.exec(source);
  if (match?.[1] === undefined) return { fields: {}, body: source.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: source.slice(match[0].length).trim() };
}

/** `[a, b]` or `a, b`, with surrounding quotes taken off each entry. */
export function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const inner = raw.trim().replace(/^\[/u, '').replace(/\]$/u, '');
  return inner
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
    .filter((entry) => entry.length > 0);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * One file, parsed.
 *
 * Every field it needs is required, and a missing one is an error naming the
 * file. A page with no summary would be published to relays with an empty
 * `summary` tag, where every Nostr client in the world would render the gap.
 */
export function parseDoc(fileName: string, source: string): BundledDoc {
  const { fields, body } = splitFrontMatter(source);
  const required = (name: string): string => {
    const value = fields[name];
    if (value === undefined || value.length === 0) {
      throw new DocsError(
        'doc_incomplete',
        `${fileName} has no \`${name}\` in its front matter. Every page needs \`d\`, ` +
          '`title`, `summary`, `order` and `published_at`.'
      );
    }
    return value;
  };

  const d = required('d');
  if (!SLUG.test(d)) {
    throw new DocsError(
      'doc_invalid',
      `${fileName} claims \`d: ${d}\`. A \`d\` tag is an article's identity and a URL ` +
        'slug here, so it is lower-case words joined by single hyphens.'
    );
  }

  const order = Number(required('order'));
  if (!Number.isInteger(order)) {
    throw new DocsError('doc_invalid', `${fileName} has a non-integer \`order\`.`);
  }
  if (body.length === 0) {
    throw new DocsError('doc_incomplete', `${fileName} has front matter and no body.`);
  }

  return {
    d,
    title: required('title'),
    summary: required('summary'),
    order,
    publishedAt: required('published_at'),
    tags: parseList(fields['tags']),
    markdown: body,
  };
}

/**
 * Where the Markdown is.
 *
 * `TOON_CONSOLE_DOCS_DIR` first, so a packager can put the pages wherever it
 * installs read-only data; the default is `docs/` at the root of this
 * repository, which is where both a checkout and the npm workspace layout put
 * them. Exactly the shape `resolveUiRoot` uses in `main.ts`, for the same
 * reason.
 */
export function docsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['TOON_CONSOLE_DOCS_DIR'];
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'docs');
}

/**
 * Every page, in reading order.
 *
 * A duplicate `d` is refused rather than resolved. Two files claiming one
 * article identity would mean one publication silently replacing the other on
 * every relay in the network, and the file that won would depend on the order
 * the directory happened to list.
 */
export function loadDocs(dir: string = docsDir()): readonly BundledDoc[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch (error) {
    throw new DocsError(
      'docs_missing',
      `No documentation at ${dir}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Set TOON_CONSOLE_DOCS_DIR if the pages are installed elsewhere.'
    );
  }

  const byD = new Map<string, BundledDoc>();
  for (const name of names.sort()) {
    const doc = parseDoc(name, readFileSync(join(dir, name), 'utf8'));
    const held = byD.get(doc.d);
    if (held !== undefined) {
      throw new DocsError(
        'doc_duplicate',
        `${name} claims \`d: ${doc.d}\`, and so does another page. A \`d\` tag is an ` +
          'article’s identity: two pages sharing one would replace each other on every ' +
          'relay they were published to.'
      );
    }
    byD.set(doc.d, doc);
  }

  return [...byD.values()].sort(
    (left, right) => left.order - right.order || left.d.localeCompare(right.d)
  );
}
