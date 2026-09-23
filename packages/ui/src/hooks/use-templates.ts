import { useCallback, useEffect, useState } from 'react';

import {
  DaemonError,
  daemon,
  type ExpandedTemplate,
  type TemplateGallery,
  type TemplateSettings,
} from '@/lib/daemon';

/**
 * The Template gallery, from the window's side (TOON_Network#94).
 *
 * Reading is free and needs no account, exactly like the Provider Directory,
 * so this runs the moment the view opens. There is no clock in it: a Template
 * is an addressable event with no expiry, so unlike a Liveness it does not go
 * stale while a person looks at it.
 *
 * `expand` is the interesting half, and it is deliberately a ROUND TRIP rather
 * than a local computation. The window has the Template's fixed settings and
 * its tenant-settable names in hand and could assemble a spawn itself — and
 * then the rule about which settings a publisher fixed would live in a
 * browser, where a stale tab still holds last week's copy. So the daemon
 * expands, against the event it re-reads from the relays, and what comes back
 * is what would be sent.
 */

export interface TemplatesState {
  readonly gallery?: TemplateGallery;
  readonly loading: boolean;
  readonly error?: string;
  /** The last expansion, keyed by the Template it is of. */
  readonly expansion?: ExpandedTemplate;
  readonly expanding: boolean;
  readonly expandError?: string;
  refresh(): void;
  expand(template: string, settings: TemplateSettings): Promise<boolean>;
  clearExpansion(): void;
}

export function useTemplates(options: {
  active: boolean;
  profileId?: string;
}): TemplatesState {
  const [gallery, setGallery] = useState<TemplateGallery>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [expansion, setExpansion] = useState<ExpandedTemplate>();
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string>();

  const { active, profileId } = options;

  const load = useCallback(() => {
    setLoading(true);
    return daemon
      .templates()
      .then((next) => {
        setGallery(next);
        setError(undefined);
      })
      .catch((caught: unknown) => setError(message(caught)))
      .finally(() => setLoading(false));
  }, []);

  // The profile is a dependency because a switch is another network: another
  // relay, other publishers, and nothing about the old answer carries.
  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, profileId, load]);

  const expand = useCallback(
    async (template: string, settings: TemplateSettings): Promise<boolean> => {
      setExpanding(true);
      try {
        const next = await daemon.expandTemplate(template, settings);
        setExpansion(next);
        setExpandError(undefined);
        return true;
      } catch (caught: unknown) {
        // The refusal is the answer here, not an accident: "that setting is
        // not yours to set" is the thing a person needs to read.
        setExpansion(undefined);
        setExpandError(message(caught));
        return false;
      } finally {
        setExpanding(false);
      }
    },
    []
  );

  return {
    ...(gallery === undefined ? {} : { gallery }),
    loading,
    ...(error === undefined ? {} : { error }),
    ...(expansion === undefined ? {} : { expansion }),
    expanding,
    ...(expandError === undefined ? {} : { expandError }),
    refresh: () => void load(),
    expand,
    clearExpansion: () => {
      setExpansion(undefined);
      setExpandError(undefined);
    },
  };
}

function message(caught: unknown): string {
  return caught instanceof DaemonError || caught instanceof Error
    ? caught.message
    : String(caught);
}
