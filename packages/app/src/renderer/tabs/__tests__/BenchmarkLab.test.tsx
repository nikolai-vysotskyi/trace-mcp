// @vitest-environment jsdom
/**
 * Benchmark Lab — the TRA-1951 contract at the UI level: the tab opens
 * against a live-looking daemon, a run executes and its table renders from
 * the returned record, a failed run says so, and the export path shows the
 * markdown the docs pages quote.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BenchmarkLab } from '../BenchmarkLab';

const ARMS = {
  arms: [
    { id: 'file-reading', label: 'File reading (baseline)', description: 'Raw reads.', tools: [] },
    { id: 'minimal', label: 'minimal preset', description: 'Default surface.', tools: ['search'] },
    { id: 'standard', label: 'standard preset', description: 'Wider surface.', tools: ['search'] },
  ],
};

const FIXTURES = {
  fixtures: [
    { id: 'fx-one', kind: 'symbol', query: 'foo', k: 5 },
    { id: 'fx-two', kind: 'file', query: 'bar', k: 5 },
  ],
};

const RUN = {
  run_id: 'lab-20260926-000000-aaaaaa',
  schema_version: 1,
  started_at: '2026-09-26T00:05:00.000Z',
  finished_at: '2026-09-26T00:06:00.000Z',
  project_root: '/tmp/proj',
  battery: { source: 'tests/recall-harness/fixtures', fixtures_sha: 'abc123', fixture_count: 2 },
  measured_build: { version: '3.33.0', commit: 'deadbeef' },
  model: { name: 'claude-sonnet-4-5', input_usd_per_mtok: 3 },
  arms: ['file-reading', 'minimal'],
  results: [
    {
      fixture_id: 'fx-one',
      kind: 'symbol',
      query: 'foo',
      k: 5,
      baseline: 1,
      arms: {
        'file-reading': { calls: 1, tokens: 1000, success: true, ms: 3, recall_at_k: null },
        minimal: { calls: 1, tokens: 200, success: true, ms: 12, recall_at_k: 1 },
      },
    },
  ],
  aggregates: [
    {
      arm: 'file-reading',
      fixtures: 1,
      success_count: 1,
      success_rate: 100,
      total_tokens: 1000,
      total_calls: 1,
      total_ms: 3,
      median_tokens_per_fixture: 1000,
      savings_vs_baseline_pct: null,
      cost_usd: 0.003,
    },
    {
      arm: 'minimal',
      fixtures: 1,
      success_count: 1,
      success_rate: 100,
      total_tokens: 200,
      total_calls: 1,
      total_ms: 12,
      median_tokens_per_fixture: 200,
      savings_vs_baseline_pct: 80,
      cost_usd: 0.0006,
    },
  ],
};

vi.mock('../../hooks/useDaemon', () => ({
  useDaemon: () => ({
    projects: [{ root: '/tmp/proj', status: 'ready' }],
    restarting: false,
    restartDaemon: vi.fn(),
  }),
}));

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = handler(url, init);
      if (body instanceof Response) return body;
      if (typeof body === 'string') return new Response(body, { status: 200 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const okReads = () =>
  mockFetch((url) => {
    if (url.endsWith('/api/benchmark-lab/arms')) return ARMS;
    if (url.endsWith('/api/benchmark-lab/fixtures')) return FIXTURES;
    if (url.endsWith('/api/benchmark-lab/runs')) return { runs: [] };
    throw new Error(`unexpected GET ${url}`);
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BenchmarkLab', () => {
  it('opens with the arm picker and an empty state', async () => {
    okReads();
    render(<BenchmarkLab />);
    expect(await screen.findByRole('heading', { name: 'Benchmark Lab', level: 2 })).toBeTruthy();
    expect(screen.getByText('File reading (baseline)')).toBeTruthy();
    expect(screen.getByText('minimal preset')).toBeTruthy();
    expect(await screen.findByText('No runs yet')).toBeTruthy();
  });

  it('runs the battery and renders the returned record, not a recomputation', async () => {
    okReads();
    const seen: { url: string; init?: RequestInit }[] = [];
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/api/benchmark-lab/run')) return new Response(JSON.stringify({ run: RUN, file: 'x.json' }), { status: 200 });
      if (url.endsWith('/api/benchmark-lab/arms')) return new Response(JSON.stringify(ARMS), { status: 200 });
      if (url.endsWith('/api/benchmark-lab/fixtures')) return new Response(JSON.stringify(FIXTURES), { status: 200 });
      if (url.endsWith('/api/benchmark-lab/runs')) return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    render(<BenchmarkLab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run benchmark' }));

    // The aggregate table prints the daemon's numbers verbatim.
    expect(await screen.findByText('−80.0%')).toBeTruthy();
    expect(screen.getByText('$0.0006')).toBeTruthy();
    // Provenance travels with the number.
    expect(screen.getByText(/Measured 2026-09-26 · build 3.33.0@deadbeef · battery abc123/)).toBeTruthy();
    // Per-fixture row from the same record.
    expect(screen.getByText('fx-one')).toBeTruthy();

    const post = seen.find((s) => s.url.endsWith('/api/benchmark-lab/run'));
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      project: '/tmp/proj',
      arms: ['file-reading', 'minimal', 'standard'],
    });
  });

  it('says the run failed instead of printing a stale table', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/benchmark-lab/run'))
        return new Response(JSON.stringify({ error: 'no index DB' }), { status: 500 });
      if (url.endsWith('/api/benchmark-lab/arms')) return ARMS;
      if (url.endsWith('/api/benchmark-lab/fixtures')) return FIXTURES;
      return { runs: [] };
    });
    render(<BenchmarkLab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run benchmark' }));
    expect(await screen.findByText(/Run failed/)).toBeTruthy();
    expect(screen.queryByText('−80.0%')).toBeNull();
  });

  it('exports the daemon markdown and offers it for copy', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/benchmark-lab/run'))
        return new Response(JSON.stringify({ run: RUN, file: 'x.json' }), { status: 200 });
      if (url.includes('/api/benchmark-lab/export')) return '## Benchmark Lab run x\n';
      if (url.endsWith('/api/benchmark-lab/arms')) return ARMS;
      if (url.endsWith('/api/benchmark-lab/fixtures')) return FIXTURES;
      return { runs: [] };
    });
    render(<BenchmarkLab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run benchmark' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export markdown' }));
    await waitFor(() => expect(screen.getByText(/Benchmark Lab run x/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
