/* TRA-363. An icon NAMES the action (DESIGN.md §5). Two glyphs were rejected by
   name and this is the guard that keeps them out — a comment in icons.tsx did
   not stop the first one, because the pressure to reach for sparkles comes from
   whoever is adding the next "exciting" item, not from whoever reads the set.

   `auto_awesome` (sparkles) decorates rather than names: it says "exciting"
   instead of saying what the item does, and on a developer tool it reads as AI
   marketing. `forum` (speech bubbles) promises a conversation with a person,
   which nothing in this app provides — Get help opens GitHub issues, Ask
   queries the indexed graph.

   The scan is over source TEXT, not over the glyph map, because re-adding a
   banned body under a new key is the same regression wearing a hat. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLOBAL_ACTIONS } from '../../../shared/global-actions.js';

const SRC = fileURLToPath(new URL('../../..', import.meta.url));
const ICONS = readFileSync(fileURLToPath(new URL('../icons.tsx', import.meta.url)), 'utf8');

/** Every .ts/.tsx under src/, minus this file and the generated icon blobs. */
function sources(dir: string, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) {
      sources(path, out);
    } else if (/\.tsx?$/.test(entry) && entry !== 'icons.test.ts' && !entry.includes('generated')) {
      out.push([path.slice(SRC.length), readFileSync(path, 'utf8')]);
    }
  }
  return out;
}

/** The glyph keys icons.tsx actually defines. */
function glyphNames(): string[] {
  const body = ICONS.slice(ICONS.indexOf('const GLYPHS'), ICONS.indexOf('function Icon'));
  return [...body.matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)].map((m) => m[1]);
}

describe('icon set', () => {
  it('carries no sparkles and no speech bubbles, anywhere', () => {
    const offenders = sources(SRC)
      .filter(([, text]) => /\bauto_awesome\b|\bforum\b/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('does not define either rejected glyph under any key', () => {
    const names = glyphNames();
    expect(names).not.toContain('auto_awesome');
    expect(names).not.toContain('forum');
    // The replacements the reference asked for, present and spelled as used.
    expect(names).toContain('help');
    expect(names).toContain('description');
  });

  /* A global action's `icon` is a string looked up at render time, so a name
     that does not exist draws nothing at all — silently, and only in the app
     menu, which is the surface least likely to be open while you work. */
  it('gives every global action a glyph that exists', () => {
    const names = glyphNames();
    for (const action of GLOBAL_ACTIONS) {
      expect(names, `${action.id} → ${action.icon}`).toContain(action.icon);
    }
  });
});
