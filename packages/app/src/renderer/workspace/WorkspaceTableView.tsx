/**
 * WorkspaceTableView — sortable wide-table view of merged projects.
 *
 * Port of the legacy Dashboard.tsx table, extended with:
 *  - selection checkbox column (multi-row select + select-all in the header)
 *  - inline progress bar inside the Status cell when a pipeline is running
 *  - per-row Open / Re-index / Remove actions (Remove has two-step confirm)
 *  - dims Re-index/Remove when `canMutate === false` or `inDaemon === false`
 *
 * Data flows in via props already sorted — the parent shell owns sort state
 * and applies it once so every view shows the same order. `sortKey`/`sortDir`
 * are consumed only to render the header indicator. The component does not
 * call `useWorkspaceProjects`.
 */
import { type CSSProperties, type MouseEvent, useEffect, useRef, useState } from 'react';
import { Checkbox, GradeBadge, StatusDot } from '../lattice/ui';
import { InlineProgress } from './components/InlineProgress';
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
 * over `--bg-primary` the way a normal row is stacked over the page.
 */
const overPage = (tint: string) => `linear-gradient(${tint}, ${tint}), var(--bg-primary)`;
const STICKY_HEADER_BG = overPage('var(--bg-secondary)');

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
      className={`px-3 py-2 text-${align} text-[11px] font-semibold cursor-pointer select-none whitespace-nowrap`}
      style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)', zIndex: 1, ...sticky }}
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

// ── Tristate select-all checkbox ─────────────────────────────────────────

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

// ── Action cell (Open / Re-index / Remove) ───────────────────────────────

function ActionCell({
  project,
  canMutate,
  onOpen,
  onReindex,
  onRemove,
}: {
  project: ProjectViewModel;
  canMutate: boolean;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const mutationAllowed = canMutate && project.inDaemon;
  const isIndexing = project.displayStatus === 'indexing' || project.displayStatus === 'computing';

  const stop = (e: MouseEvent) => e.stopPropagation();
  const baseBtn =
    'w-7 h-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-active)]';

  if (confirm) {
    return (
      <div className="flex items-center gap-1" onClick={stop}>
        <button
          type="button"
          onClick={() => setConfirm(false)}
          className="text-[11px] px-1.5 py-0.5 rounded font-medium"
          style={{ background: 'var(--fill-control)', color: 'var(--text-secondary)', border: '0.5px solid var(--border)' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onRemove(project.root);
            setConfirm(false);
          }}
          className="text-[11px] px-1.5 py-0.5 rounded font-medium"
          style={{ background: 'var(--destructive)', color: '#fff' }}
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5" onClick={stop}>
      <button
        type="button"
        onClick={() => onOpen(project.root)}
        className={baseBtn}
        style={{ color: 'var(--accent)' }}
        title="Open project"
      >
        →
      </button>
      <button
        type="button"
        disabled={!mutationAllowed || isIndexing}
        onClick={() => onReindex(project.root)}
        className={`${baseBtn} disabled:opacity-30`}
        style={{ color: 'var(--text-secondary)' }}
        title="Re-index"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 2.5v4h4" />
          <path d="M2.3 10a6 6 0 1 0 .9-5.6L1.5 6.5" />
        </svg>
      </button>
      <button
        type="button"
        disabled={!mutationAllowed}
        onClick={() => setConfirm(true)}
        className={`${baseBtn} disabled:opacity-30`}
        style={{ color: 'var(--text-tertiary)' }}
        title="Remove"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

function Row({
  project,
  selected,
  canMutate,
  onSelectChange,
  onOpen,
  onReindex,
  onRemove,
}: {
  project: ProjectViewModel;
  selected: boolean;
  canMutate: boolean;
  onSelectChange: (root: string, next: boolean) => void;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  const tdNum = 'px-3 py-2 tabular-nums text-right';
  const dotTone = statusToDot(project.displayStatus);
  // Hover is state rather than a direct style write so the pinned cells, which
  // carry their own opaque background, can follow the row highlight.
  const [hovered, setHovered] = useState(false);
  const bg = hovered ? overPage('var(--bg-secondary)') : 'var(--bg-primary)';

  return (
    <tr
      className="cursor-pointer transition-colors"
      style={{ borderBottom: '0.5px solid var(--border)', background: hovered ? bg : undefined }}
      onClick={() => onOpen(project.root)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <td
        className="px-2 py-2"
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
        className="px-3 py-2 font-medium max-w-[200px]"
        style={{ color: 'var(--text-primary)', ...stickyCell('left', SELECT_COL_W, bg) }}
      >
        <div className="truncate" title={project.name}>
          {project.name}
        </div>
        <div className="truncate text-[10px]" style={{ color: 'var(--text-tertiary)' }} title={project.root}>
          {project.root}
        </div>
      </td>

      <td className="px-3 py-2 max-w-[180px]">
        <div className="flex items-center gap-1.5">
          <StatusDot tone={dotTone} pulse={dotTone === 'green'} />
          <span style={{ color: 'var(--text-secondary)' }}>{statusLabel(project.displayStatus)}</span>
        </div>
        {project.error && (
          <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--destructive)' }} title={project.error}>
            {project.error}
          </div>
        )}
        <InlineProgress
          progress={project.progress}
          hint={project.liveStatus !== project.displayStatus ? project.liveStatus : undefined}
        />
      </td>

      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
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
              color: project.deadExports > 0 ? '#ff9f0a' : 'var(--text-secondary)',
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
      <td className="px-3 py-2 text-center">
        {project.techDebtGrade ? (
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
      <td className="px-3 py-2" style={stickyCell('right', 0, bg)}>
        <ActionCell
          project={project}
          canMutate={canMutate}
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
}: WorkspaceTableViewProps) {
  const thProps = { current: sortKey, dir: sortDir, onSort };

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-secondary)' }}>
          <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
            <th
              className="px-2 py-2 w-8"
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
            <Th label="Last Indexed" sortKey="lastIndexed" {...thProps} />
            <Th label="Files" sortKey="totalFiles" align="right" {...thProps} />
            <Th label="Symbols" sortKey="totalSymbols" align="right" {...thProps} />
            <Th
              label="Dead"
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
              className="px-3 py-2 text-left text-[11px] font-semibold"
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
          {projects.map((p) => (
            <Row
              key={p.root}
              project={p}
              selected={selected.has(p.root)}
              canMutate={canMutate}
              onSelectChange={onSelectChange}
              onOpen={onOpen}
              onReindex={onReindex}
              onRemove={onRemove}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
