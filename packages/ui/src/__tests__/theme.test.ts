import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyTheme, THEME_STYLE_ID } from '@/hooks/use-desktop';

/**
 * **There is no palette in this app** (TOON_Network#99, ADR 0019).
 *
 * The console's colours come from the current Omarchy theme, so a colour
 * written into a component is a colour that cannot follow it. The scan below
 * is the test that says so, and it is deliberately mechanical: the rule is
 * easy to keep and easy to forget, and the next person to add a card wants to
 * be told at once rather than on somebody's desktop.
 *
 * One exemption, and it is named rather than pattern-matched, so that adding a
 * second is a decision somebody makes on purpose.
 */

const SRC = resolve(import.meta.dirname, '..');

/**
 * A QR code is scanned by a camera, not read by a person. It has to be dark on
 * light whatever the desktop's theme is, or half of the themes make it
 * unreadable by a phone. It is the one place a fixed colour is correct.
 */
const EXEMPT = new Map([['app/funding-view.tsx', ['bg-white']]]);

const COLOUR = /#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(|\boklch\(/u;

const PALETTE_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/u;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sources(path));
    } else if (/\.(tsx?|css)$/u.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('the app carries no colours of its own', () => {
  it.each(sources(SRC).map((path) => relative(SRC, path)))('%s', (name) => {
    const exempt = EXEMPT.get(name) ?? [];
    const offending = readFileSync(join(SRC, name), 'utf8')
      .split('\n')
      // A comment is prose, and every one of these files cites spec sections
      // and issue numbers that look nothing like colours but are worth not
      // having to think about.
      .filter(
        (line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')
      )
      .filter((line) => COLOUR.test(line) || PALETTE_CLASS.test(line))
      .filter((line) => !exempt.some((allowed) => line.includes(allowed)));

    expect(offending).toEqual([]);
  });
});

describe('applyTheme', () => {
  it('replaces the rule the daemon served rather than adding a second one', () => {
    document.head.innerHTML = `<style id="${THEME_STYLE_ID}">:root { --background: #000000; }</style>`;

    applyTheme(':root { --background: #ffffff; }');

    const styles = document.head.querySelectorAll(`#${THEME_STYLE_ID}`);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(':root { --background: #ffffff; }');
  });

  it('makes its own when a page was opened without one', () => {
    document.head.innerHTML = '';

    applyTheme(':root { --background: #123456; }');

    expect(document.getElementById(THEME_STYLE_ID)?.textContent).toContain('#123456');
  });
});
