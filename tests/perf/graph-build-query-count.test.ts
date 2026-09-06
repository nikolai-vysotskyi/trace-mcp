/**
 * TRA-651 regression guard for the daemon's graph read path.
 *
 * `/api/projects/graph` rebuilds a whole-project graph per request on the same
 * thread that answers `/health`. What made that expensive was not the SQL but
 * the number of round trips: `getSymbolsByFileIds` ran one prepared statement
 * per file, so a 1 817-file project issued ~1 800 statements to fetch symbols
 * nobody read past `id`/`file_id`, and the chunked edge query re-parsed
 * identical SQL on every chunk.
 *
 * A timing assertion here would be machine-dependent and would rot. Statement
 * count would not: it is the thing that regressed and it is exact. The ceiling
 * is deliberately generous — this catches "the N+1 came back", not a drift of
 * a few queries.
 */
import { describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { buildGraphData } from '../../src/tools/analysis/visualize.js';
import { createTestStore } from '../test-utils.js';

/** Files × symbols-per-file, enough to make a per-file loop obvious. */
const FILES = 120;
const SYMBOLS_PER_FILE = 4;

function seed(store: Store): void {
  const fileIds: number[] = [];
  for (let f = 0; f < FILES; f++) {
    const id = store.insertFile(`src/mod${f}.ts`, 'typescript', `h${f}`, 500);
    fileIds.push(id);
    for (let s = 0; s < SYMBOLS_PER_FILE; s++) {
      store.insertSymbol(id, {
        symbolId: `src/mod${f}.ts::fn${s}#function`,
        name: `fn${s}`,
        kind: 'function',
        fqn: `mod${f}.fn${s}`,
        byteStart: s * 50,
        byteEnd: s * 50 + 40,
        lineStart: s * 5 + 1,
        lineEnd: s * 5 + 4,
      });
    }
  }
  // A chain of imports so the graph has edges to walk, not just isolated nodes.
  for (let f = 1; f < FILES; f++) {
    store.insertEdge(
      store.createNode('file', fileIds[f]),
      store.createNode('file', fileIds[f - 1]),
      'imports',
    );
  }
}

/**
 * Count statement *executions* for the duration of `fn`, not `prepare` calls:
 * the N+1 this guards against ran a statement the repository had prepared once
 * in its constructor, so a prepare counter never saw it.
 */
function countQueries(store: Store, fn: () => void): number {
  // biome-ignore lint/suspicious/noExplicitAny: reaching the raw handle is the point of the probe
  const db = (store as any).db as { prepare: (sql: string) => { all: unknown } };
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as {
    all: (...a: unknown[]) => unknown;
  };
  const original = proto.all;
  let calls = 0;
  proto.all = function patched(this: unknown, ...a: unknown[]) {
    calls++;
    return original.apply(this, a);
  };
  try {
    fn();
  } finally {
    proto.all = original;
  }
  return calls;
}

describe('TRA-651: whole-project graph build does not scale queries with file count', () => {
  it('issues far fewer statements than it has files', () => {
    const store = createTestStore();
    seed(store);

    let nodes = 0;
    const queries = countQueries(store, () => {
      const g = buildGraphData(store, {
        scope: 'project',
        depth: 2,
        granularity: 'file',
        hideIsolated: false,
      } as never);
      nodes = g.nodes.length;
    });

    expect(nodes).toBeGreaterThan(0);
    // Before the fix this sat above FILES (one symbol query per file) and grew
    // linearly with the project. A batched build is a small fixed number of
    // statements per chunk, independent of FILES.
    expect(queries).toBeLessThan(FILES / 2);
  });
});
