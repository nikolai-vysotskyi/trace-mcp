/**
 * @vitest-environment jsdom
 *
 * TRA-293. These assert the things the rewrite exists to fix, so they fail if
 * the surface drifts back: the primary action is a capsule and not a full-bleed
 * bar, states are designed rather than a grey line, row actions exist without
 * hover, and the timestamp answers "is this stale?".
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectOverview,
  coverageTone,
  formatIndexedAt,
  relativeTime,
  shortPath,
} from '../ProjectOverview';

const ROOT = '/Users/someone/code/demo-app';

const daemon = {
  projects: [] as { root: string; status: string; progress?: { phase: string; percent: number } }[],
  loading: false,
  connected: true,
  reindexProject: vi.fn(),
  addProject: vi.fn(),
};

vi.mock('../../hooks/useDaemon', () => ({
  useDaemon: () => daemon,
}));

/** Route each overview endpoint to a canned payload; `null` = a failed fetch. */
function mockApi(routes: Record<string, unknown | null>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (key === undefined || routes[key] === null) {
        return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => routes[key] } as unknown as Response;
    }),
  );
}

const STATS = { files: 77, symbols: 337, edges: 280, lastIndexed: '2026-08-28T17:01:49.000Z' };
const COVERAGE = {
  coverage: { total_significant: 4, covered: 4, coverage_pct: 100 },
  gaps: [],
  unknown: [],
};
const NO_SMELLS = {
  files_scanned: 77,
  findings: [],
  summary: { todo_comment: 0, empty_function: 0, hardcoded_value: 0, debug_artifact: 0 },
  total: 0,
};

beforeEach(() => {
  daemon.projects = [{ root: ROOT, status: 'ready' }];
  daemon.loading = false;
  daemon.connected = true;
  daemon.reindexProject.mockClear();
  daemon.addProject.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('formatting helpers', () => {
  it('renders a path relative to the home directory', () => {
    expect(shortPath('/Users/someone/code/demo-app')).toBe('~/code/demo-app');
    expect(shortPath('/opt/src/thing')).toBe('/opt/src/thing');
  });

  it('describes recency in words, singular and plural', () => {
    const now = Date.UTC(2026, 7, 28, 12, 0, 0);
    expect(relativeTime(now - 30_000, now)).toBe('just now');
    expect(relativeTime(now - 60_000, now)).toBe('1 minute ago');
    expect(relativeTime(now - 7_200_000, now)).toBe('2 hours ago');
    expect(relativeTime(now - 172_800_000, now)).toBe('2 days ago');
  });

  it('pairs the relative form with an absolute one', () => {
    const iso = '2026-08-28T10:00:00.000Z';
    const out = formatIndexedAt(iso, new Date(iso).getTime() + 7_200_000);
    expect(out.startsWith('2 hours ago · ')).toBe(true);
    /* The absolute half must not be a bare locale dump like "8/28/2026". */
    expect(out).not.toMatch(/\d+\/\d+\/\d{4}/);
  });

  it('does not crash on an unparseable timestamp', () => {
    expect(formatIndexedAt('not-a-date')).toBe('Unknown');
  });

  it('grades coverage on the same thresholds the meter is painted with', () => {
    expect(coverageTone(100)).toBe('green');
    expect(coverageTone(85)).toBe('orange');
    expect(coverageTone(40)).toBe('red');
  });
});

describe('ProjectOverview surface', () => {
  it('offers reindex as a capsule button, not a full-bleed accent bar', async () => {
    mockApi({ '/stats': STATS, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    const { container } = render(<ProjectOverview root={ROOT} />);

    const button = await screen.findByRole('button', { name: 'Reindex' });
    /* The old bar was `w-full` with an 8px radius and a 1640px span. */
    expect(button.className).toContain('lx-btn');
    expect(button.className).toContain('v-prominent');
    expect(button.className).not.toContain('w-full');

    /* And it is the ONLY prominent control on the surface — one per region. */
    expect(container.querySelectorAll('.lx-btn.v-prominent')).toHaveLength(1);
  });

  it('shows the indexing phase as a progress bar with an accessible value', async () => {
    daemon.projects = [{ root: ROOT, status: 'indexing', progress: { phase: 'Resolving edges', percent: 42 } }];
    mockApi({ '/stats': STATS, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    const bar = await screen.findByRole('progressbar', { name: 'Indexing progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(await screen.findByText('Resolving edges')).toBeTruthy();
    /* The button reports the state rather than inviting a second reindex — and
       carries `is-status`, without which :disabled dims the only progress text
       on the toolbar to 2.3:1. */
    const action = screen.getByRole('button', { name: 'Indexing…' });
    expect(action).toHaveProperty('disabled', true);
    expect(action.className).toContain('is-status');
  });

  it('gives the empty services list real anatomy, not one grey line', async () => {
    mockApi({
      '/stats': STATS,
      '/coverage': COVERAGE,
      '/subprojects': { repos: [], services: [] },
      '/smells': NO_SMELLS,
    });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText('No services detected')).toBeTruthy();
    expect(
      screen.getByText(/Services are found when the project is indexed/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add service/ })).toBeTruthy();
  });

  it('names the finding category in words instead of leaking the API enum', async () => {
    mockApi({
      '/stats': STATS,
      '/coverage': COVERAGE,
      '/subprojects': { repos: [], services: [] },
      '/smells': NO_SMELLS,
    });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText('No debug artifacts')).toBeTruthy();
    expect(screen.queryByText(/debug_artifact/)).toBeNull();
  });

  it('exposes every service action without a hover', async () => {
    mockApi({
      '/stats': STATS,
      '/coverage': COVERAGE,
      '/subprojects': {
        repos: [],
        services: [
          {
            id: 1,
            name: 'demo-api',
            repoRoot: '/Users/someone/code/demo-app',
            serviceType: null,
            projectGroup: null,
            endpointCount: 13,
          },
        ],
      },
      '/smells': NO_SMELLS,
    });
    render(<ProjectOverview root={ROOT} />);

    /* Previously three buttons that only existed at opacity 0 until hover. */
    const actions = await screen.findByRole('button', { name: 'Actions for demo-api' });
    expect(actions.getAttribute('title')).toBe('Actions for demo-api');
    /* A single unnamed group is not a group worth labelling. */
    expect(screen.queryByText('Ungrouped')).toBeNull();
    expect(screen.queryByText('No group')).toBeNull();
  });

  it('does not call an unanswered daemon "not indexed"', async () => {
    /* Reproduces what the running app showed: "Status: Not indexed" and
       "Index project" sitting directly above "Files indexed 78". */
    daemon.projects = [];
    daemon.loading = true;
    mockApi({ '/stats': STATS, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText('Checking…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Index project' })).toBeNull();
    expect(screen.queryByText('Not indexed')).toBeNull();
  });

  it('says the daemon is unreachable rather than blaming the project', async () => {
    daemon.projects = [];
    daemon.loading = false;
    daemon.connected = false;
    mockApi({ '/stats': null, '/coverage': null, '/subprojects': null, '/smells': null });
    render(<ProjectOverview root={ROOT} />);

    /* The toolbar always renders, so it carries the diagnosis even when every
       section fetch failed and the Status row never appeared. */
    const action = await screen.findByRole('button', { name: 'Daemon unreachable' });
    expect(action).toHaveProperty('disabled', true);
    expect(action.className).toContain('is-status');
    expect(screen.queryByRole('button', { name: 'Index project' })).toBeNull();
  });

  it('keeps the chrome and offers a retry when a section fails', async () => {
    mockApi({ '/stats': null, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    await waitFor(() => expect(screen.getByText(/Couldn't load the index summary/)).toBeTruthy());
    /* The toolbar does not disappear when one section fails. */
    expect(screen.getByRole('button', { name: 'Reindex' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });
});
