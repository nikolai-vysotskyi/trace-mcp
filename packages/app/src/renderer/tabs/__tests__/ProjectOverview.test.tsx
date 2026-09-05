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
import { ProjectOverview, coverageTone, formatIndexedAt, shortPath } from '../ProjectOverview';
import { setLocale } from '../../i18n';
import { relativeTime } from '../../i18n/format';

const ROOT = '/Users/someone/code/demo-app';

const daemon = {
  projects: [] as { root: string; status: string; progress?: { phase: string; percent: number } }[],
  loading: false,
  connected: true,
  restarting: false,
  restartDaemon: vi.fn(),
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
  /* The pane keeps its last stats in localStorage (TRA-934), and jsdom shares
     one store across every test in this file — so a test that fetches stats
     successfully would otherwise hand its numbers to the next one. */
  localStorage.clear();
  daemon.projects = [{ root: ROOT, status: 'ready' }];
  daemon.loading = false;
  daemon.connected = true;
  daemon.restarting = false;
  daemon.restartDaemon.mockClear();
  daemon.reindexProject.mockClear();
  daemon.addProject.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('formatting helpers', () => {
  it('renders a path relative to the home directory', () => {
    expect(shortPath('/Users/someone/code/demo-app')).toBe('~/code/demo-app');
    expect(shortPath('/opt/src/thing')).toBe('/opt/src/thing');
  });

  /* The surface's own hand-rolled helper is gone; the shared Intl one produces
     the same English and the same singular/plural split, which is what this
     asserted all along. Its only behaviour change is the sub-minute case: Intl
     says "30 seconds ago" where the old helper rounded to "just now". */
  it('describes recency in words, singular and plural', () => {
    const now = Date.UTC(2026, 7, 28, 12, 0, 0);
    expect(relativeTime(now - 30_000, now)).toBe('30 seconds ago');
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

  it('opens on the last known numbers while the daemon is unanswered', async () => {
    /* TRA-934. Measured on this machine, every renderer read of the daemon
       blocked for 7.80 s at once while it indexed. Without a snapshot this pane
       spent all of it on five grey bars for counts that were on disk. With one
       it opens on the counts and says they are the last indexed ones. */
    localStorage.setItem(`trace-mcp.overview.stats:${ROOT}`, JSON.stringify(STATS));
    // Every endpoint hangs — the wedge, not a refusal.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText('337')).toBeTruthy();
    expect(
      screen.getByText('The daemon is busy. These are the last indexed numbers.'),
    ).toBeTruthy();
  });

  it('does not call a project the daemon forgot "not indexed"', async () => {
    /* Seen on the shipped build: the daemon's registry reset, so the project
       was absent from its list while the on-disk index still reported 2,196
       files. "Status: Not indexed" sat one row above "Files indexed 2,196". */
    daemon.projects = [];
    daemon.loading = false;
    daemon.connected = true;
    mockApi({ '/stats': STATS, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText('Not tracked')).toBeTruthy();
    expect(screen.queryByText('Not indexed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Re-add project' })).toBeTruthy();
  });

  /* TRA-469. Every section here reads the daemon, so a daemon that never
     answered used to fail all five at once: the toolbar chip, Guard's own line
     and four section errors, six statements about one dead process. Four of
     them said "the daemon may still be indexing" — the *wait* state — and
     offered a Retry against a socket that was refusing. One condition gets one
     sentence (DESIGN.md §5), and this one is a button, not a wait. */
  it('says an unreachable daemon once, with the process to start', async () => {
    daemon.projects = [];
    daemon.loading = false;
    daemon.connected = false;
    mockApi({ '/stats': null, '/coverage': null, '/subprojects': null, '/smells': null });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText("The daemon isn't running")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start daemon' })).toBeTruthy();

    // Not the five broken cards, and not a second copy of the diagnosis.
    expect(screen.queryByText(/may still be indexing/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Daemon unreachable' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Index project' })).toBeNull();
  });

  /* The pane is for a daemon that never answered, NOT for the first moments of
     a mount — `connected` is false there too, and a naive test would flash it
     on every project open. */
  it('does not show the daemon-down pane while the daemon is still answering', async () => {
    daemon.projects = [];
    daemon.loading = true;
    daemon.connected = false;
    mockApi({ '/stats': STATS, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeTruthy();
    expect(screen.queryByText("The daemon isn't running")).toBeNull();
  });

  /* TRA-489. `deriveDaemonState` returns three values and the pane above only
     tested one of them. 'stale' — a feed that dropped after the daemon had
     already named some projects — left all five sections rendering, and with
     nothing behind them all five failed: the six-statement pane, back in full.
     Workspace can afford 'stale' because it has cached KPI numbers to keep on
     screen; this surface caches nothing, so 'stale' here IS down. */
  it('says a stale daemon once too, not five times', async () => {
    daemon.projects = [{ root: ROOT, status: 'ready' }];
    daemon.loading = false;
    daemon.connected = false;
    mockApi({ '/stats': null, '/coverage': null, '/subprojects': null, '/smells': null });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByText("The daemon isn't running")).toBeTruthy();
    expect(screen.queryByText(/may still be indexing/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    /* And the toolbar dot does not keep the last snapshot's green over a pane
       that says the daemon is gone — measured on the render, where 'stale'
       still had `status: 'ready'` cached and showed one. */
    expect(document.querySelector('.ws-statusdot.t-green')).toBeNull();
    expect(document.querySelector('.ws-statusdot.t-neutral')).toBeTruthy();
  });

  /* The other uncovered branch, and the one that made the bug intermittent:
     `loading` reduces to 'ok', so the sections render — and four local fetches
     against a refused socket lose to no one. They finished failing before the
     daemon conceded, painting the same four errors under a toolbar that said
     "Checking…". Until the daemon has answered there is nothing to fetch. */
  it('does not paint section failures before the daemon has answered', async () => {
    daemon.projects = [];
    daemon.loading = true;
    daemon.connected = false;
    mockApi({ '/stats': null, '/coverage': null, '/subprojects': null, '/smells': null });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/may still be indexing/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText("The daemon isn't running")).toBeNull();
  });

  it('keeps the chrome and offers a retry when a section fails', async () => {
    mockApi({ '/stats': null, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    await waitFor(() => expect(screen.getByText(/Couldn't load the index summary/)).toBeTruthy());
    /* The toolbar does not disappear when one section fails. */
    expect(screen.getByRole('button', { name: 'Reindex' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    /* And it does not name a cause it cannot know (TRA-662). */
    expect(screen.queryByText(/still be indexing/)).toBeNull();
  });

  /* TRA-662. The daemon is UP here — the pane above never fires — and two
     sections fail anyway. Before this they each stated it separately, which
     put the same sentence on screen twice, over a project last indexed five
     days ago and a daemon with nothing running. */
  it('states a multi-section failure once, with one retry', async () => {
    mockApi({ '/stats': null, '/coverage': COVERAGE, '/subprojects': {}, '/smells': null });
    render(<ProjectOverview root={ROOT} />);

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't load the index summary and the quality scan."),
      ).toBeTruthy(),
    );
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    /* The collapsed sections leave no empty heading behind — a title over a
       card that only repeats the banner is not information. */
    expect(screen.queryByText('Index')).toBeNull();
    expect(screen.queryByText('Quality')).toBeNull();
    /* The sections that answered are untouched. */
    expect(screen.getByText('Coverage')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reindex' })).toBeTruthy();
  });
});

/* TRA-384. A key that is in the catalogue but not wired into the component
   still renders — it renders the key. Nothing above catches that, because the
   English catalogue and the English literal it replaced read identically. This
   is the check that does: one surface, rendered in the other language.
   (The Russian here is the shipped translation being asserted, not authored
   content — see catalog/ru/overview.ts.) */
describe('the surface reads from the catalogue, not from literals', () => {
  afterEach(() => setLocale('en'));

  it('renders in Russian when Russian is the active language', async () => {
    setLocale('ru');
    mockApi({ '/stats': STATS, '/coverage': COVERAGE, '/subprojects': {}, '/smells': NO_SMELLS });
    render(<ProjectOverview root={ROOT} />);

    expect(await screen.findByRole('button', { name: 'Переиндексировать' })).toBeTruthy();
    expect(screen.getByText('Индекс')).toBeTruthy();
    expect(screen.getByText('Файлов проиндексировано')).toBeTruthy();
    expect(screen.queryByText('Reindex')).toBeNull();
  });

  /* A list of nouns dropped into a sentence written for one noun is not a
     sentence. `Intl.ListFormat` joins the nouns and cannot touch the verb
     around them: Spanish needs `pudieron`, not `pudo`. German's old wording
     `{{what}} konnte nicht geladen werden` could not be pluralised into a
     correct sentence at all — the interpolation was sentence-initial, so it
     also opened every German error with a lowercase article — and now reads
     off a colon, where number and case stop mattering. */
  it.each([
    ['de', 'Fehler beim Laden: die Index-Übersicht und der Qualitätsscan.'],
    ['es', 'No se pudieron cargar el resumen del índice y el escaneo de calidad.'],
  ])('agrees with a plural subject in %s', async (locale, sentence) => {
    setLocale(locale);
    mockApi({ '/stats': null, '/coverage': COVERAGE, '/subprojects': {}, '/smells': null });
    render(<ProjectOverview root={ROOT} />);

    await waitFor(() => expect(screen.getByText(sentence)).toBeTruthy());
  });
});
