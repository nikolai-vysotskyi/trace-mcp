/**
 * Tick overhead of the per-call compute guard (TRA-841).
 *
 * The guard only earns its place if an ordinary call does not notice it. This
 * runs the same `get_call_graph` traversal twice on a synthetic graph — once
 * with the guard live, once with `TRACE_MCP_NO_COMPUTE_GUARD=1` — and prints
 * the delta. Numbers quoted anywhere about guard overhead come from here.
 *
 *   pnpm exec tsx scripts/bench-compute-guard.ts
 */
import { createTestStore } from '../tests/test-utils.js';
import { getCallGraph } from '../src/tools/framework/call-graph.js';
import { forTool } from '../src/compute-guard.js';

const FANOUT = 8;
const LEVELS = 5;
const DEPTH = 5;
const RUNS = 40;

function buildGraph() {
  const store = createTestStore();
  store.ensureEdgeType('calls', 'code', 'Function calls');
  const fileId = store.insertFile('src/bench.ts', 'typescript', null, null);

  const nodeIds: number[] = [];
  let count = 0;
  for (let level = 0; level <= LEVELS; level++) count += FANOUT ** level;
  for (let i = 0; i < count; i++) {
    const symbolDbId = store.insertSymbol(fileId, {
      symbolId: `src/bench.ts::fn${i}#function`,
      name: `fn${i}`,
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
      lineStart: i + 1,
      lineEnd: i + 1,
    });
    nodeIds.push(store.getNodeId('symbol', symbolDbId)!);
  }
  // Balanced FANOUT-ary tree of `calls` edges.
  for (let i = 0; i * FANOUT + FANOUT < nodeIds.length; i++) {
    for (let k = 1; k <= FANOUT; k++) {
      store.insertEdge(nodeIds[i], nodeIds[i * FANOUT + k], 'calls');
    }
  }
  return { store, nodes: nodeIds.length };
}

function once(store: ReturnType<typeof buildGraph>['store'], guarded: boolean): number {
  if (guarded) delete process.env.TRACE_MCP_NO_COMPUTE_GUARD;
  else process.env.TRACE_MCP_NO_COMPUTE_GUARD = '1';
  const guard = forTool('get_call_graph');
  const started = process.hrtime.bigint();
  getCallGraph(store, { symbolId: 'src/bench.ts::fn0#function' }, DEPTH, guard);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (guarded) lastTicks = guard.consumed;
  return ms;
}

let lastTicks = 0;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const { store, nodes } = buildGraph();
process.stdout.write(`graph: ${nodes} symbols, fanout ${FANOUT}, depth ${DEPTH}, ${RUNS} runs\n`);

// Warm up so JIT and SQLite statement caches are not part of the measurement.
for (let i = 0; i < 10; i++) once(store, true);

// Alternate the two variants run-by-run: measuring them in separate blocks
// makes the first block eat every cold-cache cost and produced swings larger
// than the effect being measured.
const on: number[] = [];
const off: number[] = [];
for (let i = 0; i < RUNS; i++) {
  on.push(once(store, true));
  off.push(once(store, false));
}
const ticks = lastTicks;

const withGuard = median(on);
const withoutGuard = median(off);
const overhead = ((withGuard - withoutGuard) / withoutGuard) * 100;
process.stdout.write(
  `ticks/call:    ${ticks}\n` +
    `with guard:    ${withGuard.toFixed(3)} ms/call (median)\n` +
    `without guard: ${withoutGuard.toFixed(3)} ms/call (median)\n` +
    `overhead:      ${overhead.toFixed(2)}%\n`,
);
