import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { buildGraphData } from '../../src/tools/analysis/visualize.js';
import { TopologyStore } from '../../src/topology/topology-db.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('service topology is not file/symbol dependency evidence (TRA-1748)', () => {
  let folder: string;
  let main: Store;
  let topology: TopologyStore;
  let mainService: number;
  let childService: number;
  let unknownService: number;

  function addSymbol(store: Store, file: string): number {
    const fileId = store.insertFile(file, 'typescript', file, 100);
    const symbolId = store.insertSymbol(fileId, {
      symbolId: `${file}::run#function`,
      name: 'run',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 5,
    });
    return store.getNodeId('symbol', symbolId)!;
  }

  beforeEach(() => {
    folder = createTmpDir('viz-topology-');
    main = new Store(initializeDatabase(':memory:'));
    const entry = addSymbol(main, 'entry.ts');
    const util = addSymbol(main, 'util.ts');
    const childEntry = addSymbol(main, 'child/entry.ts');
    main.insertEdge(entry, util, 'calls');
    // A real indexed dependency across repository boundaries must survive.
    main.insertEdge(entry, childEntry, 'calls');

    const childPath = path.join(folder, 'child.db');
    const childDb = initializeDatabase(childPath);
    try {
      const child = new Store(childDb);
      child.insertEdge(addSymbol(child, 'entry.ts'), addSymbol(child, 'util.ts'), 'calls');
    } finally {
      childDb.close();
    }

    topology = new TopologyStore(path.join(folder, 'topology.db'));
    topology.upsertSubproject({
      name: 'child',
      repoRoot: path.join(folder, 'child'),
      projectRoot: folder,
      dbPath: childPath,
    });
    mainService = topology.upsertService({
      name: path.basename(folder),
      repoRoot: folder,
      dbPath: '',
    });
    childService = topology.upsertService({
      name: 'child',
      repoRoot: path.join(folder, 'child'),
      dbPath: childPath,
    });
    unknownService = topology.upsertService({
      name: 'unrelated',
      repoRoot: path.join(folder, 'unrelated'),
      dbPath: '',
    });
  });

  afterEach(() => {
    main.db.close();
    topology.close();
    removeTmpDir(folder);
  });

  for (const granularity of ['file', 'symbol'] as const) {
    for (const hideIsolated of [false, true]) {
      it.each([
        { includeEdges: undefined },
        { includeEdges: ['imports'] },
        { includeEdges: ['calls'] },
      ])(
        `preserves only indexed ${granularity} relationships (hideIsolated=${hideIsolated}, filter=$includeEdges)`,
        ({ includeEdges }) => {
          const options = {
            scope: 'project',
            projectRoot: folder,
            topoStore: topology,
            granularity,
            hideIsolated,
            includeEdges,
          };
          const baseline = buildGraphData(main, options);
          const excludesCalls = includeEdges?.includes('imports');
          expect(baseline.edges).toHaveLength(excludesCalls ? 0 : 3);
          if (!excludesCalls) {
            expect(baseline.nodes).toHaveLength(4);
            const suffix = granularity === 'symbol' ? '::run#function' : '';
            expect(baseline.edges).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  source: `entry.ts${suffix}`,
                  target: `child/entry.ts${suffix}`,
                  type: 'calls',
                }),
              ]),
            );
          }

          for (const [sourceServiceId, targetServiceId] of [
            [mainService, childService],
            [childService, mainService],
            [unknownService, childService],
          ]) {
            topology.insertCrossServiceEdge({
              sourceServiceId,
              targetServiceId,
              edgeType: 'http_calls',
              sourceRef: '/api/items',
              targetRef: '/api/items',
            });
          }

          // Service edges must not fabricate dependencies, bypass filters,
          // alter communities/degrees, or map an unknown service to the main repo.
          expect(buildGraphData(main, options)).toEqual(baseline);
          expect(topology.getAllCrossServiceEdges()).toHaveLength(3);
        },
      );
    }
  }
});
