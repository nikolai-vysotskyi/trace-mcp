/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceHeader, activeFilterCount } from '../WorkspaceHeader';
import { EMPTY_FILTER, type WorkspaceFilter, type WorkspaceKpis } from '../types';
import { type KpiBaseline, LS_BASELINE_KEY } from '../kpiBaseline';

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
    kpis: WorkspaceKpis;
    filter: WorkspaceFilter;
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

  /* The baseline is what every delta chip is measured against, so a reading
     taken while the daemon is silent becomes tomorrow's fabricated growth:
     one launch with the daemon down stored all zeros, and the dashboard then
     reported "↑ +656.2k symbols vs 5 hours ago" on a workspace that had not
     changed in days (TRA-458). `metricsLoading` alone does not catch it —
     Workspace.tsx passes it as false the moment the request FAILS. */
  it.each([
    ['metrics are still loading', true, {}],
    ['the metrics request failed', false, { metricsFailed: true }],
    ['the project list is still loading', false, { listLoading: true }],
    ['the daemon is down', false, { listFailed: true }],
  ])('stores no baseline while %s', (_case, metricsLoading, extra) => {
    renderHeader(metricsLoading, extra);
    expect(localStorage.getItem(LS_BASELINE_KEY)).toBeNull();
  });

  it('starts tracking once it has a reading of a non-empty workspace', () => {
    renderHeader(false);
    const stored = JSON.parse(localStorage.getItem(LS_BASELINE_KEY)!) as KpiBaseline;
    expect(stored.kpis.totalProjects).toBe(78);
    // First reading, so there is nothing to compare against yet — and a
    // number is never dressed up as growth it did not have.
    expect(kpiTile('Projects').textContent).not.toMatch(/[↑↓]/);
  });

  it('shows no delta when the stored baseline is an empty workspace', () => {
    localStorage.setItem(
      LS_BASELINE_KEY,
      JSON.stringify({
        at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        kpis: { ...ZERO_KPIS, totalProjects: 0 },
      }),
    );
    renderHeader(false);
    expect(kpiTile('Projects').textContent).not.toMatch(/[↑↓]/);
    // Not "+78 vs 5 hours ago" — a delta equal to the value restates the
    // number instead of comparing it.
    expect(kpiTile('Projects').textContent).not.toContain('+78');
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

  it('does not give two overlapping sets the grammar of a partition', () => {
    // Healthy is (grade A or B) AND no security findings; Needs attention is
    // (grade D or F) OR findings OR ≥10 dead exports. A grade-B project with 15
    // dead exports is in both, so the workspace this was measured on had 30
    // healthy and 44 needing attention out of 53 — printed as shares that was
    // "57% of 53 projects" beside "83% of 53 projects" (TRA-459).
    renderHeader(false, {
      kpis: { ...ZERO_KPIS, totalProjects: 53, healthy: 30, needsAttention: 44, indexing: 4 },
    });
    for (const label of ['Healthy', 'Needs attention']) {
      const comparison = kpiTile(label).children[2]!.textContent!;
      expect(comparison).not.toMatch(/%/);
      expect(comparison).not.toMatch(/\d/);
    }
    // Indexing really is a subset of the workspace, so it keeps its share.
    expect(kpiTile('Indexing').children[2]!.textContent).toBe('8% of 53 projects');
  });
});

describe('WorkspaceHeader KPI tiles: which of them are controls', () => {
  beforeEach(() => localStorage.clear());

  const READOUTS = ['Projects', 'Files', 'Symbols'];
  const FILTERS = ['Healthy', 'Needs attention', 'Indexing'];

  it('marks nothing selected while nothing is filtered', () => {
    // Projects used to light when NO filter was on, so the one mark meaning
    // "this filter is active" sat, on every launch, above a list showing
    // everything (TRA-475).
    renderHeader(false);
    for (const label of [...READOUTS, ...FILTERS]) {
      const tile = kpiTile(label);
      expect(tile.getAttribute('aria-pressed')).not.toBe('true');
      expect(tile.style.border).toContain('var(--separator)');
    }
  });

  it('renders a tile with no filter behind it as content, not a dead control', () => {
    // `<button disabled>` told VoiceOver there was a control here and that the
    // user may not use it — a broken control where there was never one.
    renderHeader(false);
    for (const label of READOUTS) {
      const tile = kpiTile(label);
      expect(tile.tagName).toBe('DIV');
      expect(tile.getAttribute('aria-pressed')).toBeNull();
      // Still a card: same anatomy, same hook, same class.
      expect(tile.children).toHaveLength(3);
      expect(tile.className).toContain('ws-kpi');
    }
  });

  it('keeps the three filter presets as real buttons', () => {
    renderHeader(false);
    for (const label of FILTERS) {
      const tile = kpiTile(label);
      expect(tile.tagName).toBe('BUTTON');
      expect(tile).not.toHaveProperty('disabled', true);
      expect(tile.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('lights exactly the tile whose filter is on', () => {
    renderHeader(false, { filter: { ...EMPTY_FILTER, preset: 'healthy' } });
    expect(kpiTile('Healthy').getAttribute('aria-pressed')).toBe('true');
    expect(kpiTile('Healthy').style.border).toContain('var(--accent)');
    for (const label of ['Projects', 'Files', 'Symbols', 'Needs attention', 'Indexing']) {
      expect(kpiTile(label).style.border).toContain('var(--separator)');
    }
  });
});

describe('WorkspaceHeader at a pane that cannot afford the full layout', () => {
  beforeEach(() => localStorage.clear());

  it('puts the toolbar above the KPI strip so chrome is never pushed off-window', () => {
    // Six full tiles are 396px. With them first, a 420px window — the app's own
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
