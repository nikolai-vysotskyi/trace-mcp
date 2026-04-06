import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { getLayerViolations, detectLayerPreset, type LayerDefinition } from '../../src/tools/analysis/layer-violations.js';

function insertFile(store: Store, filePath: string): number {
  return store.insertFile(filePath, 'typescript', 'hash_' + filePath, 100);
}

function insertEdge(store: Store, srcNodeId: number, tgtNodeId: number, edgeType: string): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType, true);
}

const LAYERS: LayerDefinition[] = [
  { name: 'domain', path_prefixes: ['src/domain/'], may_not_import: ['infrastructure', 'presentation'] },
  { name: 'application', path_prefixes: ['src/application/'], may_not_import: ['infrastructure'] },
  { name: 'infrastructure', path_prefixes: ['src/infrastructure/'], may_not_import: [] },
  { name: 'presentation', path_prefixes: ['src/presentation/'], may_not_import: [] },
];

describe('getLayerViolations', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns no violations when layers respect rules', () => {
    const fPres = insertFile(store, 'src/presentation/api.ts');
    const fApp = insertFile(store, 'src/application/service.ts');
    const fDom = insertFile(store, 'src/domain/entity.ts');

    const nodePres = store.getNodeId('file', fPres)!;
    const nodeApp = store.getNodeId('file', fApp)!;
    const nodeDom = store.getNodeId('file', fDom)!;

    // presentation → application → domain (all allowed)
    insertEdge(store, nodePres, nodeApp, 'esm_imports');
    insertEdge(store, nodeApp, nodeDom, 'esm_imports');

    const result = getLayerViolations(store, LAYERS);
    expect(result.total_violations).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.layers_checked).toContain('domain');
  });

  it('detects domain importing infrastructure', () => {
    const fDom = insertFile(store, 'src/domain/entity.ts');
    const fInfra = insertFile(store, 'src/infrastructure/db.ts');

    const nodeDom = store.getNodeId('file', fDom)!;
    const nodeInfra = store.getNodeId('file', fInfra)!;

    insertEdge(store, nodeDom, nodeInfra, 'esm_imports');

    const result = getLayerViolations(store, LAYERS);
    expect(result.total_violations).toBe(1);
    expect(result.violations[0].source_layer).toBe('domain');
    expect(result.violations[0].target_layer).toBe('infrastructure');
    expect(result.violations[0].rule).toBe('domain may not import infrastructure');
  });

  it('detects multiple violations', () => {
    const fDom = insertFile(store, 'src/domain/entity.ts');
    const fInfra = insertFile(store, 'src/infrastructure/db.ts');
    const fPres = insertFile(store, 'src/presentation/view.ts');

    const nodeDom = store.getNodeId('file', fDom)!;
    const nodeInfra = store.getNodeId('file', fInfra)!;
    const nodePres = store.getNodeId('file', fPres)!;

    // domain → infrastructure (forbidden)
    insertEdge(store, nodeDom, nodeInfra, 'esm_imports');
    // domain → presentation (forbidden)
    insertEdge(store, nodeDom, nodePres, 'esm_imports');

    const result = getLayerViolations(store, LAYERS);
    expect(result.total_violations).toBe(2);
  });

  it('ignores files not belonging to any layer', () => {
    const fDom = insertFile(store, 'src/domain/entity.ts');
    const fUtils = insertFile(store, 'src/utils/helpers.ts');

    const nodeDom = store.getNodeId('file', fDom)!;
    const nodeUtils = store.getNodeId('file', fUtils)!;

    // domain → utils (utils has no layer, so no violation)
    insertEdge(store, nodeDom, nodeUtils, 'esm_imports');

    const result = getLayerViolations(store, LAYERS);
    expect(result.total_violations).toBe(0);
  });
});

describe('detectLayerPreset', () => {
  it('detects clean-architecture when matching paths exist', () => {
    const store = createTestStore();
    insertFile(store, 'src/domain/user.ts');
    insertFile(store, 'src/application/user-service.ts');
    insertFile(store, 'src/infrastructure/user-repo.ts');

    const detected = detectLayerPreset(store);
    expect(detected).not.toBeNull();
    expect(detected!.preset).toBe('clean-architecture');
  });

  it('returns null when no preset matches', () => {
    const store = createTestStore();
    insertFile(store, 'src/components/button.ts');
    insertFile(store, 'src/utils/format.ts');

    const detected = detectLayerPreset(store);
    expect(detected).toBeNull();
  });
});
