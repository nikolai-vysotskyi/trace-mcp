/**
 * Per-project row actions, shared by the table and the compact list.
 *
 * Three icon-only buttons — Open, Re-index, Remove — each with a label and a
 * tooltip (an unlabelled "×" that deletes something is not an affordance), a
 * 24×24 hit target regardless of the 14px glyph, and the destructive one
 * behind a confirm. The same actions are also reachable by right-click via
 * {@link ProjectContextMenu}, so the pointer and the menu agree.
 *
 * The confirm step is owned by the view (`confirming` + `onRequestRemove`) so
 * the × button and the context menu drive the same one.
 */
import type { MouseEvent } from 'react';
import { Icon } from '../../lattice/icons';
import { Menu, MenuItem, MenuSeparator } from '../../lattice/ui';
import type { ProjectViewModel } from '../types';

export interface ProjectActionHandlers {
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRemove: (root: string) => void;
}

export interface RemoveConfirmState {
  /** This row is awaiting removal confirmation. */
  confirming: boolean;
  onRequestRemove: (root: string) => void;
  onCancelRemove: () => void;
}

export interface ProjectRowActionsProps extends ProjectActionHandlers, RemoveConfirmState {
  project: ProjectViewModel;
  /** false = daemon disconnected; Re-index/Remove are disabled. */
  canMutate: boolean;
}

/** 24×24 hit target, 14px glyph — the HIG floor even when the icon is small. */
const ICON_BTN =
  'w-6 h-6 inline-flex items-center justify-center rounded-md transition-colors ' +
  'hover:bg-[var(--bg-active)] disabled:opacity-30';

export function canReindex(project: ProjectViewModel, canMutate: boolean): boolean {
  const indexing = project.displayStatus === 'indexing' || project.displayStatus === 'computing';
  return canMutate && project.inDaemon && !indexing;
}

export function ProjectRowActions({
  project,
  canMutate,
  confirming,
  onRequestRemove,
  onCancelRemove,
  onOpen,
  onReindex,
  onRemove,
}: ProjectRowActionsProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  const mutationAllowed = canMutate && project.inDaemon;

  if (confirming) {
    return (
      <div className="flex items-center gap-1" onClick={stop}>
        <button
          type="button"
          onClick={onCancelRemove}
          className="h-6 text-[11px] px-2 rounded-full font-medium"
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
          onClick={() => onRemove(project.root)}
          className="h-6 text-[11px] px-2 rounded-full font-medium whitespace-nowrap"
          style={{ background: 'var(--destructive)', color: '#fff' }}
        >
          Remove project
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5" onClick={stop}>
      <button
        type="button"
        onClick={() => onOpen(project.root)}
        className={ICON_BTN}
        style={{ color: 'var(--accent)' }}
        aria-label={`Open ${project.name}`}
        title={`Open ${project.name}`}
      >
        <Icon name="arrow_right_alt" size={14} />
      </button>
      <button
        type="button"
        disabled={!canReindex(project, canMutate)}
        onClick={() => onReindex(project.root)}
        className={ICON_BTN}
        style={{ color: 'var(--text-secondary)' }}
        aria-label={`Re-index ${project.name}`}
        title={`Re-index ${project.name}`}
      >
        <Icon name="refresh" size={14} />
      </button>
      <button
        type="button"
        disabled={!mutationAllowed}
        onClick={() => onRequestRemove(project.root)}
        className={ICON_BTN}
        style={{ color: 'var(--text-tertiary)' }}
        aria-label={`Remove ${project.name} from the workspace`}
        title={`Remove ${project.name} from the workspace`}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export interface ProjectContextMenuProps {
  project: ProjectViewModel;
  canMutate: boolean;
  x: number;
  y: number;
  onOpen: (root: string) => void;
  onReindex: (root: string) => void;
  onRequestRemove: (root: string) => void;
  onClose: () => void;
}

export function ProjectContextMenu({
  project,
  canMutate,
  x,
  y,
  onOpen,
  onReindex,
  onRequestRemove,
  onClose,
}: ProjectContextMenuProps) {
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <Menu x={x} y={y} onClose={onClose}>
      <MenuItem icon="arrow_right_alt" onClick={run(() => onOpen(project.root))}>
        Open {project.name}
      </MenuItem>
      <MenuItem
        icon="refresh"
        disabled={!canReindex(project, canMutate)}
        onClick={run(() => onReindex(project.root))}
      >
        Re-index
      </MenuItem>
      <MenuItem
        icon="content_copy"
        onClick={run(() => void navigator.clipboard?.writeText(project.root))}
      >
        Copy path
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        danger
        icon="trash"
        disabled={!(canMutate && project.inDaemon)}
        onClick={run(() => onRequestRemove(project.root))}
      >
        Remove from workspace…
      </MenuItem>
    </Menu>
  );
}
