import { Marked, type Tokens } from 'marked';

/**
 * Markdown to HTML, with the HTML taken out.
 *
 * The body of a page can arrive from a relay, and although every event is
 * signature-checked against the documentation key before it gets here
 * (`articles.ts`), "the key that signs the docs also decides what script runs
 * on this origin" is not a sentence anybody should have to rely on. So raw
 * HTML in Markdown renders as nothing, and a link whose scheme is not one of
 * three known-safe ones renders as text.
 *
 * `marked` is configured once, here, and exported as a function rather than
 * left to each caller. A second call site that forgot one of these two
 * overrides would be an injection, and the way to make that impossible is to
 * have no second call site.
 *
 * The console UI carries its own copy of this file for the same reason the
 * site carries its own copy of the merge rules: the daemon builds for Node and
 * cannot be imported into a browser bundle, and the two browsers are separate
 * builds. `markdown.test.ts` in each asserts the same two facts.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Whether a link may keep its href, or must be rendered as plain text. */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  // Relative and same-page links: no scheme, so no scheme to abuse.
  if (/^[#/]/u.test(trimmed)) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    try {
      return SAFE_SCHEMES.has(new URL(trimmed).protocol);
    } catch {
      return false;
    }
  }
  return true;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
});

marked.use({
  renderer: {
    // Raw HTML in the source renders as nothing at all. Not escaped and shown
    // — dropped: a docs page has no reason to contain any.
    html: () => '',
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      if (!isSafeHref(href)) return text;
      const external = /^https?:/iu.test(href.trim());
      return (
        `<a href="${escapeAttribute(href)}"` +
        (title ? ` title="${escapeAttribute(title)}"` : '') +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        `>${text}</a>`
      );
    },
  },
});

export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false });
}

/**
 * A page's headings, for the table of contents beside it.
 *
 * Read off the Markdown rather than out of the rendered DOM, so the list and
 * the anchors are decided in one place and a page with no `h2` simply has no
 * contents list instead of an empty box.
 */
export interface Heading {
  readonly id: string;
  readonly text: string;
}

export function headingsOf(source: string): Heading[] {
  return source
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^##\s+(.+?)\s*$/u.exec(line);
      return match?.[1] === undefined ? [] : [{ id: slugify(match[1]), text: match[1] }];
    })
    .filter((heading) => heading.id.length > 0);
}

/** `marked`'s own heading ids are not exposed, so this is the one rule. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
