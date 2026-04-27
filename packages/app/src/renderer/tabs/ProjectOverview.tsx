import { useCallback, useEffect, useState } from 'react';
import { StatusDot } from '../components/StatusDot';
import { useDaemon } from '../hooks/useDaemon';

interface ProjectStats {
  files: number;
  symbols: number;
  edges: number;
  lastIndexed?: string;
}

interface CoverageGap {
  name: string;
  version: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
}

interface UnknownPackage {
  name: string;
  version: string;
  ecosystem: string;
  needs_plugin: 'likely' | 'maybe' | 'no';
  reason: string;
}

interface CoverageReport {
  coverage: {
    total_significant: number;
    covered: number;
    coverage_pct: number;
  };
  gaps: CoverageGap[];
  unknown: UnknownPackage[];
}

const BASE = 'http://127.0.0.1:3741';
const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';

function shortPath(root: string): string {
  return root
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~');
}

function buildIssueUrl(gap: CoverageGap | UnknownPackage): string {
  const isGap = 'priority' in gap;
  const title = isGap ? `Plugin support: ${gap.name}` : `Catalog review: ${gap.name}`;
  const body = isGap
    ? `## Plugin request\n\n**Package:** \`${gap.name}\` (${gap.version})\n**Category:** ${gap.category}\n**Priority:** ${(gap as CoverageGap).priority}\n\nThis dependency is detected in my project but has no trace-mcp plugin coverage.\n\n### Expected\nA dedicated plugin that extracts framework-specific edges and metadata for \`${gap.name}\`.\n\n### Context\n<!-- Describe how you use this package, what patterns you'd like traced -->\n`
    : `## Catalog review\n\n**Package:** \`${gap.name}\` (${gap.version})\n**Ecosystem:** ${(gap as UnknownPackage).ecosystem}\n**Assessment:** ${(gap as UnknownPackage).needs_plugin} — ${(gap as UnknownPackage).reason}\n\nThis dependency is not in the known-packages catalog.\n\n### Expected\nAdd to catalog with appropriate category/priority, or create a plugin if it has framework-level semantics.\n`;
  const labels = isGap ? 'enhancement,plugin-request' : 'enhancement,catalog-review';
  return `https://github.com/${GITHUB_REPO}/issues/new?${new URLSearchParams({ title, body, labels })}`;
}

function coverageColor(pct: number): string {
  if (pct >= 100) return 'var(--green, #22c55e)';
  if (pct >= 80) return 'var(--yellow, #eab308)';
  return 'var(--red, #ef4444)';
}

function priorityBadge(priority: string) {
  const colors: Record<string, { bg: string; text: string }> = {
    high: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    medium: { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
    low: { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' },
    likely: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    maybe: { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
  };
  const c = colors[priority] ?? colors.low;
  return (
    <span
      className="text-[9px] px-1.5 py-0.5 rounded font-medium uppercase"
      style={{ background: c.bg, color: c.text }}
    >
      {priority}
    </span>
  );
}

interface SubprojectInfo {
  name: string;
  repoRoot: string;
  services: number;
  endpoints: number;
}

interface SmellFinding {
  category: 'todo_comment' | 'empty_function' | 'hardcoded_value' | 'debug_artifact';
  priority: 'high' | 'medium' | 'low';
  tag?: string;
  file: string;
  line: number;
  snippet: string;
  description: string;
}

interface SmellReport {
  files_scanned: number;
  findings: SmellFinding[];
  summary: {
    todo_comment: number;
    empty_function: number;
    hardcoded_value: number;
    debug_artifact: number;
  };
  total: number;
}

interface ServiceInfo {
  id: number;
  name: string;
  repoRoot: string;
  serviceType: string | null;
  projectGroup: string | null;
  endpointCount: number;
}

export function ProjectOverview({
  root,
  onNavigateToService,
}: {
  root: string;
  onNavigateToService?: (serviceName: string) => void;
}) {
  const { projects, reindexProject, addProject } = useDaemon();
  const project = projects.find((p) => p.root === root);
  const status = project?.status ?? 'unknown';
  const progress = project?.progress;

  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [_services, setServices] = useState<SubprojectInfo[]>([]);
  const [svcList, setSvcList] = useState<ServiceInfo[]>([]);
  const [addingService, setAddingService] = useState(false);
  const [editingGroup, setEditingGroup] = useState<number | null>(null);
  const [groupInput, setGroupInput] = useState('');
  const [smells, setSmells] = useState<SmellReport | null>(null);
  const [smellsLoading, setSmellsLoading] = useState(false);
  const [smellsCategory, setSmellsCategory] = useState<SmellFinding['category']>('debug_artifact');

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/projects/stats?project=${encodeURIComponent(root)}`);
      if (res.ok) setStats(await res.json());
    } catch {
      /* optional */
    }
  }, [root]);

  const fetchCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      const res = await fetch(`${BASE}/api/projects/coverage?project=${encodeURIComponent(root)}`);
      if (res.ok) setCoverage(await res.json());
    } catch {
      /* optional */
    }
    setCoverageLoading(false);
  }, [root]);

  const fetchServices = useCallback(async () => {
    try {
      const params = new URLSearchParams({ project: root });
      const res = await fetch(`${BASE}/api/projects/subprojects?${params}`);
      if (res.ok) {
        const data = await res.json();
        setServices(data.repos ?? []);
        setSvcList(data.services ?? []);
      }
    } catch {
      /* optional */
    }
  }, [root]);

  const fetchSmells = useCallback(
    async (category: SmellFinding['category']) => {
      setSmellsLoading(true);
      try {
        const params = new URLSearchParams({
          project: root,
          category,
          limit: '500',
        });
        const res = await fetch(`${BASE}/api/projects/smells?${params}`);
        if (res.ok) setSmells(await res.json());
      } catch {
        /* optional */
      }
      setSmellsLoading(false);
    },
    [root],
  );

  useEffect(() => {
    fetchStats();
    fetchCoverage();
    fetchServices();
    fetchSmells(smellsCategory);
  }, [fetchStats, fetchCoverage, fetchServices, fetchSmells, smellsCategory, status]);

  const handleAddService = async () => {
    const api = (window as any).electronAPI;
    if (!api?.selectFolder) return;
    setAddingService(true);
    try {
      const folder = await api.selectFolder();
      if (!folder) return;
      await fetch(`${BASE}/api/projects/subprojects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: folder, project: root }),
      });
      fetchServices();
    } catch {
      /* optional */
    } finally {
      setAddingService(false);
    }
  };

  const handleRemoveService = async (name: string) => {
    try {
      const res = await fetch(`${BASE}/api/projects/subprojects?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setServices((prev) => prev.filter((s) => s.name !== name));
        setSvcList((prev) => prev.filter((s) => s.name !== name));
      }
    } catch {
      /* optional */
    }
  };

  const handleUpdateGroup = async (serviceId: number, projectGroup: string | null) => {
    try {
      const res = await fetch(`${BASE}/api/projects/services`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId, projectGroup: projectGroup || null }),
      });
      if (res.ok) {
        setSvcList((prev) =>
          prev.map((s) => (s.id === serviceId ? { ...s, projectGroup: projectGroup || null } : s)),
        );
      }
    } catch {
      /* optional */
    }
    setEditingGroup(null);
  };

  const statusDot =
    status === 'indexing'
      ? ('idle' as const)
      : status === 'error'
        ? ('error' as const)
        : status === 'ready'
          ? ('active' as const)
          : ('disconnected' as const);

  const hasGaps =
    coverage &&
    (coverage.gaps.length > 0 ||
      coverage.unknown.filter((u) => u.needs_plugin === 'likely').length > 0);

  const statusLabel =
    status === 'indexing'
      ? 'Indexing…'
      : status === 'ready'
        ? 'Ready'
        : status === 'error'
          ? 'Error'
          : status;

  return (
    <div className="space-y-5 pb-4">
      {/* ── Hero header ──────────────────────────────── */}
      <div className="pt-1">
        <div className="flex items-center gap-2.5">
          <StatusDot status={statusDot} />
          <h2
            className="text-[17px] font-semibold leading-tight truncate"
            style={{ color: 'var(--text-primary)', letterSpacing: '-0.022em' }}
            title={root.split(/[/\\]/).filter(Boolean).pop()}
          >
            {root.split(/[/\\]/).filter(Boolean).pop()}
          </h2>
        </div>
        <div
          className="text-[11px] mt-1 ml-[18px] truncate"
          style={{ color: 'var(--text-tertiary)', fontFamily: 'SF Mono, Menlo, monospace' }}
          title={root}
        >
          {shortPath(root)}
        </div>

        {/* Indexing progress inline under header */}
        {status === 'indexing' && progress?.percent != null && (
          <div className="mt-3 ml-[18px]">
            <div
              className="flex justify-between text-[10px] mb-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <span className="truncate">{progress.phase}</span>
              <span className="tabular-nums">{progress.percent}%</span>
            </div>
            <div
              className="h-1 rounded-full overflow-hidden"
              style={{ background: 'var(--bg-inset)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${progress.percent}%`, background: 'var(--accent)' }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Primary action ───────────────────────────── */}
      {project ? (
        <button
          type="button"
          onClick={() => reindexProject(root)}
          disabled={status === 'indexing'}
          className="w-full text-[13px] font-medium transition-all disabled:opacity-40 hover:brightness-110 active:brightness-95"
          style={{
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 8,
            height: 30,
            boxShadow:
              '0 0 0 0.5px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08), inset 0 0.5px 0 rgba(255,255,255,0.25)',
            cursor: status === 'indexing' ? 'default' : 'pointer',
            letterSpacing: '-0.005em',
          }}
        >
          {status === 'indexing' ? 'Indexing…' : 'Re-index Project'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => addProject(root)}
          className="w-full text-[13px] font-medium transition-all hover:brightness-110 active:brightness-95"
          style={{
            background: 'var(--success)',
            color: '#fff',
            borderRadius: 8,
            height: 30,
            boxShadow:
              '0 0 0 0.5px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08), inset 0 0.5px 0 rgba(255,255,255,0.25)',
            letterSpacing: '-0.005em',
          }}
        >
          Index Project
        </button>
      )}

      {/* ── Index stats (grouped list) ───────────────── */}
      {stats && (
        <div>
          <div
            className="text-[11px] mb-1.5 px-3"
            style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
          >
            Index
          </div>
          <div
            style={{
              background: 'var(--bg-grouped)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-grouped)',
              overflow: 'hidden',
            }}
          >
            <SettingsRow label="Status" value={statusLabel} />
            <SettingsRow label="Files indexed" value={stats.files.toLocaleString()} />
            <SettingsRow label="Symbols" value={stats.symbols.toLocaleString()} />
            <SettingsRow label="Edges" value={stats.edges.toLocaleString()} />
            {stats.lastIndexed && (
              <SettingsRow
                label="Last indexed"
                value={new Date(stats.lastIndexed).toLocaleString()}
                last
              />
            )}
          </div>
        </div>
      )}

      {/* ── Technology Coverage (grouped list) ───────── */}
      {coverage && (
        <div>
          <div className="flex items-baseline justify-between mb-1.5 px-3">
            <div
              className="text-[11px]"
              style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
            >
              Coverage
            </div>
            <span
              className="text-[11px] font-semibold tabular-nums"
              style={{ color: coverageColor(coverage.coverage.coverage_pct) }}
            >
              {coverage.coverage.coverage_pct}%
            </span>
          </div>
          <div
            style={{
              background: 'var(--bg-grouped)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-grouped)',
              overflow: 'hidden',
            }}
          >
            {/* Progress row */}
            <div className="px-3 py-2.5" style={{ borderBottom: '0.5px solid var(--border-row)' }}>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: 'var(--bg-inset)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${coverage.coverage.coverage_pct}%`,
                    background: coverageColor(coverage.coverage.coverage_pct),
                  }}
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {coverage.coverage.covered} of {coverage.coverage.total_significant} covered
                </span>
              </div>
            </div>

            {/* Gaps */}
            {coverage.gaps.map((gap, i) => {
              const isLast =
                i === coverage.gaps.length - 1 &&
                coverage.unknown.filter((u) => u.needs_plugin === 'likely').length === 0;
              return (
                <div
                  key={gap.name}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                  style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)' }}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {priorityBadge(gap.priority)}
                    <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {gap.name}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.open(buildIssueUrl(gap), '_blank')}
                    className="shrink-0 text-[11px] font-medium transition-colors hover:opacity-80"
                    style={{
                      background: 'var(--accent)',
                      color: '#fff',
                      borderRadius: 6,
                      padding: '2px 10px',
                    }}
                    title={`Request plugin support for ${gap.name}`}
                  >
                    Request
                  </button>
                </div>
              );
            })}

            {/* Unknown packages that likely need plugins */}
            {coverage.unknown
              .filter((u) => u.needs_plugin === 'likely')
              .map((pkg, i, arr) => (
                <div
                  key={pkg.name}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                  style={{
                    borderBottom: i === arr.length - 1 ? 'none' : '0.5px solid var(--border-row)',
                  }}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {priorityBadge(pkg.needs_plugin)}
                    <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {pkg.name}
                    </span>
                    <span
                      className="text-[10px] shrink-0"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {pkg.ecosystem}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.open(buildIssueUrl(pkg), '_blank')}
                    className="shrink-0 text-[11px] font-medium transition-colors hover:opacity-80"
                    style={{
                      background: 'var(--accent)',
                      color: '#fff',
                      borderRadius: 6,
                      padding: '2px 10px',
                    }}
                    title={`Request catalog addition for ${pkg.name}`}
                  >
                    Request
                  </button>
                </div>
              ))}

            {/* All covered message */}
            {!hasGaps && coverage.coverage.total_significant > 0 && (
              <div
                className="text-[12px] text-center px-3 py-2"
                style={{ color: 'var(--success)', borderTop: '0.5px solid var(--border-row)' }}
              >
                All significant dependencies are covered
              </div>
            )}
          </div>
        </div>
      )}

      {coverageLoading && !coverage && (
        <div>
          <div
            className="text-[11px] mb-1.5 px-3"
            style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
          >
            Coverage
          </div>
          <div
            className="px-3 py-3 text-[11px] text-center"
            style={{
              background: 'var(--bg-grouped)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-grouped)',
              color: 'var(--text-tertiary)',
            }}
          >
            Analyzing technology coverage…
          </div>
        </div>
      )}

      {/* ── Quality (debug artifacts, TODOs, hardcoded values, empty functions) ── */}
      {(smells || smellsLoading) && (
        <div>
          <div className="flex items-baseline justify-between mb-1.5 px-3">
            <div
              className="text-[11px]"
              style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
            >
              Quality
            </div>
            {smells && (
              <span
                className="text-[11px] font-semibold tabular-nums"
                style={{
                  color:
                    smells.total === 0
                      ? 'var(--green, #22c55e)'
                      : smells.total > 20
                        ? 'var(--red, #ef4444)'
                        : 'var(--yellow, #eab308)',
                }}
              >
                {smells.total} finding{smells.total === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {/* Category tabs */}
          <div className="flex gap-1 px-3 mb-2">
            {(
              [
                { key: 'debug_artifact', label: 'Debug' },
                { key: 'todo_comment', label: 'TODOs' },
                { key: 'hardcoded_value', label: 'Hardcoded' },
                { key: 'empty_function', label: 'Stubs' },
              ] as const
            ).map((tab) => {
              const active = smellsCategory === tab.key;
              return (
                <button
                  type="button"
                  key={tab.key}
                  onClick={() => setSmellsCategory(tab.key)}
                  className="text-[11px] px-2 py-1 rounded transition-all"
                  style={{
                    background: active ? 'var(--accent)' : 'var(--bg-inset)',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div
            style={{
              background: 'var(--bg-grouped)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-grouped)',
              overflow: 'hidden',
            }}
          >
            {smellsLoading && !smells && (
              <div
                className="px-3 py-3 text-[12px] text-center"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Scanning…
              </div>
            )}
            {smells && smells.findings.length === 0 && (
              <div
                className="px-3 py-3 text-[12px] text-center"
                style={{ color: 'var(--text-tertiary)' }}
              >
                No {smellsCategory.replace('_', ' ')} findings
              </div>
            )}
            {smells?.findings.slice(0, 25).map((f, i) => {
              const isLast = i === Math.min(smells.findings.length, 25) - 1;
              return (
                <button
                  type="button"
                  key={`${f.file}:${f.line}:${i}`}
                  onClick={() => {
                    const api = (window as any).electronAPI;
                    if (api?.openInEditor) api.openInEditor(`${root}/${f.file}:${f.line}`);
                  }}
                  className="flex items-start justify-between gap-2 px-3 py-2 w-full text-left hover:brightness-110"
                  style={{
                    borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)',
                    cursor: 'pointer',
                  }}
                >
                  <div className="flex items-start gap-1.5 min-w-0 flex-1">
                    {priorityBadge(f.priority)}
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-[12px] truncate"
                        style={{
                          color: 'var(--text-primary)',
                          fontFamily: 'SF Mono, Menlo, monospace',
                        }}
                      >
                        {f.snippet}
                      </div>
                      <div
                        className="text-[10px] mt-0.5 truncate"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {f.file}:{f.line}
                        {f.tag ? ` · ${f.tag}` : ''}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
            {smells && smells.findings.length > 25 && (
              <div
                className="px-3 py-1.5 text-[10px] text-center"
                style={{
                  color: 'var(--text-tertiary)',
                  borderTop: '0.5px solid var(--border-row)',
                }}
              >
                + {smells.findings.length - 25} more
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Services (native grouped list with group headers) ── */}
      {(() => {
        // Group services by projectGroup
        const grouped = new Map<string, ServiceInfo[]>();
        const existingGroups: string[] = [];
        for (const svc of svcList) {
          const key = svc.projectGroup ?? '';
          if (!grouped.has(key)) {
            grouped.set(key, []);
            existingGroups.push(key);
          }
          grouped.get(key)!.push(svc);
        }
        const groupKeys = [...grouped.keys()].sort((a, b) => {
          if (!a) return 1; // ungrouped last
          if (!b) return -1;
          return a.localeCompare(b);
        });

        const totalCount = svcList.length;

        return (
          <div>
            {/* Section header with + Add button */}
            <div className="flex items-baseline justify-between mb-1.5 px-3">
              <div className="flex items-baseline gap-1.5">
                <span
                  className="text-[11px]"
                  style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}
                >
                  Services
                </span>
                {totalCount > 0 && (
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {totalCount}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleAddService}
                disabled={addingService}
                className="text-[12px] transition-colors disabled:opacity-40 flex items-center gap-1 hover:opacity-80"
                style={{ color: 'var(--accent)' }}
                title="Add external service"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add
              </button>
            </div>

            {totalCount === 0 ? (
              <div
                className="px-3 py-3 text-[12px] text-center"
                style={{
                  background: 'var(--bg-grouped)',
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-grouped)',
                  color: 'var(--text-tertiary)',
                }}
              >
                No services detected.
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  Re-index the project or add manually.
                </div>
              </div>
            ) : (
              <div className="space-y-3.5">
                {groupKeys.map((groupKey) => {
                  const groupServices = grouped.get(groupKey)!;
                  return (
                    <div key={groupKey || '__ungrouped__'}>
                      {/* Group sub-header */}
                      <div
                        className="text-[11px] font-medium mb-1 px-3"
                        style={{
                          color: groupKey ? 'var(--accent)' : 'var(--text-tertiary)',
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {groupKey || 'Ungrouped'}
                      </div>

                      {/* Service list card */}
                      <div
                        style={{
                          background: 'var(--bg-grouped)',
                          borderRadius: 10,
                          boxShadow: 'var(--shadow-grouped)',
                          overflow: 'hidden',
                        }}
                      >
                        {groupServices.map((svc, i) => {
                          const isLast = i === groupServices.length - 1;
                          return (
                            <div
                              key={svc.id}
                              className="group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-[var(--bg-active)]"
                              style={{
                                borderBottom: isLast ? 'none' : '0.5px solid var(--border-row)',
                              }}
                            >
                              {/* Service icon */}
                              <div
                                className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                                style={{
                                  background: 'var(--bg-inset)',
                                  color: 'var(--text-secondary)',
                                }}
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <rect x="3" y="3" width="18" height="6" rx="1" />
                                  <rect x="3" y="15" width="18" height="6" rx="1" />
                                  <line x1="7" y1="6" x2="7.01" y2="6" />
                                  <line x1="7" y1="18" x2="7.01" y2="18" />
                                </svg>
                              </div>

                              {/* Service info */}
                              <div className="flex-1 min-w-0">
                                <div
                                  className="text-[13px] truncate leading-tight"
                                  style={{ color: 'var(--text-primary)' }}
                                >
                                  {svc.name}
                                </div>
                                <div
                                  className="text-[10px] truncate mt-0.5"
                                  style={{
                                    color: 'var(--text-tertiary)',
                                    fontFamily: 'SF Mono, Menlo, monospace',
                                  }}
                                  title={svc.repoRoot}
                                >
                                  {shortPath(svc.repoRoot)}
                                  {svc.endpointCount > 0 && (
                                    <span style={{ fontFamily: 'inherit' }}>
                                      {' · '}
                                      {svc.endpointCount} endpoints
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Group badge / editor */}
                              {editingGroup === svc.id ? (
                                <form
                                  className="shrink-0 flex items-center"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    handleUpdateGroup(svc.id, groupInput);
                                  }}
                                >
                                  <input
                                    autoFocus
                                    value={groupInput}
                                    onChange={(e) => setGroupInput(e.target.value)}
                                    onBlur={() => handleUpdateGroup(svc.id, groupInput)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setEditingGroup(null);
                                      }
                                    }}
                                    placeholder="Group name"
                                    list={`group-options-${svc.id}`}
                                    className="w-28 text-[12px] outline-none"
                                    style={{
                                      background: 'var(--bg-primary)',
                                      border: '0.5px solid var(--accent)',
                                      borderRadius: 6,
                                      padding: '3px 8px',
                                      color: 'var(--text-primary)',
                                      boxShadow: '0 0 0 2px rgba(0,122,255,0.15)',
                                    }}
                                  />
                                  <datalist id={`group-options-${svc.id}`}>
                                    {existingGroups.filter(Boolean).map((g) => (
                                      <option key={g} value={g} />
                                    ))}
                                  </datalist>
                                </form>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingGroup(svc.id);
                                    setGroupInput(svc.projectGroup ?? '');
                                  }}
                                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] font-medium flex items-center gap-1"
                                  style={{
                                    color: svc.projectGroup
                                      ? 'var(--accent)'
                                      : 'var(--text-secondary)',
                                    background: 'var(--fill-control)',
                                    border: '0.5px solid var(--border)',
                                    borderRadius: 6,
                                    padding: '2px 8px',
                                    boxShadow: 'var(--shadow-control)',
                                  }}
                                  title={
                                    svc.projectGroup
                                      ? `Group: ${svc.projectGroup} · click to change`
                                      : 'Assign to a group'
                                  }
                                >
                                  <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
                                    <line x1="7" y1="7" x2="7.01" y2="7" />
                                  </svg>
                                  {svc.projectGroup || 'Group'}
                                </button>
                              )}

                              {/* Graph button */}
                              {onNavigateToService && (
                                <button
                                  type="button"
                                  onClick={() => onNavigateToService(svc.name)}
                                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity w-[26px] h-[22px] flex items-center justify-center"
                                  style={{
                                    color: 'var(--text-secondary)',
                                    background: 'var(--fill-control)',
                                    border: '0.5px solid var(--border)',
                                    borderRadius: 6,
                                    boxShadow: 'var(--shadow-control)',
                                  }}
                                  title="Open in graph"
                                >
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <circle cx="6" cy="6" r="2.5" />
                                    <circle cx="18" cy="18" r="2.5" />
                                    <circle cx="18" cy="6" r="2.5" />
                                    <path d="M8.5 8.5l7 7M8.5 6H15" />
                                  </svg>
                                </button>
                              )}

                              {/* Remove button */}
                              <button
                                type="button"
                                onClick={() => handleRemoveService(svc.name)}
                                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity w-[22px] h-[22px] flex items-center justify-center rounded-full"
                                style={{ color: 'var(--text-tertiary)' }}
                                onMouseEnter={(e) => {
                                  (e.currentTarget as HTMLElement).style.background =
                                    'var(--destructive)';
                                  (e.currentTarget as HTMLElement).style.color = '#fff';
                                }}
                                onMouseLeave={(e) => {
                                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                                  (e.currentTarget as HTMLElement).style.color =
                                    'var(--text-tertiary)';
                                }}
                                title="Remove service"
                              >
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 10 10"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.75"
                                  strokeLinecap="round"
                                >
                                  <path d="M2 2l6 6M8 2l-6 6" />
                                </svg>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function SettingsRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className="flex items-center justify-between px-3"
      style={{
        borderBottom: last ? 'none' : '0.5px solid var(--border-row)',
        minHeight: 32,
      }}
    >
      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
        {label}
      </span>
      <span
        className="text-[13px] tabular-nums truncate ml-2"
        style={{ color: 'var(--text-secondary)' }}
      >
        {value}
      </span>
    </div>
  );
}
