/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiTile } from '../components/KpiTile';

describe('KpiTile (TRA-492)', () => {
  it('clamps the label to 1 line (13px) with truncation to preserve TILE_H', () => {
    const { container } = render(
      <KpiTile
        label="Benötigt Aufmerksamkeit"
        value={42}
        tone="warn"
        footnote="36% of 116 projects"
      />,
    );

    const labelContainer = container.querySelector('span.inline-flex');
    expect(labelContainer).not.toBeNull();
    expect(labelContainer?.getAttribute('style')).toContain('height: 13px');
    expect(labelContainer?.getAttribute('style')).toContain('min-height: 13px');
    expect(labelContainer?.getAttribute('style')).toContain('max-height: 13px');
    expect(labelContainer?.className).toContain('max-w-full');

    const labelText = labelContainer?.querySelector('.truncate');
    expect(labelText).not.toBeNull();
    expect(labelText?.textContent).toBe('Benötigt Aufmerksamkeit');
  });

  it('clamps the comparison slot to 2 lines (26px) with -webkit-line-clamp to preserve TILE_H', () => {
    const { container } = render(
      <KpiTile
        label="Files"
        value={105600}
        delta={105600}
        deltaCaption="vs 9 minutes ago"
      />,
    );

    const comparison = container.querySelector('span.line-clamp-2');
    expect(comparison).not.toBeNull();
    const style = comparison?.getAttribute('style') ?? '';
    expect(style).toContain('height: 26px');
    expect(style).toContain('min-height: 26px');
    expect(style).toContain('max-height: 26px');
    expect(style).toContain('overflow: hidden');
    expect(comparison?.className).toContain('line-clamp-2');
  });

  it('keeps the delta value on one line and lets the caption break (TRA-803)', () => {
    const { container } = render(
      <KpiTile label="Symbols" value={166_100} delta={22_300} deltaCaption="2 시간 전 대비" />,
    );

    // The number is one token: a break-word caption beside it split "+22.3k"
    // into "+22.3" and "k", which reads as a different number.
    const value = container.querySelector('.whitespace-nowrap');
    expect(value?.textContent).toBe('+22.3k');

    // The caption's wrapping is a class, not an inline style, so
    // `:lang(ko) .wrap-label { word-break: keep-all }` can win over it.
    const comparison = container.querySelector('span.line-clamp-2');
    expect(comparison?.className).toContain('wrap-label');
    expect(comparison?.getAttribute('style') ?? '').not.toContain('word-break');
  });

  it('reserves 26px even when footnote or delta is absent', () => {
    const { container } = render(
      <KpiTile
        label="Projects"
        value={10}
      />,
    );

    const comparison = container.querySelector('span.line-clamp-2');
    expect(comparison).not.toBeNull();
    const style = comparison?.getAttribute('style') ?? '';
    expect(style).toContain('height: 26px');
  });

  it('omits comparison slot in dense mode', () => {
    const { container } = render(
      <KpiTile
        label="Projects"
        value={10}
        dense
        footnote="footnote text"
      />,
    );

    const comparison = container.querySelector('span.line-clamp-2');
    expect(comparison).toBeNull();
  });
});
