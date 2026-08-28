/**
 * ProjectOverview — the project window's landing surface (TRA-293).
 *
 * Layout:
 *   Toolbar  — 52px glass row: status + project name + path on the left, the
 *              single prominent action (Reindex) and an overflow menu on the
 *              right. Indexing progress is a 2px determinate bar on the
 *              toolbar's bottom edge, not a full-bleed accent band across the
 *              content.
 *   Content  — inset grouped lists capped at a readable measure and centred:
 *              Index · Coverage · Quality · Services.
 *
 * What this replaces, measured on the running app before the rewrite:
 *   - "Re-index Project" as a 1640px-wide accent-filled bar spanning the whole
 *     content width, and the same slot rendering "Indexing..." as a solid
 *     periwinkle band with centred white text at ~2:1.
 *   - Seven font sizes on one screen, 61 of 100 text nodes at 9–10px, eight
 *     distinct radii, and 35 of 51 controls under the 24×24 hit-target floor.
 *   - Three empty states that were a single grey line at --text-tertiary
 *     (2.21:1), and row actions that only existed on hover.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ProjectStatsModal } from '../components/ProjectStatsModal';
import { useDaemon } from '../hooks/useDaemon';
import { Icon } from '../lattice/icons';
import {
  Badge,
  Button,
  ConfirmPopover,
  EmptyState,
  Menu,
  MenuItem,
  MenuSeparator,
  SegmentedControl,
  StatusDot,
  useMenuAnchor,
  type Tone,
} from '../lattice/ui';
// ponytail: Skeleton lives next to the workspace surface that introduced it.
// It is a general primitive and wants to move to lattice/ui, but that means
// editing four freshly-merged files for no visual change — do it when a third
// surface needs it.
import { Skeleton } from '../workspace/components/Skeleton';

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
  summary: Record<SmellFinding['category'], number>;
  total: number;
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

/** A fetch that finished and failed is not still loading — the two states read
    differently (an em dash vs a skeleton), so they are tracked separately. */
type Load = 'idle' | 'loading' | 'ready' | 'failed';

const BASE = 'http://127.0.0.1:3741';
const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';
/** Findings past this are summarised rather than listed — the surface is an
    overview, not a results table. */
const FINDING_LIMIT = 25;

const SMELL_CATEGORIES: { value: SmellFinding['category']; label: string }[] = [
  { value: 'debug_artifact', label: 'Debug' },
  { value: 'todo_comment', label: 'TODOs' },
  { value: 'hardcoded_value', label: 'Hardcoded' },
  { value: 'empty_function', label: 'Stubs' },
];

/** Sentence-case names for the empty states — "No empty_function findings" was
    leaking the API's own enum into the UI. */
const SMELL_NOUN: Record<SmellFinding['category'], string> = {
  debug_artifact: 'debug artifacts',
  todo_comment: 'TODO comments',
  hardcoded_value: 'hardcoded values',
  empty_function: 'empty functions',
};

const PRIORITY_TONE: Record<string, Tone> = {
  high: 'red',
  likely: 'red',
  medium: 'orange',
  maybe: 'orange',
  low: 'neutral',
};

export function shortPath(root: string): string {
  return root
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~');
}

export function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** "2 hours ago · Aug 28, 5:01 PM" — the relative form answers "is this
    stale?", the absolute one answers "which run was that?". The old value was
    a bare `8/28/2026, 5:01:49 PM`, which answers neither at a glance. */
export function formatIndexedAt(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'Unknown';
  const abs = new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${relativeTime(t, now)} · ${abs}`;
}

export function coverageTone(pct: number): Tone {
  if (pct >= 100) return 'green';
  if (pct >= 80) return 'orange';
  return 'red';
}

const TONE_VAR: Record<Tone, string> = {
  neutral: 'var(--label-secondary)',
  accent: 'var(--accent)',
  green: 'var(--status-green)',
  orange: 'var(--status-orange)',
  red: 'var(--status-red)',
  blue: 'var(--status-blue)',
  purple: 'var(--status-purple)',
};

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

// ── Section scaffolding ─────────────────────────────────────────────────────

/** A titled group. Grouping is whitespace + a caption, never a rule. */
function Section({
  title,
  count,
  trailing,
  children,
}: {
  title: string;
  count?: number;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1 min-h-6">
        <h3
          className="flex items-baseline gap-1.5 text-[11px] leading-[13px] font-semibold"
          style={{ color: 'var(--label-secondary)' }}
        >
          {title}
          {count !== undefined && count > 0 && (
            <span className="tabular-nums" style={{ color: 'var(--label-secondary)' }}>
              {count.toLocaleString()}
            </span>
          )}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

/** Inset grouped-list container. Content, so: opaque, hairline, no shadow. */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`overflow-hidden${className ? ` ${className}` : ''}`}
      style={{
        background: 'var(--surface)',
        borderRadius: 12,
        border: '0.5px solid var(--separator)',
      }}
    >
      {children}
    </div>
  );
}

/** One label/value row of a grouped list. 32px, 13px both sides. */
function ListRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3"
      style={{
        minHeight: 32,
        borderBottom: last ? 'none' : '0.5px solid var(--separator)',
      }}
    >
      <span className="text-[13px] leading-4" style={{ color: 'var(--label)' }}>
        {label}
      </span>
      <span
        className="text-[13px] leading-4 tabular-nums truncate"
        style={{ color: 'var(--label-secondary)' }}
      >
        {value}
      </span>
    </div>
  );
}

/** Rows at the real 32px geometry so nothing moves when the data lands. */
function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between px-3"
          style={{
            minHeight: 32,
            borderBottom: i === rows - 1 ? 'none' : '0.5px solid var(--separator)',
          }}
        >
          <Skeleton width={92 + ((i * 29) % 40)} height={11} />
          <Skeleton width={48 + ((i * 17) % 32)} height={11} />
        </div>
      ))}
    </div>
  );
}

/** Inline "we couldn't measure this" panel with the one action that helps. */
function SectionError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon name="warning" size={14} />
      <span className="text-[13px] leading-4 flex-1" style={{ color: 'var(--label-secondary)' }}>
        Couldn't load {what}. The daemon may still be indexing.
      </span>
      <Button size="small" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

// ── Surface ─────────────────────────────────────────────────────────────────

export function ProjectOverview({
  root,
  onNavigateToService,
}: {
  root: string;
  onNavigateToService?: (serviceName: string) => void;
}) {
  const { projects, loading: daemonLoading, connected, reindexProject, addProject } = useDaemon();
  const project = projects.find((p) => p.root === root);
  const status = project?.status ?? 'unknown';
  const progress = project?.progress;
  /* "We haven't heard from the daemon yet" is not "this project was never
     indexed". Without this the panel offered "Index project" for a project it
     was simultaneously reporting 78 files and 700 symbols for. */
  const listPending = !project && (daemonLoading || !connected);

  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [statsLoad, setStatsLoad] = useState<Load>('loading');
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [coverageLoad, setCoverageLoad] = useState<Load>('loading');
  const [, setRepos] = useState<SubprojectInfo[]>([]);
  const [svcList, setSvcList] = useState<ServiceInfo[]>([]);
  const [servicesLoad, setServicesLoad] = useState<Load>('loading');
  const [addingService, setAddingService] = useState(false);
  const [editingGroup, setEditingGroup] = useState<number | null>(null);
  const [groupInput, setGroupInput] = useState('');
  const [smells, setSmells] = useState<SmellReport | null>(null);
  const [smellsLoad, setSmellsLoad] = useState<Load>('loading');
  const [smellsCategory, setSmellsCategory] = useState<SmellFinding['category']>('debug_artifact');
  const [statsModalOpen, setStatsModalOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const overflowMenu = useMenuAnchor();
  const rowMenu = useMenuAnchor();
  const [rowMenuFor, setRowMenuFor] = useState<ServiceInfo | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{
    service: ServiceInfo;
    x: number;
    y: number;
  } | null>(null);

  const fetchStats = useCallback(async () => {
    setStatsLoad('loading');
    try {
      const res = await fetch(`${BASE}/api/projects/stats?project=${encodeURIComponent(root)}`);
      if (!res.ok) throw new Error(String(res.status));
      setStats(await res.json());
      setStatsLoad('ready');
    } catch {
      setStatsLoad('failed');
    }
  }, [root]);

  const fetchCoverage = useCallback(async () => {
    setCoverageLoad('loading');
    try {
      const res = await fetch(`${BASE}/api/projects/coverage?project=${encodeURIComponent(root)}`);
      if (!res.ok) throw new Error(String(res.status));
      setCoverage(await res.json());
      setCoverageLoad('ready');
    } catch {
      setCoverageLoad('failed');
    }
  }, [root]);

  const fetchServices = useCallback(async () => {
    setServicesLoad('loading');
    try {
      const params = new URLSearchParams({ project: root });
      const res = await fetch(`${BASE}/api/projects/subprojects?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setRepos(data.repos ?? []);
      setSvcList(data.services ?? []);
      setServicesLoad('ready');
    } catch {
      setServicesLoad('failed');
    }
  }, [root]);

  const fetchSmells = useCallback(
    async (category: SmellFinding['category']) => {
      setSmellsLoad('loading');
      try {
        const params = new URLSearchParams({ project: root, category, limit: '500' });
        const res = await fetch(`${BASE}/api/projects/smells?${params}`);
        if (!res.ok) throw new Error(String(res.status));
        setSmells(await res.json());
        setSmellsLoad('ready');
      } catch {
        setSmellsLoad('failed');
      }
    },
    [root],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: status is an intentional trigger — refetches after the project leaves 'indexing' so the panel reflects the new totals.
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
      /* the list simply stays as it was */
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
        setRepos((prev) => prev.filter((s) => s.name !== name));
        setSvcList((prev) => prev.filter((s) => s.name !== name));
      }
    } catch {
      /* the row stays; the next fetch reconciles */
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
      /* keep the previous group */
    }
    setEditingGroup(null);
  };

  const projectName = root.split(/[/\\]/).filter(Boolean).pop() ?? root;

  const statusTone: Tone =
    status === 'indexing'
      ? 'orange'
      : status === 'error'
        ? 'red'
        : status === 'ready'
          ? 'green'
          : 'neutral';

  /* The daemon can answer with a list that simply does not contain this project
     while an index for it is still on disk — its registry resets, ours doesn't.
     Calling that "Not indexed" one row above "Files indexed 2,196" is a
     contradiction the user has to resolve; "Not tracked" is what actually
     happened, and re-adding the project is what fixes it. */
  const untracked = !listPending && !project && (stats?.files ?? 0) > 0;

  const statusLabel = listPending
    ? connected
      ? 'Checking…'
      : 'Daemon unreachable'
    : untracked
      ? 'Not tracked'
      : status === 'indexing'
        ? 'Indexing'
        : status === 'ready'
          ? 'Ready'
          : status === 'error'
            ? 'Error'
            : 'Not indexed';

  const likelyUnknown = useMemo(
    () => coverage?.unknown.filter((u) => u.needs_plugin === 'likely') ?? [],
    [coverage],
  );
  const hasGaps = (coverage?.gaps.length ?? 0) > 0 || likelyUnknown.length > 0;

  const groups = useMemo(() => {
    const map = new Map<string, ServiceInfo[]>();
    for (const svc of svcList) {
      const key = svc.projectGroup ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(svc);
    }
    const keys = [...map.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    return { map, keys };
  }, [svcList]);
  const existingGroups = groups.keys.filter(Boolean);
  /* A lone unnamed group is not a group — "Ungrouped" was a system word
     labelling the only row on screen. */
  const showGroupHeaders = groups.keys.length > 1 || Boolean(groups.keys[0]);

  const visibleFindings = smells?.findings.slice(0, FINDING_LIMIT) ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-4 shrink-0 glass relative"
        style={{
          height: 52,
          borderBottom: '0.5px solid transparent',
          borderBottomColor: scrolled ? 'var(--separator)' : 'transparent',
          transition: 'border-bottom-color var(--dur-standard) var(--ease-out)',
        }}
      >
        <StatusDot tone={statusTone} pulse={status === 'indexing'} />
        <div className="min-w-0 flex-1">
          <h2
            className="text-[17px] leading-[22px] font-semibold truncate"
            style={{ color: 'var(--label)', letterSpacing: '-0.01em' }}
            title={projectName}
          >
            {projectName}
          </h2>
          <div
            className="text-[11px] leading-[13px] truncate"
            style={{ color: 'var(--label-secondary)', fontFamily: 'var(--font-mono)' }}
            title={root}
          >
            {shortPath(root)}
          </div>
        </div>

        {listPending ? (
          /* Offering "Index project" before the daemon has answered invites the
             user to re-index something that may already be indexed. The toolbar
             always renders, so the daemon-down wording lives here rather than in
             the Status row, which is itself missing when the fetch failed. */
          <Button className="is-status" disabled>
            {connected ? 'Checking…' : 'Daemon unreachable'}
          </Button>
        ) : project ? (
          /* While indexing the action is unavailable, and a DISABLED prominent
             button is white-on-40%-accent — 2.2:1, measured. A bordered button
             marked `is-status` is unpressable but still readable, because this
             label — not the button — is what reports the phase. */
          status === 'indexing' ? (
            <Button className="is-status" icon="refresh" disabled>
              Indexing…
            </Button>
          ) : (
            <Button variant="prominent" icon="refresh" onClick={() => reindexProject(root)}>
              Reindex
            </Button>
          )
        ) : (
          <Button variant="prominent" icon="add" onClick={() => addProject(root)}>
            {untracked ? 'Re-add project' : 'Index project'}
          </Button>
        )}

        <Button
          ref={overflowMenu.ref}
          variant="icon"
          icon="more_horiz"
          onClick={() => (overflowMenu.at ? overflowMenu.close() : overflowMenu.open())}
          aria-haspopup="menu"
          aria-expanded={overflowMenu.at !== null}
          aria-label="More actions"
          title="More actions"
        />

        {/* Indexing progress rides the toolbar's bottom edge — a 2px accent
            rule, not a full-bleed band with centred white text on it. */}
        {status === 'indexing' && progress?.percent != null && (
          <div
            className="absolute left-0 right-0 bottom-0"
            style={{ height: 2, background: 'var(--fill-quaternary)' }}
          >
            <div
              role="progressbar"
              aria-valuenow={progress.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Indexing progress"
              style={{
                height: '100%',
                width: `${progress.percent}%`,
                background: 'var(--accent)',
                transition: 'width var(--dur-standard) var(--ease-out)',
              }}
            />
          </div>
        )}
      </div>

      {overflowMenu.at && (
        <Menu x={overflowMenu.at.x} y={overflowMenu.at.y} align="end" onClose={overflowMenu.close}>
          <MenuItem
            icon="monitoring"
            onClick={() => {
              setStatsModalOpen(true);
              overflowMenu.close();
            }}
          >
            View stats
          </MenuItem>
          <MenuItem
            icon="add"
            disabled={addingService}
            onClick={() => {
              overflowMenu.close();
              handleAddService();
            }}
          >
            Add service…
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="folder_open"
            onClick={() => {
              window.electronAPI?.openInEditor?.(root);
              overflowMenu.close();
            }}
          >
            Open in editor
          </MenuItem>
        </Menu>
      )}

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        <div className="flex flex-col gap-6 px-4 py-4 mx-auto w-full" style={{ maxWidth: 720 }}>
          {/* Indexing caption — the phase in words, next to the bar above. */}
          {status === 'indexing' && progress?.phase && (
            <div
              className="text-[13px] leading-4 -mb-2 px-1 flex items-center gap-1.5"
              style={{ color: 'var(--label-secondary)' }}
            >
              <Icon name="refresh" size={13} />
              <span className="truncate">{progress.phase}</span>
              {progress.percent != null && (
                <span className="tabular-nums">· {progress.percent}%</span>
              )}
            </div>
          )}

          {/* ── Index ──────────────────────────────────────────────── */}
          <Section title="Index">
            <Card>
              {statsLoad === 'loading' && !stats ? (
                <SkeletonRows rows={5} />
              ) : statsLoad === 'failed' && !stats ? (
                <SectionError what="the index summary" onRetry={fetchStats} />
              ) : stats ? (
                <>
                  <ListRow
                    label="Status"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone={statusTone} />
                        {statusLabel}
                      </span>
                    }
                  />
                  <ListRow label="Files indexed" value={stats.files.toLocaleString()} />
                  <ListRow label="Symbols" value={stats.symbols.toLocaleString()} />
                  <ListRow label="Edges" value={stats.edges.toLocaleString()} />
                  <ListRow
                    label="Last indexed"
                    value={stats.lastIndexed ? formatIndexedAt(stats.lastIndexed) : 'Never'}
                    last
                  />
                </>
              ) : (
                <EmptyState
                  compact
                  icon="database"
                  title="Not indexed yet"
                  subtitle="Index this project to explore its symbols, edges and history."
                  action={
                    <Button variant="prominent" icon="add" onClick={() => addProject(root)}>
                      Index project
                    </Button>
                  }
                />
              )}
            </Card>
          </Section>

          {/* ── Coverage ───────────────────────────────────────────── */}
          <Section
            title="Coverage"
            trailing={
              coverage && coverage.coverage.total_significant > 0 ? (
                <span
                  className="text-[11px] leading-[13px] font-semibold tabular-nums"
                  style={{ color: TONE_VAR[coverageTone(coverage.coverage.coverage_pct)] }}
                >
                  {coverage.coverage.coverage_pct}%
                </span>
              ) : undefined
            }
          >
            <Card>
              {coverageLoad === 'loading' && !coverage ? (
                <div className="px-3 py-3 flex flex-col gap-2">
                  <Skeleton width="100%" height={6} radius={3} />
                  <Skeleton width={140} height={11} />
                </div>
              ) : coverageLoad === 'failed' && !coverage ? (
                <SectionError what="dependency coverage" onRetry={fetchCoverage} />
              ) : coverage && coverage.coverage.total_significant === 0 ? (
                /* Nothing to cover is not 100% covered. A full green meter over
                   "0 of 0 dependencies covered" claims a result nobody measured. */
                <EmptyState
                  compact
                  icon="cable"
                  title="No dependencies detected"
                  subtitle="Coverage appears once this project has a dependency manifest in the index."
                />
              ) : coverage ? (
                <>
                  <div
                    className="px-3 py-3"
                    style={{
                      borderBottom: hasGaps ? '0.5px solid var(--separator)' : 'none',
                    }}
                  >
                    <div
                      className="overflow-hidden"
                      style={{ height: 6, borderRadius: 3, background: 'var(--fill-quaternary)' }}
                    >
                      <div
                        role="progressbar"
                        aria-valuenow={coverage.coverage.coverage_pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="Dependency coverage"
                        style={{
                          height: '100%',
                          borderRadius: 3,
                          width: `${coverage.coverage.coverage_pct}%`,
                          background: TONE_VAR[coverageTone(coverage.coverage.coverage_pct)],
                          transition: 'width var(--dur-large) var(--ease-out)',
                        }}
                      />
                    </div>
                    {/* Status arrives with a glyph and a left-aligned sentence,
                        never as centred green prose. */}
                    <div
                      className="flex items-center gap-1.5 mt-2 text-[13px] leading-4"
                      style={{ color: 'var(--label-secondary)' }}
                    >
                      <Icon name={hasGaps ? 'warning' : 'check'} size={13} />
                      <span className="tabular-nums">
                        {coverage.coverage.covered} of {coverage.coverage.total_significant}{' '}
                        dependencies covered
                      </span>
                    </div>
                  </div>

                  {coverage.gaps.map((gap, i) => (
                    <CoverageRow
                      key={gap.name}
                      name={gap.name}
                      tone={PRIORITY_TONE[gap.priority] ?? 'neutral'}
                      badge={gap.priority}
                      last={i === coverage.gaps.length - 1 && likelyUnknown.length === 0}
                      onRequest={() => openInBrowser(buildIssueUrl(gap))}
                    />
                  ))}
                  {likelyUnknown.map((pkg, i) => (
                    <CoverageRow
                      key={pkg.name}
                      name={pkg.name}
                      meta={pkg.ecosystem}
                      tone={PRIORITY_TONE[pkg.needs_plugin] ?? 'neutral'}
                      badge={pkg.needs_plugin}
                      last={i === likelyUnknown.length - 1}
                      onRequest={() => openInBrowser(buildIssueUrl(pkg))}
                    />
                  ))}
                </>
              ) : (
                <EmptyState
                  compact
                  icon="cable"
                  title="No dependencies found"
                  subtitle="Coverage appears once the project has a dependency manifest indexed."
                />
              )}
            </Card>
          </Section>

          {/* ── Quality ────────────────────────────────────────────── */}
          <Section
            title="Quality"
            trailing={
              smells ? (
                <Badge tone={smells.total === 0 ? 'green' : smells.total > 20 ? 'red' : 'orange'}>
                  {smells.total.toLocaleString()} finding{smells.total === 1 ? '' : 's'}
                </Badge>
              ) : undefined
            }
          >
            <div className="px-1">
              <SegmentedControl
                options={SMELL_CATEGORIES}
                value={smellsCategory}
                onChange={(v) => setSmellsCategory(v as SmellFinding['category'])}
                aria-label="Finding category"
              />
            </div>
            <Card>
              {smellsLoad === 'loading' && !smells ? (
                <SkeletonRows rows={4} />
              ) : smellsLoad === 'failed' && !smells ? (
                <SectionError what="the quality scan" onRetry={() => fetchSmells(smellsCategory)} />
              ) : visibleFindings.length === 0 ? (
                <EmptyState
                  compact
                  icon="check"
                  title={`No ${SMELL_NOUN[smellsCategory]}`}
                  subtitle={`Nothing to clean up in this category across ${(smells?.files_scanned ?? 0).toLocaleString()} scanned files.`}
                />
              ) : (
                <>
                  {visibleFindings.map((f, i) => (
                    <button
                      type="button"
                      // biome-ignore lint/suspicious/noArrayIndexKey: file+line can repeat for several findings on one line; the index disambiguates within a stable sliced list.
                      key={`${f.file}:${f.line}:${i}`}
                      onClick={() =>
                        window.electronAPI?.openInEditor?.(`${root}/${f.file}:${f.line}`)
                      }
                      className="flex items-start gap-2 px-3 py-2 w-full text-left"
                      style={{
                        borderBottom:
                          i === visibleFindings.length - 1 && smells!.findings.length <= FINDING_LIMIT
                            ? 'none'
                            : '0.5px solid var(--separator)',
                        cursor: 'default',
                      }}
                      title={`Open ${f.file}:${f.line} in your editor`}
                    >
                      <Badge tone={PRIORITY_TONE[f.priority] ?? 'neutral'}>{f.priority}</Badge>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block text-[13px] leading-4 truncate"
                          style={{ color: 'var(--label)', fontFamily: 'var(--font-mono)' }}
                        >
                          {f.snippet}
                        </span>
                        <span
                          className="block text-[11px] leading-[13px] truncate mt-0.5"
                          style={{ color: 'var(--label-secondary)' }}
                        >
                          {f.file}:{f.line}
                          {f.tag ? ` · ${f.tag}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                  {smells && smells.findings.length > FINDING_LIMIT && (
                    <div
                      className="px-3 py-2 text-[11px] leading-[13px]"
                      style={{ color: 'var(--label-secondary)' }}
                    >
                      {(smells.findings.length - FINDING_LIMIT).toLocaleString()} more not shown
                    </div>
                  )}
                </>
              )}
            </Card>
          </Section>

          {/* ── Services ───────────────────────────────────────────── */}
          <Section
            title="Services"
            count={svcList.length}
            trailing={
              <Button size="small" icon="add" disabled={addingService} onClick={handleAddService}>
                Add
              </Button>
            }
          >
            {servicesLoad === 'loading' && svcList.length === 0 ? (
              <Card>
                <SkeletonRows rows={2} />
              </Card>
            ) : servicesLoad === 'failed' && svcList.length === 0 ? (
              <Card>
                <SectionError what="the service list" onRetry={fetchServices} />
              </Card>
            ) : svcList.length === 0 ? (
              <Card>
                <EmptyState
                  compact
                  icon="db_server"
                  title="No services detected"
                  subtitle="Services are found when the project is indexed, or you can point at a repository yourself."
                  action={
                    <Button icon="add" disabled={addingService} onClick={handleAddService}>
                      Add service…
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.keys.map((groupKey) => {
                  const groupServices = groups.map.get(groupKey)!;
                  return (
                    <div key={groupKey || '__ungrouped__'} className="flex flex-col gap-1.5">
                      {showGroupHeaders && (
                        <div
                          className="text-[11px] leading-[13px] font-medium px-1"
                          style={{ color: 'var(--label-secondary)' }}
                        >
                          {groupKey || 'No group'}
                        </div>
                      )}
                      <Card>
                        {groupServices.map((svc, i) => (
                          <div
                            key={svc.id}
                            className="flex items-center gap-2 px-3"
                            style={{
                              minHeight: 44,
                              borderBottom:
                                i === groupServices.length - 1
                                  ? 'none'
                                  : '0.5px solid var(--separator)',
                            }}
                          >
                            <span
                              className="shrink-0 inline-flex items-center justify-center"
                              style={{
                                width: 24,
                                height: 24,
                                borderRadius: 6,
                                background: 'var(--fill-quaternary)',
                                color: 'var(--label-secondary)',
                              }}
                            >
                              <Icon name="db_server" size={14} />
                            </span>

                            <span className="flex-1 min-w-0">
                              {editingGroup === svc.id ? (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    handleUpdateGroup(svc.id, groupInput);
                                  }}
                                >
                                  <input
                                    // biome-ignore lint/a11y/noAutofocus: the input only mounts after the user picks "Set group…", where focus is the expected next step.
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
                                    aria-label={`Group for ${svc.name}`}
                                    list={`group-options-${svc.id}`}
                                    className="w-full text-[13px] outline-none"
                                    style={{
                                      background: 'var(--surface)',
                                      border: '0.5px solid var(--separator)',
                                      borderRadius: 999,
                                      height: 24,
                                      padding: '0 10px',
                                      color: 'var(--label)',
                                    }}
                                  />
                                  <datalist id={`group-options-${svc.id}`}>
                                    {existingGroups.map((g) => (
                                      <option key={g} value={g} />
                                    ))}
                                  </datalist>
                                </form>
                              ) : (
                                <>
                                  <span
                                    className="block text-[13px] leading-4 truncate"
                                    style={{ color: 'var(--label)' }}
                                  >
                                    {svc.name}
                                  </span>
                                  <span
                                    className="block text-[11px] leading-[13px] truncate"
                                    style={{ color: 'var(--label-secondary)' }}
                                    title={svc.repoRoot}
                                  >
                                    <span style={{ fontFamily: 'var(--font-mono)' }}>
                                      {shortPath(svc.repoRoot)}
                                    </span>
                                    {svc.endpointCount > 0 &&
                                      ` · ${svc.endpointCount.toLocaleString()} endpoint${svc.endpointCount === 1 ? '' : 's'}`}
                                  </span>
                                </>
                              )}
                            </span>

                            {/* Always visible: hover was the only way to find
                                these three actions before. */}
                            <Button
                              variant="icon"
                              icon="more_horiz"
                              aria-label={`Actions for ${svc.name}`}
                              title={`Actions for ${svc.name}`}
                              aria-haspopup="menu"
                              ref={rowMenuFor?.id === svc.id ? rowMenu.ref : undefined}
                              onClick={(e) => {
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setRowMenuFor(svc);
                                rowMenu.openAt({ x: r.right, y: r.bottom + 4 });
                              }}
                            />
                          </div>
                        ))}
                      </Card>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>
      </div>

      {rowMenu.at && rowMenuFor && (
        <Menu
          x={rowMenu.at.x}
          y={rowMenu.at.y}
          align="end"
          onClose={() => {
            rowMenu.close();
            setRowMenuFor(null);
          }}
        >
          {onNavigateToService && (
            <MenuItem
              icon="hub"
              onClick={() => {
                onNavigateToService(rowMenuFor.name);
                rowMenu.close();
              }}
            >
              Open in graph
            </MenuItem>
          )}
          <MenuItem
            icon="tune"
            onClick={() => {
              setEditingGroup(rowMenuFor.id);
              setGroupInput(rowMenuFor.projectGroup ?? '');
              rowMenu.close();
            }}
          >
            Set group…
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            icon="close"
            onClick={() => {
              setConfirmRemove({ service: rowMenuFor, x: rowMenu.at!.x, y: rowMenu.at!.y });
              rowMenu.close();
            }}
          >
            Remove service…
          </MenuItem>
        </Menu>
      )}

      {confirmRemove && (
        <ConfirmPopover
          x={confirmRemove.x}
          y={confirmRemove.y}
          align="end"
          danger
          title={`Remove ${confirmRemove.service.name}?`}
          body="The service stops being tracked here. Nothing on disk changes."
          confirmLabel="Remove service"
          onConfirm={() => {
            handleRemoveService(confirmRemove.service.name);
            setConfirmRemove(null);
            setRowMenuFor(null);
          }}
          onCancel={() => {
            setConfirmRemove(null);
            setRowMenuFor(null);
          }}
        />
      )}

      {statsModalOpen && <ProjectStatsModal root={root} onClose={() => setStatsModalOpen(false)} />}
    </div>
  );
}

/** One uncovered dependency. The "Request" action repeats down the list, so it
    is bordered — prominence is for the one action per region, not for twelve. */
function CoverageRow({
  name,
  meta,
  tone,
  badge,
  last,
  onRequest,
}: {
  name: string;
  meta?: string;
  tone: Tone;
  badge: string;
  last: boolean;
  onRequest: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-2 px-3"
      style={{ minHeight: 36, borderBottom: last ? 'none' : '0.5px solid var(--separator)' }}
    >
      <span className="flex items-center gap-2 min-w-0">
        <Badge tone={tone}>{badge}</Badge>
        <span className="text-[13px] leading-4 truncate" style={{ color: 'var(--label)' }}>
          {name}
        </span>
        {meta && (
          <span
            className="text-[11px] leading-[13px] shrink-0"
            style={{ color: 'var(--label-secondary)' }}
          >
            {meta}
          </span>
        )}
      </span>
      <Button size="small" onClick={onRequest} title={`Open a plugin request for ${name}`}>
        Request
      </Button>
    </div>
  );
}
