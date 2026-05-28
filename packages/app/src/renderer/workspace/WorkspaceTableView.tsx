/**
 * WorkspaceTableView — sortable wide-table view of merged projects.
 *
 * Port of the legacy Dashboard.tsx table, extended with:
 *  - selection checkbox column (multi-row select + select-all in the header)
 *  - inline progress bar inside the Status cell when a pipeline is running
 *  - per-row Open / Re-index / Remove actions (Remove has two-step confirm)
 *  - dims Re-index/Remove when `canMutate === false` or `inDaemon === false`
 *
 * Data flows in via props; sorting is performed locally using
 * `compareViewModels` from `./types.ts`. The component does not call
 * `useWorkspaceProjects` — the parent shell owns that state.
 */
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { StatusDot } from '../components/StatusDot';
import { InlineProgress } from './components/InlineProgress';
import {
  type ProjectViewModel,
  type SortDir,
  type SortKey,
  type TechDebtGrade,
  compareViewModels,
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

const GRADE_COLOR: Record<TechDebtGrade, string> = {
  A: '#34c759',
  B: '#30d158',
  C: '#ffcc00',
  D: '#ff9f0a',
  F: '#ff3b30',
};

// ── Sortable header cell ──────────────────────────────────────────────────

interface ThProps {
  label: string;
  tooltip?: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right' | 'center';
}

function Th({ label, tooltip, sortKey, current, dir, onSort, align = 'left' }: ThProps) {
  const isActive = current === sortKey;
  return (
    <th
      className={`px-3 py-2 text-${align} text-[11px] font-semibold cursor-pointer select-none whitespace-nowrap`}
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
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.indeterminate = selectedCount > 0 && selectedCount < total;
  }, [selectedCount, total]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={total > 0 && selectedCount === total}
      onChange={(e) => onChange(e.target.checked)}
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
          style={{ background: '#ff3b30', color: '#fff' }}
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

  return (
    <tr
      className="cursor-pointer transition-colors"
      style={{ borderBottom: '0.5px solid var(--border)' }}
      onClick={() => onOpen(project.root)}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-secondary)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLTableRowElement).style.background = '';
      }}
    >
      <td className="px-2 py-2" onClick={stop}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelectChange(project.root, e.target.checked)}
          aria-label={`Select ${project.name}`}
        />
      </td>

      <td className="px-3 py-2 font-medium max-w-[200px]" style={{ color: 'var(--text-primary)' }}>
        <div className="truncate" title={project.name}>
          {project.name}
        </div>
        <div className="truncate text-[10px]" style={{ color: 'var(--text-tertiary)' }} title={project.root}>
          {project.root}
        </div>
      </td>

      <td className="px-3 py-2 max-w-[180px]">
        <div className="flex items-center gap-1.5">
          <StatusDot status={statusToDot(project.displayStatus)} />
          <span style={{ color: 'var(--text-secondary)' }}>{statusLabel(project.displayStatus)}</span>
        </div>
        {project.error && (
          <div className="text-[10px] mt-0.5 truncate" style={{ color: '#ff3b30' }} title={project.error}>
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
          <span
            className="inline-block px-1.5 py-0.5 rounded text-[11px] font-bold"
            style={{ color: '#fff', background: GRADE_COLOR[project.techDebtGrade] }}
          >
            {project.techDebtGrade}
          </span>
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
              color: project.securityFindings > 0 ? '#ff3b30' : 'var(--text-tertiary)',
              fontWeight: project.securityFindings > 0 ? 600 : undefined,
            }}
          >
            {project.securityFindings.toLocaleString()}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
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
  const sorted = [...projects].sort((a, b) => compareViewModels(a, b, sortKey, sortDir));
  const thProps = { current: sortKey, dir: sortDir, onSort };

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-secondary)' }}>
          <tr style={{ borderBottom: '0.5px solid var(--border)' }}>
            <th className="px-2 py-2 w-8" style={{ background: 'var(--bg-secondary)' }}>
              <SelectAllCheckbox total={projects.length} selectedCount={selected.size} onChange={onSelectAll} />
            </th>
            <Th label="Project" sortKey="name" {...thProps} />
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
              style={{ color: 'var(--text-secondary)' }}
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
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
