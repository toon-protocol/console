import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DaemonError,
  daemon,
  type Dashboard,
  type ExtendResult,
  type TerminateResult,
  type WorkloadCard,
} from '@/lib/daemon';

/**
 * The dashboard, from the window's side (TOON_Network#93).
 *
 * The same shape as the other hooks, with the same distinction `use-leases`
 * draws and one more.
 *
 * **Reading and spending are different functions.** `refresh` asks every
 * provider what its lease is doing, which is free at the provider (§5) and
 * happens on a timer. `extend` spends an interval, and happens only when
 * somebody presses something. A hook that put the paid one on the timer would
 * be a hook that bought a lease a minute.
 *
 * **The poll is slow on purpose.** Free at the provider does not mean free of
 * packets, and a card that refreshed every second would send one per lease per
 * second for a figure that moves in hours. Thirty seconds is fast enough that
 * a runway moves while a person watches it, and slow enough to be polite.
 *
 * **Busy is per workload.** One card extending must not grey out the rest: a
 * person with six workloads acts on them one at a time, and a single global
 * flag would make the page feel like it had locked up.
 */

export interface WorkloadsState {
  readonly dashboard?: Dashboard;
  readonly loading: boolean;
  /** Which workload ids have something in flight right now. */
  readonly busy: readonly string[];
  readonly error?: string;
  readonly errorCode?: string;
  /** The last extension or termination, so the page can report what it cost. */
  readonly lastAction?:
    { kind: 'extend'; result: ExtendResult } | { kind: 'terminate'; result: TerminateResult };
  reload(options?: { refresh?: boolean }): void;
  refresh(): void;
  extend(workloadId: string, maxPrice?: string): Promise<ExtendResult | undefined>;
  terminate(workloadId: string): Promise<TerminateResult | undefined>;
  arm(
    workloadId: string,
    request: { budget: string; agreedPrice: string; leadSeconds?: number }
  ): Promise<boolean>;
  disarm(workloadId: string): Promise<void>;
  clearError(): void;
  dismissAction(): void;
}

/** How often the cards ask their providers. See the note above. */
export const POLL_MS = 30_000;

export function useWorkloads(
  options: { active?: boolean; pubkey?: string | undefined; pollMs?: number } = {}
): WorkloadsState {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [lastAction, setLastAction] = useState<WorkloadsState['lastAction']>();
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
  }, []);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      void daemon
        .workloads({ refresh })
        .then((next) => {
          if (!alive.current) return;
          setDashboard(next);
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

  const active = options.active !== false;
  useEffect(() => {
    if (!active) return;
    load(true);
  }, [active, load, options.pubkey]);

  // The poll. Only while this tab is the one being looked at: a background tab
  // asking six providers every thirty seconds forever is not politeness.
  useEffect(() => {
    if (!active) return;
    const every = options.pollMs ?? POLL_MS;
    const timer = setInterval(() => load(true), every);
    return () => clearInterval(timer);
  }, [active, load, options.pollMs]);

  /** Put one card's answer back without disturbing the others. */
  const replace = useCallback((card: WorkloadCard) => {
    setDashboard((held) =>
      held === undefined
        ? held
        : {
            ...held,
            cards: held.cards.map((candidate) =>
              candidate.workloadId === card.workloadId ? card : candidate
            ),
          }
    );
  }, []);

  const withBusy = useCallback(
    async <T>(workloadId: string, run: () => Promise<T>): Promise<T | undefined> => {
      setBusy((held) => [...held, workloadId]);
      setError(undefined);
      setErrorCode(undefined);
      try {
        return await run();
      } catch (caught) {
        remember(caught);
        return undefined;
      } finally {
        if (alive.current) {
          setBusy((held) => held.filter((id) => id !== workloadId));
        }
      }
    },
    [remember]
  );

  const extend = useCallback(
    (workloadId: string, maxPrice?: string) =>
      withBusy(workloadId, async () => {
        const result = await daemon.extendWorkload(
          workloadId,
          maxPrice === undefined ? {} : { maxPrice }
        );
        if (alive.current) {
          replace(result.card);
          setLastAction({ kind: 'extend', result });
        }
        return result;
      }),
    [replace, withBusy]
  );

  const terminate = useCallback(
    (workloadId: string) =>
      withBusy(workloadId, async () => {
        const result = await daemon.terminateWorkload(workloadId);
        if (alive.current) {
          replace(result.card);
          setLastAction({ kind: 'terminate', result });
        }
        return result;
      }),
    [replace, withBusy]
  );

  const arm = useCallback(
    async (
      workloadId: string,
      request: { budget: string; agreedPrice: string; leadSeconds?: number }
    ) => {
      const card = await withBusy(workloadId, () => daemon.armAutoExtend(workloadId, request));
      if (card !== undefined && alive.current) replace(card);
      return card !== undefined;
    },
    [replace, withBusy]
  );

  const disarm = useCallback(
    async (workloadId: string) => {
      const card = await withBusy(workloadId, () => daemon.disarmAutoExtend(workloadId));
      if (card !== undefined && alive.current) replace(card);
    },
    [replace, withBusy]
  );

  return {
    dashboard,
    loading,
    busy,
    error,
    errorCode,
    lastAction,
    reload: (asked = {}) => load(asked.refresh === true),
    refresh: () => load(true),
    extend,
    terminate,
    arm,
    disarm,
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
    },
    dismissAction: () => setLastAction(undefined),
  } satisfies WorkloadsState;
}
