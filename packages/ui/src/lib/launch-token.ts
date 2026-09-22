/**
 * How the window gets its token.
 *
 * The daemon hands the token over exactly once, as `?t=…` on the URL the
 * launcher opens. The page takes it out of the address bar immediately —
 * `history.replaceState`, before anything can read `document.location` and
 * before it can be copied, bookmarked or shoulder-surfed — and keeps it in
 * `sessionStorage`, which dies with the tab and is not shared with another
 * origin or another window.
 *
 * `sessionStorage` rather than a module variable because a reload inside the
 * window (F5, or the daemon rebuilding the UI in development) must not lose
 * it: there is no second copy of the URL to go back to.
 */

const STORAGE_KEY = 'toon-console.launch-token';
const QUERY_KEY = 't';

/**
 * The copy this document holds. It is what makes a window with storage
 * disabled still work, and it is never the only copy when storage does work.
 */
let held: string | undefined;

export function adoptLaunchToken(location: Location, history: History): string | undefined {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get(QUERY_KEY);
  if (fromUrl) {
    store(fromUrl);
    url.searchParams.delete(QUERY_KEY);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  return read();
}

export function launchToken(): string | undefined {
  return read();
}

function store(token: string): void {
  held = token;
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // A window with storage disabled still works for as long as it is open;
    // only a reload would lose the token, and that is better than refusing.
  }
}

function read(): string | undefined {
  if (held) return held;
  try {
    held = sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    held = undefined;
  }
  return held;
}

/** Test seam: forget what this document holds. */
export function forgetLaunchToken(): void {
  held = undefined;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}
