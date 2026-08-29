/**
 * @vitest-environment jsdom
 *
 * TRA-266: sorting lives in the shell, so Table and Compact render the same
 * order and switching views can't silently reshuffle the list.
 */
import { render, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '../Workspace';
import type { ProjectViewModel } from '../types';

const projects: ProjectViewModel[] = ['zulu', 'alpha', 'mike'].map((name) => ({
  root: `/Users/nikolai/Projects/${name}`,
  name,
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

/** Project names in DOM order, read off the per-row select checkboxes. */
function renderedOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .map((c) => c.getAttribute('aria-label') ?? '')
    .filter((l) => l.startsWith('Select ') && l !== 'Select all projects')
    .map((l) => l.slice('Select '.length));
}

describe('Workspace ordering', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sorts by name in the default table view', () => {
    localStorage.setItem('trace-mcp.workspace.view', 'table');
    const { container } = render(<Workspace />);
    expect(renderedOrder(container)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('applies the same sort in compact view', () => {
    localStorage.setItem('trace-mcp.workspace.view', 'compact');
    const { container } = render(<Workspace />);
    expect(renderedOrder(container)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('keeps the leading slash at the front of compact paths', () => {
    localStorage.setItem('trace-mcp.workspace.view', 'compact');
    const { container } = render(<Workspace />);
    const path = within(container).getByTitle('/Users/nikolai/Projects/alpha');
    // U+200E keeps the neutral "/" inside the LTR run despite direction: rtl.
    expect(path.textContent).toBe('\u200e/Users/nikolai/Projects/alpha');
  });
});
