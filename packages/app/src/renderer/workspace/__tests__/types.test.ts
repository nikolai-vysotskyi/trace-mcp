import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../../hooks/useDaemon';
import {
  EMPTY_FILTER,
  type ProjectHealthMetrics,
  type ProjectViewModel,
  applyFilter,
  canonicalizeDaemonStatus,
  compareViewModels,
  deriveKpis,
  mergeIntoViewModel,
  statusLabel,
  statusToDot,
} from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────

function metric(over: Partial<ProjectHealthMetrics> = {}): ProjectHealthMetrics {
  return {
    root: '/a',
    name: 'a',
    status: 'ok',
    lastIndexed: '2026-01-01T00:00:00Z',
    totalFiles: 100,
    totalSymbols: 1000,
    totalEdges: 5000,
    deadExports: 0,
    untestedSymbols: 0,
    securityFindings: 0,
    ...over,
  };
}

function daemonProject(over: Partial<ProjectState> = {}): ProjectState {
  return { root: '/a', status: 'ready', ...over };
}

function vm(over: Partial<ProjectViewModel> = {}): ProjectViewModel {
  return {
    root: '/a',
    name: 'a',
    displayStatus: 'ok',
    lastIndexed: null,
    hasMetrics: false,
    inDaemon: false,
    ...over,
  };
}

// ── canonicalizeDaemonStatus ──────────────────────────────────────────────

describe('canonicalizeDaemonStatus', () => {
  it('maps ready/ok → ok', () => {
    expect(canonicalizeDaemonStatus('ready')).toBe('ok');
    expect(canonicalizeDaemonStatus('ok')).toBe('ok');
  });
  it('maps indexing/embedding → indexing', () => {
    expect(canonicalizeDaemonStatus('indexing')).toBe('indexing');
    expect(canonicalizeDaemonStatus('embedding')).toBe('indexing');
  });
  it('maps pending/computing → computing', () => {
    expect(canonicalizeDaemonStatus('pending')).toBe('computing');
    expect(canonicalizeDaemonStatus('computing')).toBe('computing');
  });
  it('maps error → error', () => {
    expect(canonicalizeDaemonStatus('error')).toBe('error');
  });
  it('maps unknown → not_loaded', () => {
    expect(canonicalizeDaemonStatus('whatever')).toBe('not_loaded');
    expect(canonicalizeDaemonStatus('')).toBe('not_loaded');
  });
});

// ── mergeIntoViewModel ────────────────────────────────────────────────────

describe('mergeIntoViewModel', () => {
  it('handles empty inputs', () => {
    expect(mergeIntoViewModel([], [])).toEqual([]);
  });

  it('renders dashboard-only projects with hasMetrics=true, inDaemon=false', () => {
    const out = mergeIntoViewModel([], [metric({ root: '/a', name: 'a', totalFiles: 5 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      root: '/a',
      name: 'a',
      displayStatus: 'ok',
      totalFiles: 5,
      hasMetrics: true,
      inDaemon: false,
    });
  });

  it('renders daemon-only projects with hasMetrics=false, inDaemon=true', () => {
    const out = mergeIntoViewModel(
      [daemonProject({ root: '/proj/foo-bar', status: 'indexing' })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      root: '/proj/foo-bar',
      name: 'foo-bar',
      displayStatus: 'indexing',
      liveStatus: 'indexing',
      hasMetrics: false,
      inDaemon: true,
    });
  });

  it('merges both sources with field-level precedence', () => {
    const out = mergeIntoViewModel(
      [daemonProject({ status: 'indexing', progress: { phase: 'parse', current: 3, total: 10, percent: 30 } })],
      [metric()],
    );
    expect(out[0].displayStatus).toBe('indexing'); // daemon transient wins
    expect(out[0].progress?.percent).toBe(30);
    expect(out[0].totalFiles).toBe(100); // dashboard metrics retained
    expect(out[0].hasMetrics).toBe(true);
    expect(out[0].inDaemon).toBe(true);
  });

  it('daemon ready does NOT override dashboard error', () => {
    const out = mergeIntoViewModel([daemonProject({ status: 'ready' })], [metric({ status: 'error' })]);
    expect(out[0].displayStatus).toBe('error');
  });

  it('daemon transient overrides dashboard ok', () => {
    const out = mergeIntoViewModel([daemonProject({ status: 'indexing' })], [metric({ status: 'ok' })]);
    expect(out[0].displayStatus).toBe('indexing');
  });

  it('daemon liveStatus retains finer-grained value (embedding)', () => {
    const out = mergeIntoViewModel([daemonProject({ status: 'embedding' })], [metric()]);
    expect(out[0].displayStatus).toBe('indexing');
    expect(out[0].liveStatus).toBe('embedding');
  });

  it('error from daemon overrides dashboard error', () => {
    const out = mergeIntoViewModel(
      [daemonProject({ status: 'error', error: 'live boom' })],
      [metric({ status: 'error', error: 'cached boom' })],
    );
    expect(out[0].error).toBe('live boom');
  });

  it('dashboard error preserved when daemon has no error', () => {
    const out = mergeIntoViewModel(
      [daemonProject({ status: 'ready' })],
      [metric({ status: 'error', error: 'cached boom' })],
    );
    expect(out[0].error).toBe('cached boom');
  });

  it('not_loaded dashboard status defers to daemon canonical', () => {
    const out = mergeIntoViewModel(
      [daemonProject({ status: 'ready' })],
      [metric({ status: 'not_loaded' })],
    );
    expect(out[0].displayStatus).toBe('ok');
  });

  it('basename fallback strips trailing slashes', () => {
    const out = mergeIntoViewModel(
      [daemonProject({ root: '/Users/me/projects/widget///' })],
      [],
    );
    expect(out[0].name).toBe('widget');
  });
});

// ── deriveKpis ────────────────────────────────────────────────────────────

describe('deriveKpis', () => {
  it('counts totals across hasMetrics projects', () => {
    const k = deriveKpis([
      vm({ root: '/a', hasMetrics: true, totalFiles: 10, totalSymbols: 100 }),
      vm({ root: '/b', hasMetrics: true, totalFiles: 5, totalSymbols: 50 }),
      vm({ root: '/c', hasMetrics: false }),
    ]);
    expect(k.totalProjects).toBe(3);
    expect(k.totalFiles).toBe(15);
    expect(k.totalSymbols).toBe(150);
  });

  it('counts healthy = grade A/B AND 0 security findings', () => {
    const k = deriveKpis([
      vm({ root: '/a', hasMetrics: true, techDebtGrade: 'A', securityFindings: 0 }),
      vm({ root: '/b', hasMetrics: true, techDebtGrade: 'B', securityFindings: 0 }),
      vm({ root: '/c', hasMetrics: true, techDebtGrade: 'A', securityFindings: 1 }), // unhealthy: has security
      vm({ root: '/d', hasMetrics: true, techDebtGrade: 'C', securityFindings: 0 }), // unhealthy: grade
    ]);
    expect(k.healthy).toBe(2);
  });

  it('counts needsAttention = D/F grade OR security > 0 OR dead >= 10', () => {
    const k = deriveKpis([
      vm({ root: '/a', hasMetrics: true, techDebtGrade: 'D' }),
      vm({ root: '/b', hasMetrics: true, securityFindings: 5 }),
      vm({ root: '/c', hasMetrics: true, deadExports: 10 }),
      vm({ root: '/d', hasMetrics: true, deadExports: 9 }), // below threshold
    ]);
    expect(k.needsAttention).toBe(3);
  });

  it('counts indexing = displayStatus indexing|computing', () => {
    const k = deriveKpis([
      vm({ root: '/a', displayStatus: 'indexing' }),
      vm({ root: '/b', displayStatus: 'computing' }),
      vm({ root: '/c', displayStatus: 'ok' }),
    ]);
    expect(k.indexing).toBe(2);
  });
});

// ── applyFilter ───────────────────────────────────────────────────────────

describe('applyFilter', () => {
  const projects: ProjectViewModel[] = [
    vm({ root: '/widgets', name: 'widgets', displayStatus: 'ok', hasMetrics: true, techDebtGrade: 'A', securityFindings: 0, deadExports: 0 }),
    vm({ root: '/legacy', name: 'legacy', displayStatus: 'error', hasMetrics: true, techDebtGrade: 'F', securityFindings: 3, deadExports: 50 }),
    vm({ root: '/wip', name: 'wip', displayStatus: 'indexing', hasMetrics: false }),
  ];

  it('default filter is identity', () => {
    expect(applyFilter(projects, EMPTY_FILTER).map((p) => p.root)).toEqual(['/widgets', '/legacy', '/wip']);
  });

  it('query matches name + root, case-insensitive', () => {
    expect(applyFilter(projects, { ...EMPTY_FILTER, query: 'LEG' }).map((p) => p.root)).toEqual(['/legacy']);
    expect(applyFilter(projects, { ...EMPTY_FILTER, query: '/wip' }).map((p) => p.root)).toEqual(['/wip']);
  });

  it('statuses whitelist (OR within list)', () => {
    expect(
      applyFilter(projects, { ...EMPTY_FILTER, statuses: ['ok', 'indexing'] }).map((p) => p.root),
    ).toEqual(['/widgets', '/wip']);
  });

  it('grades whitelist excludes ungraded', () => {
    expect(applyFilter(projects, { ...EMPTY_FILTER, grades: ['A'] }).map((p) => p.root)).toEqual(['/widgets']);
  });

  it('hasSecurityFindings true keeps only > 0', () => {
    expect(
      applyFilter(projects, { ...EMPTY_FILTER, hasSecurityFindings: true }).map((p) => p.root),
    ).toEqual(['/legacy']);
  });

  it('hasDeadExports true keeps only > 0', () => {
    expect(
      applyFilter(projects, { ...EMPTY_FILTER, hasDeadExports: true }).map((p) => p.root),
    ).toEqual(['/legacy']);
  });

  it('preset healthy matches A/B + 0 security', () => {
    expect(applyFilter(projects, { ...EMPTY_FILTER, preset: 'healthy' }).map((p) => p.root)).toEqual(['/widgets']);
  });

  it('preset needs_attention matches grade D/F | security > 0 | dead >= 10', () => {
    expect(
      applyFilter(projects, { ...EMPTY_FILTER, preset: 'needs_attention' }).map((p) => p.root),
    ).toEqual(['/legacy']);
  });

  it('preset indexing matches transient statuses', () => {
    expect(applyFilter(projects, { ...EMPTY_FILTER, preset: 'indexing' }).map((p) => p.root)).toEqual(['/wip']);
  });

  it('preset failing matches error status', () => {
    expect(applyFilter(projects, { ...EMPTY_FILTER, preset: 'failing' }).map((p) => p.root)).toEqual(['/legacy']);
  });

  it('preset and granular filters AND together', () => {
    // healthy preset AND grade [B] → /widgets is grade A, not B → empty
    expect(
      applyFilter(projects, { ...EMPTY_FILTER, preset: 'healthy', grades: ['B'] }).map((p) => p.root),
    ).toEqual([]);
  });
});

// ── compareViewModels ─────────────────────────────────────────────────────

describe('compareViewModels', () => {
  it('sorts by name asc / desc', () => {
    const out = [vm({ name: 'b' }), vm({ name: 'a' })].sort((a, b) => compareViewModels(a, b, 'name', 'asc'));
    expect(out.map((p) => p.name)).toEqual(['a', 'b']);
    const out2 = [vm({ name: 'a' }), vm({ name: 'b' })].sort((a, b) => compareViewModels(a, b, 'name', 'desc'));
    expect(out2.map((p) => p.name)).toEqual(['b', 'a']);
  });

  it('sorts by techDebtGrade with undefined sinking to bottom', () => {
    const out = [
      vm({ root: '/a', techDebtGrade: 'F' }),
      vm({ root: '/b' }), // undefined → bottom
      vm({ root: '/c', techDebtGrade: 'A' }),
    ].sort((a, b) => compareViewModels(a, b, 'techDebtGrade', 'asc'));
    expect(out.map((p) => p.root)).toEqual(['/c', '/a', '/b']);
  });

  it('sorts by status using canonical order', () => {
    const out = [
      vm({ root: '/x', displayStatus: 'error' }),
      vm({ root: '/y', displayStatus: 'ok' }),
      vm({ root: '/z', displayStatus: 'indexing' }),
    ].sort((a, b) => compareViewModels(a, b, 'status', 'asc'));
    expect(out.map((p) => p.root)).toEqual(['/y', '/z', '/x']);
  });

  it('numeric metric sort treats undefined as -1', () => {
    const out = [
      vm({ root: '/a', totalFiles: 5 }),
      vm({ root: '/b' }),
      vm({ root: '/c', totalFiles: 1 }),
    ].sort((a, b) => compareViewModels(a, b, 'totalFiles', 'asc'));
    expect(out.map((p) => p.root)).toEqual(['/b', '/c', '/a']);
  });

  it('sorts by lastIndexed lexicographically (ISO is sortable)', () => {
    const out = [
      vm({ root: '/a', lastIndexed: '2026-01-01T00:00:00Z' }),
      vm({ root: '/b', lastIndexed: null }),
      vm({ root: '/c', lastIndexed: '2026-03-01T00:00:00Z' }),
    ].sort((a, b) => compareViewModels(a, b, 'lastIndexed', 'asc'));
    // null becomes '' which sorts first lexicographically.
    expect(out.map((p) => p.root)).toEqual(['/b', '/a', '/c']);
  });
});

// ── statusToDot / statusLabel ─────────────────────────────────────────────

describe('statusToDot', () => {
  it('maps all canonical statuses', () => {
    expect(statusToDot('ok')).toBe('active');
    expect(statusToDot('indexing')).toBe('idle');
    expect(statusToDot('computing')).toBe('idle');
    expect(statusToDot('error')).toBe('error');
    expect(statusToDot('not_loaded')).toBe('disconnected');
  });
});

describe('statusLabel', () => {
  it('renders human labels', () => {
    expect(statusLabel('ok')).toBe('OK');
    expect(statusLabel('indexing')).toBe('Indexing');
    expect(statusLabel('computing')).toBe('Computing');
    expect(statusLabel('error')).toBe('Error');
    expect(statusLabel('not_loaded')).toBe('Not loaded');
  });
});
