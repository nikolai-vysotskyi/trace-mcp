/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceHeader, activeFilterCount } from '../WorkspaceHeader';
import { EMPTY_FILTER, type WorkspaceFilter, type WorkspaceKpis } from '../types';

const ZERO_KPIS: WorkspaceKpis = {
  totalProjects: 78,
  totalFiles: 0,
  totalSymbols: 0,
  healthy: 0,
  needsAttention: 0,
  indexing: 0,
};

let strip: HTMLElement;

function renderHeader(metricsLoading: boolean) {
  const { container } = render(
    <WorkspaceHeader
      kpis={ZERO_KPIS}
      metricsLoading={metricsLoading}
      filter={EMPTY_FILTER}
      onFilterChange={() => {}}
      view="table"
      onViewChange={() => {}}
      onRefresh={() => {}}
      refreshing={false}
    />,
  );
  strip = container;
}

/** The KPI tile whose label is `label`. */
function kpiTile(label: string): HTMLElement {
  const tile = strip.querySelector<HTMLElement>(`[data-kpi="${label}"]`);
  if (!tile) throw new Error(`no KPI tile for ${label}`);
  return tile;
}

/** Text of the number line of that tile ('' while it is a skeleton). */
function kpiValue(label: string): string {
  return kpiTile(label).querySelector('[data-kpi-value]')?.textContent ?? '';
}

describe('WorkspaceHeader KPI strip', () => {
  beforeEach(() => localStorage.clear());

  it('does not report metric zeros as facts while metrics are loading', () => {
    renderHeader(true);
    for (const label of ['Files', 'Symbols', 'Healthy', 'Needs attention']) {
      expect(kpiValue(label)).not.toMatch(/\d/);
      // A skeleton at the final geometry, not the word "Loading" and not a "—"
      // that reads the same as "none".
      expect(kpiTile(label).querySelector('.ws-skel')).not.toBeNull();
    }
    // Projects and Indexing come from the daemon, not the dashboard cache.
    expect(kpiValue('Projects')).toBe('78');
    expect(kpiValue('Indexing')).toBe('0');
  });

  it('shows the real numbers once metrics land', () => {
    renderHeader(false);
    expect(kpiValue('Files')).toBe('0');
    expect(kpiValue('Healthy')).toBe('0');
  });

  it('colors accented KPI numbers with design tokens, not hardcoded hex', () => {
    renderHeader(false);
    expect(kpiTile('Healthy').querySelector('[data-kpi-value]')!.getAttribute('style')).toContain(
      'var(--success)',
    );
    expect(
      kpiTile('Needs attention').querySelector('[data-kpi-value]')!.getAttribute('style'),
    ).toContain('var(--warning)');
  });

  it('gives every tile a comparison, never a bare number', () => {
    renderHeader(false);
    for (const label of ['Projects', 'Files', 'Symbols', 'Healthy', 'Needs attention', 'Indexing']) {
      // label + value + comparison — three lines, none of them empty.
      const lines = [...kpiTile(label).children].map((c) => c.textContent?.trim() ?? '');
      expect(lines).toHaveLength(3);
      expect(lines[2]).not.toBe('');
    }
  });
});

describe('activeFilterCount', () => {
  it('counts every facet narrowing the list', () => {
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
    const f: WorkspaceFilter = {
      ...EMPTY_FILTER,
      statuses: ['ok', 'error'],
      grades: ['F'],
      hasSecurityFindings: true,
      preset: 'healthy',
    };
    expect(activeFilterCount(f)).toBe(5);
  });

  it('ignores the free-text query — that is the search field, not a chip', () => {
    expect(activeFilterCount({ ...EMPTY_FILTER, query: 'alpha' })).toBe(0);
  });
});
