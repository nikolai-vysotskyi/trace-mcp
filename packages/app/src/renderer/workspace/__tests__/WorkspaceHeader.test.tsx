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

function renderHeader(
  metricsLoading: boolean,
  extra: Partial<{
    listLoading: boolean;
    metricsFailed: boolean;
    listFailed: boolean;
    dense: boolean;
    hideViewToggle: boolean;
  }> = {},
) {
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
      {...extra}
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
      'var(--status-green)',
    );
    expect(
      kpiTile('Needs attention').querySelector('[data-kpi-value]')!.getAttribute('style'),
    ).toContain('var(--status-orange)');
  });

  it('skeletons the daemon-derived tiles too while the project list is loading', () => {
    // Without listLoading these two render a confident `0` for a count that
    // nobody knows yet — the same "can't tell unknown from none" bug the
    // metric tiles had.
    renderHeader(true, { listLoading: true });
    for (const label of ['Projects', 'Indexing']) {
      expect(kpiValue(label)).not.toMatch(/\d/);
      expect(kpiTile(label).querySelector('.ws-skel')).not.toBeNull();
    }
  });

  it('resolves a failed metrics fetch to "unknown", not an endless skeleton', () => {
    renderHeader(true, { metricsFailed: true });
    for (const label of ['Files', 'Symbols', 'Healthy', 'Needs attention']) {
      // A skeleton promises data that is still coming; this fetch already
      // finished and failed, so it must settle on an em dash instead.
      expect(kpiTile(label).querySelector('.ws-skel')).toBeNull();
      expect(kpiValue(label)).toBe('—');
      expect(kpiTile(label).textContent).toContain("Couldn't be measured");
    }
  });

  it('never turns a dead daemon into a negative delta', () => {
    renderHeader(false, { listFailed: true });
    expect(kpiValue('Projects')).toBe('—');
    expect(kpiTile('Projects').textContent).not.toMatch(/[↑↓]/);
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

describe('WorkspaceHeader at a pane that cannot afford the full layout', () => {
  beforeEach(() => localStorage.clear());

  it('puts the toolbar above the KPI strip so chrome is never pushed off-window', () => {
    // Six full tiles are 357px. With them first, a 420px window — the app's own
    // minimum (main/tray.ts) — left the toolbar and the whole list below the
    // bottom edge with no scroll container to reach them (TRA-325).
    renderHeader(false);
    const root = strip.firstElementChild!;
    const toolbar = strip.querySelector('input[aria-label="Search projects"]')!.closest('.glass')!;
    const kpiStrip = kpiTile('Projects').parentElement!;
    const order = [...root.children];
    expect(order.indexOf(toolbar)).toBeLessThan(order.indexOf(kpiStrip));
  });

  it('lets the toolbar wrap instead of clipping its trailing controls', () => {
    renderHeader(false);
    const toolbar = strip.querySelector('input[aria-label="Search projects"]')!.closest('.glass')!;
    // A fixed 52px non-wrapping row ran 51px past a 420px pane, putting the
    // + Add chevron and the overflow menu outside the window entirely.
    expect(toolbar.className).toContain('flex-wrap');
    expect(toolbar.getAttribute('style')).toContain('min-height: 52px');
    // A floor, not a fixed height — a wrapped second line has to grow the row.
    expect((toolbar as HTMLElement).style.height).toBe('');
  });

  it('collapses each KPI tile to label + value when dense', () => {
    renderHeader(false, { dense: true });
    for (const label of ['Projects', 'Files', 'Healthy', 'Indexing']) {
      const tile = kpiTile(label);
      expect(tile).toHaveProperty('dataset.dense', '');
      // Two children, not three: the comparison line is what buys the height.
      expect(tile.children).toHaveLength(2);
      expect(kpiValue(label)).not.toBe('');
    }
  });

  it('keeps "couldn\'t be measured" reachable when dense drops the caption', () => {
    renderHeader(true, { dense: true, metricsFailed: true });
    const tile = kpiTile('Files');
    expect(kpiValue('Files')).toBe('—');
    expect(tile.getAttribute('title')).toBe("Couldn't be measured");
  });

  it('hides the view toggle when Compact is the only view that fits', () => {
    renderHeader(false, { hideViewToggle: true });
    expect(strip.querySelector('[aria-label="View mode"]')).toBeNull();
    // The rest of the toolbar stays: the surface still searches and filters.
    expect(strip.querySelector('input[aria-label="Search projects"]')).not.toBeNull();
    expect(strip.querySelector('[aria-label="More actions"]')).not.toBeNull();
  });

  it('shows the view toggle at a normal pane', () => {
    renderHeader(false);
    expect(strip.querySelector('[aria-label="View mode"]')).not.toBeNull();
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
