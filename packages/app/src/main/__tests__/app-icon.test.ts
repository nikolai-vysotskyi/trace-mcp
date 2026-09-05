// Guards on the app-icon vector masters (TRA-780).
//
// The icon set used to be a bitmap with no source, so every regression in it
// was invisible until someone looked at a dock. These assertions pin the things
// that were actually measured to be broken, so they cannot come back quietly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ICON_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'assets',
  'icon',
);

const masters = {
  detail: fs.readFileSync(path.join(ICON_DIR, 'icon.svg'), 'utf8'),
  small: fs.readFileSync(path.join(ICON_DIR, 'icon-small.svg'), 'utf8'),
};

/** Widest extent of the plate path, to catch a return to the 82% padding. */
function plateExtent(svg: string): { min: number; max: number } {
  const d = svg.match(/<path d="(M [^"]+)" fill="url\(#plate\)"/)?.[1];
  if (!d) throw new Error('no plate path');
  const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].flatMap((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  return { min: Math.min(...coords), max: Math.max(...coords) };
}

describe.each(Object.entries(masters))('app icon master: %s', (name, svg) => {
  it('is a 1024 square', () => {
    expect(svg).toContain('viewBox="0 0 1024 1024"');
  });

  it('carries no <text>, so it does not depend on a font being installed', () => {
    // The shipping icon drew its T with <text font-family="SF Pro Display, ...">,
    // which resolved to whatever the rasteriser happened to find.
    expect(svg).not.toMatch(/<text/);
  });

  it('fills the whole canvas — the plate is not inset', () => {
    const { min, max } = plateExtent(svg);
    expect(min).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThanOrEqual(1023);
  });

  it('still draws the same mark: nine nodes and twelve edges', () => {
    expect(svg.match(/<circle /g)).toHaveLength(9);
    expect(svg.match(/<line /g)).toHaveLength(12);
  });

  it('keeps the edge over the pixel floor measured for its tier', () => {
    // 0.88% of the plate was the shipping weight and it does not survive: 0.23px
    // on a 32px icon. Detail tier >= 1%, small tier >= 3%.
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]) / 1024);
    expect(widths.length).toBeGreaterThan(0);
    const floor = name === 'small' ? 0.03 : 0.01;
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(floor);
  });
});

it('the small master draws heavier than the detail master', () => {
  const weight = (svg: string) => Number(svg.match(/stroke-width="([\d.]+)"/)?.[1]);
  expect(weight(masters.small)).toBeGreaterThan(weight(masters.detail));
});
