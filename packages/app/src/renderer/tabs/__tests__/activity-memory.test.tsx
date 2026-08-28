/**
 * @vitest-environment jsdom
 *
 * TRA-294. These assert the things the Activity + Memory rewrite exists to fix,
 * so the surfaces fail loudly if they drift back:
 *
 *   - ONE toolbar per surface (Activity stacked three control rows; Memory four)
 *   - every icon-only control has a name and a tooltip
 *   - empty states are icon + line + sentence + an action, not two grey lines
 *   - the destructive row action is behind a menu, not inline in every row
 *   - no ALL-CAPS strings, no type below 11px, no glass on a card
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Activity } from '../Activity';
import { MemoryExplorer } from '../MemoryExplorer';

const ROOT = '/tmp/proj';
const now = Date.now();

const EMPTY_STATS = {
  window_ms: 3_600_000,
  total_calls: 0,
  error_rate: 0,
  hot_tools: [],
  hot_files: [],
  latency_buckets: [],
  error_groups: [],
  by_minute: [],
};

const DECISION = {
  id: 1,
  title: 'Index writes go through the queue',
  content: 'Direct SQLite writes from the watcher raced the indexer.',
  type: 'architecture_decision',
  project_root: ROOT,
  service_name: null,
  symbol_id: null,
  file_path: 'src/indexer/queue.ts',
  tags: '["indexer"]',
  valid_from: new Date(now).toISOString(),
  valid_until: null,
  session_id: null,
  source: 'manual',
  confidence: 1,
  git_branch: null,
  review_status: null,
  created_at: new Date(now).toISOString(),
  updated_at: null,
};

/** Route every endpoint these two surfaces touch; `decisions` is overridable. */
function mockApi(decisions: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const u = String(input);
      let body: unknown = {};
      if (u.includes('/journal/stats')) body = EMPTY_STATS;
      else if (u.includes('/journal')) body = [];
      else if (u.includes('/decisions/stats')) {
        body = { total: decisions.length, active: decisions.length, by_type: {}, by_source: {} };
      } else if (u.includes('/decisions')) body = { decisions, total: decisions.length };
      else if (u.includes('/ai/activity')) body = { entries: [], stats: null };
      else if (u.includes('/corpora')) body = { corpora: [] };
      else if (u.includes('/sessions')) body = { sessions: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

beforeEach(() => {
  const api = new Proxy(function () {} as object, {
    get: () => () => Promise.resolve(undefined),
    apply: () => Promise.resolve(undefined),
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
    },
  );
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render and flush the mount fetches. */
async function mount(node: React.ReactElement) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(node);
    await Promise.resolve();
    await Promise.resolve();
  });
  return result;
}

describe('Activity surface', () => {
  it('collapses its three control rows into exactly one toolbar', async () => {
    mockApi();
    const { container } = await mount(<Activity root={ROOT} />);
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  });

  it('puts the source switcher, the feed state and the search on that toolbar', async () => {
    mockApi();
    await mount(<Activity root={ROOT} />);
    const toolbar = screen.getByRole('toolbar');
    within(toolbar).getByRole('group', { name: 'Activity source' });
    within(toolbar).getByRole('button', { name: 'Tool calls' });
    /* The SSE stub never opens, so the feed reports Offline — the point is
       that the state is a WORD next to the dot, not the dot alone. */
    within(toolbar).getByText('Offline');
    within(toolbar).getByRole('textbox', { name: 'Search calls' });
  });

  it('names its icon-only controls for both the pointer and the screen reader', async () => {
    mockApi();
    await mount(<Activity root={ROOT} />);
    const toolbar = screen.getByRole('toolbar');
    for (const button of within(toolbar).getAllByRole('button')) {
      const hasText = (button.textContent ?? '').trim().length > 0;
      if (hasText) continue;
      expect(button.getAttribute('aria-label'), button.outerHTML).toBeTruthy();
      expect(button.getAttribute('title'), button.outerHTML).toBeTruthy();
    }
  });

  it('offers an action from the empty feed instead of two grey lines', async () => {
    mockApi();
    await mount(<Activity root={ROOT} />);
    screen.getByText('No tool calls yet');
    screen.getByRole('button', { name: 'Connect a client' });
  });
});

describe('Memory surface', () => {
  it('collapses tab pills, stat card, add button and filter card into one toolbar', async () => {
    mockApi();
    const { container } = await mount(<MemoryExplorer root={ROOT} />);
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  });

  it('puts the one prominent action on that toolbar, at control height', async () => {
    mockApi();
    await mount(<MemoryExplorer root={ROOT} />);
    const toolbar = screen.getByRole('toolbar');
    const add = within(toolbar).getByRole('button', { name: 'Add decision' });
    /* The old button was a 40px `rounded-md` accent block on a row of its own. */
    expect(add.className).toContain('lx-btn');
    expect(add.className).toContain('v-prominent');
  });

  it('replaces MATCH / EXCLUDE with one search field, exclude behind the menu', async () => {
    mockApi();
    await mount(<MemoryExplorer root={ROOT} />);
    expect(screen.queryByText('Match')).toBeNull();
    expect(screen.queryByText('Exclude')).toBeNull();
    screen.getByRole('textbox', { name: 'Search decisions' });
  });

  it('gives the empty list the action it was missing', async () => {
    mockApi();
    await mount(<MemoryExplorer root={ROOT} />);
    screen.getByText('No decisions yet');
    screen.getByRole('button', { name: 'Add the first decision' });
  });

  it('walks the decision list with the arrow keys', async () => {
    const second = { ...DECISION, id: 2, title: 'Embeddings are rebuilt on schema change' };
    mockApi([DECISION, second]);
    await mount(<MemoryExplorer root={ROOT} />);

    /* The same selector the roving handler walks. */
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]'),
    ].filter((el) => el.textContent?.startsWith(DECISION.title) || el.textContent?.startsWith(second.title));
    expect(rows.length).toBe(2);

    rows[0].focus();
    await act(async () => {
      fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    });
    expect(document.activeElement).toBe(rows[1]);

    await act(async () => {
      fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
    });
    expect(document.activeElement).toBe(rows[0]);

    /* ArrowUp at the top stays put rather than escaping the list. */
    await act(async () => {
      fireEvent.keyDown(rows[0], { key: 'ArrowUp' });
    });
    expect(document.activeElement).toBe(rows[0]);
  });

  it('keeps the destructive action out of the row and behind a named menu', async () => {
    mockApi([DECISION]);
    await mount(<MemoryExplorer root={ROOT} />);
    /* "Invalidate" used to be a red bordered button in every row, one click
       from expiring a decision with no confirmation. */
    expect(screen.queryByRole('button', { name: /^Invalidate/ })).toBeNull();
    screen.getByRole('button', { name: `Actions for ${DECISION.title}` });
  });
});

/* A dead daemon must not read as "you have no data" — that sends you off to
   connect a client that is already connected, or to re-add decisions you
   already have. */
describe('failure is its own state', () => {
  function failApi() {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  }

  it('Activity says the indexer is unreachable, not that there are no calls', async () => {
    failApi();
    await mount(<Activity root={ROOT} />);
    screen.getByText("Can't reach the indexer");
    expect(screen.queryByText('No tool calls yet')).toBeNull();
    screen.getByRole('button', { name: 'Try again' });
  });

  it('Memory offers a retry instead of the add-your-first empty state', async () => {
    failApi();
    await mount(<MemoryExplorer root={ROOT} />);
    screen.getByText(/Couldn.t load the decisions for this project/);
    expect(screen.queryByText('No decisions yet')).toBeNull();
    screen.getByRole('button', { name: 'Retry' });
  });
});

/* ── Source-level guards ───────────────────────────────────────────────────
   jsdom does not resolve Tailwind arbitrary values, so the type-scale and
   material rules are checked where they are written. Same shape as
   scripts/design-tokens.mjs: cheap, and it fails on the exact thing the
   definition of done names. */
describe('type scale and material', () => {
  const files = ['Activity.tsx', 'ToolActivity.tsx', 'AIActivity.tsx', 'MemoryExplorer.tsx'];
  /* vitest runs with cwd = packages/app; import.meta.url is a served URL. */
  const read = (f: string) =>
    readFileSync(join(process.cwd(), 'src/renderer/tabs', f), 'utf8')
      /* Drop comments: they describe what was removed. */
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it.each(files)('%s has no type below 11px', (f) => {
    const src = read(f);
    const tw = [...src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    const inline = [...src.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect([...tw, ...inline].filter((n) => n < 11)).toEqual([]);
  });

  it.each(files)('%s ships no ALL-CAPS strings', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/\btext-transform\b|textTransform|\buppercase\b|toUpperCase\(\)/);
  });

  it.each(files)('%s puts no glass on content', (f) => {
    expect(read(f)).not.toMatch(/backdropFilter|backdrop-filter/);
  });
});
