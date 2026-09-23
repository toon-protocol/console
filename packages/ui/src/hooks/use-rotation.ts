import { useCallback, useEffect, useRef, useState } from 'react';

import { DaemonError, daemon, type RotationResult, type RotationView } from '@/lib/daemon';

/**
 * One workload's rotation, from the window's side (TOON_Network#96, spec §6.8).
 *
 * Per card, like the gateway's, and for the same reason: a rotation names one
 * workload's Standby Set. It reads on mount — free, and no lease packet — so
 * that a set left part-way through by an earlier run says so the moment the
 * card is opened rather than when somebody presses something.
 *
 * **There is no retry timer here, and there must not be one.** A rotate is not
 * re-sent to find out whether it worked: the same request again is
 * `stale_request`, and a new one presenting the old token after the first took
 * effect is `not_tenant` (ADR 0018). The daemon settles that with a free
 * `status` presenting the new token. What a person presses when a member did
 * not answer is **Finish the rotation**, which resumes from where it stopped
 * and never starts a second one.
 */

export interface RotationState {
  readonly view?: RotationView;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  /** The last rotation this window ran, so the card can report what happened. */
  readonly lastRun?: RotationResult;
  load(): void;
  rotate(): Promise<RotationResult | undefined>;
  clearError(): void;
  dismissRun(): void;
}

export function useRotation(
  workloadId: string,
  options: { active?: boolean } = {}
): RotationState {
  const active = options.active !== false;
  const [view, setView] = useState<RotationView>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [lastRun, setLastRun] = useState<RotationResult>();
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

  const read = useCallback(() => {
    setLoading(true);
    void daemon
      .rotation(workloadId)
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
  }, [workloadId, remember]);

  useEffect(() => {
    if (!active) return;
    read();
  }, [active, read]);

  const rotate = useCallback(async (): Promise<RotationResult | undefined> => {
    setBusy(true);
    try {
      const result = await daemon.rotateWorkload(workloadId);
      if (!alive.current) return result;
      setView(result.view);
      setLastRun(result);
      setError(undefined);
      setErrorCode(undefined);
      return result;
    } catch (caught) {
      remember(caught);
      return undefined;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [workloadId, remember]);

  return {
    ...(view === undefined ? {} : { view }),
    loading,
    busy,
    ...(error === undefined ? {} : { error }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(lastRun === undefined ? {} : { lastRun }),
    load: read,
    rotate,
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
    },
    dismissRun: () => setLastRun(undefined),
  };
}
