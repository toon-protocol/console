import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { DocsState } from '@/hooks/use-docs';
import { renderMarkdown } from '@/lib/markdown';

/**
 * The Help tab: the same documentation as the public site, in the app
 * (TOON_Network#102).
 *
 * Same pages, same source, two carriages. The daemon reads the published
 * NIP-23 articles off the network profile's relay — free, needing no account —
 * and falls back to the Markdown this console shipped with. Which of the two
 * is on screen is stated, never inferred, because "the docs you are reading
 * are the ones from the tarball" is exactly the sort of thing a person needs
 * told while they are following instructions about money.
 *
 * Offline is the case this most needs to work in. Half of these pages are
 * about getting online, so the bundle is not a degraded mode here — it is the
 * mode a new install is in.
 */
export function DocsView({ docs }: { docs: DocsState }) {
  const page = docs.page;
  const html = useMemo(
    () => (page === undefined ? '' : renderMarkdown(page.doc.markdown)),
    [page]
  );

  if (page !== undefined) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => docs.close()}>
            &larr; All pages
          </Button>
          <SourceBadge source={page.doc.source} />
        </div>
        {page.fallback !== undefined && <FallbackNote note={page.fallback} />}
        <Card>
          <CardContent className="pt-6">
            <article
              className="prose-console"
              // `renderMarkdown` drops raw HTML and refuses any link scheme
              // but http, https and mailto. The body can have come off a
              // relay, and although the event was checked against the
              // documentation key first, a page that would be an injection if
              // that key ever leaked is not a page worth shipping.
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {page.doc.address !== undefined && (
              <p className="text-muted-foreground mt-8 border-t pt-4 text-xs">
                Published as a NIP-23 article. Open it in any Nostr client at{' '}
                <code className="font-mono">{page.doc.address}</code>.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Documentation</h2>
          <p className="text-muted-foreground text-sm">
            {docs.index?.author === undefined
              ? 'The pages this console shipped with.'
              : `Published as NIP-23 articles by ${docs.index.author.npub.slice(0, 20)}…`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={docs.refresh} disabled={docs.loading}>
          {docs.loading ? 'Reading…' : 'Re-read from relays'}
        </Button>
      </div>

      {docs.error !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The documentation could not be read</CardTitle>
            <CardDescription>{docs.error}</CardDescription>
          </CardHeader>
        </Card>
      )}
      {docs.openError !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">That page could not be opened</CardTitle>
            <CardDescription>{docs.openError}</CardDescription>
          </CardHeader>
        </Card>
      )}
      {docs.index?.fallback !== undefined && <FallbackNote note={docs.index.fallback} />}

      <div className="grid gap-3 md:grid-cols-2">
        {(docs.index?.docs ?? []).map((doc) => (
          <button
            key={doc.d}
            type="button"
            onClick={() => docs.open(doc.d)}
            className="hover:border-primary rounded-lg border p-4 text-left transition-colors"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{doc.title}</span>
              <SourceBadge source={doc.source} />
            </div>
            <span className="text-muted-foreground mt-1 block text-sm">{doc.summary}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: 'relays' | 'bundled' }) {
  return source === 'relays' ? (
    <Badge variant="success">published</Badge>
  ) : (
    <Badge variant="warning">bundled</Badge>
  );
}

function FallbackNote({ note }: { note: string }) {
  return (
    <p className="text-muted-foreground bg-muted/40 rounded-md border px-3 py-2 text-xs">
      {note}
    </p>
  );
}
