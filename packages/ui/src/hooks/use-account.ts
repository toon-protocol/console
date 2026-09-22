import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DaemonError,
  daemon,
  type LocalSignerRequest,
  type SessionStatus,
} from '@/lib/daemon';

/**
 * Who is signed in, from the window's side.
 *
 * Every action is the same shape — post something, get the whole session state
 * back — so there is one `run` and no per-action state. The daemon is the only
 * copy of the truth here: it holds the signer, and a window that kept its own
 * idea of "signed in" would be wrong the moment another window signed out.
 *
 * Two things are polled, and only while they are outstanding:
 *
 * - a `nostrconnect://` invitation, which is accepted by a phone and not by
 *   this window, so nothing here is told when it happens;
 * - the account's kind-0, which the daemon reads off relays in the background
 *   rather than making a sign-in wait on one.
 *
 * Nothing is polled otherwise. A console that fetched every second would keep
 * a laptop awake for a screen that changes when a person clicks it.
 */

const POLL_MS = 1_500;

export interface AccountState {
  readonly status?: SessionStatus;
  readonly loading: boolean;
  /** Set while an action is in flight, so the forms can disable. */
  readonly busy: boolean;
  readonly error?: string;
  /** The daemon's code for the last failure, e.g. `passphrase_required`. */
  readonly errorCode?: string;
  reload(): void;
  clearError(): void;
  addLocalSigner(request: LocalSignerRequest): Promise<boolean>;
  addBunkerSigner(request: {
    uri: string;
    label?: string;
    passphrase?: string;
  }): Promise<boolean>;
  invite(request?: { label?: string; passphrase?: string }): Promise<boolean>;
  cancelInvite(): Promise<boolean>;
  signIn(request: { id: string; passphrase?: string }): Promise<boolean>;
  signOut(): Promise<boolean>;
  forgetSigner(id: string): Promise<boolean>;
}

export function useAccount(): AccountState {
  const [status, setStatus] = useState<SessionStatus>();
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

  const run = useCallback(async (work: () => Promise<SessionStatus>): Promise<boolean> => {
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
      setError(messageOf(caught));
      setErrorCode(caught instanceof DaemonError ? caught.code : 'error');
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    void run(() => daemon.account()).finally(() => {
      if (alive.current) setLoading(false);
    });
  }, [run]);

  useEffect(() => reload(), [reload]);

  const waiting = status?.invitation?.state === 'waiting';
  const readingProfile = status?.account?.profileState === 'loading';

  useEffect(() => {
    if (!waiting && !readingProfile) return;
    const timer = setInterval(() => {
      daemon
        .account()
        .then((next) => {
          if (alive.current) setStatus(next);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, readingProfile]);

  return {
    status,
    loading,
    busy,
    error,
    errorCode,
    reload,
    clearError: () => {
      setError(undefined);
      setErrorCode(undefined);
    },
    addLocalSigner: (request) => run(() => daemon.addLocalSigner(request)),
    addBunkerSigner: (request) => run(() => daemon.addBunkerSigner(request)),
    invite: (request = {}) => run(() => daemon.invite(request)),
    cancelInvite: () => run(() => daemon.cancelInvite()),
    signIn: (request) => run(() => daemon.signIn(request)),
    signOut: () => run(() => daemon.signOut()),
    forgetSigner: (id) => run(() => daemon.forgetSigner(id)),
  };
}

function messageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  return String(caught);
}
