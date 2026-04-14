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
  return root
    .replace(/^\/Users\/[^/]+/, home)
    .replace(/^\/home\/[^/]+/, home)
    .replace(/^[A-Z]:\\Users\\[^\\]+/, home);
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
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {!confirmRemove ? (
            <>
              <button
                onClick={onReindex}
                disabled={status === 'indexing'}
                className="w-7 h-7 flex items-center justify-center rounded-lg disabled:opacity-30 transition-colors hover:bg-[var(--bg-active)]"
                style={{ color: 'var(--text-secondary)' }}
                title="Re-index"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 2.5v4h4" />
                  <path d="M2.3 10a6 6 0 1 0 .9-5.6L1.5 6.5" />
                </svg>
              </button>
              <button
                onClick={() => setConfirmRemove(true)}
                className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-active)]"
                style={{ color: 'var(--text-tertiary)' }}
                title="Remove"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setConfirmRemove(false)}
                className="text-[11px] px-1.5 py-0.5 rounded-md font-medium transition-colors hover:bg-[var(--bg-active)]"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary, var(--bg-secondary))', border: '1px solid var(--border)' }}
              >
                Cancel
              </button>
              <button
                onClick={() => { onRemove(); setConfirmRemove(false); }}
                className="text-[11px] px-1.5 py-0.5 rounded-md font-medium transition-colors"
                style={{ background: '#ff3b3018', color: '#ff3b30', border: '1px solid #ff3b3040' }}
                title="Confirm removal"
              >
                Remove
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
