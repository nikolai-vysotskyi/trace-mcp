#!/usr/bin/env tsx
/**
 * TRA-880: what do trace-mcp *responses* cost in tokens?
 *
 * The advertised-surface side of the token story is measured and guarded
 * (`preset-surface-budget.test.ts`). The response side never was: `src/savings.ts`
 * scores every call against a hand-written `RAW_COST_ESTIMATES` table and a flat
 * `COMPRESSION_RATIO = 0.15`, so the "tokens saved" number it reports is
 * `calls x constant` and carries no measurement at all.
 *
 * This drives the real built server over stdio on a real repo, calls each tool
 * with representative arguments, and prints the token cost of what actually
 * comes back next to what savings.ts assumes.
 *
 * Run after `pnpm run build`:
 *   npx tsx scripts/bench-response-tokens.ts [repoPath]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { DEFAULT_DAEMON_PORT } from '../src/global.js';
import { estimateTokens } from '../src/utils/token-counter.js';
import { measuredBuild } from './measured-build.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TARGET = process.argv[2] ?? REPO;

/** Tool + args, ordered by real call volume from `~/.trace/savings.json`. */
/**
 * TRA-985: `search` is 24% of all recorded calls, and its cost depends far more
 * on the query than on the tool. One query decided a quarter of the published
 * aggregate: `savings` measured 363 tokens where the 15-query basket below
 * averages 859. Volume-heavy tools get a basket; the row published for them is
 * the mean over it, not one lucky sample. Provenance for the basket: the terms
 * are the fifteen most common subsystem nouns in this repo's own directory
 * names, chosen before any of them was measured.
 */
/**
 * `get_outline` (4 461 calls) and `search_text` (5 125 calls) carried the same
 * one-sample defect `search` did, and TRA-985's first pass left them alone to
 * keep that run's aggregate attributable. Measuring them showed the single
 * samples were not close: `get_outline` was published from `src/savings.ts`,
 * which is the **most expensive of fifteen files spanning a 17x spread** —
 * 1 427 tokens against a 558 basket mean. `search_text` went the other way,
 * 1 722 published against a 2 053 mean over a 1.7x spread.
 *
 * The two errors point in opposite directions, which is the argument for
 * baskets: a single sample is noise, not a consistent bias anyone could correct
 * for after the fact.
 *
 * Files are a size-stratified sample of this repo's own source: every
 * non-test `src/**\/*.ts` sorted by line count, fourteen taken at even
 * percentiles, plus `src/savings.ts` so the row stays comparable with the runs
 * that published only it. Fixed before any of them was measured. Outline cost
 * tracks symbol count and signature length rather than file length — the
 * 3 684-line `src/cli.ts` outlines in 370 tokens — so stratifying by size
 * spreads the sample without aiming it.
 */
const OUTLINE_BASKET = [
  'src/session/tracker.ts',
  'src/tools/_common/output-format.ts',
  'src/daemon/vitals-log.ts',
  'src/tools/analysis/module-graph.ts',
  'src/analytics/session-analytics.ts',
  'src/ai/voyage.ts',
  'src/indexer/plugins/integration/tooling/data-fetching/index.ts',
  'src/analytics/startup-watch.ts',
  'src/tools/advanced/intent.ts',
  'src/indexer/plugins/integration/messaging/kafka/index.ts',
  'src/tools/analysis/graph-timeline.ts',
  'src/indexer/plugins/language/kotlin/helpers.ts',
  'src/indexer/plugins/integration/tooling/electron/index.ts',
  'src/cli.ts',
  'src/savings.ts',
];

const SEARCH_BASKET = [
  'savings',
  'search',
  'indexer',
  'daemon',
  'token',
  'config',
  'preset',
  'telemetry',
  'embedding',
  'watcher',
  'launcher',
  'outline',
  'graph',
  'cache',
  'session',
];

const CALLS: Array<{
  tool: string;
  args: Record<string, unknown>;
  warmup?: boolean;
  /** Rows sharing a group collapse into one row holding their mean. */
  group?: string;
}> = [
  // Not measured: the session DB is seeded per-session, so index in-session to
  // make the run self-contained instead of depending on a prior `trace index`.
  { tool: 'reindex', args: {}, warmup: true },
  // Not measured: resolves a real symbol_id for the symbol-scoped tools below.
  { tool: 'search', args: { query: 'estimateTokens', kind: 'function', limit: 1 }, warmup: true },
  ...SEARCH_BASKET.map((query) => ({ tool: 'search_text', args: { query }, group: 'search_text' })),
  ...OUTLINE_BASKET.map((path) => ({ tool: 'get_outline', args: { path }, group: 'get_outline' })),
  ...SEARCH_BASKET.map((query) => ({ tool: 'search', args: { query }, group: 'search' })),
  { tool: 'get_symbol', args: { symbol_id: '$SYMBOL' } },
  { tool: 'find_usages', args: { symbol_id: '$SYMBOL' } },
  { tool: 'get_project_map', args: {} },
  { tool: 'get_index_health', args: {} },
  { tool: 'get_tests_for', args: { symbol_id: '$SYMBOL' } },
  { tool: 'get_context_bundle', args: { symbol_id: '$SYMBOL' } },
  { tool: 'get_task_context', args: { task: 'reduce tool response token cost' } },
  { tool: 'get_call_graph', args: { symbol_id: '$SYMBOL' } },
  { tool: 'get_complexity_report', args: {} },
  // TRA-945: the tail. The twelve above are 88% of recorded calls; these are the
  // next thirteen by volume, taking coverage to 97%.
  { tool: 'register_edit', args: { file_path: 'src/savings.ts' } },
  { tool: 'reindex', args: {} },
  { tool: 'get_feature_context', args: { description: 'tool response token cost' } },
  { tool: 'get_env_vars', args: {} },
  { tool: 'get_dead_code', args: {} },
  { tool: 'get_changed_symbols', args: {} },
  { tool: 'check_quality_gates', args: {} },
  { tool: 'get_circular_imports', args: {} },
  { tool: 'check_duplication', args: { name: 'estimateTokens' } },
  { tool: 'check_claudemd_drift', args: {} },
  { tool: 'scan_security', args: { rules: ['all'] } },
  { tool: 'list_projects', args: {} },
];

interface Row {
  tool: string;
  ok: boolean;
  chars: number;
  est: number;
  real: number;
  ms: number;
}

/**
 * Collapse every grouped row into one row holding the group's mean. Mean, not
 * median: the aggregate multiplies this by a call count, so it has to be the
 * average cost of a call.
 */
function collapseGroups(rows: Array<Row & { group?: string }>): Row[] {
  const out: Row[] = [];
  const groups = new Map<string, Array<Row & { group?: string }>>();
  for (const r of rows) {
    if (!r.group) {
      out.push(r);
      continue;
    }
    (groups.get(r.group) ?? groups.set(r.group, []).get(r.group)!).push(r);
  }
  const mean = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  for (const [, rs] of groups) {
    out.push({
      tool: rs[0].tool,
      ok: rs.every((r) => r.ok),
      chars: mean(rs.map((r) => r.chars)),
      est: mean(rs.map((r) => r.est)),
      real: mean(rs.map((r) => r.real)),
      ms: mean(rs.map((r) => r.ms)),
    });
  }
  return out;
}

function run(): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    // `--preset full` rather than TRACE_MCP_PRESET: the flag is applied before
    // the config loads, so it holds whatever the machine's global config says.
    // TRACE_MCP_NO_DAEMON only disables auto-*spawn*; a session still attaches
    // to a daemon that is already running, and answers at that daemon's preset
    // (TRA-951). bench-local-only.mjs makes the daemon port unreachable for
    // this child alone, so the run measures the surface it asked for on any
    // machine — with or without a daemon up.
    const server = spawn(
      'node',
      [
        '--import',
        pathToFileURL(join(REPO, 'scripts/bench-local-only.mjs')).href,
        join(REPO, 'dist/cli.js'),
        'serve',
        '--preset',
        'full',
      ],
      {
        cwd: TARGET,
        env: {
          ...process.env,
          TRACE_MCP_NO_DAEMON: '1',
          TRACE_MCP_BENCH_BLOCK_PORT: String(DEFAULT_DAEMON_PORT),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    const send = (m: unknown): void => void server.stdin.write(`${JSON.stringify(m)}\n`);
    const rows: Array<Row & { group?: string }> = [];
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error('timed out'));
    }, 900_000);

    let i = 0;
    let started = 0;
    let symbolId = '';
    const next = (): void => {
      if (i >= CALLS.length) {
        clearTimeout(timer);
        server.kill();
        resolve(collapseGroups(rows));
        return;
      }
      started = Date.now();
      const c = CALLS[i];
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.args)) args[k] = v === '$SYMBOL' ? symbolId : v;
      send({
        jsonrpc: '2.0',
        id: 100 + i,
        method: 'tools/call',
        params: { name: c.tool, arguments: args },
      });
    };

    let buf = '';
    server.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: {
          id?: number;
          result?: { content?: Array<{ text?: string }>; isError?: boolean };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          next();
          continue;
        }
        if (typeof msg.id === 'number' && msg.id >= 100) {
          const text = msg.result?.content?.map((c) => c.text ?? '').join('') ?? '';

          symbolId ||= /"symbol_id"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
          if (msg.result?.isError) console.error(`  [${CALLS[i].tool}] ${text.slice(0, 300)}`);
          if (!CALLS[i].warmup)
            rows.push({
              tool: CALLS[i].tool,
              ok: !msg.result?.isError,
              chars: text.length,
              est: estimateTokens(text),
              real: encode(text).length,
              ms: Date.now() - started,
              group: CALLS[i].group,
            });
          i += 1;
          next();
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench-response-tokens', version: '1' },
      },
    });
  });
}

// TRA-945: three sessions, median per tool. A single sample is not a
// measurement here — `get_task_context` moved 5 383 -> 8 357 tokens between two
// runs minutes apart on the same commit, because the answer depends on index
// state, not only on the code. The median is what gets published; the spread is
// printed so a reader can see it.
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const samples = new Map<string, Row[]>();
for (let n = 0; n < RUNS; n += 1) {
  for (const r of await run()) {
    if (!r.ok) {
      throw new Error(
        `[${r.tool}] returned an error — the preset or the index is wrong for this run, ` +
          'and a number measured on a degraded surface is worse than none. Fix, then re-run.',
      );
    }
    (samples.get(r.tool) ?? samples.set(r.tool, []).get(r.tool)!).push(r);
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const rows = [...samples.entries()].map(([tool, rs]) => ({
  tool,
  ok: true,
  chars: median(rs.map((r) => r.chars)),
  est: median(rs.map((r) => r.est)),
  real: median(rs.map((r) => r.real)),
  ms: median(rs.map((r) => r.ms)),
  runs: rs.length,
  real_min: Math.min(...rs.map((r) => r.real)),
  real_max: Math.max(...rs.map((r) => r.real)),
}));

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
console.log(
  `\n${pad('tool', 24)}${pad('chars', 10)}${pad('est(c/4)', 10)}${pad('o200k', 10)}${pad('min-max', 16)}${pad('ms', 8)}`,
);
for (const r of rows) {
  console.log(
    `${pad(r.tool, 24)}${pad(r.chars, 10)}${pad(r.est, 10)}${pad(r.real, 10)}${pad(`${r.real_min}-${r.real_max}`, 16)}${pad(r.ms, 8)}`,
  );
}
const total = rows.reduce((a, r) => a + r.real, 0);
console.log(`\nmedian of ${RUNS} runs; total o200k tokens across ${rows.length} tools: ${total}`);
writeFileSync(
  join(REPO, 'docs/perf/response-tokens.json'),
  `${JSON.stringify(
    {
      measured_at: new Date().toISOString(),
      // TRA-920: the build this ran at travels with the number to every surface.
      measured_build: measuredBuild(),
      target: TARGET === REPO ? 'self' : TARGET,
      runs: RUNS,
      rows,
    },
    null,
    2,
  )}\n`,
);
