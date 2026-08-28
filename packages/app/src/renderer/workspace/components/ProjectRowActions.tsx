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
import { Button, Menu, MenuItem, MenuSeparator } from '../../lattice/ui';
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
        <Button size="small" onClick={onCancelRemove}>
          Cancel
        </Button>
        {/* A destructive FILL, not --status-red: white on --status-red measures
            3.41:1 in dark. --danger-fill is the same hue tuned for a label. */}
        <Button
          size="small"
          variant="prominent"
          className="whitespace-nowrap"
          style={{ background: 'var(--danger-fill)' }}
          onClick={() => onRemove(project.root)}
        >
          Remove project
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5" onClick={stop}>
      {/* variant="icon" is 24×24 with a 16px glyph and will not compile without
          both a label and a tooltip — an unlabelled × that deletes is not an
          affordance. */}
      <Button
        variant="icon"
        icon="arrow_right_alt"
        onClick={() => onOpen(project.root)}
        style={{ color: 'var(--accent)' }}
        aria-label={`Open ${project.name}`}
        title={`Open ${project.name}`}
      />
      <Button
        variant="icon"
        icon="refresh"
        disabled={!canReindex(project, canMutate)}
        onClick={() => onReindex(project.root)}
        aria-label={`Re-index ${project.name}`}
        title={`Re-index ${project.name}`}
      />
      <Button
        variant="icon"
        icon="close"
        disabled={!mutationAllowed}
        onClick={() => onRequestRemove(project.root)}
        aria-label={`Remove ${project.name} from the workspace`}
        title={`Remove ${project.name} from the workspace`}
      />
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
