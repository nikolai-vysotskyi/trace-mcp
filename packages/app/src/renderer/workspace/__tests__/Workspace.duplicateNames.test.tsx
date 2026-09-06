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
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .map((c) => c.getAttribute('aria-label') ?? '')
    .filter((l) => l.startsWith('Select ') && l !== 'Select all projects')
    .map((l) => l.slice('Select '.length));
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
});
