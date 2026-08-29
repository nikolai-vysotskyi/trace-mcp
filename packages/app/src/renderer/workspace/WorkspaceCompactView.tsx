/**
 * WorkspaceCompactView — vertical list of compact project rows.
 *
 * Same content treatment as the table: one 12px-radius pane, 13px body text,
 * head-truncated paths, 24×24 hit targets, labelled actions, a right-click
 * menu with the same actions, and ↑ / ↓ + ⏎ list navigation. Selection and
 * mutation contracts match WorkspaceTableView.
 */
import { type MouseEvent, type UIEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, StatusDot } from '../lattice/ui';
import { InlineProgress } from './components/InlineProgress';
import { ProjectMetricsBadges } from './components/ProjectMetricsBadges';
import { ProjectPath } from './components/ProjectPath';
import { ProjectContextMenu, ProjectRowActions } from './components/ProjectRowActions';
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
  /** Reports the pane's scroll offset so the toolbar can fade in its hairline. */
  onScroll?: (scrollTop: number) => void;
}

/** Matches the table so switching views does not change row rhythm. */
export const COMPACT_ROW_H = 46;

function basename(root: string): string {
  const trimmed = root.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

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

function CompactRow({
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
  const { t } = useTranslation('workspace');
  const [hovered, setHovered] = useState(false);
  const dotTone = statusToDot(project.displayStatus);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const highlighted = hovered || cursored || selected;

  return (
    <div
      role="row"
      aria-selected={selected}
      className="flex items-center gap-2 px-3 cursor-pointer transition-colors"
      style={{
        minHeight: COMPACT_ROW_H,
        borderBottom: '0.5px solid var(--separator)',
        background: highlighted ? 'var(--fill-tertiary)' : undefined,
        outline: cursored ? '2px solid var(--accent)' : undefined,
        outlineOffset: -2,
      }}
      onClick={() => onOpen(project.root)}
      onContextMenu={(e) => onContextMenu(e, project)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span onClick={stop} className="inline-flex items-center shrink-0">
        <Checkbox
          checked={selected}
          onChange={(next) => onSelectChange(project.root, next)}
          aria-label={t('selectProject', { name: project.name || basename(project.root) })}
        />
      </span>
      <StatusDot tone={dotTone} pulse={dotTone === 'green'} />
      <div className="flex-1 min-w-0">
        {/* Name and status share one line — the dot already carries the tone,
            so the word costs no extra row height. */}
        <div className="flex items-baseline gap-2">
          <div
            className="text-[13px] font-medium truncate"
            style={{ color: 'var(--label)' }}
            title={project.name}
          >
            {project.name || basename(project.root)}
          </div>
          <div className="text-[11px] shrink-0" style={{ color: 'var(--label-secondary)' }}>
            {statusLabel(project.displayStatus)}
          </div>
        </div>
        <ProjectPath root={project.root} className="text-[11px] text-[var(--label-secondary)]" />
        {project.error && (
          <div className="text-[11px] truncate" style={{ color: 'var(--status-red)' }} title={project.error}>
            {project.error}
          </div>
        )}
        <InlineProgress
          progress={project.progress}
          hint={project.liveStatus !== project.displayStatus ? project.liveStatus : undefined}
        />
      </div>

      <div className="flex items-center gap-2" onClick={stop}>
        <ProjectMetricsBadges project={project} dense />
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
  onScroll,
}: WorkspaceCompactViewProps) {
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [confirmRoot, setConfirmRoot] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectViewModel } | null>(null);

  const moveCursor = (delta: number) => {
    const next = Math.min(projects.length - 1, Math.max(0, (cursor < 0 ? -1 : cursor) + delta));
    setCursor(next);
    const el = scrollRef.current;
    if (!el) return;
    const top = next * COMPACT_ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + COMPACT_ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = top + COMPACT_ROW_H - el.clientHeight;
  };

  const handleScroll = (e: UIEvent<HTMLDivElement>) => onScroll?.(e.currentTarget.scrollTop);

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="grid"
      aria-label={t('projectsGrid')}
      className="flex-1 overflow-auto"
      style={{
        borderRadius: 12,
        border: '0.5px solid var(--separator)',
        background: 'var(--surface)',
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
      {projects.map((p, i) => (
        <CompactRow
          key={p.root}
          project={p}
          selected={selected.has(p.root)}
          cursored={i === cursor}
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
