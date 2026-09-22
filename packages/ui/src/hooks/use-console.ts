import { useCallback, useEffect, useState } from 'react';

import { DaemonError, daemon, type Health, type ProfileView } from '@/lib/daemon';

/**
 * Everything the shell knows, in one place.
 *
 * Health and the profile list are fetched together because they answer one
 * question — "what am I connected to, and is it answering?" — and showing a
 * profile switcher that disagrees with the health card underneath it would be
 * worse than showing neither.
 *
 * A switch re-reads health rather than patching it: the new profile's
 * connector is a different machine with different terms, and nothing about the
 * old answer carries over.
 */

export interface ConsoleState {
  readonly health?: Health;
  readonly profiles: readonly ProfileView[];
  readonly loading: boolean;
  /** Set while a profile switch is in flight, so the switcher can disable. */
  readonly switching?: string;
  readonly error?: string;
  refresh(): void;
  selectProfile(id: string): void;
}

export function useConsole(): ConsoleState {
  const [health, setHealth] = useState<Health>();
  const [profiles, setProfiles] = useState<readonly ProfileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async (options: { refresh?: boolean } = {}) => {
    setLoading(true);
    try {
      const [nextHealth, nextProfiles] = await Promise.all([
        daemon.health(options),
        daemon.profiles(),
      ]);
      setHealth(nextHealth);
      setProfiles(nextProfiles.profiles);
      setError(undefined);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectProfile = useCallback(
    (id: string) => {
      setSwitching(id);
      void (async () => {
        try {
          const next = await daemon.setProfile(id);
          setProfiles(next.profiles);
          // The connector behind the new profile has not been asked anything
          // yet, so force the read rather than showing the old one's cache.
          setHealth(await daemon.health({ refresh: true }));
          setError(undefined);
        } catch (caught) {
          setError(messageOf(caught));
        } finally {
          setSwitching(undefined);
        }
      })();
    },
    []
  );

  return {
    health,
    profiles,
    loading,
    switching,
    error,
    refresh: () => void load({ refresh: true }),
    selectProfile,
  };
}

function messageOf(caught: unknown): string {
  if (caught instanceof DaemonError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return String(caught);
}
