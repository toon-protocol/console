import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DaemonError,
  daemon,
  type LeaseVaultStatus,
  type PreflightView,
  type SpawnRequestBody,
  type SpawnResult,
  type StandbySetPreflightView,
  type StandbySetRequestBody,
  type StandbySetResult,
} from '@/lib/daemon';

/**
 * The Lease Vault and the spawn, from the window's side.
 *
 * The same shape as the other hooks — the daemon holds the truth and every
 * action gets the whole state back — with one thing none of them has: this one
 * can **spend money**, and so it keeps the two apart by name.
 *
 * `check` is a preflight. It is free, it sends no packet, and the form calls
 * it whenever what a person typed settles. `spawn` is the paid one, and it
 * happens only when somebody presses the button. A hook that ran the paid
 * route on a debounce would be a hook that bought a lease per keystroke.
 *
 * A spawn's failure is kept as a first-class field rather than folded into a
 * generic error, because the interesting half of it is the provider's own
 * refusal code (spec §5): `no_capacity` is "try another provider",
 * `refused_image` is "that image is not allowed here", and a page that showed
 * either as "something went wrong" would be hiding the only thing worth
 * knowing.
 */

export interface LeasesState {
  readonly vault?: LeaseVaultStatus;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  /** The provider's own refusal code, when the last spawn was refused. */
  readonly providerError?: string;
  /** The last preflight, for the form to show before anything is paid. */
  readonly preflight?: PreflightView;
  /** The last spawn that worked, so the page can show its access details. */
  readonly spawned?: SpawnResult;
  /** The last Standby Set preflight, priced at every member (§7). */
  readonly standbySetPreflight?: StandbySetPreflightView;
  /** The last Standby Set spawned, reported member by member. */
  readonly spawnedSet?: StandbySetResult;
  reload(): void;
  /** Re-read the vault from the account's relays. What recovery looks like. */
  recover(): void;
  check(request: SpawnRequestBody): Promise<PreflightView | undefined>;
  spawn(request: SpawnRequestBody): Promise<boolean>;
  /** Free, and it prices every member of the set. Safe on a debounce. */
  checkSet(request: StandbySetRequestBody): Promise<StandbySetPreflightView | undefined>;
  /** Paid at EVERY member. Only ever from a press. */
  spawnSet(request: StandbySetRequestBody): Promise<boolean>;
  clearError(): void;
  dismissSpawned(): void;
}

export function useLeases(options: { active?: boolean; pubkey?: string | undefined } = {}) {
  const [vault, setVault] = useState<LeaseVaultStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [providerError, setProviderError] = useState<string>();
  const [preflight, setPreflight] = useState<PreflightView>();
  const [spawned, setSpawned] = useState<SpawnResult>();
  const [standbySetPreflight, rememberSetPreflight] = useState<StandbySetPreflightView>();
  const [spawnedSet, setSpawnedSet] = useState<StandbySetResult>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const remember = useCallback((caught: unknown) => {
    if (!alive.current) return;
    setError(caught instanceof Error ? caught.message : String(caught));
    setErrorCode(caught instanceof DaemonError ? caught.code : 'error');
    setProviderError(caught instanceof DaemonError ? caught.providerError : undefined);
  }, []);

  const load = useCallback(
    (fromRelays: boolean) => {
      setLoading(true);
      void (fromRelays ? daemon.refreshLeases() : daemon.leases())
        .then((next) => {
          if (!alive.current) return;
          setVault(next);
          setError(undefined);
          setErrorCode(undefined);
        })
        .catch(remember)
        .finally(() => {
          if (alive.current) setLoading(false);
        });
    },
    [remember]
  );

  // Keyed to the ACCOUNT and nothing else: a lease belongs to whoever holds
  // its Root Secret, and switching accounts is a different vault. The network
  // profile is not in the key — the vault holds leases from every network the
  // account has spawned on, and each record says which (ADR 0021).
  useEffect(() => {
    if (options.active === false) return;
    // A fresh window asks the relays, not just the cache: that is what makes
    // signing in on another machine show the workloads again.
    load(true);
  }, [load, options.active, options.pubkey]);

  const check = useCallback(
    async (request: SpawnRequestBody): Promise<PreflightView | undefined> => {
      try {
        const view = await daemon.preflightSpawn(request);
        if (alive.current) setPreflight(view);
        return view;
      } catch (caught) {
        remember(caught);
        return undefined;
      }
    },
    [remember]
  );

  const spawn = useCallback(
    async (request: SpawnRequestBody): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      setErrorCode(undefined);
      setProviderError(undefined);
      try {
        const result = await daemon.spawn(request);
        if (!alive.current) return true;
        setSpawned(result);
        setPreflight(result.preflight);
        setVault(await daemon.leases());
        return true;
      } catch (caught) {
        remember(caught);
        // The vault may have changed even though the spawn did not work — a
        // refusal takes its record back, and an unconfirmed one keeps it.
        void daemon
          .leases()
          .then((next) => {
            if (alive.current) setVault(next);
          })
          .catch(() => undefined);
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [remember]
  );

  const checkSet = useCallback(
    async (request: StandbySetRequestBody): Promise<StandbySetPreflightView | undefined> => {
      try {
        const view = await daemon.preflightStandbySet(request);
        if (alive.current) rememberSetPreflight(view);
        return view;
      } catch (caught) {
        remember(caught);
        return undefined;
      }
    },
    [remember]
  );

  const spawnSet = useCallback(
    async (request: StandbySetRequestBody): Promise<boolean> => {
      setBusy(true);
      setError(undefined);
      setErrorCode(undefined);
      setProviderError(undefined);
      try {
        const result = await daemon.spawnStandbySet(request);
        if (!alive.current) return true;
        setSpawnedSet(result);
        rememberSetPreflight(result.preflight);
        setVault(await daemon.leases());
        return true;
      } catch (caught) {
        remember(caught);
        void daemon
          .leases()
          .then((next) => {
            if (alive.current) setVault(next);
          })
          .catch(() => undefined);
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [remember]
  );

  return {
    vault,
    loading,
    busy,
    error,
    errorCode,
    providerError,
    preflight,
    spawned,
    standbySetPreflight,
    spawnedSet,
    reload: () => load(false),
    recover: () => load(true),
    check,
    spawn,
    checkSet,
    spawnSet,
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
      setProviderError(undefined);
    },
    dismissSpawned: () => {
      setSpawned(undefined);
      setSpawnedSet(undefined);
    },
  } satisfies LeasesState;
}
