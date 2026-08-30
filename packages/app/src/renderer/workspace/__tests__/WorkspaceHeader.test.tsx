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
      // The em dash is the whole statement. The caption slot is for a
      // comparison, and four cards repeating one failure sentence is not one
      // — the banner or the daemon-down pane says it, once (TRA-488).
      expect(kpiTile(label).textContent).not.toContain("Couldn't be measured");
      expect(kpiTile(label).querySelector('[aria-label="Not available"]')).not.toBeNull();
    }
  });

  it('never turns a dead daemon into a negative delta', () => {
    renderHeader(false, { listFailed: true });
    expect(kpiTile('Projects').textContent).not.toMatch(/[↑↓]/);
  });

  /* One `deriveKpis(data.projects)` call feeds all six tiles: Projects is that
     array's LENGTH, Files and Symbols are sums over its ELEMENTS. Blanking the
     length while the sums print is the strip contradicting itself two tiles
     apart, and contradicting the pane below that promises "nothing was lost"
     (TRA-495). */
  it('keeps the stock tiles on their snapshot when the daemon drops', () => {
    const kpis: WorkspaceKpis = {
      totalProjects: 64,
      totalFiles: 114_400,
      totalSymbols: 767_300,
      healthy: 39,
      needsAttention: 54,
      indexing: 0,
    };
    renderHeader(false, { listFailed: true, kpis });
    expect(kpiValue('Projects')).toBe('64');
    expect(kpiValue('Files')).toBe('114.4k');
    expect(kpiValue('Healthy')).toBe('39');
    // Activity, not stock: a daemon that is not running is not indexing, so a
    // cached count here would be the one genuine lie on the strip.
    expect(kpiValue('Indexing')).toBe('—');
  });

  /* A delta asserts something about NOW — "21.4k files appeared since 3 hours
     ago" — 500px above a pane saying the daemon isn't running. TRA-458 stopped
     the baseline being WRITTEN while the daemon is down; it does not stop an
     already-rolled one being DISPLAYED on the frame the connection drops. */
  it('shows no delta on any tile while the daemon is unreachable', () => {
    localStorage.setItem(
      LS_BASELINE_KEY,
      JSON.stringify({
        at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        kpis: { ...ZERO_KPIS, totalProjects: 57, totalFiles: 93_000 },
      }),
    );
    const kpis: WorkspaceKpis = { ...ZERO_KPIS, totalProjects: 64, totalFiles: 114_400 };
    renderHeader(false, { listFailed: true, kpis });
    for (const label of ['Projects', 'Files']) {
      const comparison = kpiTile(label).children[2]!.textContent!;
      expect(comparison).not.toMatch(/[↑↓]/);
      expect(comparison).not.toContain('hours ago');
      // The slot falls back to the footnote — a ratio or a criterion, which
      // stays true of a snapshot — rather than going blank.
      expect(comparison).not.toBe('');
    }
  });

  it('em-dashes every tile when the daemon is down with no snapshot behind it', () => {
    renderHeader(true, {
      listFailed: true,
      metricsFailed: true,
      kpis: { ...ZERO_KPIS, totalProjects: 0 },
    });
    for (const label of ['Projects', 'Files', 'Symbols', 'Healthy', 'Needs attention', 'Indexing']) {
      expect(kpiValue(label)).toBe('—');
    }
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

  /* The accent border on this strip means "this tile's filter is on". Projects
     carried it whenever NO filter was on, so every launch opened with one tile
     marked selected above a list showing everything (TRA-475). */
  it('marks nothing selected while nothing is filtered', () => {
    renderHeader(false);
    for (const label of ['Projects', 'Files', 'Symbols', 'Healthy', 'Needs attention', 'Indexing']) {
      expect(kpiTile(label).getAttribute('aria-pressed')).not.toBe('true');
      expect(kpiTile(label).getAttribute('style')).toContain('var(--separator)');
    }
  });

  it('lights only the tile whose own filter is on', () => {
    renderHeader(false, { filter: { ...EMPTY_FILTER, preset: 'healthy' } });
    expect(kpiTile('Healthy').getAttribute('aria-pressed')).toBe('true');
    expect(kpiTile('Healthy').getAttribute('style')).toContain('var(--accent)');
    for (const label of ['Projects', 'Needs attention', 'Indexing']) {
      expect(kpiTile(label).getAttribute('style')).toContain('var(--separator)');
    }
  });

  /* A readout is content. As `<button disabled>` a number went into the
     accessibility tree as a control the user is told they may not operate,
     when there was never a control to operate. */
  it('renders a tile with no filter behind it as content, not a disabled button', () => {
    renderHeader(false);
    for (const label of ['Projects', 'Files', 'Symbols']) {
      expect(kpiTile(label).tagName).toBe('DIV');
    }
    for (const label of ['Healthy', 'Needs attention', 'Indexing']) {
      const tile = kpiTile(label);
      expect(tile.tagName).toBe('BUTTON');
      expect((tile as HTMLButtonElement).disabled).toBe(false);
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

  it('says "unknown" once when dense, on the em dash itself', () => {
    renderHeader(true, { dense: true, metricsFailed: true });
    const tile = kpiTile('Files');
    expect(kpiValue('Files')).toBe('—');
    // The dense tile carried a `title` tooltip repeating the failure sentence,
    // which is the same sentence the banner above it already holds. The em
    // dash's own accessible name is what a reader needs here (TRA-488).
    expect(tile.getAttribute('title')).toBeNull();
    expect(tile.querySelector('[aria-label="Not available"]')).not.toBeNull();
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
