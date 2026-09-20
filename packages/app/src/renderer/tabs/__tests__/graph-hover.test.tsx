// @vitest-environment jsdom
import React, { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GraphHover } from '../GraphHover';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('measures the tooltip and avoids the legend inside the graph pane', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(340);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90);
  const pane = document.createElement('div');
  pane.getBoundingClientRect = () =>
    ({ left: 250, top: 90, right: 1000, bottom: 700, width: 750, height: 610 }) as DOMRect;
  const legend = document.createElement('div');
  legend.className = 'cosmos-gpu-legend';
  legend.getBoundingClientRect = () =>
    ({ left: 262, top: 540, right: 490, bottom: 688 }) as DOMRect;
  pane.append(legend);
  const boundsRef = createRef<HTMLElement>();
  boundsRef.current = pane;
  render(
    <GraphHover boundsRef={boundsRef} anchor={{ x: 270, y: 675 }}>
      ForexController.php
    </GraphHover>,
  );
  const tooltip = screen.getByRole('tooltip');
  const top = Number.parseFloat(tooltip.style.top) + 90;
  const left = Number.parseFloat(tooltip.style.left) + 250;
  expect(top + 90 <= 540 || left >= 490).toBe(true);
  expect(left + 340).toBeLessThanOrEqual(992);
  expect(tooltip.textContent).toContain('ForexController.php');
});

it('puts the measured hover above the legend without intercepting pointer events', () => {
  const css = readFileSync('src/renderer/tabs/graph-exploration.css', 'utf8');
  const rule = css.match(/\.graph-hover\s*\{([^}]+)\}/)![1];
  expect(rule).toMatch(/pointer-events:\s*none/);
  expect(Number(rule.match(/z-index:\s*(\d+)/)![1])).toBeGreaterThan(30);
});
