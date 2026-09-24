import { useCallback, useEffect, useRef, useState } from 'react';

import { applyTheme, storedTheme, THEMES } from '@/lib/themes';

/**
 * Change the theme (TOON_Network#102).
 *
 * Omarchy's own site puts this in the nav bar and binds it to `T`, because
 * inside Omarchy the theme is a keystroke away and a page that says so should
 * behave that way. The same two affordances are here: the button, and `T`
 * anywhere that is not a text field, which steps to the next theme.
 *
 * A theme is remembered; no choice means the browser's own preference decides
 * between the dark default and the light one, which is what `site.css` does
 * with `prefers-color-scheme` when no `data-theme` is set.
 */
export function ThemePicker() {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setCurrent(storedTheme()), []);

  const choose = useCallback((id: string | undefined) => {
    applyTheme(id);
    setCurrent(id);
  }, []);

  // `T` steps through the list, starting from the one on screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return setOpen(false);
      if (event.key !== 't' && event.key !== 'T') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      const at = THEMES.findIndex((theme) => theme.id === current);
      choose(THEMES[(at + 1) % THEMES.length]?.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, choose]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="themes" ref={box}>
      <button
        type="button"
        className="theme-button"
        aria-expanded={open}
        aria-haspopup="true"
        title="Change the theme — or press T"
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <rect x="0" y="0" width="7" height="7" fill="var(--signal-fill)" />
          <rect x="9" y="0" width="7" height="7" fill="var(--live)" />
          <rect x="0" y="9" width="7" height="7" fill="currentColor" opacity="0.55" />
          <rect x="9" y="9" width="7" height="7" fill="currentColor" opacity="0.25" />
        </svg>
        <span className="visually-hidden">Change the theme</span>
      </button>

      {open && (
        <div className="theme-menu" role="menu" aria-label="Themes">
          <p className="theme-note">Omarchy&rsquo;s themes. Press T to step through them.</p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={current === undefined}
            onClick={() => choose(undefined)}
          >
            <span className="swatch system" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Match the browser
          </button>
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="menuitemradio"
              aria-checked={current === theme.id}
              onClick={() => choose(theme.id)}
            >
              <span className="swatch" data-theme={theme.id} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {theme.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
