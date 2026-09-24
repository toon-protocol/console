/**
 * The themes, as Omarchy names them.
 *
 * Omarchy ships a theme as `themes/<name>/colors.toml` — a background, a
 * selection, a muted line, four foregrounds and the sixteen terminal colours —
 * and re-dresses the whole desktop from it. The console follows the desktop
 * (ADR 0019). This site cannot read the desktop, so it offers the same
 * wardrobe and remembers which one was chosen.
 *
 * The palettes live in `site.css`, one `[data-theme='<id>']` block each, taken
 * from those files. Nothing here repeats a colour: a swatch is drawn by
 * putting the id on a `<span>` and letting the same block paint it, so a theme
 * can never be listed here in colours it does not have.
 */

export interface Theme {
  /** The directory name in Omarchy's `themes/`. */
  readonly id: string;
  readonly label: string;
}

export const THEMES: readonly Theme[] = [
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'catppuccin', label: 'Catppuccin' },
  { id: 'kanagawa', label: 'Kanagawa' },
  { id: 'everforest', label: 'Everforest' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'nord', label: 'Nord' },
  { id: 'osaka-jade', label: 'Osaka Jade' },
  { id: 'ristretto', label: 'Ristretto' },
  { id: 'matte-black', label: 'Matte Black' },
  { id: 'rose-pine', label: 'Rosé Pine Dawn' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte' },
];

export const STORAGE_KEY = 'toon-site-theme';

/** The id in storage, or `undefined` for "whatever the browser asks for". */
export function storedTheme(): string | undefined {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return THEMES.some((theme) => theme.id === saved) ? (saved ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** Puts a theme on the document, or takes the choice off it again. */
export function applyTheme(id: string | undefined): void {
  const root = document.documentElement;
  if (id === undefined) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  try {
    if (id === undefined) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // A browser that refuses storage still gets the theme, just not next time.
  }
}
