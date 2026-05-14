/**
 * Behavioural coverage for the `check_architecture` MCP tool. The tool's
 * inline body in `registerAnalysisTools()` chooses one of three layer
 * sources (custom, preset, auto-detected) and delegates to
 * `getLayerViolations()`. Tests exercise:
 *   - clean-architecture preset: domain→infrastructure import surfaces a
 *     violation with the expected source/target/rule
 *   - custom layers config: forbidden edge between custom layers reported
 *   - clean layering (no forbidden edges): zero violations, layers_checked
 *     still populated
 *   - empty layers array: never throws, returns zero violations
 *   - detectLayerPreset auto-detects when 2+ preset layers are present
 *   - each violation row carries source_file, target_file, source_layer,
 *     target_layer, rule
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import {
  detectLayerPreset,
  getLayerViolations,
  LAYER_PRESETS,
  type LayerDefinition,
} from '../../../src/tools/analysis/layer-violations.js';
import { createTestStore } from '../../test-utils.js';

/**
 * Add a file-level import edge: src → tgt. `buildFileGraph` in
 * graph-analysis.ts builds the layer-checking graph directly from file→file
 * edges, so we wire them at the file-node level.
 */
function importFile(store: Store, srcPath: string, tgtPath: string): void {
  const srcRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(srcPath) as
    | { id: number }
    | undefined;
  const tgtRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(tgtPath) as
    | { id: number }
    | undefined;
  if (!srcRow || !tgtRow) throw new Error(`Missing file rows for ${srcPath} or ${tgtPath}`);
  const srcNid = store.getNodeId('file', srcRow.id)!;
  const tgtNid = store.getNodeId('file', tgtRow.id)!;
  store.insertEdge(srcNid, tgtNid, 'esm_imports', true, undefined, false, 'ast_resolved');
}

function addFile(store: Store, path: string): void {
  const fid = store.insertFile(path, 'typescript', `h-${path}`, 80);
  // Insert one symbol per file so the file is reachable by every analytics path.
  store.insertSymbol(fid, {
    symbolId: `${path}::stubFn#function`,
    name: 'stubFn',
    kind: 'function',
    fqn: 'stubFn',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });
}

describe('check_architecture — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('clean-architecture preset: domain importing infrastructure is flagged', () => {
    addFile(store, 'src/domain/user.ts');
    addFile(store, 'src/infrastructure/db.ts');
    importFile(store, 'src/domain/user.ts', 'src/infrastructure/db.ts');

    const result = getLayerViolations(store, LAYER_PRESETS['clean-architecture']);
    expect(result.total_violations).toBeGreaterThan(0);

    const v = result.violations.find(
      (x) => x.source_file === 'src/domain/user.ts' && x.target_file === 'src/infrastructure/db.ts',
    );
    expect(v).toBeDefined();
    expect(v!.source_layer).toBe('domain');
    expect(v!.target_layer).toBe('infrastructure');
    expect(v!.rule).toBe('domain may not import infrastructure');
  });

  it('every violation row has source_file, target_file, source_layer, target_layer, rule', () => {
    addFile(store, 'src/domain/order.ts');
    addFile(store, 'src/infrastructure/cache.ts');
    importFile(store, 'src/domain/order.ts', 'src/infrastructure/cache.ts');

    const result = getLayerViolations(store, LAYER_PRESETS['clean-architecture']);
    expect(result.violations.length).toBeGreaterThan(0);

    for (const v of result.violations) {
      expect(typeof v.source_file).toBe('string');
      expect(typeof v.target_file).toBe('string');
      expect(typeof v.source_layer).toBe('string');
      expect(typeof v.target_layer).toBe('string');
      expect(typeof v.rule).toBe('string');
      expect(v.rule.length).toBeGreaterThan(0);
    }
    // layers_checked echoes the input layer names.
    expect(result.layers_checked).toEqual(LAYER_PRESETS['clean-architecture'].map((l) => l.name));
  });

  it('custom layers config: domain may not import infrastructure rule is respected', () => {
    addFile(store, 'app/Domain/Money.ts');
    addFile(store, 'app/Infrastructure/Persistence.ts');
    importFile(store, 'app/Domain/Money.ts', 'app/Infrastructure/Persistence.ts');

    const custom: LayerDefinition[] = [
      {
        name: 'domain',
        path_prefixes: ['app/Domain/'],
        may_not_import: ['infrastructure'],
      },
      {
        name: 'infrastructure',
        path_prefixes: ['app/Infrastructure/'],
        may_not_import: [],
      },
    ];

    const result = getLayerViolations(store, custom);
    expect(result.total_violations).toBe(1);
    expect(result.violations[0].source_layer).toBe('domain');
    expect(result.violations[0].target_layer).toBe('infrastructure');
    expect(result.layers_checked).toEqual(['domain', 'infrastructure']);
  });

  it('clean layering (allowed import direction) returns zero violations', () => {
    addFile(store, 'src/infrastructure/db.ts');
    addFile(store, 'src/domain/user.ts');
    // infrastructure → domain: allowed in clean-architecture (domain has no may-not on infra,
    // but the layer that imports is "infrastructure" and its forbidden set does NOT include "domain").
    importFile(store, 'src/infrastructure/db.ts', 'src/domain/user.ts');

    const result = getLayerViolations(store, LAYER_PRESETS['clean-architecture']);
    expect(result.total_violations).toBe(0);
    expect(result.violations).toEqual([]);
    // layers_checked still populated even with zero violations.
    expect(result.layers_checked.length).toBeGreaterThan(0);
  });

  it('empty layers config gracefully returns zero violations (no throw)', () => {
    addFile(store, 'src/foo.ts');
    addFile(store, 'src/bar.ts');
    importFile(store, 'src/foo.ts', 'src/bar.ts');

    const result = getLayerViolations(store, []);
    expect(result.total_violations).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.layers_checked).toEqual([]);
  });

  it('detectLayerPreset auto-detects clean-architecture when 2+ layer dirs present', () => {
    // Need at least 2 preset layers' path prefixes to be present.
    addFile(store, 'src/domain/user.ts');
    addFile(store, 'src/infrastructure/db.ts');
    addFile(store, 'src/application/use-case.ts');

    const detected = detectLayerPreset(store);
    expect(detected).not.toBeNull();
    expect(detected!.preset).toBe('clean-architecture');
    expect(detected!.layers).toBe(LAYER_PRESETS['clean-architecture']);
  });

  it('detectLayerPreset returns null when no preset layers match', () => {
    addFile(store, 'src/random/thing.ts');
    addFile(store, 'lib/other/thing.ts');

    const detected = detectLayerPreset(store);
    expect(detected).toBeNull();
  });
});
