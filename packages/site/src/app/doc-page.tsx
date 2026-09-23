import { useMemo } from 'react';

import type { Doc } from '@/lib/docs';
import { headingsOf, renderMarkdown } from '@/lib/markdown';

/**
 * One documentation page.
 *
 * The Markdown is rendered with raw HTML dropped and unsafe link schemes
 * stripped (`markdown.ts`), which is what makes `dangerouslySetInnerHTML`
 * defensible here: the body may have come off a relay, and although the event
 * was signature-checked against the documentation key first, a page that would
 * be an injection if that key ever leaked is not a page worth shipping.
 *
 * A published page says so, with the address a Nostr client can open it by.
 * That is not decoration: "you can read this somewhere other than here" is the
 * whole point of publishing the docs as articles, and a reader who cannot see
 * the address cannot act on it.
 */
export function DocPage({
  doc,
  docs,
  onOpenDoc,
}: {
  doc: Doc;
  docs: readonly Doc[];
  onOpenDoc: (d: string) => void;
}) {
  const html = useMemo(() => renderMarkdown(doc.markdown), [doc.markdown]);
  const headings = useMemo(() => headingsOf(doc.markdown), [doc.markdown]);
  const at = docs.findIndex((candidate) => candidate.d === doc.d);
  const previous = at > 0 ? docs[at - 1] : undefined;
  const next = at >= 0 && at < docs.length - 1 ? docs[at + 1] : undefined;

  return (
    <div className="doc-layout">
      <nav className="doc-side" aria-label="Documentation">
        <ol>
          {docs.map((candidate) => (
            <li key={candidate.d} className={candidate.d === doc.d ? 'current' : undefined}>
              <button type="button" onClick={() => onOpenDoc(candidate.d)}>
                {candidate.title}
              </button>
            </li>
          ))}
        </ol>
        {headings.length > 1 && (
          <>
            <h2 className="side-heading">On this page</h2>
            <ol className="contents">
              {headings.map((heading) => (
                <li key={heading.id}>
                  <a href={`#${heading.id}`}>{heading.text}</a>
                </li>
              ))}
            </ol>
          </>
        )}
      </nav>

      <main className="doc-main">
        <p className="doc-meta">
          {doc.source === 'relays' ? (
            <>
              Published as a NIP-23 article. <code>{doc.address}</code>
            </>
          ) : (
            <>This page as it was published with this site.</>
          )}
        </p>
        <article
          className="prose"
          // Safe by construction: `renderMarkdown` drops raw HTML and refuses
          // any link scheme but http, https and mailto.
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(event) => {
            // The pages link to each other by slug (`[Funding](funding)`), so
            // an in-site link stays in the app instead of asking the server
            // for a path it would have to rewrite back.
            const target = (event.target as HTMLElement).closest('a');
            const href = target?.getAttribute('href');
            if (href === null || href === undefined) return;
            if (/^[a-z][a-z0-9+.-]*:|^[#/]/iu.test(href)) return;
            event.preventDefault();
            onOpenDoc(href);
          }}
        />
        <nav className="doc-nav" aria-label="More pages">
          {previous && (
            <button type="button" onClick={() => onOpenDoc(previous.d)}>
              ← {previous.title}
            </button>
          )}
          {next && (
            <button type="button" className="right" onClick={() => onOpenDoc(next.d)}>
              {next.title} →
            </button>
          )}
        </nav>
      </main>
    </div>
  );
}
