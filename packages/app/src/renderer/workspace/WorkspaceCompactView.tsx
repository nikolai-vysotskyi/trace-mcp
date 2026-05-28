/**
 * WorkspaceCompactView — vertical list of compact project rows.
 *
 * Port of the legacy ProjectRow visual idiom (status dot · truncated path ·
 * action buttons) extended with a select checkbox and inline metric badges
 * + progress. Same selection / mutation contract as WorkspaceTableView.
 */
import { type MouseEvent, useState } from 'react';
import { StatusDot } from '../components/StatusDot';
import { InlineProgress } from './components/InlineProgress';
import { ProjectMetricsBadges } from './components/ProjectMetricsBadges';
import { type ProjectViewModel, statusLabel, statusToDot } from './types';

export interface WorkspaceCompactViewProps {
  projects: ProjectViewModel[];
  selected: Set<string>;
  onSelectChange: (root: string, selected: boolean) => void;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
  /** false = daemon disconnected; Re-index/Remove are dimmed. */
  canMutate: boolean;
}

function shortPath(root: string): string {
  const trimmed = root.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

interface RowProps {
  project: ProjectViewModel;
  selected: boolean;
  canMutate: boolean;
  onSelectChange: (root: string, next: boolean) => void;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
}

function CompactRow({
  project,
  selected,
  canMutate,
  onSelectChange,
  onOpen,
  onReindex,
  onRemove,
}: RowProps) {
  const [confirm, setConfirm] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const mutationAllowed = canMutate && project.inDaemon;
  const isIndexing = project.displayStatus === 'indexing' || project.displayStatus === 'computing';
  const iconBtn =
    'w-7 h-7 inline-flex items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-active)] disabled:opacity-30';

  return (
    <div
      role="button"
      tabIndex={0}
      className="px-2 py-1.5 rounded-md cursor-pointer transition-all hover:brightness-110"
      style={{ background: 'var(--bg-secondary)' }}
      onClick={() => onOpen(project.root)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(project.root);
        }
      }}
    >
      <div className="flex items-center gap-2">
        <span onClick={stop}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelectChange(project.root, e.target.checked)}
            aria-label={`Select ${shortPath(project.root)}`}
          />
        </span>
        <StatusDot status={statusToDot(project.displayStatus)} />
        <div className="flex-1 min-w-0">
          <div
            className="text-xs font-medium truncate"
            style={{ color: 'var(--text-primary)' }}
            title={project.name}
          >
            {project.name || shortPath(project.root)}
          </div>
          <div
            className="text-[10px] truncate"
            style={{
              color: 'var(--text-tertiary)',
              direction: 'rtl',
              textAlign: 'left',
            }}
            title={project.root}
          >
            {project.root}
          </div>
          {project.error ? (
            <div className="text-[10px] truncate" style={{ color: '#ff3b30' }} title={project.error}>
              {project.error}
            </div>
          ) : (
            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {statusLabel(project.displayStatus)}
            </div>
          )}
          <InlineProgress
            progress={project.progress}
            hint={project.liveStatus !== project.displayStatus ? project.liveStatus : undefined}
          />
        </div>

        <div className="flex items-center gap-2" onClick={stop}>
          <ProjectMetricsBadges project={project} dense />
          {!confirm ? (
            <>
              <button
                type="button"
                onClick={() => onOpen(project.root)}
                className={iconBtn}
                style={{ color: 'var(--accent)' }}
                title="Open project"
              >
                →
              </button>
              <button
                type="button"
                disabled={!mutationAllowed || isIndexing}
                onClick={() => onReindex(project.root)}
                className={iconBtn}
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
                className={iconBtn}
                style={{ color: 'var(--text-tertiary)' }}
                title="Remove"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="text-[11px] px-1.5 py-0.5 rounded font-medium"
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
                onClick={() => {
                  onRemove(project.root);
                  setConfirm(false);
                }}
                className="text-[11px] px-1.5 py-0.5 rounded font-medium"
                style={{ background: '#ff3b30', color: '#fff' }}
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceCompactView({
  projects,
  selected,
  canMutate,
  onSelectChange,
  onOpen,
  onReindex,
  onRemove,
}: WorkspaceCompactViewProps) {
  return (
    <div className="flex-1 overflow-auto px-2 py-1">
      <div className="flex flex-col gap-1">
        {projects.map((p) => (
          <CompactRow
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
      </div>
    </div>
  );
}
