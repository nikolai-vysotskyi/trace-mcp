/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceTableView } from '../WorkspaceTableView';
import type { ProjectViewModel } from '../types';

const PROJECT: ProjectViewModel = {
  root: '/Projects/alpha',
  name: 'alpha',
  displayStatus: 'ok',
  lastIndexed: '2026-08-01T10:00:00Z',
  totalFiles: 12,
  totalSymbols: 340,
  deadExports: 0,
  untestedSymbols: 3,
  techDebtGrade: 'B',
  securityFindings: 2,
  hasMetrics: true,
  inDaemon: true,
};

function renderTable() {
  const { container } = render(
    <WorkspaceTableView
      projects={[PROJECT]}
      sortKey="name"
      sortDir="asc"
      onSort={() => {}}
      selected={new Set()}
      onSelectChange={() => {}}
      onSelectAll={() => {}}
      onOpen={() => {}}
      onReindex={() => {}}
      onRemove={() => {}}
      canMutate
    />,
  );
  return container;
}

/** Cells at `index` (0-based) of the header row and of the single body row. */
function column(container: HTMLElement, index: number): HTMLElement[] {
  const head = container.querySelectorAll('thead th')[index] as HTMLElement;
  const body = container.querySelectorAll('tbody td')[index] as HTMLElement;
  return [head, body];
}

// The table is wider than the 732 px viewport of the default 960×700 window;
// without frozen columns you can never see a project's name and its
// Security/Actions columns at the same time (TRA-265).
describe('WorkspaceTableView frozen columns', () => {
  it('pins the checkbox and Project columns to the left', () => {
    const container = renderTable();
    for (const cell of [...column(container, 0), ...column(container, 1)]) {
      expect(cell.style.position).toBe('sticky');
      expect(cell.style.left).not.toBe('');
      expect(cell.style.background).not.toBe('');
    }
    // Project sits immediately right of the checkbox column.
    for (const cell of column(container, 1)) {
      expect(cell.style.left).toBe('32px');
    }
  });

  it('pins the Actions column to the right', () => {
    const container = renderTable();
    const lastHeader = container.querySelectorAll('thead th').length - 1;
    const lastBody = container.querySelectorAll('tbody td').length - 1;
    expect(container.querySelectorAll('thead th')[lastHeader].textContent).toBe('Actions');
    for (const cell of [
      container.querySelectorAll('thead th')[lastHeader] as HTMLElement,
      container.querySelectorAll('tbody td')[lastBody] as HTMLElement,
    ]) {
      expect(cell.style.position).toBe('sticky');
      expect(cell.style.right).toBe('0px');
      expect(cell.style.background).not.toBe('');
    }
  });

  it('leaves the scrolling middle columns unpinned', () => {
    const container = renderTable();
    for (const cell of column(container, 4)) {
      expect(cell.style.position).toBe('');
    }
  });
});
