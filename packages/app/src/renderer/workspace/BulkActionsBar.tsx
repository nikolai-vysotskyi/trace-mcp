/**
 * BulkActionsBar — floating action strip shown when ≥1 project is selected
 * in the Workspace tab. Re-index, Remove (two-step), Export JSON, Export CSV,
 * Clear. Renders null when nothing selected.
 */
import { useState } from 'react';
import type { ProjectViewModel } from './types';

export interface BulkActionsBarProps {
  /** The selected ProjectViewModel objects (parent slices `projects` by selection). */
  projects: ProjectViewModel[];
  onReindex: (roots: string[]) => void | Promise<void>;
  onRemove: (roots: string[]) => void | Promise<void>;
  onClear: () => void;
}

// CSV columns mirror WorkspaceTableView for consistency.
const CSV_COLUMNS = [
  'name',
  'root',
  'status',
  'lastIndexed',
  'totalFiles',
  'totalSymbols',
  'deadExports',
  'untestedSymbols',
  'techDebtGrade',
  'securityFindings',
] as const;

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(p: ProjectViewModel): string {
  return [
    p.name,
    p.root,
    p.displayStatus,
    p.lastIndexed ?? '',
    p.totalFiles ?? '',
    p.totalSymbols ?? '',
    p.deadExports ?? '',
    p.untestedSymbols ?? '',
    p.techDebtGrade ?? '',
    p.securityFindings ?? '',
  ]
    .map(csvCell)
    .join(',');
}

export function BulkActionsBar({ projects, onReindex, onRemove, onClear }: BulkActionsBarProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  if (projects.length === 0) return null;
  const roots = projects.map((p) => p.root);

  const handleReindex = async () => {
    setBusy(true);
    try {
      await onReindex(roots);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      await onRemove(roots);
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(projects, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `trace-mcp-projects-${todayStamp()}.json`);
  };

  const handleExportCsv = () => {
    const lines = [CSV_COLUMNS.join(','), ...projects.map(rowToCsv)];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    downloadBlob(blob, `trace-mcp-projects-${todayStamp()}.csv`);
  };

  const baseBtn =
    'text-[11px] px-2 py-1 rounded-md font-medium transition-opacity hover:opacity-80 disabled:opacity-40';

  return (
    <div
      className="sticky bottom-2 z-10 mx-auto mt-2 flex w-fit items-center gap-2 px-3 py-1.5 rounded-xl"
      style={{
        background: 'var(--bg-secondary)',
        border: '0.5px solid var(--border)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <span className="text-[11px] font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {projects.length} selected
      </span>
      <span style={{ width: 1, height: 14, background: 'var(--border)' }} aria-hidden />
      {!confirmRemove ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleReindex()}
            className={baseBtn}
            style={{
              background: 'var(--fill-control)',
              color: 'var(--accent)',
              border: '0.5px solid var(--border)',
            }}
          >
            Re-index
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
            className={baseBtn}
            style={{
              background: '#ff3b3018',
              color: '#ff3b30',
              border: '0.5px solid #ff3b3040',
            }}
          >
            Remove
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleExportJson}
            className={baseBtn}
            style={{
              background: 'var(--fill-control)',
              color: 'var(--text-secondary)',
              border: '0.5px solid var(--border)',
            }}
          >
            Export JSON
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleExportCsv}
            className={baseBtn}
            style={{
              background: 'var(--fill-control)',
              color: 'var(--text-secondary)',
              border: '0.5px solid var(--border)',
            }}
          >
            Export CSV
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClear}
            className={baseBtn}
            style={{ color: 'var(--text-tertiary)' }}
          >
            Clear
          </button>
        </>
      ) : (
        <>
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Remove {projects.length} project{projects.length === 1 ? '' : 's'}?
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmRemove(false)}
            className={baseBtn}
            style={{
              background: 'var(--fill-control)',
              color: 'var(--text-secondary)',
              border: '0.5px solid var(--border)',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRemove()}
            className={baseBtn}
            style={{ background: '#ff3b30', color: '#fff' }}
          >
            Confirm
          </button>
        </>
      )}
    </div>
  );
}
