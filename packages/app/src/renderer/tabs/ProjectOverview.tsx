import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ProjectStatsModal } from '../components/ProjectStatsModal';
import { Icon } from '../lattice/icons';
import { Badge, Button, SegmentedControl, StatusDot, type Tone } from '../lattice/ui';
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

function openInBrowser(url: string): void {
  const api = window.electronAPI;
  if (api?.openExternal) {
    void api.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
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

/** Status is never signalled by colour alone — every tone carries a glyph too. */
function coverageTone(pct: number): { tone: Tone; icon: string } {
  if (pct >= 100) return { tone: 'green', icon: 'check' };
  if (pct >= 80) return { tone: 'gold', icon: 'radio' };
  return { tone: 'red', icon: 'bug_report' };
}

const PRIORITY_TONE: Record<string, Tone> = {
  high: 'red',
  medium: 'gold',
  low: 'neutral',
  likely: 'red',
  maybe: 'gold',
  no: 'neutral',
};

/**
 * "2 hours ago · Aug 28, 5:01 PM" — a relative anchor plus the absolute stamp,
 * because "8/28/2026, 5:01:49 PM" answers neither "is this fresh?" nor "when?".
 * Exported for the unit test; `now` is injectable so the test is not clock-bound.
 */
export function formatLastIndexed(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const absolute = then.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 0) return absolute;
  if (seconds < 45) return `just now · ${absolute}`;
  // [seconds per unit, unit, upper bound in seconds] — first fitting entry wins.
  const scale: Array<[number, Intl.RelativeTimeFormatUnit, number]> = [
    [60, 'minute', 3600],
    [3600, 'hour', 86400],
    [86400, 'day', 604800],
    [604800, 'week', Number.POSITIVE_INFINITY],
  ];
  const [span, unit] = scale.find(([, , limit]) => seconds < limit) ?? scale[scale.length - 1];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return `${rtf.format(-Math.round(seconds / span), unit)} · ${absolute}`;
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

const SMELL_TABS = [
  { value: 'debug_artifact', label: 'Debug' },
  { value: 'todo_comment', label: 'TODOs' },
  { value: 'hardcoded_value', label: 'Hardcoded' },
  { value: 'empty_function', label: 'Stubs' },
] as const;

const SMELL_EMPTY: Record<SmellFinding['category'], string> = {
  debug_artifact: 'No leftover console logs or debugger statements.',
  todo_comment: 'No TODO or FIXME comments in the indexed sources.',
  hardcoded_value: 'No hardcoded URLs, ports or credentials found.',
  empty_function: 'No empty function bodies or unimplemented stubs.',
};

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
  const [statsModalOpen, setStatsModalOpen] = useState(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: status is an intentional trigger — refetches the project overview after the project transitions out of 'indexing' so the panel reflects the new totals.
  useEffect(() => {
    fetchStats();
    fetchCoverage();
    fetchServices();
    fetchSmells(smellsCategory);
  }, [fetchStats, fetchCoverage, fetchServices, fetchSmells, smellsCategory, status]);

  const handleAddService = async () => {
    const api = window.electronAPI;
    if (!api?.selectFolder) return;
    setAddingService(true);
    try {
      const folder = await api.selectFolder();
      if (!folder) return;
      await fetch(`${BASE}/api/projects/subprojects`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
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
      const res = await fetch(`${BASE}/api/projects/services`, { // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
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

  const indexing = status === 'indexing';
  const statusDot: Tone = indexing
    ? 'gold'
    : status === 'error'
      ? 'red'
      : status === 'ready'
        ? 'green'
        : 'neutral';

  const hasGaps =
    coverage &&
    (coverage.gaps.length > 0 ||
      coverage.unknown.filter((u) => u.needs_plugin === 'likely').length > 0);

  const statusLabel = indexing
    ? 'Indexing'
    : status === 'ready'
      ? 'Ready'
      : status === 'error'
        ? 'Error'
        : 'Not indexed';

  const name = root.split(/[/\\]/).filter(Boolean).pop() ?? root;

  return (
    <>
      <div className="flex flex-col min-h-0" style={{ maxWidth: 1120 }}>
        {/* ── Surface header: identity left, actions right ─────────────── */}
        <header
          className="flex items-start gap-3 pb-3"
          style={{ borderBottom: '0.5px solid var(--sep)' }}
        >
          <StatusDot tone={statusDot} pulse={indexing} size={8} className="mt-[7px] shrink-0" />
          <div className="min-w-0 flex-1">
            <h2
              className="text-[17px] font-semibold leading-[22px] truncate"
              style={{ color: 'var(--text-1)', letterSpacing: '-0.012em' }}
              title={name}
            >
              {name}
            </h2>
            <div
              className="text-[11px] leading-[16px] truncate"
              style={{ color: 'var(--text-2)', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
              title={root}
            >
              {shortPath(root)}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="chip"
              icon="monitoring"
              onClick={() => setStatsModalOpen(true)}
              title="Open detailed project statistics"
            >
              View stats
            </Button>
            {project ? (
              <Button
                variant="primary"
                icon="refresh"
                onClick={() => reindexProject(root)}
                disabled={indexing}
                title="Rebuild the index for this project"
              >
                Reindex project
              </Button>
            ) : (
              <Button variant="primary" icon="add" onClick={() => addProject(root)}>
                Index project
              </Button>
            )}
          </div>
        </header>

        {/* ── Indexing progress — a labelled bar, not a filled slab ────── */}
        {indexing && (
          <div className="pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] truncate" style={{ color: 'var(--text-1)' }}>
                {progress?.phase ? `Indexing · ${progress.phase}` : 'Indexing…'}
              </span>
              {progress?.percent != null && (
                <span
                  className="text-[12px] tabular-nums shrink-0"
                  style={{ color: 'var(--text-2)' }}
                >
                  {progress.percent}%
                </span>
              )}
            </div>
            {progress?.percent != null && (
              <div
                role="progressbar"
                aria-label="Indexing progress"
                aria-valuenow={progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-[2px] mt-2 overflow-hidden"
                style={{ background: 'var(--row-hover)', borderRadius: 1 }}
              >
                <div
                  className="h-full transition-[width] duration-300"
                  style={{ width: `${progress.percent}%`, background: 'var(--accent)' }}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Error ────────────────────────────────────────────────────── */}
        {status === 'error' && (
          <Card className="mt-4">
            <div className="flex items-start gap-2.5 px-3.5 py-3">
              <span style={{ color: 'var(--status-red-fg)' }} className="mt-[1px] shrink-0">
                <Icon name="bug_report" size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px]" style={{ color: 'var(--text-1)' }}>
                  Indexing failed
                </div>
                <div className="text-[12px] mt-0.5 break-words" style={{ color: 'var(--text-1)' }}>
                  {project?.error ?? 'The daemon reported an error but gave no detail.'}
                </div>
              </div>
              <Button variant="chip" icon="refresh" onClick={() => reindexProject(root)}>
                Try again
              </Button>
            </div>
          </Card>
        )}

        {/* ── Never indexed ────────────────────────────────────────────── */}
        {!project && (
          <Card className="mt-4">
            <div className="flex flex-col items-center text-center gap-2 px-4 py-8">
              <span style={{ color: 'var(--text-2)' }}>
                <Icon name="account_tree" size={32} />
              </span>
              <div className="text-[17px] font-semibold" style={{ color: 'var(--text-1)' }}>
                Not indexed yet
              </div>
              <div className="text-[13px] max-w-[380px]" style={{ color: 'var(--text-1)' }}>
                trace-mcp needs one pass over this folder before it can answer questions about the
                code.
              </div>
              <Button variant="primary" icon="add" className="mt-1" onClick={() => addProject(root)}>
                Index project
              </Button>
            </div>
          </Card>
        )}

        {/* ── Sections ─────────────────────────────────────────────────── */}
        <div className="grid gap-5 pt-5 pb-4 lg:grid-cols-2 items-start">
          {/* Index */}
          {stats && (
            <Section title="Index">
              <Card>
                <Row label="Status" value={statusLabel} />
                <Row label="Files indexed" value={stats.files.toLocaleString()} />
                <Row label="Symbols" value={stats.symbols.toLocaleString()} />
                <Row label="Edges" value={stats.edges.toLocaleString()} />
                {stats.lastIndexed && (
                  <Row label="Last indexed" value={formatLastIndexed(stats.lastIndexed)} last />
                )}
              </Card>
            </Section>
          )}

          {/* Coverage */}
          {coverage && (
            <Section
              title="Coverage"
              accessory={
                <Badge tone={coverageTone(coverage.coverage.coverage_pct).tone} className="sz-11">
                  <Icon name={coverageTone(coverage.coverage.coverage_pct).icon} size={11} />
                  <span className="tabular-nums">{coverage.coverage.coverage_pct}%</span>
                </Badge>
              }
            >
              <Card>
                <div className="px-3.5 py-3" style={{ borderBottom: '0.5px solid var(--sep)' }}>
                  <div
                    role="progressbar"
                    aria-label="Dependency coverage"
                    aria-valuenow={coverage.coverage.coverage_pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-[2px] overflow-hidden"
                    style={{ background: 'var(--row-hover)', borderRadius: 1 }}
                  >
                    <div
                      className="h-full transition-[width] duration-500"
                      style={{
                        width: `${coverage.coverage.coverage_pct}%`,
                        background: `var(--status-${coverageTone(coverage.coverage.coverage_pct).tone}-hue)`,
                      }}
                    />
                  </div>
                  <div className="text-[12px] mt-2" style={{ color: 'var(--text-1)' }}>
                    <span className="tabular-nums">{coverage.coverage.covered}</span> of{' '}
                    <span className="tabular-nums">{coverage.coverage.total_significant}</span>{' '}
                    significant dependencies covered
                  </div>
                </div>

                {coverage.gaps.map((gap, i) => (
                  <GapRow
                    key={gap.name}
                    name={gap.name}
                    priority={gap.priority}
                    onRequest={() => openInBrowser(buildIssueUrl(gap))}
                    title={`Request plugin support for ${gap.name}`}
                    last={
                      i === coverage.gaps.length - 1 &&
                      coverage.unknown.filter((u) => u.needs_plugin === 'likely').length === 0
                    }
                  />
                ))}

                {coverage.unknown
                  .filter((u) => u.needs_plugin === 'likely')
                  .map((pkg, i, arr) => (
                    <GapRow
                      key={pkg.name}
                      name={pkg.name}
                      note={pkg.ecosystem}
                      priority={pkg.needs_plugin}
                      onRequest={() => openInBrowser(buildIssueUrl(pkg))}
                      title={`Request catalog addition for ${pkg.name}`}
                      last={i === arr.length - 1}
                    />
                  ))}

                {!hasGaps && coverage.coverage.total_significant > 0 && (
                  <div className="flex items-center gap-2 px-3.5 py-2.5">
                    <span style={{ color: 'var(--status-green-fg)' }} className="shrink-0">
                      <Icon name="check" size={14} />
                    </span>
                    <span className="text-[13px]" style={{ color: 'var(--text-1)' }}>
                      Every significant dependency is covered
                    </span>
                  </div>
                )}
              </Card>
            </Section>
          )}

          {coverageLoading && !coverage && (
            <Section title="Coverage">
              <Card>
                <SkeletonRows rows={3} />
              </Card>
            </Section>
          )}

          {/* Quality */}
          {(smells || smellsLoading) && (
            <Section
              title="Quality"
              accessory={
                smells && (
                  <Badge tone={smells.total === 0 ? 'green' : smells.total > 20 ? 'red' : 'gold'} className="sz-11">
                    <Icon name={smells.total === 0 ? 'check' : 'bug_report'} size={11} />
                    <span className="tabular-nums">
                      {smells.total} finding{smells.total === 1 ? '' : 's'}
                    </span>
                  </Badge>
                )
              }
            >
              <div className="mb-2">
                <SegmentedControl
                  size="mini"
                  aria-label="Finding category"
                  options={SMELL_TABS}
                  value={smellsCategory}
                  onChange={setSmellsCategory}
                />
              </div>
              <Card>
                {smellsLoading && !smells && <SkeletonRows rows={4} />}
                {smells && smells.findings.length === 0 && (
                  <div className="flex flex-col items-center text-center gap-1.5 px-4 py-6">
                    <span style={{ color: 'var(--status-green-fg)' }}>
                      <Icon name="check" size={20} />
                    </span>
                    <div className="text-[13px] max-w-[320px]" style={{ color: 'var(--text-1)' }}>
                      {SMELL_EMPTY[smellsCategory]}
                    </div>
                    <Button
                      variant="text"
                      icon="refresh"
                      className="mt-1"
                      onClick={() => fetchSmells(smellsCategory)}
                    >
                      Scan again
                    </Button>
                  </div>
                )}
                {smells?.findings.slice(0, 25).map((f, i) => {
                  const isLast =
                    i === Math.min(smells.findings.length, 25) - 1 && smells.findings.length <= 25;
                  return (
                    <button
                      type="button"
                      // biome-ignore lint/suspicious/noArrayIndexKey: composite key (file+line) may collide for multiple smells in the same line; index disambiguates within a stable, sliced 25-item list.
                      key={`${f.file}:${f.line}:${i}`}
                      onClick={() => {
                        const api = window.electronAPI;
                        if (api?.openInEditor) api.openInEditor(`${root}/${f.file}:${f.line}`);
                      }}
                      className="relative flex items-start gap-2 px-3.5 py-2 w-full text-left hover:bg-[var(--row-hover)]"
                      style={{ cursor: 'default' }}
                    >
                      <Badge tone={PRIORITY_TONE[f.priority] ?? 'neutral'} className="sz-11 mt-[1px]">
                        {f.priority}
                      </Badge>
                      <span className="min-w-0 flex-1" style={{ display: 'block' }}>
                        <span
                          className="text-[12px] truncate"
                          style={{
                            display: 'block',
                            color: 'var(--text-1)',
                            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                          }}
                        >
                          {f.snippet}
                        </span>
                        <span
                          className="text-[11px] mt-0.5 truncate"
                          style={{ display: 'block', color: 'var(--text-2)' }}
                        >
                          {f.file}:{f.line}
                          {f.tag ? ` · ${f.tag}` : ''}
                        </span>
                      </span>
                      {!isLast && <Separator />}
                    </button>
                  );
                })}
                {smells && smells.findings.length > 25 && (
                  <div
                    className="px-3.5 py-2 text-[11px]"
                    style={{ color: 'var(--text-2)', borderTop: '0.5px solid var(--sep)' }}
                  >
                    <span className="tabular-nums">{smells.findings.length - 25}</span> more not
                    shown
                  </div>
                )}
              </Card>
            </Section>
          )}

          {/* Services */}
          <ServicesSection
            services={svcList}
            adding={addingService}
            editingGroup={editingGroup}
            groupInput={groupInput}
            onAdd={handleAddService}
            onRemove={handleRemoveService}
            onEditGroup={(id, initial) => {
              setEditingGroup(id);
              setGroupInput(initial);
            }}
            onGroupInput={setGroupInput}
            onCommitGroup={handleUpdateGroup}
            onCancelGroup={() => setEditingGroup(null)}
            onNavigateToService={onNavigateToService}
          />
        </div>
      </div>
      {statsModalOpen && <ProjectStatsModal root={root} onClose={() => setStatsModalOpen(false)} />}
    </>
  );
}

/* ── Building blocks ──────────────────────────────────────────────────── */

/** Inset grouped-list container: content surface, hairline, no shadow. */
function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`overflow-hidden${className ? ` ${className}` : ''}`}
      style={{
        background: 'var(--island)',
        border: '0.5px solid var(--sep)',
        borderRadius: 10,
      }}
    >
      {children}
    </div>
  );
}

function Section({
  title,
  accessory,
  children,
}: {
  title: string;
  accessory?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1.5 px-1 min-h-[20px]">
        <h3
          className="text-[11px] font-semibold"
          style={{ color: 'var(--text-2)', letterSpacing: '0.04em' }}
        >
          {title}
        </h3>
        {accessory}
      </div>
      {children}
    </section>
  );
}

/** Hairline inset to the text origin, the way a native grouped list draws it. */
function Separator() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 14,
        right: 0,
        bottom: 0,
        height: '0.5px',
        background: 'var(--sep)',
      }}
    />
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className="relative flex items-center justify-between gap-3 px-3.5" style={{ height: 32 }}>
      <span className="text-[13px] shrink-0" style={{ color: 'var(--text-1)' }}>
        {label}
      </span>
      <span
        className="text-[13px] tabular-nums truncate"
        style={{ color: 'var(--text-2)' }}
        title={value}
      >
        {value}
      </span>
      {!last && <Separator />}
    </div>
  );
}

function GapRow({
  name,
  note,
  priority,
  onRequest,
  title,
  last,
}: {
  name: string;
  note?: string;
  priority: string;
  onRequest: () => void;
  title: string;
  last: boolean;
}) {
  return (
    <div className="relative flex items-center justify-between gap-2 px-3.5 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <Badge tone={PRIORITY_TONE[priority] ?? 'neutral'} className="sz-11">{priority}</Badge>
        <span className="text-[13px] truncate" style={{ color: 'var(--text-1)' }}>
          {name}
        </span>
        {note && (
          <span className="text-[11px] shrink-0" style={{ color: 'var(--text-2)' }}>
            {note}
          </span>
        )}
      </div>
      <Button variant="text" onClick={onRequest} title={title}>
        Request
      </Button>
      {!last && <Separator />}
    </div>
  );
}

/** Skeleton at the final row geometry — no centred spinner, no layout shift. */
function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list with no identity of its own.
          key={i}
          className="relative flex items-center px-3.5"
          style={{ height: 32 }}
        >
          <span
            style={{
              display: 'block',
              height: 9,
              width: `${45 + ((i * 17) % 30)}%`,
              borderRadius: 4,
              background: 'var(--row-hover)',
            }}
          />
          {i < rows - 1 && <Separator />}
        </div>
      ))}
    </div>
  );
}

function ServicesSection({
  services,
  adding,
  editingGroup,
  groupInput,
  onAdd,
  onRemove,
  onEditGroup,
  onGroupInput,
  onCommitGroup,
  onCancelGroup,
  onNavigateToService,
}: {
  services: ServiceInfo[];
  adding: boolean;
  editingGroup: number | null;
  groupInput: string;
  onAdd: () => void;
  onRemove: (name: string) => void;
  onEditGroup: (id: number, initial: string) => void;
  onGroupInput: (value: string) => void;
  onCommitGroup: (id: number, group: string | null) => void;
  onCancelGroup: () => void;
  onNavigateToService?: (serviceName: string) => void;
}) {
  const namedGroups = [...new Set(services.map((s) => s.projectGroup).filter(Boolean))] as string[];
  // "Ungrouped" is a data-model word. With no named group there is nothing to
  // disambiguate, so the list is rendered flat and no header is drawn at all.
  const showGroupHeaders = namedGroups.length > 0;
  const groups: Array<{ key: string; label: string | null; items: ServiceInfo[] }> = showGroupHeaders
    ? [
        ...namedGroups
          .slice()
          .sort((a, b) => a.localeCompare(b))
          .map((g) => ({
            key: g,
            label: g,
            items: services.filter((s) => s.projectGroup === g),
          })),
        ...(services.some((s) => !s.projectGroup)
          ? [
              {
                key: '__other__',
                label: 'Other services',
                items: services.filter((s) => !s.projectGroup),
              },
            ]
          : []),
      ]
    : [{ key: '__all__', label: null, items: services }];

  return (
    <Section
      title="Services"
      accessory={
        <div className="flex items-center gap-2">
          {services.length > 0 && (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-2)' }}>
              {services.length}
            </span>
          )}
          <Button variant="text" icon="add" onClick={onAdd} disabled={adding}>
            Add
          </Button>
        </div>
      }
    >
      {services.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center text-center gap-1.5 px-4 py-6">
            <span style={{ color: 'var(--text-2)' }}>
              <Icon name="hub" size={20} />
            </span>
            <div className="text-[13px] max-w-[320px]" style={{ color: 'var(--text-1)' }}>
              No services detected in this project.
            </div>
            <Button variant="text" icon="add" className="mt-1" onClick={onAdd} disabled={adding}>
              Add a service folder
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.key}>
              {group.label && (
                <div
                  className="text-[11px] font-semibold mb-1 px-1"
                  style={{ color: 'var(--text-2)', letterSpacing: '0.04em' }}
                >
                  {group.label}
                </div>
              )}
              <Card>
                {group.items.map((svc, i) => (
                  <ServiceRow
                    key={svc.id}
                    svc={svc}
                    last={i === group.items.length - 1}
                    editing={editingGroup === svc.id}
                    groupInput={groupInput}
                    groupOptions={namedGroups}
                    onEditGroup={onEditGroup}
                    onGroupInput={onGroupInput}
                    onCommitGroup={onCommitGroup}
                    onCancelGroup={onCancelGroup}
                    onRemove={onRemove}
                    onNavigateToService={onNavigateToService}
                  />
                ))}
              </Card>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ServiceRow({
  svc,
  last,
  editing,
  groupInput,
  groupOptions,
  onEditGroup,
  onGroupInput,
  onCommitGroup,
  onCancelGroup,
  onRemove,
  onNavigateToService,
}: {
  svc: ServiceInfo;
  last: boolean;
  editing: boolean;
  groupInput: string;
  groupOptions: string[];
  onEditGroup: (id: number, initial: string) => void;
  onGroupInput: (value: string) => void;
  onCommitGroup: (id: number, group: string | null) => void;
  onCancelGroup: () => void;
  onRemove: (name: string) => void;
  onNavigateToService?: (serviceName: string) => void;
}) {
  return (
    <div className="relative flex items-center gap-2.5 px-3.5 py-2 hover:bg-[var(--row-hover)]">
      <span className="shrink-0" style={{ color: 'var(--text-2)' }}>
        <Icon name="db_server" size={16} />
      </span>

      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate leading-[17px]" style={{ color: 'var(--text-1)' }}>
          {svc.name}
        </div>
        <div
          className="text-[11px] truncate leading-[15px]"
          style={{ color: 'var(--text-2)', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}
          title={svc.repoRoot}
        >
          {shortPath(svc.repoRoot)}
          {svc.endpointCount > 0 && (
            <span style={{ fontFamily: 'inherit' }}>
              {' · '}
              <span className="tabular-nums">{svc.endpointCount}</span> endpoints
            </span>
          )}
        </div>
      </div>

      {editing ? (
        <form
          className="shrink-0 flex items-center"
          onSubmit={(e) => {
            e.preventDefault();
            onCommitGroup(svc.id, groupInput);
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: input only mounts when the user activates the group button; auto-focus is the expected inline-editor behaviour.
            autoFocus
            value={groupInput}
            onChange={(e) => onGroupInput(e.target.value)}
            onBlur={() => onCommitGroup(svc.id, groupInput)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancelGroup();
              }
            }}
            aria-label={`Group for ${svc.name}`}
            placeholder="Group name"
            list={`group-options-${svc.id}`}
            className="w-32 text-[12px] outline-none"
            style={{
              background: 'var(--frame)',
              border: '0.5px solid var(--accent)',
              borderRadius: 8,
              height: 24,
              padding: '0 8px',
              color: 'var(--text-1)',
            }}
          />
          <datalist id={`group-options-${svc.id}`}>
            {groupOptions.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </form>
      ) : (
        <Button
          variant="text"
          icon="tune"
          className="shrink-0"
          onClick={() => onEditGroup(svc.id, svc.projectGroup ?? '')}
          title={
            svc.projectGroup ? `Group: ${svc.projectGroup} — change` : `Assign ${svc.name} to a group`
          }
        >
          {svc.projectGroup || 'Group'}
        </Button>
      )}

      {onNavigateToService && (
        <Button
          variant="mini"
          icon="account_tree"
          className="shrink-0"
          onClick={() => onNavigateToService(svc.name)}
          aria-label={`Open ${svc.name} in graph`}
          title="Open in graph"
        />
      )}

      <Button
        variant="mini"
        icon="close"
        className="shrink-0"
        onClick={() => onRemove(svc.name)}
        aria-label={`Remove ${svc.name}`}
        title="Remove service"
      />

      {!last && <Separator />}
    </div>
  );
}
