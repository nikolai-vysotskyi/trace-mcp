/**
 * @vitest-environment jsdom
 */
import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { EMPTY_FILTER, type WorkspaceKpis } from '../types';

const ZERO_KPIS: WorkspaceKpis = {
  totalProjects: 78,
  totalFiles: 0,
  totalSymbols: 0,
  healthy: 0,
  needsAttention: 0,
  indexing: 0,
};

/** The KPI strip only — "Indexing" is also a filter chip in the toolbar row. */
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
  strip = container.querySelector<HTMLElement>('.items-stretch')!;
}

/** The KPI tile whose label is `label`. */
function kpiTile(label: string): HTMLElement {
  const tile = within(strip).getByText(label).closest('button');
  if (!tile) throw new Error(`no KPI tile for ${label}`);
  return tile;
}

/** Text of the number line of that tile. */
function kpiValue(label: string): string {
  return kpiTile(label).querySelector('span')?.textContent ?? '';
}

describe('WorkspaceHeader KPI strip', () => {
  it('does not report metric zeros as facts while metrics are loading', () => {
    renderHeader(true);
    for (const label of ['Files', 'Symbols', 'Healthy', 'Needs attention']) {
      expect(kpiValue(label)).not.toMatch(/\d/);
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
    expect(kpiTile('Healthy').querySelector('span')!.getAttribute('style')).toContain(
      'var(--success)',
    );
    expect(kpiTile('Needs attention').querySelector('span')!.getAttribute('style')).toContain(
      'var(--warning)',
    );
  });
});
