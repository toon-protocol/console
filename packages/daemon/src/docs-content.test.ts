import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DocsError,
  docsDir,
  loadDocs,
  parseDoc,
  parseList,
  splitFrontMatter,
} from './docs-content.js';

const page = (fields: Record<string, string>, body = '# Hi\n\nA page.') =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}\n---\n\n${body}\n`;

const COMPLETE = {
  d: 'concepts',
  title: 'Concepts',
  summary: 'The words.',
  order: '1',
  published_at: '2026-09-23',
  tags: '[toon-network, concepts]',
};

const dirs: string[] = [];
function tempDocs(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'toon-docs-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('front matter', () => {
  it('splits the block from the body and keeps the body verbatim', () => {
    const { fields, body } = splitFrontMatter(page(COMPLETE, '# Hi\n\n    indented\n'));
    expect(fields['d']).toBe('concepts');
    expect(body).toBe('# Hi\n\n    indented');
  });

  it('treats a file with no front matter as all body', () => {
    const { fields, body } = splitFrontMatter('# Just a page');
    expect(fields).toEqual({});
    expect(body).toBe('# Just a page');
  });

  it('reads a list either bracketed or bare, and drops the quotes', () => {
    expect(parseList('[a, b]')).toEqual(['a', 'b']);
    expect(parseList('\'a\', "b"')).toEqual(['a', 'b']);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe('one page', () => {
  it('carries every field through', () => {
    const doc = parseDoc('concepts.md', page(COMPLETE));
    expect(doc).toMatchObject({
      d: 'concepts',
      title: 'Concepts',
      summary: 'The words.',
      order: 1,
      publishedAt: '2026-09-23',
      tags: ['toon-network', 'concepts'],
    });
    expect(doc.markdown).toContain('A page.');
    // The front matter must not survive into what gets published: it would be
    // rendered as a table by half the Nostr clients in the world.
    expect(doc.markdown).not.toContain('---');
  });

  it('refuses a page with no summary, because a relay would show the gap', () => {
    const { summary: _dropped, ...rest } = COMPLETE;
    expect(() => parseDoc('concepts.md', page(rest))).toThrow(/no `summary`/u);
  });

  it('refuses a `d` that is not a slug: it is an identity and a URL', () => {
    expect(() => parseDoc('x.md', page({ ...COMPLETE, d: 'Concepts Page' }))).toThrow(
      DocsError
    );
  });

  it('refuses front matter with no body', () => {
    expect(() => parseDoc('x.md', page(COMPLETE, ''))).toThrow(/no body/u);
  });
});

describe('the directory', () => {
  it('returns every page in reading order, not directory order', () => {
    const dir = tempDocs({
      'b.md': page({ ...COMPLETE, d: 'second', order: '2' }),
      'a.md': page({ ...COMPLETE, d: 'third', order: '3' }),
      'c.md': page({ ...COMPLETE, d: 'first', order: '1' }),
    });
    expect(loadDocs(dir).map((doc) => doc.d)).toEqual(['first', 'second', 'third']);
  });

  it('refuses two pages claiming one `d`, rather than silently picking one', () => {
    const dir = tempDocs({
      'one.md': page(COMPLETE),
      'two.md': page({ ...COMPLETE, title: 'Other' }),
    });
    // Two files at one article address would mean each publication replaced
    // the other on every relay, and which won would depend on `readdir`.
    expect(() => loadDocs(dir)).toThrow(/identity/u);
  });

  it('says where it looked when there is nothing there', () => {
    expect(() => loadDocs(join(tmpdir(), 'toon-docs-that-do-not-exist'))).toThrow(
      /TOON_CONSOLE_DOCS_DIR/u
    );
  });

  it('honours TOON_CONSOLE_DOCS_DIR so a packager can install them anywhere', () => {
    expect(docsDir({ TOON_CONSOLE_DOCS_DIR: '/opt/toon/docs' })).toBe('/opt/toon/docs');
    expect(docsDir({})).toMatch(/docs$/u);
  });
});

describe('the pages this repository actually ships', () => {
  const docs = loadDocs();

  it('covers every subject TOON_Network#102 asked for', () => {
    expect(docs.map((doc) => doc.d)).toEqual([
      'concepts',
      'first-workload',
      'funding',
      'gateways',
      'failover',
      'hidden-providers',
      'spec',
    ]);
  });

  it('is honest that this is a devnet', () => {
    const everything = docs
      .map((doc) => doc.markdown)
      .join('\n')
      .toLowerCase();
    expect(everything).toContain('there is no mainnet yet');
    expect(everything).toContain('no public mainnet provider');
  });

  it('says plainly that no faucet gives native gas', () => {
    const funding = docs.find((doc) => doc.d === 'funding');
    expect(funding?.markdown).toMatch(/no faucet on toon network gives you native gas/iu);
  });

  it('quotes the devnet listings the provider really sells', () => {
    const concepts = docs.find((doc) => doc.d === 'concepts')?.markdown ?? '';
    expect(concepts).toContain('1000 µUSDC');
    expect(concepts).toContain('5000 µUSDC');
    expect(concepts).toContain('3600 s');
    expect(concepts).toContain('Docker Capability');
  });
});
