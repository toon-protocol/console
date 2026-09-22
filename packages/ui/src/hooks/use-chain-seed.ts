import { useCallback, useEffect, useRef, useState } from 'react';

import { DaemonError, daemon, type ChainSeedStatus, type PublishOutcome } from '@/lib/daemon';

/**
 * The account's Chain Seed, from the window's side.
 *
 * The same shape as `use-account`: every action posts and gets the whole state
 * back, because the daemon holds the truth and a window that kept its own copy
 * would be wrong the moment another window minted.
 *
 * What is NOT here is the point of it. A mnemonic typed into the import form
 * is passed straight to `daemon.importChainSeed` and never put in a state
 * setter, never in `localStorage`, never in the URL, and never logged. The
 * word the person typed lives in one controlled input, and the first thing a
 * successful import does is clear it.
 *
 * `reload` runs whenever the signed-in account changes — the seed belongs to
 * the Account, so signing in as somebody else is a different seed or none.
 */

export interface ChainSeedState {
  readonly status?: ChainSeedStatus;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  /** Per-relay detail when a publish persisted nothing. */
  readonly refusals?: PublishOutcome[];
  reload(): void;
  clearError(): void;
  refresh(relays?: string[]): Promise<boolean>;
  acknowledge(): Promise<boolean>;
  mint(): Promise<boolean>;
  importMnemonic(mnemonic: string): Promise<boolean>;
  publishRelayList(
    relays: { url: string; mode?: 'read' | 'write' | 'both' }[]
  ): Promise<boolean>;
}

export function useChainSeed(options: { pubkey?: string | undefined } = {}): ChainSeedState {
  const [status, setStatus] = useState<ChainSeedStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [refusals, setRefusals] = useState<PublishOutcome[]>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<ChainSeedStatus>): Promise<boolean> => {
    setBusy(true);
    try {
      const next = await work();
      if (!alive.current) return true;
      setStatus(next);
      setError(undefined);
      setErrorCode(undefined);
      setRefusals(undefined);
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      setError(caught instanceof Error ? caught.message : String(caught));
      setErrorCode(caught instanceof DaemonError ? caught.code : 'error');
      setRefusals(caught instanceof DaemonError ? caught.relays : undefined);
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    void run(() => daemon.chainSeed()).finally(() => {
      if (alive.current) setLoading(false);
    });
  }, [run]);

  // Keyed to the account: a different signer is a different seed.
  useEffect(() => reload(), [reload, options.pubkey]);

  return {
    status,
    loading,
    busy,
    error,
    errorCode,
    refusals,
    reload,
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
      setRefusals(undefined);
    },
    refresh: (relays) => run(() => daemon.refreshChainSeed(relays)),
    acknowledge: () => run(() => daemon.acknowledgeCustody()),
    mint: () => run(() => daemon.mintChainSeed()),
    importMnemonic: (mnemonic) => run(() => daemon.importChainSeed(mnemonic)),
    publishRelayList: (relays) => run(() => daemon.publishRelayList(relays)),
  };
}
