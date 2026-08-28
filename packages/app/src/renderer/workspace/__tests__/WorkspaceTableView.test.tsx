/**
 * @vitest-environment jsdom
 */
import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROW_H, WINDOW_THRESHOLD, WorkspaceTableView, visibleRange } from '../WorkspaceTableView';
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

// Twelve sibling checkouts share the first 40 characters of their path; tail
// truncation hides the only part that tells them apart (TRA-292).
describe('WorkspaceTableView row content', () => {
  it('truncates the project path at the head, keeping the tail visible', () => {
    const container = renderTable();
    const path = within(container).getByTitle(PROJECT.root);
    expect(path.style.direction).toBe('rtl');
    expect(path.textContent).toBe(`\u200e${PROJECT.root}`);
  });

  it('labels every icon-only row action, including the destructive one', () => {
    const container = renderTable();
    for (const label of ['Open alpha', 'Re-index alpha', 'Remove alpha from the workspace']) {
      expect(within(container).getByLabelText(label)).toBeTruthy();
    }
  });

  it('spells the grade badge out for assistive tech', () => {
    const container = renderTable();
    expect(within(container).getByLabelText('Tech debt grade B')).toBeTruthy();
  });

  // The 24px hit target is a controls.css rule on every `input[type=checkbox]`
  // and is measured in lattice/ui/__tests__/primitives.test.tsx. What this
  // surface owns is using the real primitive, so it inherits that rule instead
  // of re-declaring a smaller inline size.
  it('renders row selection as a labelled native checkbox, not a styled div', () => {
    const container = renderTable();
    const box = within(container).getByLabelText('Select alpha') as HTMLInputElement;
    expect(box.tagName).toBe('INPUT');
    expect(box.type).toBe('checkbox');
    expect(box.style.width).toBe('');
  });
});

describe('visibleRange', () => {
  it('renders everything below the windowing threshold', () => {
    expect(visibleRange(WINDOW_THRESHOLD, 0, 600)).toEqual({ start: 0, end: WINDOW_THRESHOLD });
  });

  it('windows a thousand rows down to what fits plus overscan', () => {
    const { start, end } = visibleRange(1000, 100 * ROW_H, 600);
    expect(start).toBeLessThanOrEqual(100);
    expect(start).toBeGreaterThan(80);
    expect(end - start).toBeLessThan(40);
  });

  it('clamps at both ends', () => {
    expect(visibleRange(1000, 0, 600).start).toBe(0);
    expect(visibleRange(1000, 1000 * ROW_H, 600).end).toBe(1000);
  });

  it('falls back to rendering everything before the viewport is measured', () => {
    expect(visibleRange(1000, 0, 0)).toEqual({ start: 0, end: 1000 });
  });
});
