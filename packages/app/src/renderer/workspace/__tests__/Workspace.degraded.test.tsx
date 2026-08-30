/**
 * @vitest-environment jsdom
 *
 * TRA-397 — one slow daemon used to produce three different banners and then
 * throw the numbers away. What this pins down:
 *
 *  - a slow daemon with cached values keeps the values and says so once;
 *  - a slow daemon with no cached values still says the same one thing;
 *  - a daemon that never answered is still its own screen, with the process
 *    to start on it.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace, busyMessage } from '../Workspace';
import type { ProjectViewModel } from '../types';
import type { UseWorkspaceProjectsResult } from '../useWorkspaceProjects';

const cached: ProjectViewModel[] = [
  {
    root: '/Users/nikolai/Projects/alpha',
    name: 'alpha',
    displayStatus: 'ok',
    lastIndexed: '2026-08-29T09:00:00Z',
    totalFiles: 1200,
    totalSymbols: 9800,
    techDebtGrade: 'A',
    securityFindings: 0,
    deadExports: 0,
    hasMetrics: true,
    inDaemon: true,
  },
];

const OK: UseWorkspaceProjectsResult = {
  projects: cached,
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
};

let data: UseWorkspaceProjectsResult = OK;

vi.mock('../useWorkspaceProjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../useWorkspaceProjects')>()),
  useWorkspaceProjects: () => data,
}));

/** The rendered value of one KPI tile, e.g. "1.2k" or "—". */
function kpi(label: string): string {
  const value = document.querySelector(`[data-kpi="${label}"] [data-kpi-value]`);
  return value?.textContent ?? '';
}

function banners(): string[] {
  return screen.queryAllByRole('status').map((el) => el.textContent ?? '');
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('trace-mcp.workspace.view', 'table');
  data = OK;
});

describe('a slow daemon', () => {
  it('keeps the cached numbers on screen under exactly one banner', () => {
    data = { ...OK, daemonState: 'stale', errorKind: 'timeout' };
    render(<Workspace />);

    expect(banners()).toHaveLength(1);
    expect(banners()[0]).toContain('These are the last indexed numbers.');
    // The values that were valid a minute ago are still the values.
    expect(kpi('Files')).toBe('1.2k');
    expect(kpi('Symbols')).toBe('9.8k');
    expect(screen.queryByText("Couldn't be measured")).toBeNull();
    // Slow is not down: no "start the daemon" anywhere on the screen.
    expect(screen.queryByText('Start daemon')).toBeNull();
  });

  it('says the same one thing when the feed is down instead of the fetch', () => {
    const slow = render(<Workspace />);
    data = { ...OK, daemonState: 'stale', connected: false };
    slow.rerender(<Workspace />);
    expect(banners()).toHaveLength(1);
    expect(banners()[0]).toContain('These are the last indexed numbers.');
  });

  it('reads as unknown, not as zero, when there is no snapshot to fall back on', () => {
    data = {
      ...OK,
      projects: [],
      metricsLoading: true,
      daemonState: 'stale',
      errorKind: 'timeout',
    };
    render(<Workspace />);

    expect(banners()).toHaveLength(1);
    // …and the line above them must not claim otherwise.
    expect(banners()[0]).toContain("The numbers arrive when it's done.");
    expect(kpi('Files')).toBe('—');
    // The banner is the only thing on screen that explains the em dashes. The
    // tiles used to caption every one of them "Couldn't be measured" — past
    // tense and terminal, under a banner that is future tense and transient,
    // about the same four numbers at the same instant (TRA-488).
    expect(screen.queryByText("Couldn't be measured")).toBeNull();
  });

  it('offers the retry that matches, and never a restart', () => {
    data = { ...OK, daemonState: 'stale', errorKind: 'offline' };
    render(<Workspace />);
    expect(within(screen.getByRole('status')).getByRole('button')).toHaveProperty(
      'textContent',
      'Try again',
    );
  });
});

describe('an unreachable daemon', () => {
  it('is its own screen, with no second sentence above it', () => {
    data = { ...OK, projects: [], daemonState: 'unreachable', connected: false };
    render(<Workspace />);

    expect(screen.getByText("The daemon isn't running")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start daemon' })).toBeTruthy();
    expect(banners()).toHaveLength(0);
  });

  /* One dead daemon used to be announced seven times in one window: the pane
     said it once with a Start daemon button, and the strip above it repeated
     "Couldn't be measured" on all six tiles (TRA-488). */
  it('is not repeated once per tile by the strip above it', () => {
    data = { ...OK, projects: [], daemonState: 'unreachable', connected: false };
    render(<Workspace />);

    expect(screen.queryByText("Couldn't be measured")).toBeNull();
    expect(kpi('Projects')).toBe('—');
  });
});

describe('busyMessage', () => {
  const withNumbers = { connected: true, indexing: 3, total: 12, haveNumbers: true };

  it('reports progress when the feed can tell us any', () => {
    expect(busyMessage(withNumbers)).toMatch(/^Indexing 3 of 12 projects\./);
  });

  it('does not guess at indexing with the feed down', () => {
    expect(busyMessage({ ...withNumbers, connected: false })).toMatch(/^The daemon is busy\./);
    expect(busyMessage({ ...withNumbers, indexing: 0 })).toMatch(/^The daemon is busy\./);
  });

  it('only claims there are numbers when there are', () => {
    expect(busyMessage(withNumbers)).toContain('These are the last indexed numbers.');
    expect(busyMessage({ ...withNumbers, haveNumbers: false })).toContain(
      "The numbers arrive when it's done.",
    );
  });
});
