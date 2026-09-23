import { useEffect, useRef, useState } from 'react';

import { daemon, type DesktopView, type MenuView } from '@/lib/daemon';

/**
 * **The desktop, from the window's side** (TOON_Network#99, ADR 0019).
 *
 * One long poll, forever, doing two jobs.
 *
 * **It re-themes.** The daemon already put this machine's `:root` rule into
 * the document that carried this script, so the window opened in the right
 * colours. When somebody sets another Omarchy theme, the `theme-set` hook
 * tells the daemon, the poll below returns, and the contents of that same
 * `<style>` are replaced. Nothing re-renders and nothing restarts — a custom
 * property changing repaints the page, which is the whole reason the UI has no
 * colours of its own.
 *
 * **It opens what the menu asked for.** An Omarchy menu entry runs
 * `toon-console --view funds`, which posts the view and then focuses the
 * window. Focusing is all Omarchy can do to a window that is already open, so
 * the view arrives here instead, and `console-app.tsx` switches to it.
 *
 * Two details that matter.
 *
 * `seq` is sent back on every poll, so nothing is missed between two of them:
 * a window whose `seq` is behind is answered at once rather than waiting for
 * the next change. And a failed poll waits before retrying, so a daemon that
 * has gone away (an update, a `systemctl restart`) is not hammered — it is
 * also why this hook never reports an error into the page: a window whose
 * colours are a few seconds stale is not something to interrupt anyone about.
 */

/**
 * The `<style>` the daemon put the theme in. The same literal as
 * `THEME_STYLE_ID` in `packages/daemon/src/theme.ts`, which this package
 * cannot import (ADR 0019: the daemon builds for Node).
 */
export const THEME_STYLE_ID = 'toon-theme';

/** How long to wait before reconnecting after a poll that failed. */
export const RETRY_MS = 5_000;

/**
 * The shortest gap between two polls.
 *
 * The daemon holds a poll open until something changes, so in the ordinary
 * case this never fires. It is there for every case where it does NOT hold:
 * a window whose `seq` is behind is answered at once (which is the point of
 * `seq`), and so is an older daemon that does not know `wait` at all. Without
 * a floor, either of those turns this loop into a spin.
 */
export const MIN_GAP_MS = 250;

export interface DesktopState {
  /** What the daemon last said. Undefined until the first answer. */
  readonly desktop?: DesktopView;
  /** The view the menu asked for, once each. Cleared when it is honoured. */
  readonly open?: MenuView;
  clearOpen(): void;
}

export function useDesktop(options: { retryMs?: number } = {}): DesktopState {
  const [desktop, setDesktop] = useState<DesktopView>();
  const [open, setOpen] = useState<MenuView>();
  const honoured = useRef<string | undefined>(undefined);
  const retryMs = options.retryMs ?? RETRY_MS;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (view: DesktopView) => {
      setDesktop(view);
      applyTheme(view.theme.css);
      // A menu request is honoured once. The daemon keeps answering with it
      // until it ages out, so the window remembers which one it has acted on
      // rather than jumping back to that tab on every poll.
      if (view.open !== undefined && view.openedAt !== honoured.current) {
        honoured.current = view.openedAt;
        setOpen(view.open);
      }
    };

    const pause = (ms: number) =>
      new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      });

    const loop = async () => {
      let since: number | undefined;
      while (alive) {
        const began = Date.now();
        try {
          const view = await daemon.desktop(since === undefined ? {} : { since, wait: true });
          if (!alive) return;
          apply(view);
          since = view.seq;
          await pause(Math.max(0, MIN_GAP_MS - (Date.now() - began)));
        } catch {
          if (!alive) return;
          await pause(retryMs);
        }
      }
    };

    void loop();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [retryMs]);

  return {
    ...(desktop === undefined ? {} : { desktop }),
    ...(open === undefined ? {} : { open }),
    clearOpen: () => setOpen(undefined),
  };
}

/**
 * Put the rule where the daemon put its first one.
 *
 * Replacing the text of the existing `<style>` and not adding another: two
 * rules of the same specificity would leave the page showing whichever was
 * last inserted, which is the sort of thing that works until somebody switches
 * themes twice.
 */
export function applyTheme(css: string): void {
  if (typeof document === 'undefined') return;
  let style = document.getElementById(THEME_STYLE_ID);
  if (style === null) {
    style = document.createElement('style');
    style.id = THEME_STYLE_ID;
    document.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}
