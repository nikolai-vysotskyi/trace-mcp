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
import { useTranslation } from 'react-i18next';
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
  /** Disambiguated display name — see Workspace.tsx (TRA-1058). Required, not
      defaulted to `project.name`: a missing prop should fail to compile, not
      silently reintroduce the ambiguity (this is the third time a consumer of
      `project.name` was found still unpatched after the first fix). */
  label: string;
  /** false = daemon disconnected; Re-index/Remove are disabled. */
  canMutate: boolean;
}

export function canReindex(project: ProjectViewModel, canMutate: boolean): boolean {
  const indexing = project.displayStatus === 'indexing' || project.displayStatus === 'computing';
  return canMutate && project.inDaemon && !indexing && project.displayStatus !== 'missing';
}

/** No directory, nothing to open (TRA-1054). Only Remove makes sense. */
function canOpen(project: ProjectViewModel): boolean {
  return project.displayStatus !== 'missing';
}

export function ProjectRowActions({
  project,
  label,
  canMutate,
  confirming,
  onRequestRemove,
  onCancelRemove,
  onOpen,
  onReindex,
  onRemove,
}: ProjectRowActionsProps) {
  const { t } = useTranslation('workspace');
  const stop = (e: MouseEvent) => e.stopPropagation();
  const mutationAllowed = canMutate && project.inDaemon;

  if (confirming) {
    return (
      <div className="flex items-center gap-1" onClick={stop}>
        <Button size="small" onClick={onCancelRemove}>
          {t('cancel')}
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
          {t('removeProject')}
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
        disabled={!canOpen(project)}
        onClick={() => onOpen(project.root)}
        style={{ color: 'var(--accent)' }}
        aria-label={t('openProject', { name: label })}
        title={t('openProject', { name: label })}
      />
      <Button
        variant="icon"
        icon="refresh"
        disabled={!canReindex(project, canMutate)}
        onClick={() => onReindex(project.root)}
        aria-label={t('reindexProject', { name: label })}
        title={t('reindexProject', { name: label })}
      />
      <Button
        variant="icon"
        icon="close"
        disabled={!mutationAllowed}
        onClick={() => onRequestRemove(project.root)}
        aria-label={t('removeProjectFrom', { name: label })}
        title={t('removeProjectFrom', { name: label })}
      />
    </div>
  );
}

export interface ProjectContextMenuProps {
  project: ProjectViewModel;
  /** Disambiguated display name — see Workspace.tsx (TRA-1058). Required, same
      reasoning as {@link ProjectRowActionsProps.label}. */
  label: string;
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
  label,
  canMutate,
  x,
  y,
  onOpen,
  onReindex,
  onRequestRemove,
  onClose,
}: ProjectContextMenuProps) {
  const { t } = useTranslation('workspace');
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <Menu x={x} y={y} onClose={onClose}>
      <MenuItem
        icon="arrow_right_alt"
        disabled={!canOpen(project)}
        onClick={run(() => onOpen(project.root))}
      >
        {t('openProject', { name: label })}
      </MenuItem>
      <MenuItem
        icon="refresh"
        disabled={!canReindex(project, canMutate)}
        onClick={run(() => onReindex(project.root))}
      >
        {t('reindex')}
      </MenuItem>
      <MenuItem
        icon="content_copy"
        onClick={run(() => void navigator.clipboard?.writeText(project.root))}
      >
        {t('copyPath')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        danger
        icon="trash"
        disabled={!(canMutate && project.inDaemon)}
        onClick={run(() => onRequestRemove(project.root))}
      >
        {t('removeFromWorkspace')}
      </MenuItem>
    </Menu>
  );
}
