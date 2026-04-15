import { useState, useEffect, useCallback } from 'react';
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
  const title = isGap
    ? `Plugin support: ${gap.name}`
    : `Catalog review: ${gap.name}`;
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
    high:   { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    medium: { bg: 'rgba(234,179,8,0.15)',  text: '#eab308' },
    low:    { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af' },
    likely: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
    maybe:  { bg: 'rgba(234,179,8,0.15)',  text: '#eab308' },
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

interface ServiceInfo {
  id: number;
  name: string;
  repoRoot: string;
  serviceType: string | null;
  projectGroup: string | null;
  endpointCount: number;
}

export function ProjectOverview({ root, onNavigateToService }: {
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
  const [services, setServices] = useState<SubprojectInfo[]>([]);
  const [svcList, setSvcList] = useState<ServiceInfo[]>([]);
  const [addingService, setAddingService] = useState(false);
  const [editingGroup, setEditingGroup] = useState<number | null>(null);
  const [groupInput, setGroupInput] = useState('');

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/projects/stats?project=${encodeURIComponent(root)}`);
      if (res.ok) setStats(await res.json());
    } catch { /* optional */ }
  }, [root]);

  const fetchCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      const res = await fetch(`${BASE}/api/projects/coverage?project=${encodeURIComponent(root)}`);
      if (res.ok) setCoverage(await res.json());
    } catch { /* optional */ }
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
    } catch { /* optional */ }
  }, [root]);

  useEffect(() => {
    fetchStats();
    fetchCoverage();
    fetchServices();
  }, [fetchStats, fetchCoverage, fetchServices, status]);

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
    } catch { /* optional */ }
    finally { setAddingService(false); }
  };

  const handleRemoveService = async (name: string) => {
    try {
      const res = await fetch(`${BASE}/api/projects/subprojects?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) setServices((prev) => prev.filter((s) => s.name !== name));
    } catch { /* optional */ }
  };

  const handleUpdateGroup = async (serviceId: number, projectGroup: string | null) => {
    try {
      const res = await fetch(`${BASE}/api/projects/services`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId, projectGroup: projectGroup || null }),
      });
      if (res.ok) {
        setSvcList((prev) => prev.map((s) =>
          s.id === serviceId ? { ...s, projectGroup: projectGroup || null } : s,
        ));
      }
    } catch { /* optional */ }
    setEditingGroup(null);
  };

  const statusDot = status === 'indexing' ? 'idle' as const
    : status === 'error' ? 'error' as const
    : status === 'ready' ? 'active' as const
    : 'disconnected' as const;

  const hasGaps = coverage && (coverage.gaps.length > 0 || coverage.unknown.filter(u => u.needs_plugin === 'likely').length > 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <StatusDot status={statusDot} />
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {root.split(/[/\\]/).filter(Boolean).pop()}
          </h2>
        </div>
        <div className="text-[11px] mt-0.5 ml-5" style={{ color: 'var(--text-tertiary)' }}>
          {shortPath(root)}
        </div>
      </div>

      {/* Status card */}
      <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Status</span>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {status === 'indexing' ? 'Indexing…' : status === 'ready' ? 'Ready' : status}
          </span>
        </div>
        {status === 'indexing' && progress?.percent != null && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--text-tertiary)' }}>
              <span>{progress.phase}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${progress.percent}%`, background: 'var(--accent)' }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Stats card */}
      {stats && (
        <div className="px-3 py-2.5 rounded-lg space-y-2" style={{ background: 'var(--bg-secondary)' }}>
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Index Stats
          </div>
          <Row label="Files indexed" value={stats.files.toLocaleString()} />
          <Row label="Symbols" value={stats.symbols.toLocaleString()} />
          <Row label="Edges (dependencies)" value={stats.edges.toLocaleString()} />
          {stats.lastIndexed && (
            <Row label="Last indexed" value={new Date(stats.lastIndexed).toLocaleString()} />
          )}
        </div>
      )}

      {/* Technology Coverage card */}
      {coverage && (
        <div className="px-3 py-2.5 rounded-lg space-y-2.5" style={{ background: 'var(--bg-secondary)' }}>
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
              Technology Coverage
            </div>
            <span
              className="text-[11px] font-bold tabular-nums"
              style={{ color: coverageColor(coverage.coverage.coverage_pct) }}
            >
              {coverage.coverage.coverage_pct}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${coverage.coverage.coverage_pct}%`,
                background: coverageColor(coverage.coverage.coverage_pct),
              }}
            />
          </div>

          <Row
            label="Significant dependencies"
            value={`${coverage.coverage.covered} / ${coverage.coverage.total_significant} covered`}
          />

          {/* Gaps */}
          {coverage.gaps.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Missing plugins
              </div>
              {coverage.gaps.map((gap) => (
                <div key={gap.name} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {priorityBadge(gap.priority)}
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {gap.name}
                    </span>
                  </div>
                  <button
                    onClick={() => window.open(buildIssueUrl(gap), '_blank')}
                    className="shrink-0 text-[10px] px-2 py-0.5 rounded font-medium transition-colors hover:opacity-80"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    title={`Request plugin support for ${gap.name}`}
                  >
                    Request
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Unknown packages that likely need plugins */}
          {coverage.unknown.filter(u => u.needs_plugin === 'likely').length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Not in catalog (likely needs plugin)
              </div>
              {coverage.unknown.filter(u => u.needs_plugin === 'likely').map((pkg) => (
                <div key={pkg.name} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {priorityBadge(pkg.needs_plugin)}
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {pkg.name}
                    </span>
                    <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
                      [{pkg.ecosystem}]
                    </span>
                  </div>
                  <button
                    onClick={() => window.open(buildIssueUrl(pkg), '_blank')}
                    className="shrink-0 text-[10px] px-2 py-0.5 rounded font-medium transition-colors hover:opacity-80"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    title={`Request catalog addition for ${pkg.name}`}
                  >
                    Request
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* All covered message */}
          {!hasGaps && coverage.coverage.total_significant > 0 && (
            <div className="text-[11px] text-center py-1" style={{ color: 'var(--green, #22c55e)' }}>
              All significant dependencies are covered
            </div>
          )}
        </div>
      )}

      {coverageLoading && !coverage && (
        <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
          <div className="text-[11px] text-center" style={{ color: 'var(--text-tertiary)' }}>
            Analyzing technology coverage…
          </div>
        </div>
      )}

      {/* Services card — grouped by project_group */}
      <div className="px-3 py-2.5 rounded-lg space-y-2" style={{ background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Services
          </div>
          <button
            onClick={handleAddService}
            disabled={addingService}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-[var(--bg-active)] disabled:opacity-40"
            style={{ color: 'var(--accent)' }}
            title="Add external service"
          >
            + Add
          </button>
        </div>

        {svcList.length === 0 && services.length === 0 ? (
          <div className="text-[11px] py-1" style={{ color: 'var(--text-tertiary)' }}>
            No services detected. Re-index the project or add manually.
          </div>
        ) : (() => {
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

          return (
            <div className="flex flex-col gap-2">
              {groupKeys.map((groupKey) => {
                const groupServices = grouped.get(groupKey)!;
                return (
                  <div key={groupKey || '__ungrouped__'}>
                    {/* Group header */}
                    <div
                      className="text-[9px] font-semibold uppercase tracking-wider mb-1 px-0.5"
                      style={{ color: groupKey ? 'var(--accent)' : 'var(--text-tertiary)' }}
                    >
                      {groupKey || 'Ungrouped'}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {groupServices.map((svc) => (
                        <div
                          key={svc.id}
                          className="group flex items-center gap-1.5 rounded-md transition-colors hover:bg-[var(--bg-active)] -mx-1 px-1"
                        >
                          <button
                            onClick={() => onNavigateToService?.(svc.name)}
                            className="flex-1 min-w-0 text-left py-1"
                            title={`${svc.repoRoot}\n${svc.endpointCount} endpoints\nGroup: ${svc.projectGroup ?? 'none'}`}
                          >
                            <div className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                              {svc.name}
                            </div>
                            <div className="text-[9px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                              {shortPath(svc.repoRoot)}
                              {svc.endpointCount > 0 && ` · ${svc.endpointCount} endpoints`}
                            </div>
                          </button>

                          {/* Group edit button */}
                          {editingGroup === svc.id ? (
                            <form
                              className="shrink-0 flex items-center gap-1"
                              onSubmit={(e) => { e.preventDefault(); handleUpdateGroup(svc.id, groupInput); }}
                            >
                              <input
                                autoFocus
                                value={groupInput}
                                onChange={(e) => setGroupInput(e.target.value)}
                                onBlur={() => setEditingGroup(null)}
                                placeholder="group"
                                list="group-options"
                                className="w-16 text-[10px] px-1 py-0.5 rounded border outline-none"
                                style={{
                                  background: 'var(--bg-primary)',
                                  borderColor: 'var(--border)',
                                  color: 'var(--text-primary)',
                                }}
                              />
                              <datalist id="group-options">
                                {existingGroups.filter(Boolean).map((g) => (
                                  <option key={g} value={g} />
                                ))}
                              </datalist>
                            </form>
                          ) : (
                            <button
                              onClick={() => { setEditingGroup(svc.id); setGroupInput(svc.projectGroup ?? ''); }}
                              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[9px] px-1 py-0.5 rounded"
                              style={{ color: 'var(--text-tertiary)' }}
                              title="Change group"
                            >
                              grp
                            </button>
                          )}

                          <button
                            onClick={() => handleRemoveService(svc.name)}
                            className="shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--bg-secondary)]"
                            style={{ color: 'var(--text-tertiary)' }}
                            title="Remove service"
                          >
                            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M1 1l6 6M7 1l-6 6" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* Actions */}
      <div className="space-y-2">
        {project ? (
          <button
            onClick={() => reindexProject(root)}
            disabled={status === 'indexing'}
            className="w-full text-xs px-3 py-2 rounded-lg font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {status === 'indexing' ? 'Indexing…' : 'Re-index project'}
          </button>
        ) : (
          <button
            onClick={() => addProject(root)}
            className="w-full text-xs px-3 py-2 rounded-lg font-medium transition-colors"
            style={{ background: 'var(--green, #22c55e)', color: '#fff' }}
          >
            Index project
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-[11px] font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
