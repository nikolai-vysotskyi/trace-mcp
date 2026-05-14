/**
 * Behavioural coverage for `getCouplingMetrics()` in
 * `src/tools/analysis/graph-analysis.ts` (the implementation behind the
 * `get_coupling` MCP tool). Per-file afferent (Ca), efferent (Ce), and
 * instability index Ce / (Ca + Ce).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getCouplingMetrics } from '../../../src/tools/analysis/graph-analysis.js';
import { createTestStore } from '../../test-utils.js';

interface FileNode {
  filePath: string;
  fileNodeId: number;
}

function insertFileNode(store: Store, filePath: string): FileNode {
  const fid = store.insertFile(filePath, 'typescript', `h-${filePath}`, 100);
  store.insertSymbol(fid, {
    symbolId: `${filePath}::main#function`,
    name: 'main',
    kind: 'function',
    fqn: 'main',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });
  return { filePath, fileNodeId: store.getNodeId('file', fid)! };
}

function importEdge(store: Store, from: FileNode, to: FileNode): void {
  store.insertEdge(
    from.fileNodeId,
    to.fileNodeId,
    'esm_imports',
    true,
    undefined,
    false,
    'ast_resolved',
  );
}

describe('getCouplingMetrics() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('per-file ca + ce + instability computed correctly', () => {
    // hub is imported by 3 spokes, imports 1 utility → ca=3, ce=1, I = 1/4 = 0.25
    const hub = insertFileNode(store, 'src/hub.ts');
    const util = insertFileNode(store, 'src/util.ts');
    const s1 = insertFileNode(store, 'src/spoke1.ts');
    const s2 = insertFileNode(store, 'src/spoke2.ts');
    const s3 = insertFileNode(store, 'src/spoke3.ts');
    importEdge(store, s1, hub);
    importEdge(store, s2, hub);
    importEdge(store, s3, hub);
    importEdge(store, hub, util);

    const results = getCouplingMetrics(store);
    const hubRow = results.find((r) => r.file === 'src/hub.ts');
    expect(hubRow).toBeDefined();
    expect(hubRow!.ca).toBe(3);
    expect(hubRow!.ce).toBe(1);
    expect(hubRow!.instability).toBe(0.25);
    expect(hubRow!.assessment).toBe('stable');
  });

  it('file with only inbound edges → instability ~0 (stable)', () => {
    const hub = insertFileNode(store, 'src/hub.ts');
    const s1 = insertFileNode(store, 'src/spoke1.ts');
    const s2 = insertFileNode(store, 'src/spoke2.ts');
    importEdge(store, s1, hub);
    importEdge(store, s2, hub);

    const results = getCouplingMetrics(store);
    const hubRow = results.find((r) => r.file === 'src/hub.ts');
    expect(hubRow).toBeDefined();
    expect(hubRow!.ca).toBe(2);
    expect(hubRow!.ce).toBe(0);
    expect(hubRow!.instability).toBe(0);
    expect(hubRow!.assessment).toBe('stable');
  });

  it('file with only outbound edges → instability ~1 (unstable)', () => {
    const consumer = insertFileNode(store, 'src/consumer.ts');
    const d1 = insertFileNode(store, 'src/dep1.ts');
    const d2 = insertFileNode(store, 'src/dep2.ts');
    importEdge(store, consumer, d1);
    importEdge(store, consumer, d2);

    const results = getCouplingMetrics(store);
    const consumerRow = results.find((r) => r.file === 'src/consumer.ts');
    expect(consumerRow).toBeDefined();
    expect(consumerRow!.ca).toBe(0);
    expect(consumerRow!.ce).toBe(2);
    expect(consumerRow!.instability).toBe(1);
    expect(consumerRow!.assessment).toBe('unstable');
  });

  it('assessment classifies stable/neutral/unstable per instability thresholds', () => {
    // unstable: ce only
    const u = insertFileNode(store, 'src/u.ts');
    const d1 = insertFileNode(store, 'src/d1.ts');
    importEdge(store, u, d1);

    // stable: ca only
    const sFile = insertFileNode(store, 'src/s.ts');
    const c1 = insertFileNode(store, 'src/c1.ts');
    importEdge(store, c1, sFile);

    // neutral: 1 in + 1 out → instability 0.5
    const n = insertFileNode(store, 'src/n.ts');
    const nIn = insertFileNode(store, 'src/nIn.ts');
    const nOut = insertFileNode(store, 'src/nOut.ts');
    importEdge(store, nIn, n);
    importEdge(store, n, nOut);

    const results = getCouplingMetrics(store);
    const byFile = new Map(results.map((r) => [r.file, r]));
    expect(byFile.get('src/u.ts')!.assessment).toBe('unstable');
    expect(byFile.get('src/s.ts')!.assessment).toBe('stable');
    const neutralRow = byFile.get('src/n.ts');
    expect(neutralRow).toBeDefined();
    expect(neutralRow!.instability).toBe(0.5);
    expect(neutralRow!.assessment).toBe('neutral');
    // 'isolated' is reserved for nodes with no edges — buildFileGraph skips
    // those entirely, so they don't appear in results at all.
  });

  it('results sorted by instability descending and shape is consistent', () => {
    const u = insertFileNode(store, 'src/u.ts');
    const d1 = insertFileNode(store, 'src/d1.ts');
    importEdge(store, u, d1);
    const sFile = insertFileNode(store, 'src/s.ts');
    const c1 = insertFileNode(store, 'src/c1.ts');
    importEdge(store, c1, sFile);

    const results = getCouplingMetrics(store);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].instability).toBeGreaterThanOrEqual(results[i].instability);
    }
    for (const r of results) {
      expect(typeof r.file).toBe('string');
      expect(typeof r.file_id).toBe('number');
      expect(typeof r.ca).toBe('number');
      expect(typeof r.ce).toBe('number');
      expect(typeof r.instability).toBe('number');
      expect(['stable', 'neutral', 'unstable', 'isolated']).toContain(r.assessment);
    }
  });

  it('empty graph returns an empty array', () => {
    const results = getCouplingMetrics(store);
    expect(results).toEqual([]);
  });
});
