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

type HeaderExtra = Partial<{
  listLoading: boolean;
  metricsFailed: boolean;
  listFailed: boolean;
  dense: boolean;
  hideViewToggle: boolean;
  kpis: WorkspaceKpis;
  filter: WorkspaceFilter;
}>;

function header(metricsLoading: boolean, extra: HeaderExtra) {
  return (
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
    />
  );
}

/**
 * Renders the strip and returns a re-render for the same header with new props.
 * The daemon-down cases need it: `listFailed` is never true on the first frame
 * of a real launch — the snapshot restores, the baseline rolls off it, and the
 * connection is only pronounced dead {@link DEGRADED_GRACE_MS} later. Mounting
 * straight into the failed state skips the frame everybody actually sees.
 */
function renderHeader(metricsLoading: boolean, extra: HeaderExtra = {}) {
  const { container, rerender } = render(header(metricsLoading, extra));
  strip = container;
  return (nextLoading: boolean, nextExtra: HeaderExtra) =>
    rerender(header(nextLoading, nextExtra));
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

/* Every tile on this strip is one `deriveKpis(data.projects)` call over one
   array: `totalProjects` is that array's length, `totalFiles` a sum over its
   elements. With the daemon unreachable the array is the restored localStorage
   snapshot, and the strip used to blank the tile reporting the length while
   four tiles reported sums over the contents — one array, two answers about
   whether it was knowable, over a pane headed "The daemon isn't running" and
   promising "nothing was lost" (TRA-495). */
describe('WorkspaceHeader with the daemon down', () => {
  const SNAPSHOT: WorkspaceKpis = {
    totalProjects: 64,
    totalFiles: 114_400,
    totalSymbols: 767_300,
    healthy: 39,
    needsAttention: 54,
    indexing: 0,
  };

  /** Mount alive so the baseline rolls, then lose the daemon — the real order. */
  function loseTheDaemon(kpis: WorkspaceKpis = SNAPSHOT) {
    const rerender = renderHeader(false, { kpis });
    rerender(false, { kpis, listFailed: true });
  }

  beforeEach(() => localStorage.clear());

  it('keeps every stock reading the snapshot still holds', () => {
    loseTheDaemon();
    expect(kpiValue('Projects')).toBe('64');
    expect(kpiValue('Files')).toBe('114.4k');
    expect(kpiValue('Symbols')).toBe('767.3k');
    expect(kpiValue('Healthy')).toBe('39');
    expect(kpiValue('Needs attention')).toBe('54');
  });

  it('claims no delta, because a delta is a statement about now', () => {
    // The baseline is real and five hours old, so every tile would otherwise
    // print "↑ +114.4k vs 5 hours ago" — growth measured by an app that has
    // just said it cannot reach the thing that measures.
    localStorage.setItem(
      LS_BASELINE_KEY,
      JSON.stringify({
        at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        kpis: { ...SNAPSHOT, totalFiles: 93_000, totalSymbols: 656_200, totalProjects: 53 },
      }),
    );
    loseTheDaemon();
    for (const label of ['Projects', 'Files', 'Symbols', 'Healthy', 'Needs attention']) {
      expect(kpiTile(label).textContent).not.toMatch(/[↑↓]/);
      // …and the comparison slot is not left empty either: each falls back to
      // its footnote, which stays true of a snapshot.
      expect(kpiTile(label).children[2]!.textContent).not.toBe('');
    }
  });

  it('leaves Indexing unknown — a daemon that is not running is indexing nothing', () => {
    // The one reading on the strip that measures activity rather than stock.
    // A cached count here would be the single genuine lie.
    loseTheDaemon();
    expect(kpiValue('Indexing')).toBe('—');
    expect(kpiTile('Indexing').querySelector('[aria-label="Not available"]')).not.toBeNull();
  });

  it('falls back to six em dashes when there is no snapshot to hold', () => {
    // Cold start against a daemon that never answered: nothing was restored,
    // so the strip has nothing to be stale about and says so uniformly.
    const empty: WorkspaceKpis = { ...SNAPSHOT, totalProjects: 0, totalFiles: 0, totalSymbols: 0, healthy: 0, needsAttention: 0 };
    renderHeader(true, { kpis: empty, listFailed: true, metricsFailed: true });
    for (const label of ['Projects', 'Files', 'Symbols', 'Healthy', 'Needs attention', 'Indexing']) {
      expect(kpiValue(label)).toBe('—');
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
