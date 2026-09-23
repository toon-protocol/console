/*
 * The TOON Console's colours, from the current Omarchy theme.
 *
 * Installed as ~/.config/omarchy/themed/toon-console.css.tpl. Omarchy renders
 * it against the theme's colors.toml every time a theme is set, and the result
 * lands in ~/.local/state/omarchy/current/theme/toon-console.css, which the
 * console's daemon reads (packages/daemon/src/theme.ts) and hands to the
 * window. See ~/.config/omarchy/themed/alacritty.toml.tpl.sample for the
 * variables and the modifiers.
 *
 * Two rules were followed here.
 *
 * Surfaces are MIXES and never named shades. `{{ mix background foreground
 * 6% }}` is six per cent of the way from the page towards its text, which is a
 * slightly raised card on a dark theme and a slightly recessed one on a light
 * theme. `lighter_background` would have been one of those and the wrong one on
 * the other, and half of Omarchy's themes are light.
 *
 * The percentages lean towards the foreground a little more than a dark theme
 * needs, because a light theme compresses the whole scale into a narrower range
 * and a card that is plainly a card on one becomes invisible on the other.
 * `--muted-foreground` at 65% is firmer than most themes' own dim text
 * (`dark_foreground` sits nearer 45%), because a label in a console is read
 * rather than glanced at.
 *
 * Meaning comes from the theme's own semantic colours. A destructive button is
 * the theme's red and a warning is its yellow, so a person who chose a theme
 * because they can read it can read this console too.
 *
 * `--mode` is the theme's own `dark` or `light`. The daemon turns it into
 * `color-scheme`, which is what makes scrollbars and form controls match.
 *
 * Every property here must be in THEME_VARIABLES in packages/daemon/src/theme.ts;
 * anything else is dropped on the way to the window, deliberately.
 */

:root {
  --mode: {{ mode }};

  --background: {{ background }};
  --foreground: {{ foreground }};

  --card: {{ mix background foreground 6% }};
  --card-foreground: {{ foreground }};

  --muted: {{ mix background foreground 10% }};
  --muted-foreground: {{ mix background foreground 65% }};

  --accent: {{ mix background accent 22% }};
  --accent-foreground: {{ bright_foreground }};

  --primary: {{ accent }};
  --primary-foreground: {{ background }};

  --secondary: {{ mix background foreground 16% }};
  --secondary-foreground: {{ foreground }};

  --destructive: {{ red }};
  --destructive-foreground: {{ background }};

  --success: {{ green }};
  --success-foreground: {{ background }};

  --warning: {{ yellow }};
  --warning-foreground: {{ background }};

  --border: {{ mix background foreground 24% }};
  --input: {{ mix background foreground 32% }};
  --ring: {{ accent }};
}
