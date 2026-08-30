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
 *              Index · Guard · Coverage · Quality · Services.
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
import { useTranslation } from 'react-i18next';
import { DaemonDownPane } from '../components/DaemonDownPane';
import { GuardSection } from '../components/GuardSection';
import { ProjectStatsModal } from '../components/ProjectStatsModal';
import { useDaemon } from '../hooks/useDaemon';
import { deriveDaemonState } from '../workspace/useWorkspaceProjects';
import { t } from '../i18n';
import { formatDate, formatNumber, relativeTime } from '../i18n/format';
import { Icon } from '../lattice/icons';
import {
  Badge,
  Button,
  Card,
  ConfirmPopover,
  EmptyState,
  ListRow,
  Menu,
  MenuItem,
  MenuSeparator,
  Section,
  SectionError,
  SegmentedControl,
  Skeleton,
  SkeletonRows,
  StatusDot,
  Toolbar,
  useMenuAnchor,
  type Tone,
} from '../lattice/ui';

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

/* Catalogue keys rather than words: the picker and the empty state name the
   same four categories, and a language switch has to move both. */
const SMELL_CATEGORIES: { value: SmellFinding['category']; labelKey: string }[] = [
  { value: 'debug_artifact', labelKey: 'smellDebug' },
  { value: 'todo_comment', labelKey: 'smellTodo' },
  { value: 'hardcoded_value', labelKey: 'smellHardcoded' },
  { value: 'empty_function', labelKey: 'smellStubs' },
];

/** Sentence-case names for the empty states — "No empty_function findings" was
    leaking the API's own enum into the UI. */
const SMELL_NOUN_KEY: Record<SmellFinding['category'], string> = {
  debug_artifact: 'nounDebug',
  todo_comment: 'nounTodo',
  hardcoded_value: 'nounHardcoded',
  empty_function: 'nounStubs',
};

/* The API's own severity words, said in the reader's language. Anything the
   catalogue does not know falls through to the raw value rather than a key. */
const BADGE_KEY: Record<string, string> = {
  high: 'priorityHigh',
  medium: 'priorityMedium',
  low: 'priorityLow',
  likely: 'needsLikely',
  maybe: 'needsMaybe',
  no: 'needsNo',
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

/** "2 hours ago · Aug 28, 5:01 PM" — the relative form answers "is this
    stale?", the absolute one answers "which run was that?". The old value was
    a bare `8/28/2026, 5:01:49 PM`, which answers neither at a glance. */
export function formatIndexedAt(iso: string, now: number = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return t('overview:unknown');
  const abs = formatDate(ts, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${relativeTime(ts, now)} · ${abs}`;
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

// ── Surface ─────────────────────────────────────────────────────────────────

export function ProjectOverview({
  root,
  onNavigateToService,
}: {
  root: string;
  onNavigateToService?: (serviceName: string) => void;
}) {
  const { t } = useTranslation('overview');
  const {
    projects,
    loading: daemonLoading,
    connected,
    restarting,
    restartDaemon,
    reindexProject,
    addProject,
  } = useDaemon();
  const project = projects.find((p) => p.root === root);
  const status = project?.status ?? 'unknown';
  const progress = project?.progress;
  /* "We haven't heard from the daemon yet" is not "this project was never
     indexed". Without this the panel offered "Index project" for a project it
     was simultaneously reporting 78 files and 700 symbols for. */
  const listPending = !project && (daemonLoading || !connected);

  /* One condition gets one sentence (DESIGN.md §5). With the daemon down this
     surface used to say so six times — the toolbar chip, Guard's own line, and
     four section errors that each claimed "the daemon may still be indexing",
     which is the *wait* state for a process that is not running (TRA-469).

     `deriveDaemonState` rather than a fresh `!connected`: `connected` is false
     for the first moments of every mount, and a naive test would flash a
     daemon-down pane on every project open. Reusing the reducer is also what
     keeps the two surfaces from drifting into two definitions of "down". */
  const daemonDown =
    deriveDaemonState({
      loading: daemonLoading,
      connected,
      liveProjects: projects.length,
      metricsErrorKind: null,
    }) === 'unreachable';

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
      ? t('statusChecking')
      : t('statusDaemonUnreachable')
    : untracked
      ? t('statusNotTracked')
      : status === 'indexing'
        ? t('statusIndexing')
        : status === 'ready'
          ? t('statusReady')
          : status === 'error'
            ? t('statusError')
            : t('statusNotIndexed');

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
  /* The API's word when the catalogue has one, the API's word when it does
     not — a badge is never allowed to render a raw key. */
  const badgeLabel = (value: string): string =>
    BADGE_KEY[value] ? t(BADGE_KEY[value]) : value;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <Toolbar scrolled={scrolled} className="gap-3">
        <StatusDot tone={statusTone} pulse={status === 'indexing'} />
        {/* One line, not a stacked name-over-path: a two-line title made the
            window's 44px band 52px tall, so the content pane started 8px below
            the sidebar's first row for no reason a reader could see (TRA-354).
            The path stays visible — it is what tells four projects called
            "workdir" apart — as a secondary run alongside the name. */}
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <h2
            className="text-[15px] leading-5 font-semibold shrink-0 max-w-[60%] truncate"
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

        {daemonDown ? (
          /* The pane below owns this diagnosis and offers the button that fixes
             it, so the toolbar does not repeat it — the same reason the
             Workspace banner steps aside for DaemonDownPane (TRA-397, TRA-469). */
          null
        ) : listPending ? (
          /* Offering "Index project" before the daemon has answered invites the
             user to re-index something that may already be indexed. The toolbar
             always renders, so the "still checking" wording lives here rather
             than in the Status row, which is itself missing when the fetch
             failed. */
          <Button className="is-status" disabled>
            {t('statusChecking')}
          </Button>
        ) : project ? (
          /* While indexing the action is unavailable, and a DISABLED prominent
             button is white-on-40%-accent — 2.2:1, measured. A bordered button
             marked `is-status` is unpressable but still readable, because this
             label — not the button — is what reports the phase. */
          status === 'indexing' ? (
            <Button className="is-status" icon="refresh" disabled>
              {t('actionIndexing')}
            </Button>
          ) : (
            <Button variant="prominent" icon="refresh" onClick={() => reindexProject(root)}>
              {t('actionReindex')}
            </Button>
          )
        ) : (
          <Button variant="prominent" icon="add" onClick={() => addProject(root)}>
            {untracked ? t('actionReAdd') : t('actionIndex')}
          </Button>
        )}

        <Button
          ref={overflowMenu.ref}
          variant="icon"
          icon="more_horiz"
          onClick={() => (overflowMenu.at ? overflowMenu.close() : overflowMenu.open())}
          aria-haspopup="menu"
          aria-expanded={overflowMenu.at !== null}
          aria-label={t('moreActions')}
          title={t('moreActions')}
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
              aria-label={t('indexingProgress')}
              style={{
                height: '100%',
                width: `${progress.percent}%`,
                background: 'var(--accent)',
                transition: 'width var(--dur-standard) var(--ease-out)',
              }}
            />
          </div>
        )}
      </Toolbar>

      {overflowMenu.at && (
        <Menu x={overflowMenu.at.x} y={overflowMenu.at.y} align="end" onClose={overflowMenu.close}>
          <MenuItem
            icon="monitoring"
            onClick={() => {
              setStatsModalOpen(true);
              overflowMenu.close();
            }}
          >
            {t('menuViewStats')}
          </MenuItem>
          <MenuItem
            icon="add"
            disabled={addingService}
            onClick={() => {
              overflowMenu.close();
              handleAddService();
            }}
          >
            {t('menuAddService')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="folder_open"
            onClick={() => {
              window.electronAPI?.openInEditor?.(root);
              overflowMenu.close();
            }}
          >
            {t('menuOpenInEditor')}
          </MenuItem>
        </Menu>
      )}

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrolled((e.target as HTMLElement).scrollTop > 0)}
      >
        {daemonDown ? (
          /* Every section on this surface reads the daemon, so with the daemon
             down all five render the same failure. Five broken cards is not
             five pieces of information — it is one, said five times, and four
             of those said "may still be indexing" about a process that is not
             running (TRA-469). One statement, one button.

             The flex column is load-bearing: `.ws-center-empty` centres itself
             with `flex: 1`, which does nothing inside this scroll container's
             block formatting context. Without it the pane hugged the top edge
             and left ~900px of empty content below it, while the same component
             on Workspace — which does have a flex parent — sat centred. */
          <div className="h-full flex flex-col">
            <DaemonDownPane restarting={restarting} onRestart={() => void restartDaemon()} />
          </div>
        ) : (
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
          <Section title={t('sectionIndex')}>
            <Card>
              {statsLoad === 'loading' && !stats ? (
                <SkeletonRows rows={5} />
              ) : statsLoad === 'failed' && !stats ? (
                <SectionError what={t('errorIndexSummary')} onRetry={fetchStats} />
              ) : stats ? (
                <>
                  <ListRow
                    label={t('rowStatus')}
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone={statusTone} />
                        {statusLabel}
                      </span>
                    }
                  />
                  <ListRow label={t('rowFiles')} value={formatNumber(stats.files)} />
                  <ListRow label={t('rowSymbols')} value={formatNumber(stats.symbols)} />
                  <ListRow label={t('rowEdges')} value={formatNumber(stats.edges)} />
                  <ListRow
                    label={t('rowLastIndexed')}
                    value={stats.lastIndexed ? formatIndexedAt(stats.lastIndexed) : t('never')}
                    last
                  />
                </>
              ) : (
                <EmptyState
                  compact
                  icon="database"
                  title={t('emptyIndexTitle')}
                  subtitle={t('emptyIndexBody')}
                  action={
                    <Button variant="prominent" icon="add" onClick={() => addProject(root)}>
                      {t('actionIndex')}
                    </Button>
                  }
                />
              )}
            </Card>
          </Section>

          {/* ── Guard ─────────────────────────────────────────────────
              Second, not last: it is live state about how agents read this
              project, which is the same class of question as Index. Coverage,
              Quality and Services are analysis of what was read. */}
          <GuardSection root={root} />

          {/* ── Coverage ───────────────────────────────────────────── */}
          <Section
            title={t('sectionCoverage')}
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
                <SectionError what={t('errorCoverage')} onRetry={fetchCoverage} />
              ) : coverage && coverage.coverage.total_significant === 0 ? (
                /* Nothing to cover is not 100% covered. A full green meter over
                   "0 of 0 dependencies covered" claims a result nobody measured. */
                <EmptyState
                  compact
                  icon="cable"
                  title={t('emptyCoverageTitle')}
                  subtitle={t('emptyCoverageBody')}
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
                        aria-label={t('coverageMeter')}
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
                        {t('coverageCovered', {
                          covered: formatNumber(coverage.coverage.covered),
                          total: formatNumber(coverage.coverage.total_significant),
                        })}
                      </span>
                    </div>
                  </div>

                  {coverage.gaps.map((gap, i) => (
                    <CoverageRow
                      key={gap.name}
                      name={gap.name}
                      tone={PRIORITY_TONE[gap.priority] ?? 'neutral'}
                      badge={badgeLabel(gap.priority)}
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
                      badge={badgeLabel(pkg.needs_plugin)}
                      last={i === likelyUnknown.length - 1}
                      onRequest={() => openInBrowser(buildIssueUrl(pkg))}
                    />
                  ))}
                </>
              ) : (
                <EmptyState
                  compact
                  icon="cable"
                  title={t('emptyCoverageFoundTitle')}
                  subtitle={t('emptyCoverageFoundBody')}
                />
              )}
            </Card>
          </Section>

          {/* ── Quality ────────────────────────────────────────────── */}
          <Section
            title={t('sectionQuality')}
            trailing={
              smells ? (
                <Badge tone={smells.total === 0 ? 'green' : smells.total > 20 ? 'red' : 'orange'}>
                  {t('findings', { count: smells.total, n: formatNumber(smells.total) })}
                </Badge>
              ) : undefined
            }
          >
            <div className="px-1">
              <SegmentedControl
                options={SMELL_CATEGORIES.map((c) => ({ value: c.value, label: t(c.labelKey) }))}
                value={smellsCategory}
                onChange={(v) => setSmellsCategory(v as SmellFinding['category'])}
                aria-label={t('smellCategoryLabel')}
              />
            </div>
            <Card>
              {smellsLoad === 'loading' && !smells ? (
                <SkeletonRows rows={4} />
              ) : smellsLoad === 'failed' && !smells ? (
                <SectionError what={t('errorQuality')} onRetry={() => fetchSmells(smellsCategory)} />
              ) : visibleFindings.length === 0 ? (
                <EmptyState
                  compact
                  icon="check"
                  title={t('emptySmellTitle', { noun: t(SMELL_NOUN_KEY[smellsCategory]) })}
                  subtitle={t('emptySmellBody', { n: formatNumber(smells?.files_scanned ?? 0) })}
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
                      title={t('openInEditorTitle', { file: f.file, line: f.line })}
                    >
                      <Badge tone={PRIORITY_TONE[f.priority] ?? 'neutral'}>
                        {badgeLabel(f.priority)}
                      </Badge>
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
                      {t('moreNotShown', {
                        n: formatNumber(smells.findings.length - FINDING_LIMIT),
                      })}
                    </div>
                  )}
                </>
              )}
            </Card>
          </Section>

          {/* ── Services ───────────────────────────────────────────── */}
          <Section
            title={t('sectionServices')}
            count={svcList.length}
            trailing={
              <Button size="small" icon="add" disabled={addingService} onClick={handleAddService}>
                {t('servicesAdd')}
              </Button>
            }
          >
            {servicesLoad === 'loading' && svcList.length === 0 ? (
              <Card>
                <SkeletonRows rows={2} />
              </Card>
            ) : servicesLoad === 'failed' && svcList.length === 0 ? (
              <Card>
                <SectionError what={t('errorServices')} onRetry={fetchServices} />
              </Card>
            ) : svcList.length === 0 ? (
              <Card>
                <EmptyState
                  compact
                  icon="db_server"
                  title={t('emptyServicesTitle')}
                  subtitle={t('emptyServicesBody')}
                  action={
                    <Button icon="add" disabled={addingService} onClick={handleAddService}>
                      {t('menuAddService')}
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
                          {groupKey || t('noGroup')}
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
                                    placeholder={t('groupPlaceholder')}
                                    aria-label={t('groupFor', { name: svc.name })}
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
                                      ` · ${t('endpoints', {
                                        count: svc.endpointCount,
                                        n: formatNumber(svc.endpointCount),
                                      })}`}
                                  </span>
                                </>
                              )}
                            </span>

                            {/* Always visible: hover was the only way to find
                                these three actions before. */}
                            <Button
                              variant="icon"
                              icon="more_horiz"
                              aria-label={t('actionsFor', { name: svc.name })}
                              title={t('actionsFor', { name: svc.name })}
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
        )}
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
              {t('menuOpenInGraph')}
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
            {t('menuSetGroup')}
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
            {t('menuRemoveService')}
          </MenuItem>
        </Menu>
      )}

      {confirmRemove && (
        <ConfirmPopover
          x={confirmRemove.x}
          y={confirmRemove.y}
          align="end"
          danger
          title={t('removeTitle', { name: confirmRemove.service.name })}
          body={t('removeBody')}
          confirmLabel={t('removeConfirm')}
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
  const { t } = useTranslation('overview');
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
      <Button size="small" onClick={onRequest} title={t('coverageRequestTitle', { name })}>
        {t('coverageRequest')}
      </Button>
    </div>
  );
}
