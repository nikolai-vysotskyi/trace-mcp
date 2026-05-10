import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusDot } from '../components/StatusDot';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TechDebtGrade = 'A' | 'B' | 'C' | 'D' | 'F';

interface ProjectHealth {
  root: string;
  name: string;
  status: 'ok' | 'error' | 'indexing' | 'not_loaded' | 'computing';
  lastIndexed: string | null;
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  deadExports: number;
  untestedSymbols: number;
  techDebtGrade?: TechDebtGrade;
  securityFindings: number;
  error?: string;
}

type SortKey = keyof Pick<
  ProjectHealth,
  | 'name'
  | 'status'
  | 'lastIndexed'
  | 'totalFiles'
  | 'totalSymbols'
  | 'deadExports'
  | 'untestedSymbols'
  | 'techDebtGrade'
  | 'securityFindings'
>;

type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = 'http://127.0.0.1:3741';
const REFETCH_INTERVAL_MS = 300_000; // 5 min — matches backend cache TTL

// Map our ProjectHealth status → StatusDot status
function toStatusDot(
  status: ProjectHealth['status'],
): 'active' | 'idle' | 'error' | 'disconnected' {
  switch (status) {
    case 'ok':
      return 'active';
    case 'indexing':
    case 'computing':
      return 'idle';
    case 'error':
      return 'error';
    case 'not_loaded':
      return 'disconnected';
  }
}

function statusLabel(status: ProjectHealth['status']): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'indexing':
      return 'Indexing';
    case 'computing':
      return 'Computing';
    case 'error':
      return 'Error';
    case 'not_loaded':
      return 'Not loaded';
  }
}

// Grade colors
const GRADE_COLOR: Record<TechDebtGrade, string> = {
  A: '#34c759',
  B: '#30d158',
  C: '#ffcc00',
  D: '#ff9f0a',
  F: '#ff3b30',
};

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

const GRADE_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const STATUS_ORDER: Record<string, number> = {
  ok: 0,
  indexing: 1,
  computing: 2,
  error: 3,
  not_loaded: 4,
};

function compareProjects(a: ProjectHealth, b: ProjectHealth, key: SortKey, dir: SortDir): number {
  let result = 0;

  if (key === 'techDebtGrade') {
    const ga = GRADE_ORDER[a.techDebtGrade ?? 'F'] ?? 5;
    const gb = GRADE_ORDER[b.techDebtGrade ?? 'F'] ?? 5;
    result = ga - gb;
  } else if (key === 'status') {
    result = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
  } else if (key === 'lastIndexed') {
    const ta = a.lastIndexed ?? '';
    const tb = b.lastIndexed ?? '';
    result = ta < tb ? -1 : ta > tb ? 1 : 0;
  } else if (typeof a[key] === 'number' && typeof b[key] === 'number') {
    result = (a[key] as number) - (b[key] as number);
  } else {
    const sa = String(a[key] ?? '').toLowerCase();
    const sb = String(b[key] ?? '').toLowerCase();
    result = sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  return dir === 'asc' ? result : -result;
}

// ---------------------------------------------------------------------------
// Mini spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        border: '1.5px solid var(--border)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
        verticalAlign: 'middle',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ThProps {
  label: string;
  tooltip?: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}

function Th({ label, tooltip, sortKey, current, dir, onSort }: ThProps) {
  const isActive = current === sortKey;
  return (
    <th
      className="px-3 py-2 text-left text-[11px] font-semibold cursor-pointer select-none whitespace-nowrap"
      style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)' }}
      title={tooltip}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {isActive && (
        <span className="ml-1" style={{ color: 'var(--accent)' }}>
          {dir === 'asc' ? '▲' : '▼'}
        </span>
      )}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/dashboard/projects`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { projects: ProjectHealth[] };
      setProjects(data.projects);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to load dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Restart auto-refresh timer, cancelling any existing one
  const resetTimer = useCallback(() => {
    if (intervalRef.current != null) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => void fetchProjects(), REFETCH_INTERVAL_MS);
  }, [fetchProjects]);

  useEffect(() => {
    void fetchProjects();
    resetTimer();
    return () => {
      if (intervalRef.current != null) clearInterval(intervalRef.current);
    };
  }, [fetchProjects, resetTimer]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const handleRowClick = (root: string) => {
    window.electronAPI?.openProjectTab(root).catch(() => {/* ignore */});
  };

  // Manual refresh: invalidate cache on server, then re-fetch
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch(`${BASE}/api/dashboard/refresh`, { method: 'POST' });
    } catch {
      // If the invalidation request fails we still try to fetch
    }
    await fetchProjects();
    resetTimer(); // reset auto-refresh countdown after manual refresh
  }, [fetchProjects, resetTimer]);

  const sorted = [...projects].sort((a, b) => compareProjects(a, b, sortKey, sortDir));

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Loading…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <span className="text-xs font-medium" style={{ color: '#ff3b30' }}>
          {error}
        </span>
        <button
          type="button"
          className="text-[11px] px-3 py-1 rounded-md font-medium"
          style={{ background: 'var(--fill-control)', color: 'var(--accent)', border: '0.5px solid var(--border)' }}
          onClick={() => { setLoading(true); void fetchProjects(); }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1 px-6 text-center">
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          No projects registered.
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Click 'Add project' in the Projects tab.
        </span>
      </div>
    );
  }

  // ── Table ──────────────────────────────────────────────────────────────────

  const thProps = { current: sortKey, dir: sortDir, onSort: handleSort };

  return (
    <>
      {/* Keyframe for the spinner — injected once */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 shrink-0">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Dashboard
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {projects.length} project{projects.length !== 1 ? 's' : ''} · auto-refreshes every 5 min
            </span>
            <button
              type="button"
              disabled={refreshing}
              className="text-[11px] px-2 py-0.5 rounded font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{
                background: 'var(--fill-control)',
                color: 'var(--accent)',
                border: '0.5px solid var(--border)',
              }}
              onClick={() => void handleRefresh()}
            >
              {refreshing ? <Spinner /> : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Scrollable table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0" style={{ background: 'var(--bg-secondary)' }}>
              <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
                <Th label="Project" sortKey="name" {...thProps} />
                <Th label="Status" sortKey="status" {...thProps} />
                <Th label="Last Indexed" sortKey="lastIndexed" {...thProps} />
                <Th label="Files" sortKey="totalFiles" {...thProps} />
                <Th label="Symbols" sortKey="totalSymbols" {...thProps} />
                <Th
                  label="Dead Exports"
                  sortKey="deadExports"
                  tooltip="Exported symbols that are never imported anywhere in the project"
                  {...thProps}
                />
                <Th
                  label="Untested"
                  sortKey="untestedSymbols"
                  tooltip="Functions, classes, and methods not referenced by any test file"
                  {...thProps}
                />
                <Th
                  label="Grade"
                  sortKey="techDebtGrade"
                  tooltip="Tech-debt grade (A–F) based on cyclomatic complexity, coupling, test coverage gap, and churn"
                  {...thProps}
                />
                <Th
                  label="Security"
                  sortKey="securityFindings"
                  tooltip="Number of critical + high OWASP findings (SQL injection, XSS, hardcoded secrets, etc.)"
                  {...thProps}
                />
                <th
                  className="px-3 py-2 text-left text-[11px] font-semibold"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const isComputing = p.status === 'computing';
                const isOk = p.status === 'ok';
                return (
                  <tr
                    key={p.root}
                    className="transition-colors cursor-pointer"
                    style={{ borderBottom: '0.5px solid var(--border)' }}
                    onClick={() => handleRowClick(p.root)}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-secondary)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = '';
                    }}
                  >
                    {/* Project name */}
                    <td className="px-3 py-2 font-medium max-w-[160px]" style={{ color: 'var(--text-primary)' }}>
                      <div className="truncate" title={p.root}>
                        {p.name}
                      </div>
                      <div
                        className="truncate text-[10px]"
                        style={{ color: 'var(--text-tertiary)' }}
                        title={p.root}
                      >
                        {p.root}
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={toStatusDot(p.status)} />
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {statusLabel(p.status)}
                        </span>
                      </div>
                      {p.error && (
                        <div
                          className="text-[10px] mt-0.5 truncate max-w-[120px]"
                          style={{ color: '#ff3b30' }}
                          title={p.error}
                        >
                          {p.error}
                        </div>
                      )}
                    </td>

                    {/* Last indexed */}
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                      {p.lastIndexed
                        ? new Date(p.lastIndexed).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>

                    {/* Files */}
                    <td className="px-3 py-2 tabular-nums text-right" style={{ color: 'var(--text-primary)' }}>
                      {isComputing ? <Spinner /> : isOk ? p.totalFiles.toLocaleString() : '—'}
                    </td>

                    {/* Symbols */}
                    <td className="px-3 py-2 tabular-nums text-right" style={{ color: 'var(--text-primary)' }}>
                      {isComputing ? <Spinner /> : isOk ? p.totalSymbols.toLocaleString() : '—'}
                    </td>

                    {/* Dead exports */}
                    <td className="px-3 py-2 tabular-nums text-right">
                      {isComputing ? (
                        <Spinner />
                      ) : isOk ? (
                        <span
                          style={{
                            color: p.deadExports > 0 ? '#ff9f0a' : 'var(--text-secondary)',
                            fontWeight: p.deadExports > 0 ? 600 : undefined,
                          }}
                        >
                          {p.deadExports.toLocaleString()}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>

                    {/* Untested */}
                    <td className="px-3 py-2 tabular-nums text-right">
                      {isComputing ? (
                        <Spinner />
                      ) : isOk ? (
                        <span
                          style={{
                            color: p.untestedSymbols > 0 ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                          }}
                        >
                          {p.untestedSymbols.toLocaleString()}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>

                    {/* Grade */}
                    <td className="px-3 py-2 text-center">
                      {isComputing ? (
                        <Spinner />
                      ) : p.techDebtGrade ? (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[11px] font-bold"
                          style={{
                            color: '#fff',
                            background: GRADE_COLOR[p.techDebtGrade],
                          }}
                        >
                          {p.techDebtGrade}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>

                    {/* Security findings */}
                    <td className="px-3 py-2 tabular-nums text-right">
                      {isComputing ? (
                        <Spinner />
                      ) : isOk ? (
                        <span
                          style={{
                            color: p.securityFindings > 0 ? '#ff3b30' : 'var(--text-tertiary)',
                            fontWeight: p.securityFindings > 0 ? 600 : undefined,
                          }}
                        >
                          {p.securityFindings.toLocaleString()}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-[11px] px-2 py-0.5 rounded font-medium transition-opacity hover:opacity-80"
                        style={{
                          background: 'var(--fill-control)',
                          color: 'var(--accent)',
                          border: '0.5px solid var(--border)',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRowClick(p.root);
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
