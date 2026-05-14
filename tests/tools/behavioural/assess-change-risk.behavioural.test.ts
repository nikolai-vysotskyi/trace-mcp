/**
 * Behavioural coverage for `assessChangeRisk()` in
 * `src/tools/analysis/predictive-intelligence.ts`. Single-target risk score
 * combining 5 signals: blast_radius, complexity, churn, test_gap, coupling.
 * Returns a neverthrow Result; envelope: { target, risk_score, risk_level,
 * confidence, factors, mitigations, blast_radius }.
 *
 * Git is mocked away so churn signal does not fire — leaves 4 of 5 signals
 * driving the score (blast / complexity / test_gap / coupling), which is
 * enough to pin the contract.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { assessChangeRisk } from '../../../src/tools/analysis/predictive-intelligence.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

function insertFileSymbol(
  store: Store,
  path: string,
  symbolName: string,
  cyclomatic: number,
): { fileId: number; symbolId: string; symbolDbId: number } {
  const fileId = store.insertFile(path, 'typescript', `hash_${path}`, 100);
  const symbolId = `${path}::${symbolName}#class`;
  const dbId = store.insertSymbol(fileId, {
    symbolId,
    name: symbolName,
    kind: 'class',
    fqn: symbolName,
    byteStart: 0,
    byteEnd: 200,
    lineStart: 1,
    lineEnd: 50,
    metadata: { cyclomatic, max_nesting: 2, param_count: 1 },
  });
  return { fileId, symbolId, symbolDbId: dbId };
}

describe('assessChangeRisk() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    store = createTestStore();
  });

  it('high-complexity symbol with many incoming deps scores higher than an isolated low-complexity one', () => {
    // Target = high-complexity class imported by many files.
    const target = insertFileSymbol(store, 'src/hub.ts', 'HubService', 18);
    // 5 importers depend on HubService at the symbol level.
    for (let i = 0; i < 5; i++) {
      const dep = insertFileSymbol(store, `src/dep${i}.ts`, `Dep${i}`, 3);
      const sourceNode = store.getNodeId('symbol', dep.symbolDbId)!;
      const targetNode = store.getNodeId('symbol', target.symbolDbId)!;
      store.insertEdge(sourceNode, targetNode, 'calls', true, undefined, false, 'ast_resolved');
    }
    // An isolated, simple file.
    const isolated = insertFileSymbol(store, 'src/leaf.ts', 'Leaf', 2);

    const hub = assessChangeRisk(store, '/project', { symbolId: target.symbolId })._unsafeUnwrap();
    const leaf = assessChangeRisk(store, '/project', {
      symbolId: isolated.symbolId,
    })._unsafeUnwrap();

    expect(hub.risk_score).toBeGreaterThan(leaf.risk_score);
    expect(['medium', 'high', 'critical']).toContain(hub.risk_level);
    expect(['low', 'medium']).toContain(leaf.risk_level);
  });

  it('returns factors array naming all five signals', () => {
    const target = insertFileSymbol(store, 'src/x.ts', 'X', 4);
    const result = assessChangeRisk(store, '/project', {
      symbolId: target.symbolId,
    })._unsafeUnwrap();

    expect(Array.isArray(result.factors)).toBe(true);
    const signals = result.factors.map((f) => f.signal).sort();
    expect(signals).toEqual(['blast_radius', 'churn', 'complexity', 'coupling', 'test_gap']);
    for (const f of result.factors) {
      expect(typeof f.value).toBe('number');
      expect(typeof f.weight).toBe('number');
      expect(typeof f.contribution).toBe('number');
      expect(typeof f.detail).toBe('string');
    }
  });

  it('returns mitigations array of strings when risk-driving signals fire', () => {
    // No test coverage + no git → test_gap signal fires and produces a mitigation.
    const target = insertFileSymbol(store, 'src/dangerous.ts', 'Dangerous', 4);
    const result = assessChangeRisk(store, '/project', {
      symbolId: target.symbolId,
    })._unsafeUnwrap();

    expect(Array.isArray(result.mitigations)).toBe(true);
    for (const m of result.mitigations) {
      expect(typeof m).toBe('string');
    }
    // test_gap (no test coverage edges in the fixture) is guaranteed to fire.
    expect(result.mitigations.some((m) => /test/i.test(m))).toBe(true);
  });

  it('output envelope: target / risk_score / risk_level / confidence / blast_radius', () => {
    const target = insertFileSymbol(store, 'src/svc.ts', 'Service', 6);
    const result = assessChangeRisk(store, '/project', {
      symbolId: target.symbolId,
    })._unsafeUnwrap();

    expect(result.target).toEqual({ file: 'src/svc.ts', symbol_id: target.symbolId });
    expect(typeof result.risk_score).toBe('number');
    expect(['low', 'medium', 'high', 'critical']).toContain(result.risk_level);
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.blast_radius.files).toBe('number');
    expect(typeof result.blast_radius.symbols).toBe('number');
  });

  it('errors when neither file_path nor symbol_id is supplied', () => {
    const result = assessChangeRisk(store, '/project', {});
    expect(result.isErr()).toBe(true);
  });

  it('errors when supplied symbol_id does not exist', () => {
    const result = assessChangeRisk(store, '/project', { symbolId: 'nope::Nope#class' });
    expect(result.isErr()).toBe(true);
  });
});
