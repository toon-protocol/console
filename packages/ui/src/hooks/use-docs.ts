import { useCallback, useEffect, useState } from 'react';

import { DaemonError, daemon, type DocsIndex, type DocsPage } from '@/lib/daemon';

/**
 * The docs, from the window's side (TOON_Network#102).
 *
 * The index loads when the view opens and one page loads when it is chosen —
 * two calls rather than one, because seven article bodies is a lot of JSON to
 * ship for a reading list, and the daemon has already cached the relay read
 * behind both of them.
 *
 * Keyed to the active profile, because a switch is another network and another
 * relay. It is NOT keyed to the account: reading is free, needs no key, and
 * one of these pages is the one that explains what a key is for.
 */

export interface DocsState {
  readonly index?: DocsIndex;
  readonly page?: DocsPage;
  readonly loading: boolean;
  readonly error?: string;
  readonly openError?: string;
  open(d: string): void;
  close(): void;
  refresh(): void;
}

export function useDocs(options: { active: boolean; profileId?: string }): DocsState {
  const [index, setIndex] = useState<DocsIndex>();
  const [page, setPage] = useState<DocsPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [open, setOpen] = useState<string>();

  const { active, profileId } = options;

  const load = useCallback((refresh = false) => {
    setLoading(true);
    return daemon
      .docs(refresh ? { refresh: true } : {})
      .then((next) => {
        setIndex(next);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, profileId, load]);

  useEffect(() => {
    if (!active || open === undefined) return;
    let cancelled = false;
    void daemon
      .doc(open)
      .then((next) => {
        if (cancelled) return;
        setPage(next);
        setOpenError(undefined);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setPage(undefined);
        setOpenError(message(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [active, open, profileId]);

  return {
    ...(index === undefined ? {} : { index }),
    ...(page === undefined ? {} : { page }),
    loading,
    ...(error === undefined ? {} : { error }),
    ...(openError === undefined ? {} : { openError }),
    open: (d: string) => setOpen(d),
    close: () => {
      setOpen(undefined);
      setPage(undefined);
      setOpenError(undefined);
    },
    refresh: () => void load(true),
  };
}

function message(caught: unknown): string {
  return caught instanceof DaemonError || caught instanceof Error
    ? caught.message
    : String(caught);
}
