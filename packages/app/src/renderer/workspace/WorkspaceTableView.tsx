/**
 * WorkspaceTableView — sortable wide-table view of merged projects.
 *
 *  - selection checkbox column (multi-row select + select-all in the header)
 *  - inline progress bar inside the Status cell when a pipeline is running
 *  - per-row Open / Re-index / Remove actions, and the same set on right-click
 *  - dims Re-index/Remove when `canMutate === false` or `inDaemon === false`
 *  - ↑ / ↓ move a row cursor, ⏎ opens it; the table is one tab stop
 *  - rows are windowed past {@link WINDOW_THRESHOLD} so a thousand projects
 *    cost the same as a hundred
 *
 * Data flows in via props already sorted — the parent shell owns sort state
 * and applies it once so every view shows the same order. `sortKey`/`sortDir`
 * are consumed only to render the header indicator. The component does not
 * call `useWorkspaceProjects`.
 */
import {
  type CSSProperties,
  type MouseEvent,
  type UIEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Checkbox, GradeBadge, StatusDot } from '../lattice/ui';
import { InlineProgress } from './components/InlineProgress';
import { ProjectPath } from './components/ProjectPath';
import { ProjectContextMenu, ProjectRowActions } from './components/ProjectRowActions';
import {
  type ProjectViewModel,
  type SortDir,
  type SortKey,
  statusLabel,
  statusToDot,
} from './types';

export interface WorkspaceTableViewProps {
  projects: ProjectViewModel[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  selected: Set<string>;
  onSelectChange: (root: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
  /** false = daemon disconnected; Re-index/Remove are dimmed. */
  canMutate: boolean;
  /** Reports the pane's scroll offset so the toolbar can fade in its hairline. */
  onScroll?: (scrollTop: number) => void;
}

/** Fixed row height — the windowing maths and the loading skeletons share it. */
export const ROW_H = 46;
/** Below this many rows, rendering everything is cheaper than the bookkeeping. */
export const WINDOW_THRESHOLD = 100;
const OVERSCAN = 8;

/**
 * Which slice of `total` rows to render for a scroll offset and viewport.
 * Exported for the unit test — off-by-one here means blank rows on screen.
 */
export function visibleRange(
  total: number,
  scrollTop: number,
  viewportH: number,
): { start: number; end: number } {
  if (total <= WINDOW_THRESHOLD || viewportH <= 0) return { start: 0, end: total };
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  return { start, end };
}

// ── Frozen columns ────────────────────────────────────────────────────────
//
// The table is wider than the 732 px viewport of the default 960×700 window,
// so it scrolls horizontally. Pin the identity columns (checkbox + Project) to
// the left and Actions to the right, otherwise scrolling right hides which row
// you are looking at and scrolling left hides Security/Actions entirely.

/** Width of the select-checkbox column; the Project column is offset by it. */
const SELECT_COL_W = 32;

/**
 * The surface tokens are translucent (vibrancy), so a pinned cell painted with
 * `--bg-secondary` alone would let the scrolling rows show through. Stack it
 * over `--bg-grouped` the way a normal row is stacked over the pane.
 */
const overPane = (tint: string) => `linear-gradient(${tint}, ${tint}), var(--bg-grouped)`;
const STICKY_HEADER_BG = overPane('var(--bg-secondary)');

/** Sticky cells need their own background — rows slide underneath them. */
function stickyCell(side: 'left' | 'right', offset: number, bg: string, seam = true): CSSProperties {
  return {
    position: 'sticky',
    [side]: offset,
    background: bg,
    boxShadow: seam ? (side === 'left' ? '1px 0 0 var(--border)' : '-1px 0 0 var(--border)') : undefined,
  };
}

// ── Sortable header cell ──────────────────────────────────────────────────

interface ThProps {
  label: string;
  tooltip?: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right' | 'center';
  sticky?: CSSProperties;
}

function Th({ label, tooltip, sortKey, current, dir, onSort, align = 'left', sticky }: ThProps) {
  const isActive = current === sortKey;
  return (
    <th
      scope="col"
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-3 py-2 text-${align} text-[11px] font-medium cursor-pointer select-none whitespace-nowrap`}
      style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)', zIndex: 1, ...sticky }}
      title={tooltip}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {isActive && (
        <span className="ml-1" aria-hidden="true" style={{ color: 'var(--accent)' }}>
          {dir === 'asc' ? '▲' : '▼'}
        </span>
      )}
    </th>
  );
}

function SelectAllCheckbox({
  total,
  selectedCount,
  onChange,
}: {
  total: number;
  selectedCount: number;
  onChange: (next: boolean) => void;
}) {
  return (
    <Checkbox
      checked={total > 0 && selectedCount === total}
      indeterminate={selectedCount > 0 && selectedCount < total}
      onChange={onChange}
      aria-label="Select all projects"
    />
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

interface RowProps {
  project: ProjectViewModel;
  selected: boolean;
  cursored: boolean;
  canMutate: boolean;
  confirming: boolean;
  onRequestRemove: (root: string) => void;
  onCancelRemove: () => void;
  onSelectChange: (root: string, next: boolean) => void;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
  onContextMenu: (e: MouseEvent, project: ProjectViewModel) => void;
}

function Row({
  project,
  selected,
  cursored,
  canMutate,
  confirming,
  onRequestRemove,
  onCancelRemove,
  onSelectChange,
  onOpen,
  onReindex,
  onRemove,
  onContextMenu,
}: RowProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  const tdNum = 'px-3 tabular-nums text-right';
  const dotTone = statusToDot(project.displayStatus);
  // Hover is state rather than a direct style write so the pinned cells, which
  // carry their own opaque background, can follow the row highlight.
  const [hovered, setHovered] = useState(false);
  const highlighted = hovered || cursored || selected;
  const bg = highlighted ? overPane('var(--bg-active)') : 'var(--bg-grouped)';

  return (
    <tr
      aria-selected={selected}
      className="cursor-pointer transition-colors"
      style={{
        height: ROW_H,
        borderBottom: '0.5px solid var(--border-row)',
        background: highlighted ? bg : undefined,
        outline: cursored ? '2px solid var(--accent)' : undefined,
        outlineOffset: -2,
      }}
      onClick={() => onOpen(project.root)}
      onContextMenu={(e) => onContextMenu(e, project)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <td
        className="px-1"
        style={{ ...stickyCell('left', 0, bg, false), width: SELECT_COL_W }}
        onClick={stop}
      >
        <Checkbox
          checked={selected}
          onChange={(next) => onSelectChange(project.root, next)}
          aria-label={`Select ${project.name}`}
        />
      </td>

      <td
        className="px-3 max-w-[240px]"
        style={{ color: 'var(--text-primary)', ...stickyCell('left', SELECT_COL_W, bg) }}
      >
        <div className="truncate font-medium" title={project.name}>
          {project.name}
        </div>
        {/* Head-truncated: sibling checkouts differ in the tail, not the head. */}
        <ProjectPath root={project.root} className="text-[11px] text-[var(--text-tertiary)]" />
      </td>

      <td className="px-3 max-w-[200px]">
        <div className="flex items-center gap-1.5">
          <StatusDot tone={dotTone} pulse={dotTone === 'green'} />
          <span style={{ color: 'var(--text-secondary)' }}>{statusLabel(project.displayStatus)}</span>
        </div>
        {project.error && (
          <div className="text-[11px] truncate" style={{ color: 'var(--destructive)' }} title={project.error}>
            {project.error}
          </div>
        )}
        <InlineProgress
          progress={project.progress}
          hint={project.liveStatus !== project.displayStatus ? project.liveStatus : undefined}
        />
      </td>

      <td className="px-3 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
        {project.lastIndexed
          ? new Date(project.lastIndexed).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—'}
      </td>

      <td className={tdNum} style={{ color: 'var(--text-primary)' }}>
        {project.totalFiles?.toLocaleString() ?? '—'}
      </td>
      <td className={tdNum} style={{ color: 'var(--text-primary)' }}>
        {project.totalSymbols?.toLocaleString() ?? '—'}
      </td>
      <td className={tdNum}>
        {project.deadExports === undefined ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          <span
            style={{
              color: project.deadExports > 0 ? 'var(--warning)' : 'var(--text-secondary)',
              fontWeight: project.deadExports > 0 ? 600 : undefined,
            }}
          >
            {project.deadExports.toLocaleString()}
          </span>
        )}
      </td>
      <td className={tdNum}>
        {project.untestedSymbols === undefined ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          <span style={{ color: project.untestedSymbols > 0 ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
            {project.untestedSymbols.toLocaleString()}
          </span>
        )}
      </td>
      <td className="px-3 text-center">
        {project.techDebtGrade ? (
          // GradeBadge carries both the title and the spelled-out accessible
          // name — the letter alone means nothing to a screen reader.
          <GradeBadge grade={project.techDebtGrade} />
        ) : (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        )}
      </td>
      <td className={tdNum}>
        {project.securityFindings === undefined ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          <span
            style={{
              color: project.securityFindings > 0 ? 'var(--destructive)' : 'var(--text-tertiary)',
              fontWeight: project.securityFindings > 0 ? 600 : undefined,
            }}
          >
            {project.securityFindings.toLocaleString()}
          </span>
        )}
      </td>
      <td className="px-3" style={stickyCell('right', 0, bg)}>
        <ProjectRowActions
          project={project}
          canMutate={canMutate}
          confirming={confirming}
          onRequestRemove={onRequestRemove}
          onCancelRemove={onCancelRemove}
          onOpen={onOpen}
          onReindex={onReindex}
          onRemove={onRemove}
        />
      </td>
    </tr>
  );
}

// ── View ──────────────────────────────────────────────────────────────────

export function WorkspaceTableView({
  projects,
  sortKey,
  sortDir,
  onSort,
  selected,
  onSelectChange,
  onSelectAll,
  onOpen,
  onReindex,
  onRemove,
  canMutate,
  onScroll,
}: WorkspaceTableViewProps) {
  const thProps = { current: sortKey, dir: sortDir, onSort };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [cursor, setCursor] = useState(-1);
  const [confirmRoot, setConfirmRoot] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectViewModel } | null>(null);

  useEffect(() => {
    setViewportH(scrollRef.current?.clientHeight ?? 0);
  }, []);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    setScrollTop(top);
    setViewportH(e.currentTarget.clientHeight);
    onScroll?.(top);
  };

  const { start, end } = visibleRange(projects.length, scrollTop, viewportH);
  const rows = projects.slice(start, end);
  const padTop = start * ROW_H;
  const padBottom = (projects.length - end) * ROW_H;

  const moveCursor = (delta: number) => {
    const next = Math.min(projects.length - 1, Math.max(0, (cursor < 0 ? -1 : cursor) + delta));
    setCursor(next);
    const el = scrollRef.current;
    if (!el) return;
    const top = next * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  return (
    <div
      ref={scrollRef}
      // One tab stop for the whole grid, then ↑↓ to move and ⏎ to open — the
      // list-navigation contract every Mac list follows.
      tabIndex={0}
      role="grid"
      aria-label="Projects"
      aria-rowcount={projects.length}
      className="flex-1 overflow-auto"
      style={{
        borderRadius: 12,
        border: '0.5px solid var(--border)',
        background: 'var(--bg-grouped)',
      }}
      onScroll={handleScroll}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveCursor(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveCursor(-1);
        } else if (e.key === 'Enter' && cursor >= 0 && cursor < projects.length) {
          e.preventDefault();
          onOpen(projects[cursor].root);
        } else if (e.key === 'Escape') {
          setCursor(-1);
          setConfirmRoot(null);
        }
      }}
    >
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-secondary)' }}>
          <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
            <th
              className="px-1 w-8"
              style={{ ...stickyCell('left', 0, STICKY_HEADER_BG, false), zIndex: 1 }}
            >
              <SelectAllCheckbox total={projects.length} selectedCount={selected.size} onChange={onSelectAll} />
            </th>
            <Th
              label="Project"
              sortKey="name"
              sticky={stickyCell('left', SELECT_COL_W, STICKY_HEADER_BG)}
              {...thProps}
            />
            <Th label="Status" sortKey="status" {...thProps} />
            <Th label="Last indexed" sortKey="lastIndexed" {...thProps} />
            <Th label="Files" sortKey="totalFiles" align="right" {...thProps} />
            <Th label="Symbols" sortKey="totalSymbols" align="right" {...thProps} />
            <Th
              label="Dead exports"
              tooltip="Exported symbols never imported anywhere in the project"
              sortKey="deadExports"
              align="right"
              {...thProps}
            />
            <Th
              label="Untested"
              tooltip="Functions, classes and methods not referenced by any test file"
              sortKey="untestedSymbols"
              align="right"
              {...thProps}
            />
            <Th
              label="Grade"
              tooltip="Tech-debt grade (A–F)"
              sortKey="techDebtGrade"
              align="center"
              {...thProps}
            />
            <Th
              label="Security"
              tooltip="Critical + high OWASP findings"
              sortKey="securityFindings"
              align="right"
              {...thProps}
            />
            <th
              scope="col"
              className="px-3 py-2 text-left text-[11px] font-medium"
              style={{
                color: 'var(--text-secondary)',
                zIndex: 1,
                ...stickyCell('right', 0, STICKY_HEADER_BG),
              }}
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={11} style={{ height: padTop, padding: 0 }} />
            </tr>
          )}
          {rows.map((p, i) => (
            <Row
              key={p.root}
              project={p}
              selected={selected.has(p.root)}
              cursored={start + i === cursor}
              canMutate={canMutate}
              confirming={confirmRoot === p.root}
              onRequestRemove={setConfirmRoot}
              onCancelRemove={() => setConfirmRoot(null)}
              onSelectChange={onSelectChange}
              onOpen={onOpen}
              onReindex={onReindex}
              onRemove={(root) => {
                setConfirmRoot(null);
                onRemove(root);
              }}
              onContextMenu={(e, project) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, project });
              }}
            />
          ))}
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={11} style={{ height: padBottom, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>

      {menu && (
        <ProjectContextMenu
          project={menu.project}
          canMutate={canMutate}
          x={menu.x}
          y={menu.y}
          onOpen={onOpen}
          onReindex={onReindex}
          onRequestRemove={setConfirmRoot}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
