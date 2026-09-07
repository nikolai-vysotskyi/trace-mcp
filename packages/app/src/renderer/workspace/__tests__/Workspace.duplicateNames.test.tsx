/**
 * @vitest-environment jsdom
 *
 * TRA-1058 follow-up: the sidebar's Recent list and Quick Open were fixed to
 * disambiguate roots that share a basename, but the projects list (Table and
 * Compact — the screen the bug was actually filed against) still rendered
 * bare `project.name`, so two roots named `workdir` were indistinguishable.
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '../Workspace';
import type { ProjectViewModel } from '../types';

const projects: ProjectViewModel[] = [
  '/x/tra-1049-f6ea6628d239/workdir',
  '/x/task-30782d5e62d2/workdir',
  '/y/unique',
].map((root) => ({
  root,
  name: root.split('/').filter(Boolean).pop() ?? root,
  displayStatus: 'ok',
  lastIndexed: null,
  hasMetrics: false,
  inDaemon: true,
}));

vi.mock('../useWorkspaceProjects', () => ({
  useWorkspaceProjects: () => ({
    projects,
    loading: false,
    metricsLoading: false,
    refreshing: false,
    error: null,
    errorKind: null,
    daemonState: 'ok',
    connected: true,
    restarting: false,
    addProject: async () => {},
    removeProject: async () => {},
    reindexProject: async () => {},
    reindexMany: async () => {},
    removeMany: async () => {},
    refresh: async () => {},
    restartDaemon: async () => {},
  }),
}));

/** Row labels in DOM order, read off the per-row select checkboxes. */
function renderedLabels(container: HTMLElement): string[] {
  return ariaLabelsWithPrefix(container, 'Select ').filter((l) => l !== 'all projects');
}

/**
 * Every `aria-label` in the container that starts with `prefix`, with the
 * prefix stripped — i.e. the disambiguated name each one embeds. Reads
 * checkboxes AND buttons, so it catches the row-level Open/Re-index/Remove
 * actions (`ProjectRowActions`) as well as Select.
 *
 * TRA-1058 follow-up #2: the first pass disambiguated the Select checkbox's
 * aria-label (`labelByRoot` reached `Row`/`CompactRow`) but not Open/Re-index/
 * Remove, which stayed on raw `project.name` inside the shared
 * `ProjectRowActions` component one level down — a second, independent
 * consumer of the same ambiguous field that the first fix never touched.
 * Iterating every prefix here, rather than asserting Select alone, is the
 * one-line guard Lead Engineer asked for so a fourth consumer can't repeat it.
 */
function ariaLabelsWithPrefix(container: HTMLElement, prefix: string): string[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-label]')]
    .map((el) => el.getAttribute('aria-label') ?? '')
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));
}

describe('Workspace duplicate project names', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('disambiguates same-basename rows in table view', () => {
    localStorage.setItem('trace-mcp.workspace.view', 'table');
    const { container } = render(<Workspace />);
    const labels = renderedLabels(container);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('tra-1049-f6ea6628d239 / workdir');
    expect(labels).toContain('task-30782d5e62d2 / workdir');
    expect(labels).toContain('unique');
  });

  it('disambiguates same-basename rows in compact view', () => {
    localStorage.setItem('trace-mcp.workspace.view', 'compact');
    const { container } = render(<Workspace />);
    const labels = renderedLabels(container);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(['table', 'compact'] as const)(
    'disambiguates every row action label in %s view, not just Select',
    (view) => {
      localStorage.setItem('trace-mcp.workspace.view', view);
      const { container } = render(<Workspace />);
      for (const prefix of ['Select ', 'Open ', 'Re-index ']) {
        const labels = ariaLabelsWithPrefix(container, prefix).filter((l) => l !== 'all projects');
        expect(new Set(labels).size, `${prefix.trim()} labels: ${JSON.stringify(labels)}`).toBe(
          labels.length,
        );
      }
      // "Remove {{name}} from the workspace" has its own suffix — same check,
      // different prefix/suffix pair.
      const removeLabels = [...container.querySelectorAll<HTMLElement>('[aria-label]')]
        .map((el) => el.getAttribute('aria-label') ?? '')
        .filter((l) => l.startsWith('Remove ') && l.endsWith(' from the workspace'));
      expect(new Set(removeLabels).size, `Remove labels: ${JSON.stringify(removeLabels)}`).toBe(
        removeLabels.length,
      );
    },
  );
});
