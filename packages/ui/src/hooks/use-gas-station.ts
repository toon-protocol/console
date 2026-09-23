import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DaemonError,
  daemon,
  type GasPurchase,
  type GasQuote,
  type GasStationStatus,
} from '@/lib/daemon';

/**
 * Buying the next chain's gas, from the window's side (TOON_Network#119).
 *
 * The shape is the funding hook's, with one deliberate difference: **it does
 * not fold an action's answer back into the state**, because a quote and a
 * purchase are not the state. The state is "what could be bought"; a quote is
 * a thing this window is now holding and must show before it spends anything
 * else, and a purchase is an event that happened once. Merging either into the
 * status would make a window that merely polled look as though it had bought
 * something.
 *
 * The other difference follows from what these calls DO: every one of them but
 * `reload` **spends money**, and a refusal spends it too (ADR 0003,
 * TOON_Network#115). So a failure keeps the daemon's own error code and the
 * account of what it cost, and neither is cleared by the next poll.
 */

export interface GasStationState {
  readonly status?: GasStationStatus;
  readonly loading: boolean;
  readonly busy: boolean;
  /** The quote being shown, per chain. Cleared once it is bought or expires. */
  readonly quote?: GasQuote;
  readonly purchase?: GasPurchase;
  readonly error?: string;
  readonly errorCode?: string;
  reload(): void;
  clearError(): void;
  dismiss(): void;
  quoteGas(request: { chain: string; lamports?: string }): Promise<boolean>;
  buyGas(request: { chain: string; quoteId: string }): Promise<boolean>;
}

export function useGasStation(
  options: {
    active?: boolean;
    pubkey?: string | undefined;
    profileId?: string | undefined;
    /** Bumped by the funding view when a channel lands, so this re-reads. */
    revision?: unknown;
  } = {}
): GasStationState {
  const [status, setStatus] = useState<GasStationStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<GasQuote>();
  const [purchase, setPurchase] = useState<GasPurchase>();
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      const value = await work();
      if (!alive.current) return undefined;
      setError(undefined);
      setErrorCode(undefined);
      return value;
    } catch (caught) {
      if (!alive.current) return undefined;
      setError(caught instanceof Error ? caught.message : String(caught));
      setErrorCode(caught instanceof DaemonError ? caught.code : 'error');
      return undefined;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    void run(() => daemon.gasStation())
      .then((next) => {
        if (next && alive.current) setStatus(next);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  }, [run]);

  useEffect(() => {
    if (options.active === false) return;
    load();
  }, [load, options.active, options.pubkey, options.profileId, options.revision]);

  return {
    status,
    loading,
    busy,
    quote,
    purchase,
    error,
    errorCode,
    reload: load,
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
    },
    dismiss: () => {
      setQuote(undefined);
      setPurchase(undefined);
    },
    quoteGas: async (request) => {
      setPurchase(undefined);
      const quoted = await run(() => daemon.quoteGas(request));
      if (quoted && alive.current) setQuote(quoted);
      return quoted !== undefined;
    },
    buyGas: async (request) => {
      const bought = await run(() => daemon.buyGas(request));
      if (!alive.current) return bought !== undefined;
      // The quote is spent either way: a station that answered has consumed
      // it, and one that refused has consumed it too. Showing it afterwards
      // would invite a second purchase against a quote that no longer exists.
      setQuote(undefined);
      if (bought) setPurchase(bought);
      // The chains have changed if this landed, so read them again.
      load();
      return bought !== undefined;
    },
  };
}
