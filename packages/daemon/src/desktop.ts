import { readTheme, type ThemeReading } from './theme.js';

/**
 * **What the desktop asks of an open window** (TOON_Network#99, ADR 0019).
 *
 * Two things reach the console from outside the browser, and both arrive at
 * the daemon rather than at the page, because the page has no way to hear
 * them:
 *
 * - **the theme changed.** Omarchy runs `hooks/theme-set.d/` after it has
 *   swapped the new theme in, and this console's hook there calls
 *   `toon-console --theme-changed`, which is one authenticated POST. The
 *   window is already waiting on `GET /api/desktop`, so it re-themes in the
 *   time that round trip takes and nothing restarts.
 * - **a menu entry was chosen.** `omarchy-menu.jsonc` runs
 *   `toon-console --view funds`, which posts the view and then hands the
 *   window to `omarchy-launch-or-focus-webapp`. Focusing an open window is all
 *   Omarchy can do, so what makes the entry open the right VIEW is that the
 *   window is told separately.
 *
 * Both are one mechanism: a small piece of state with a sequence number, and a
 * long poll that returns the moment it moves.
 *
 * **Why a long poll and not an EventSource.** Every route here is behind the
 * per-launch token and the token travels in an `Authorization` header;
 * `EventSource` cannot set one, and putting the token in a query string would
 * put it in a URL that gets logged and remembered. A `fetch` that the daemon
 * holds open until something happens costs one idle socket and needs no
 * exception to the rule.
 *
 * **Why the theme is also polled while somebody waits.** The hook makes a
 * change instant, but the hook is a file in the user's configuration that may
 * not be installed — after a manual `git pull`, say, or on a machine where
 * somebody removed it. So a waiter re-reads the rendered file every second as
 * well. It is a sub-kilobyte read, it happens only while a window is actually
 * open and waiting, and it means the worst case of a missing hook is a second
 * rather than nothing at all.
 */

/** A view the Omarchy menu can ask for. The UI maps these onto its tabs. */
export const MENU_VIEWS = ['workloads', 'new-workload', 'funds'] as const;

export type MenuView = (typeof MENU_VIEWS)[number];

export function isMenuView(value: unknown): value is MenuView {
  return typeof value === 'string' && (MENU_VIEWS as readonly string[]).includes(value);
}

/**
 * How long a menu request stays worth honouring.
 *
 * It exists to survive the gap between the menu running the launcher and a
 * cold-started window asking its first question, which is however long a
 * browser takes to start. It must NOT survive long enough for a window opened
 * an hour later to jump to whatever was last chosen, so it expires.
 */
export const VIEW_REQUEST_TTL_MS = 60_000;

/** How often a waiting window's poll re-reads the rendered theme file. */
const THEME_RECHECK_MS = 1_000;

export interface DesktopView {
  /** Moves whenever anything here changes. A window sends back the last one. */
  readonly seq: number;
  readonly theme: ThemeReading;
  /** The view the menu asked for, while the request is still fresh. */
  readonly open?: MenuView | undefined;
  readonly openedAt?: string | undefined;
  readonly at: string;
}

export interface DesktopStateOptions {
  /** Swapped in tests. The default reads this machine's Omarchy theme. */
  readonly read?: (() => ThemeReading) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly recheckMs?: number | undefined;
}

export class DesktopState {
  readonly #read: () => ThemeReading;
  readonly #now: () => Date;
  readonly #recheckMs: number;
  readonly #waiting = new Set<() => void>();

  #theme: ThemeReading;
  #seq = 1;
  #open?: MenuView;
  #openedAt?: Date;
  #changedAt: Date;

  constructor(options: DesktopStateOptions = {}) {
    this.#read = options.read ?? (() => readTheme());
    this.#now = options.now ?? (() => new Date());
    this.#recheckMs = options.recheckMs ?? THEME_RECHECK_MS;
    this.#theme = this.#read();
    this.#changedAt = this.#now();
  }

  /** What an open window should be showing now. */
  current(): DesktopView {
    const open = this.#freshRequest();
    return {
      seq: this.#seq,
      theme: this.#theme,
      ...(open === undefined ? {} : { open, openedAt: this.#openedAt?.toISOString() }),
      at: this.#changedAt.toISOString(),
    };
  }

  /**
   * Re-read the rendered theme. Called by the `theme-set` hook, and by a
   * waiting poll on its own timer.
   *
   * The revision is what decides whether anything moved, so a hook that fires
   * on a theme whose colours happen to be identical wakes nobody.
   */
  refreshTheme(): DesktopView {
    const next = this.#read();
    if (next.revision !== this.#theme.revision) {
      this.#theme = next;
      this.#bump();
    }
    return this.current();
  }

  /** The Omarchy menu asked for a view. */
  requestView(view: MenuView): DesktopView {
    this.#open = view;
    this.#openedAt = this.#now();
    this.#bump();
    return this.current();
  }

  /**
   * Wait until something changes, or until `timeoutMs` has passed.
   *
   * `since` is the `seq` the window last saw. A window that is behind is
   * answered at once — which is what makes this safe to reconnect: nothing
   * that happened between two polls is lost.
   */
  async wait(since: number | undefined, timeoutMs: number): Promise<DesktopView> {
    if (since === undefined || since !== this.#seq) return this.current();

    return new Promise<DesktopView>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.#waiting.delete(wake);
        clearInterval(recheck);
        clearTimeout(deadline);
        resolve(this.current());
      };
      const wake = () => finish();
      // A hook that is installed wakes this immediately; the timer is what
      // covers a machine where it is not.
      const recheck = setInterval(() => {
        const next = this.#read();
        if (next.revision !== this.#theme.revision) {
          this.#theme = next;
          this.#bump();
        }
      }, this.#recheckMs);
      const deadline = setTimeout(finish, timeoutMs);
      // Neither timer may hold the process open: a daemon asked to stop stops,
      // and a poll that dies with it is a poll the window simply reopens.
      recheck.unref?.();
      deadline.unref?.();
      this.#waiting.add(wake);
    });
  }

  #freshRequest(): MenuView | undefined {
    if (this.#open === undefined || this.#openedAt === undefined) return undefined;
    const age = this.#now().getTime() - this.#openedAt.getTime();
    return age <= VIEW_REQUEST_TTL_MS ? this.#open : undefined;
  }

  #bump(): void {
    this.#seq += 1;
    this.#changedAt = this.#now();
    for (const wake of [...this.#waiting]) wake();
  }
}
