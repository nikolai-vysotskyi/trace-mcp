import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper, shared with the CLI check (TRA-289)
import { contrast, contrastFailures, contrastTable, tokenGuard } from '../../../../scripts/design-tokens.mjs';

const tokensCss = readFileSync(
  fileURLToPath(new URL('../tokens.css', import.meta.url)),
  'utf8',
);

describe('design tokens', () => {
  it('composites translucent labels before measuring contrast', () => {
    // black at .55 over white — the value the light --label-secondary uses.
    expect(contrast('rgb(0 0 0 / 0.55)', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('rgb(0 0 0 / 0.26)', '#ffffff')).toBeLessThan(2.5);
  });

  it('clears WCAG AA for every readable text token in both appearances', () => {
    expect(contrastFailures(contrastTable(tokensCss))).toEqual([]);
  });

  it('honours reduced motion, reduced transparency and increased contrast', () => {
    expect(tokensCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tokensCss).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(tokensCss).toContain('@media (prefers-contrast: more)');
  });

  it('keeps the JetBrains palette out of the token layer', () => {
    expect(tokensCss).not.toContain('#3574f0');
    expect(tokensCss).not.toContain('Inter');
  });

  it('adds no raw hex or Tailwind grey beyond the recorded baseline', () => {
    const { violations } = tokenGuard();
    expect(violations).toEqual([]);
  });
});
