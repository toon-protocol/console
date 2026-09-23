import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DaemonError,
  daemon,
  type GatewayView,
  type HandoverRequestBody,
  type HandoverResult,
  type WithdrawalResult,
} from '@/lib/daemon';

/**
 * One workload's hostname, from the window's side (TOON_Network#97, spec §12).
 *
 * Per card rather than per dashboard, and that is the whole shape of it: a
 * hostname belongs to one workload, a handover names one workload's Standby
 * Set, and a hook that fetched every card's gateway state at once would knock
 * on every hostname a person holds every time one card opened.
 *
 * **Reading is free; knocking is nearly free and still opt-in.** `load` reads
 * what the daemon already knows and sends nothing at all. `check` additionally
 * knocks on the hostname over ordinary HTTPS — no TOON packet, no provider, no
 * relay — and is what makes "the hostname shown matches what the gateway
 * serves" something a person can press rather than something this window
 * asserts. It is not on a timer: a public HTTPS request per card per tick
 * would be this console polling somebody else's workload for them.
 *
 * **Withdrawal is not revocation, and this hook does not let the window
 * pretend otherwise.** The daemon's answer says so in words and the card shows
 * those words; nothing here shortens them to "revoked".
 */

export interface GatewayState {
  readonly view?: GatewayView;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  /** The last handover or withdrawal, so the card can report what happened. */
  readonly lastAction?:
    | { kind: 'handover'; result: HandoverResult }
    | { kind: 'withdraw'; result: WithdrawalResult };
  load(): void;
  /** Knock on the hostname and show what it answered. */
  check(): void;
  handOver(request?: HandoverRequestBody): Promise<HandoverResult | undefined>;
  withdraw(): Promise<WithdrawalResult | undefined>;
  clearError(): void;
  dismissAction(): void;
}

export function useGateway(
  workloadId: string,
  options: { active?: boolean } = {}
): GatewayState {
  const active = options.active !== false;
  const [view, setView] = useState<GatewayView>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [lastAction, setLastAction] = useState<GatewayState['lastAction']>();
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

  const read = useCallback(
    (probe: boolean) => {
      setLoading(true);
      void daemon
        .gateway(workloadId, { probe })
        .then((next) => {
          if (!alive.current) return;
          setView(next);
          setError(undefined);
          setErrorCode(undefined);
        })
        .catch(remember)
        .finally(() => {
          if (alive.current) setLoading(false);
        });
    },
    [workloadId, remember]
  );

  useEffect(() => {
    if (!active) return;
    read(false);
  }, [active, read]);

  /**
   * One action, with its answer kept.
   *
   * Written twice over rather than once with a union argument, because the
   * two answers are different shapes and flattening them here is exactly how
   * a window ends up rendering a withdrawal as if it were a handover.
   */
  const act = useCallback(
    async <T extends { view: GatewayView }>(
      run: () => Promise<T>,
      remembered: (result: T) => GatewayState['lastAction']
    ): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await run();
        if (!alive.current) return result;
        setView(result.view);
        setLastAction(remembered(result));
        setError(undefined);
        setErrorCode(undefined);
        return result;
      } catch (caught) {
        remember(caught);
        return undefined;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [remember]
  );

  return {
    ...(view === undefined ? {} : { view }),
    loading,
    busy,
    ...(error === undefined ? {} : { error }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(lastAction === undefined ? {} : { lastAction }),
    load: () => read(false),
    check: () => read(true),
    handOver: (request?: HandoverRequestBody) =>
      act(
        () => daemon.handOverWorkload(workloadId, request),
        (result) => ({ kind: 'handover', result })
      ),
    withdraw: () =>
      act(
        () => daemon.withdrawWorkload(workloadId),
        (result) => ({ kind: 'withdraw', result })
      ),
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
    },
    dismissAction: () => setLastAction(undefined),
  };
}
