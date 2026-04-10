import { useState } from 'react';
import { StatusDot } from './StatusDot';

interface ProgressSnapshot {
  phase: string;
  current: number;
  total: number;
  percent: number;
}

export interface ProjectRowProps {
  root: string;
  status: string;
  error?: string;
  progress?: ProgressSnapshot;
  onReindex: () => void;
  onRemove: () => void;
  onClick?: () => void;
}

function shortPath(root: string): string {
  const home = '~';
  return root.replace(/^\/Users\/[^/]+/, home).replace(/^\/home\/[^/]+/, home);
}

function statusToDot(status: string): 'active' | 'idle' | 'error' | 'disconnected' {
  if (status === 'indexing') return 'active';
  if (status === 'error') return 'error';
  if (status === 'ready') return 'active';
  return 'disconnected';
}

function statusLabel(status: string): string {
  if (status === 'indexing') return 'Indexing…';
  if (status === 'ready') return 'Ready';
  if (status === 'error') return 'Error';
  if (status === 'pending') return 'Pending';
  return status;
}

export function ProjectRow({ root, status, error, progress, onReindex, onRemove, onClick }: ProjectRowProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div
      className="px-2 py-1.5 rounded-md group cursor-pointer hover:brightness-110 transition-all"
      style={{ background: 'var(--bg-secondary)' }}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={statusToDot(status)} />
        <div className="flex-1 min-w-0">
          <div
            className="text-xs font-medium truncate"
            style={{ color: 'var(--text-primary)', direction: 'rtl', textAlign: 'left' }}
            title={root}
          >
            {shortPath(root)}
          </div>
          {error && (
            <div className="text-[10px] truncate" style={{ color: '#ff3b30' }}>
              {error}
            </div>
          )}
          {!error && (
            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {statusLabel(status)}
              {progress?.phase != null && ` — ${progress.phase} ${progress.percent}%`}
            </div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          {!confirmRemove ? (
            <>
              <button
                onClick={onReindex}
                disabled={status === 'indexing'}
                className="text-[10px] px-1.5 py-0.5 rounded disabled:opacity-40"
                style={{ color: 'var(--accent)' }}
                title="Re-index"
              >
                Re-index
              </button>
              <button
                onClick={() => setConfirmRemove(true)}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: '#ff3b30' }}
                title="Remove"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => { onRemove(); setConfirmRemove(false); }}
                className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                style={{ color: '#ff3b30' }}
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {status === 'indexing' && progress?.percent != null && (
        <div
          className="mt-1 h-1 rounded-full overflow-hidden"
          style={{ background: 'var(--border)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${progress.percent}%`,
              background: 'var(--accent)',
            }}
          />
        </div>
      )}
    </div>
  );
}
