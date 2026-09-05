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
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { estimateTokens } from '../src/utils/token-counter.js';
import { measuredBuild } from './measured-build.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TARGET = process.argv[2] ?? REPO;

/** Tool + args, ordered by real call volume from `~/.trace/savings.json`. */
const CALLS: Array<{ tool: string; args: Record<string, unknown>; warmup?: boolean }> = [
  // Not measured: the session DB is seeded per-session, so index in-session to
  // make the run self-contained instead of depending on a prior `trace index`.
  { tool: 'reindex', args: {}, warmup: true },
  // Not measured: resolves a real symbol_id for the symbol-scoped tools below.
  { tool: 'search', args: { query: 'estimateTokens', kind: 'function', limit: 1 }, warmup: true },
  { tool: 'search_text', args: { query: 'estimateTokens' } },
  { tool: 'get_outline', args: { path: 'src/savings.ts' } },
  { tool: 'search', args: { query: 'savings' } },
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

function run(): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    // `--preset full` rather than TRACE_MCP_PRESET: the flag is applied before
    // the config loads, so it holds whatever the machine's global config says.
    const server = spawn('node', [join(REPO, 'dist/cli.js'), 'serve', '--preset', 'full'], {
      cwd: TARGET,
      env: { ...process.env, TRACE_MCP_NO_DAEMON: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const send = (m: unknown): void => void server.stdin.write(`${JSON.stringify(m)}\n`);
    const rows: Row[] = [];
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
        resolve(rows);
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
