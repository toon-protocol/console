import { useCallback, useEffect, useState } from 'react';

import {
  DaemonError,
  daemon,
  type Directory,
  type DirectoryFilters,
  type LivenessState,
  type LivenessView,
} from '@/lib/daemon';

/**
 * Browsing the Provider Directory.
 *
 * A read is free and needs no identity, so this hook runs the moment the view
 * opens and again on every filter change — there is nothing to spend and
 * nobody to sign in as.
 *
 * The second half is the CLOCK. A Liveness is a claim with an expiry on it, so
 * "live" is not a fact the daemon can hand over once; it is a fact about the
 * moment it is read. The ticking `now` below is what makes a provider that has
 * stopped republishing go stale in front of a person who is only looking, with
 * no refetch and no new event.
 */

export interface DirectoryState {
  readonly directory?: Directory;
  readonly filters: DirectoryFilters;
  readonly loading: boolean;
  readonly error?: string;
  /** `Date.now()`, re-read every second, so liveness ages on screen. */
  readonly now: number;
  setFilters(filters: DirectoryFilters): void;
  refresh(): void;
}

export function useDirectory(options: {
  active: boolean;
  profileId?: string;
}): DirectoryState {
  const [directory, setDirectory] = useState<Directory>();
  const [filters, setFilters] = useState<DirectoryFilters>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(options.active);

  const { active, profileId } = options;

  const load = useCallback((wanted: DirectoryFilters) => {
    setLoading(true);
    return daemon
      .directory(wanted)
      .then((next) => {
        setDirectory(next);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof DaemonError || caught instanceof Error
            ? caught.message
            : String(caught)
        );
      })
      .finally(() => setLoading(false));
  }, []);

  // The profile is in the dependencies because a switch changes the network:
  // another relay, other providers, and nothing about the old answer carries.
  useEffect(() => {
    if (!active) return;
    void load(filters);
  }, [active, profileId, filters, load]);

  return {
    ...(directory === undefined ? {} : { directory }),
    filters,
    loading,
    ...(error === undefined ? {} : { error }),
    now,
    setFilters,
    refresh: () => void load(filters),
  };
}

/** `Date.now()` once a second while the directory is on screen, and not otherwise. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Liveness, re-decided in the browser against the clock on the wall.
 *
 * The daemon answered `live` at read time. Whether it is still true a minute
 * later is a question about `expiresAt` and nothing else, and this is the
 * function that keeps asking it (spec §4.3, ADR 0007).
 */
export function livenessNow(
  liveness: LivenessView,
  now: number
): { state: LivenessState; secondsUntilExpiry?: number } {
  if (liveness.expiresAt === undefined) return { state: liveness.state };
  const secondsUntilExpiry = Math.round((Date.parse(liveness.expiresAt) - now) / 1000);
  return { state: secondsUntilExpiry > 0 ? 'live' : 'stale', secondsUntilExpiry };
}
