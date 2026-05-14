/**
 * Behavioural coverage for `predictBugs()` in
 * `src/tools/analysis/predictive-intelligence.ts`. The function is a
 * multi-signal weighted scorer (churn, fix ratio, complexity, coupling,
 * pagerank, authors) that returns predictions sorted by `score` desc, each
 * carrying a `risk` bucket and `confidence_level`. Output is wrapped in a
 * neverthrow Result; envelope includes `_methodology` disclosure.
 *
 * Git history is mocked away — these tests run without git so the churn /
 * fix_ratio / authors signals do not fire. The complexity + pagerank +
 * coupling signals still drive scoring, which is enough to pin the contract:
 *   - predictions sorted by score desc
 *   - each prediction has score/risk/confidence_level/factors fields
 *   - `min_score` filter excludes anything below the threshold
 *   - `file_pattern` filter narrows scope by substring match
 *   - `limit` caps the array
 *   - empty index → empty `predictions` array, no throw
 *   - envelope shape pinned (`predictions`, `total_files_analyzed`,
 *     `_methodology`, `cached`, `snapshot_id`)
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { predictBugs } from '../../../src/tools/analysis/predictive-intelligence.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

function insertFileWithComplexity(store: Store, path: string, cyclomatic: number): number {
  const fileId = store.insertFile(path, 'typescript', `hash_${path}`, 100);
  store.insertSymbol(fileId, {
    symbolId: `${path}::main#function`,
    name: 'main',
    kind: 'function',
    fqn: 'main',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 20,
    metadata: { cyclomatic, max_nesting: 2, param_count: 1 },
  });
  return fileId;
}

/** Build a small graph: hub.ts imported by 3 spokes (high pagerank), one isolated leaf. */
function seedFixture(store: Store): void {
  const hub = insertFileWithComplexity(store, 'src/hub.ts', 15);
  const s1 = insertFileWithComplexity(store, 'src/spoke1.ts', 8);
  const s2 = insertFileWithComplexity(store, 'src/spoke2.ts', 6);
  const s3 = insertFileWithComplexity(store, 'src/spoke3.ts', 4);
  insertFileWithComplexity(store, 'src/leaf.ts', 2);

  const hubNode = store.getNodeId('file', hub)!;
  for (const sid of [s1, s2, s3]) {
    const spokeNode = store.getNodeId('file', sid)!;
    store.insertEdge(spokeNode, hubNode, 'esm_imports', true, undefined, false, 'ast_resolved');
  }
}

describe('predictBugs() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    // Force "not a git repo" so churn/fix_ratio/authors signals zero out.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    store = createTestStore();
  });

  it('returns predictions sorted by score desc with risk + confidence_level fields', () => {
    seedFixture(store);
    const result = predictBugs(store, '/project', { refresh: true });
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();

    expect(Array.isArray(payload.predictions)).toBe(true);
    expect(payload.predictions.length).toBeGreaterThan(0);

    for (const p of payload.predictions) {
      expect(typeof p.file).toBe('string');
      expect(typeof p.score).toBe('number');
      expect(['low', 'medium', 'high', 'critical']).toContain(p.risk);
      expect(['low', 'medium', 'high', 'multi_signal']).toContain(p.confidence_level);
      expect(typeof p.signals_fired).toBe('number');
      expect(Array.isArray(p.factors)).toBe(true);
    }

    // Sorted descending by score.
    for (let i = 1; i < payload.predictions.length; i++) {
      expect(payload.predictions[i - 1].score).toBeGreaterThanOrEqual(payload.predictions[i].score);
    }
  });

  it('min_score filter excludes predictions below the threshold', () => {
    seedFixture(store);
    const high = predictBugs(store, '/project', { refresh: true, minScore: 0.9 })._unsafeUnwrap();
    for (const p of high.predictions) {
      expect(p.score).toBeGreaterThanOrEqual(0.9);
    }
    const low = predictBugs(store, '/project', { refresh: true, minScore: 0 })._unsafeUnwrap();
    // With minScore=0 we should see at least as many predictions as with a strict floor.
    expect(low.predictions.length).toBeGreaterThanOrEqual(high.predictions.length);
  });

  it('file_pattern narrows scope by substring match', () => {
    seedFixture(store);
    insertFileWithComplexity(store, 'lib/external.ts', 9);
    const result = predictBugs(store, '/project', {
      refresh: true,
      filePattern: 'src/',
    })._unsafeUnwrap();
    for (const p of result.predictions) {
      expect(p.file).toContain('src/');
    }
    // lib/external.ts must be filtered out
    expect(result.predictions.some((p) => p.file.startsWith('lib/'))).toBe(false);
  });

  it('limit caps the number of returned predictions', () => {
    seedFixture(store);
    const result = predictBugs(store, '/project', { refresh: true, limit: 2 })._unsafeUnwrap();
    expect(result.predictions.length).toBeLessThanOrEqual(2);
  });

  it('empty index returns empty predictions array without throwing', () => {
    const empty = createTestStore();
    const result = predictBugs(empty, '/project', { refresh: true });
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(payload.predictions).toEqual([]);
    expect(payload.total_files_analyzed).toBe(0);
  });

  it('envelope shape: predictions + total_files_analyzed + _methodology + cached + snapshot_id', () => {
    seedFixture(store);
    const result = predictBugs(store, '/project', { refresh: true })._unsafeUnwrap();
    expect(Array.isArray(result.predictions)).toBe(true);
    expect(typeof result.total_files_analyzed).toBe('number');
    expect(result.cached).toBe(false);
    // snapshot_id may be null if caching is unavailable; just assert presence.
    expect('snapshot_id' in result).toBe(true);
    expect(result._methodology).toBeDefined();
    expect(typeof result._methodology.algorithm).toBe('string');
    expect(Array.isArray(result._methodology.signals)).toBe(true);
  });
});
