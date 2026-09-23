import { useCallback, useEffect, useRef, useState } from 'react';

import { DaemonError, daemon, type FundingStatus } from '@/lib/daemon';

/**
 * Funding, from the window's side.
 *
 * The same shape as the other hooks — every action posts and gets the whole
 * state back, because the daemon holds the truth — with one addition this view
 * needs and the others do not: it **polls while something is in flight**.
 *
 * An open is a chain transaction. It takes as long as a block takes, the
 * daemon answers before it lands, and the state in between is `opening`. So
 * the window asks again on a timer for as long as any chain reports one, and
 * stops as soon as none does. It polls on the CHEAP read — no `refresh` — so
 * a pending open costs the daemon a look at its own memory rather than an RPC
 * round trip every two seconds; the balances that a landed open changes are
 * re-read once, when it lands.
 */

export interface FundingState {
  readonly status?: FundingStatus;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  /** True while any chain has an open in flight. */
  readonly pending: boolean;
  reload(): void;
  refresh(): void;
  clearError(): void;
  openChannel(request: { chain: string; deposit?: string }): Promise<boolean>;
  drip(chain: string): Promise<boolean>;
}

/** How often to look again while an open is in flight. */
const POLL_MS = 2000;

export function useFunding(
  options: {
    active?: boolean;
    pubkey?: string | undefined;
    profileId?: string | undefined;
  } = {}
): FundingState {
  const [status, setStatus] = useState<FundingStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<FundingStatus>): Promise<boolean> => {
    setBusy(true);
    try {
      const next = await work();
      if (!alive.current) return true;
      setStatus(next);
      setError(undefined);
      setErrorCode(undefined);
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      setError(caught instanceof Error ? caught.message : String(caught));
      setErrorCode(caught instanceof DaemonError ? caught.code : 'error');
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      void run(() => daemon.funding(refresh ? { refresh: true } : {})).finally(() => {
        if (alive.current) setLoading(false);
      });
    },
    [run]
  );

  // Keyed to the account AND the network: an address belongs to the account, a
  // channel belongs to the network, and switching either is a different view.
  useEffect(() => {
    if (options.active === false) return;
    load(false);
  }, [load, options.active, options.pubkey, options.profileId]);

  const pending = (status?.chains ?? []).some((chain) => chain.channel.phase === 'opening');

  // Poll only while something is happening. A view that polls forever is a
  // view that keeps a laptop awake for nothing.
  useEffect(() => {
    if (!pending || options.active === false) return;
    const timer = setInterval(() => {
      void run(() => daemon.funding());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, options.active, run]);

  // The moment the last open lands, read the chains once: the collateral just
  // left the wallet and went into the channel, and both figures moved.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) void run(() => daemon.funding({ refresh: true }));
    wasPending.current = pending;
  }, [pending, run]);

  return {
    status,
    loading,
    busy,
    error,
    errorCode,
    pending,
    reload: () => load(false),
    refresh: () => load(true),
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
    },
    openChannel: (request) => run(() => daemon.openChannel(request)),
    drip: (chain) => run(() => daemon.faucetDrip(chain)),
  };
}
