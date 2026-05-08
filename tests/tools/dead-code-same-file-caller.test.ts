/**
 * Regression test mirroring jcodemunch v1.80.10:
 *
 * `get_dead_code_v2` falsely flagged symbols whose only caller lived in the
 * SAME FILE as the symbol. Their `no_callers` signal only inspected files
 * that *imported* the symbol's file — the symbol's own file was skipped.
 * Combined with `unreachable_file` (entry files aren't imported anywhere)
 * and `not_barrel_exported`, this produced confidence-1.0 false positives.
 *
 * trace-mcp's getDeadCodeV2 should NOT have this bug because its call-graph
 * signal is built from `target_node_id` of every `calls`/`references` edge
 * regardless of file boundary. This test pins that behavior so a future
 * refactor that filters by file can't quietly regress it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getDeadCodeV2 } from '../../src/tools/refactoring/dead-code.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, p: string): number {
  return store.insertFile(p, 'typescript', `h_${p}`, 200);
}

function insertExportedSymbol(store: Store, fileId: number, name: string): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind: 'function',
    byteStart: 0,
    byteEnd: 100,
    metadata: { exported: true },
  });
}

function insertLocalSymbol(store: Store, fileId: number, name: string): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind: 'function',
    byteStart: 200,
    byteEnd: 300,
  });
}

describe('getDeadCodeV2 — same-file caller (jcodemunch v1.80.10 regression)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('does NOT flag a symbol whose only caller is in the same file', () => {
    // Single file `entry.ts` with two functions:
    //   - parseDeadCode (exported, the "victim" of the bug)
    //   - run (calls parseDeadCode locally — same file)
    // Neither is imported by any other file.
    const fEntry = insertFile(store, 'src/entry.ts');
    const calleeId = insertExportedSymbol(store, fEntry, 'parseDeadCode');
    const callerId = insertLocalSymbol(store, fEntry, 'run');

    const calleeNodeId = store.getNodeId('symbol', calleeId)!;
    const callerNodeId = store.getNodeId('symbol', callerId)!;

    // The intra-file call edge — exactly the input the v1.80.10 bug ignored.
    store.insertEdge(callerNodeId, calleeNodeId, 'calls', true);

    const result = getDeadCodeV2(store);
    const hit = result.dead_symbols.find((s) => s.name === 'parseDeadCode');
    expect(hit, 'parseDeadCode must not be flagged dead — it has an intra-file caller').toBe(
      undefined,
    );
  });

  it('still flags a genuinely-dead intra-file function (sanity check)', () => {
    // Same shape, but NO call edge from `run` to `parseDeadCode`.
    // The exported symbol really is unreferenced this time.
    const fEntry = insertFile(store, 'src/entry.ts');
    insertExportedSymbol(store, fEntry, 'reallyDead');
    insertLocalSymbol(store, fEntry, 'run');

    const result = getDeadCodeV2(store);
    expect(result.dead_symbols.find((s) => s.name === 'reallyDead')).toBeDefined();
  });

  it('records the call_graph signal as false when the caller is intra-file', () => {
    const fEntry = insertFile(store, 'src/entry.ts');
    const calleeId = insertExportedSymbol(store, fEntry, 'usedHere');
    const callerId = insertLocalSymbol(store, fEntry, 'run');
    const calleeNodeId = store.getNodeId('symbol', calleeId)!;
    const callerNodeId = store.getNodeId('symbol', callerId)!;
    store.insertEdge(callerNodeId, calleeNodeId, 'calls', true);

    const result = getDeadCodeV2(store, { threshold: 0 });
    const hit = result.dead_symbols.find((s) => s.name === 'usedHere');
    // Threshold 0 surfaces the symbol so we can inspect the signal map even
    // though the multi-signal verdict is "not dead enough".
    if (hit) {
      expect(hit.signals.call_graph).toBe(false);
    }
    // Either way: at the default threshold, this must NOT appear in dead_symbols.
    expect(getDeadCodeV2(store).dead_symbols.find((s) => s.name === 'usedHere')).toBeUndefined();
  });

  it('handles `references` edges intra-file the same way as `calls`', () => {
    // Some languages (Go, Rust) emit `references` rather than `calls` for
    // certain identifier uses. Coverage parity matters.
    const fEntry = insertFile(store, 'src/entry.ts');
    const calleeId = insertExportedSymbol(store, fEntry, 'CONFIG');
    const callerId = insertLocalSymbol(store, fEntry, 'main');
    const calleeNodeId = store.getNodeId('symbol', calleeId)!;
    const callerNodeId = store.getNodeId('symbol', callerId)!;
    store.insertEdge(callerNodeId, calleeNodeId, 'references', true);

    const result = getDeadCodeV2(store);
    expect(result.dead_symbols.find((s) => s.name === 'CONFIG')).toBeUndefined();
  });
});
