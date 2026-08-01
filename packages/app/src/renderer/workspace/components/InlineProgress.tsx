import type { ProgressSnapshot } from '../../hooks/useDaemon';

export interface InlineProgressProps {
  progress: ProgressSnapshot | undefined;
  /** Optional finer-grained label (e.g. raw daemon status "embedding"). */
  hint?: string;
}

/**
 * Single-line micro progress bar: `phase NN%` text + a thin accent bar.
 *
 * Shared by `WorkspaceTableView` and `WorkspaceCompactView` to keep the
 * indexing UI consistent across views. Returns `null` when no progress.
 */
export function InlineProgress({ progress, hint }: InlineProgressProps) {
  if (!progress) return null;
  const percent = Math.max(0, Math.min(100, progress.percent));
  const label = hint && hint !== progress.phase ? `${progress.phase} · ${hint}` : progress.phase;
  return (
    <div className="mt-0.5">
      <div
        className="flex items-baseline gap-1 text-[10px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <span className="truncate">{label}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div
        className="mt-0.5 h-[3px] w-full overflow-hidden rounded-full"
        style={{ background: 'var(--fill-control)' }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: 'var(--accent)',
            transition: 'width 200ms linear',
          }}
        />
      </div>
    </div>
  );
}
