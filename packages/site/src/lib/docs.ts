/**
 * The pages, as the browser has them (TOON_Network#102).
 *
 * Two copies again, exactly as in the daemon: the **article** on the relays,
 * which is what was published and may be newer than this build, and the
 * **bundled** Markdown, which is what this build shipped with. Relays win when
 * they answer; the bundle is what makes a docs site work when every relay in
 * the list is down, which is a state half of these pages are about getting out
 * of.
 *
 * This file is a deliberate, hand-kept MIRROR of the daemon's `docs-content.ts`
 * and `docs-article.ts`, not an import of them. The daemon builds for Node and
 * its package root reaches for `node:fs` — ADR 0019's first reason the console
 * is a local daemon at all — so pulling its modules into a browser bundle would
 * pull its runtime with them. The console UI mirrors the daemon's API types for
 * the same reason. `docs.test.ts` in this package and `docs-content.test.ts` in
 * the daemon assert the same facts about the same files, which is what keeps
 * the two honest.
 */

/** One page: its front matter, and the Markdown under it. */
export interface Doc {
  /** The NIP-23 `d` tag: the article's identity, and this site's URL slug. */
  readonly d: string;
  readonly title: string;
  readonly summary: string;
  readonly order: number;
  readonly publishedAt: string;
  readonly tags: readonly string[];
  readonly markdown: string;
  readonly source: 'relays' | 'bundled';
  /** `30023:<pubkey>:<d>`, on a published copy. */
  readonly address?: string;
  readonly updatedAt?: number;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

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

export function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .trim()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * The Markdown this build shipped with, straight from `docs/` at the root.
 *
 * `eager` on purpose: there are seven small files, the index needs every
 * page's front matter to render at all, and a lazy glob would turn a docs
 * index into seven round trips.
 */
const SOURCES = import.meta.glob('../../../../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const BUNDLED_DOCS: readonly Doc[] = Object.entries(SOURCES)
  .map(([path, source]): Doc => {
    const { fields, body } = splitFrontMatter(source);
    const name = path.split('/').pop() ?? path;
    const d = fields['d'] ?? name.replace(/\.md$/u, '');
    return {
      d,
      title: fields['title'] ?? d,
      summary: fields['summary'] ?? '',
      order: Number(fields['order'] ?? '999'),
      publishedAt: fields['published_at'] ?? '',
      tags: parseList(fields['tags']),
      markdown: body,
      source: 'bundled',
    };
  })
  .sort((left, right) => left.order - right.order || left.d.localeCompare(right.d));

export function docBySlug(docs: readonly Doc[], d: string): Doc | undefined {
  return docs.find((doc) => doc.d === d);
}
