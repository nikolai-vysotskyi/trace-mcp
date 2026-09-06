/**
 * Synthetic large-index fixture — generated, never vendored.
 *
 * Exists because a whole class of defect is invisible below a size threshold
 * our corpora never reached. `Math.min(...xs)` / `arr.push(...xs)` throw
 * `RangeError: Maximum call stack size exceeded` once the spread array passes
 * V8's argument limit (~65k–125k, stack-dependent). Reported from the field as
 * GitHub #957: every `search` against a 152 734-symbol index failed, while the
 * same query on a ~100-file repo worked.
 *
 * Before this file the largest corpus CI ran was 50 000 symbols
 * (`stress.test.ts`, 10 000 files x 5) — an order below the threshold, and it
 * only exercised `searchFts` and store methods, never a tool. So the size the
 * defect needs and the surface it lives on were both outside CI.
 *
 * `seedLargeIndex` is the same seeder `stress.test.ts` has always used, moved
 * here and extended with symbol-level edges: PageRank only ranks nodes that
 * appear in a resolved edge, so a file-only edge set caps `pagerankMap` at the
 * file count and cannot reproduce the failure.
 */
import { createTestStore } from '../test-utils.js';

const KINDS = [
  'class',
  'function',
  'method',
  'interface',
  'variable',
  'type',
  'constant',
  'property',
] as const;
const PREFIXES = [
  'User',
  'Auth',
  'Payment',
  'Order',
  'Product',
  'Cart',
  'Invoice',
  'Config',
  'Logger',
  'Metric',
];
const LANGS = ['typescript', 'python', 'go', 'rust', 'java', 'csharp', 'ruby', 'kotlin'];

export interface SeedOptions {
  workspaces?: string[];
  crossWsEdges?: number;
  /**
   * Also chain every symbol node into the edge table. PageRank ranks only
   * nodes reachable through a resolved edge, so this is what makes
   * `pagerankMap` scale with the symbol count rather than the file count.
   */
  symbolEdges?: boolean;
}

export function seedLargeIndex(fileCount: number, symbolsPerFile: number, opts?: SeedOptions) {
  const store = createTestStore();
  const db = store.db;

  const insertFile = db.prepare(
    `INSERT INTO files (path, language, content_hash, byte_length, indexed_at, workspace)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertNode = db.prepare(`INSERT OR IGNORE INTO nodes (node_type, ref_id) VALUES (?, ?)`);
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, is_cross_ws)
     VALUES (?, ?, ?, 1, ?)`,
  );

  const edgeType = db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as {
    id: number;
  };
  const workspaces = opts?.workspaces ?? [null as any];
  const fileIds: number[] = [];
  const symbolNodeIds: number[] = [];

  db.transaction(() => {
    for (let i = 0; i < fileCount; i++) {
      const ws = workspaces[i % workspaces.length];
      const lang = LANGS[i % LANGS.length]!;
      const filePath = ws
        ? `packages/${ws}/src/module${Math.floor(i / 10)}/file${i}.ts`
        : `src/modules/module${Math.floor(i / 10)}/file${i}.ts`;

      const result = insertFile.run(filePath, lang, `hash_${i}`, 500 + (i % 5000), ws ?? null);
      const fileId = Number(result.lastInsertRowid);
      insertNode.run('file', fileId);
      fileIds.push(fileId);

      for (let j = 0; j < symbolsPerFile; j++) {
        const prefix = PREFIXES[j % PREFIXES.length]!;
        const kind = KINDS[j % KINDS.length]!;
        const name = `${prefix}${kind.charAt(0).toUpperCase() + kind.slice(1)}${i}_${j}`;
        const symbolId = `${filePath}::${name}#${kind}`;
        const fqn = ws
          ? `${ws}.module${Math.floor(i / 10)}.${name}`
          : `module${Math.floor(i / 10)}.${name}`;
        const meta = j % 3 === 0 ? JSON.stringify({ exported: 1 }) : null;

        const symResult = insertSymbol.run(
          fileId,
          symbolId,
          name,
          kind,
          fqn,
          j * 100,
          (j + 1) * 100,
          j * 5 + 1,
          (j + 1) * 5,
          meta,
        );
        const nodeResult = insertNode.run('symbol', Number(symResult.lastInsertRowid));
        if (opts?.symbolEdges) symbolNodeIds.push(Number(nodeResult.lastInsertRowid));
      }
    }

    // Add import edges between consecutive files
    for (let i = 0; i < fileIds.length - 1; i++) {
      const srcNode = store.getNodeId('file', fileIds[i]!);
      const tgtNode = store.getNodeId('file', fileIds[i + 1]!);
      if (srcNode && tgtNode) {
        const isCrossWs =
          workspaces.length > 1 && i % workspaces.length === workspaces.length - 1 ? 1 : 0;
        insertEdge.run(srcNode, tgtNode, edgeType.id, isCrossWs);
      }
    }

    // Chain the symbol nodes so PageRank has to rank all of them.
    for (let i = 0; i < symbolNodeIds.length - 1; i++) {
      insertEdge.run(symbolNodeIds[i]!, symbolNodeIds[i + 1]!, edgeType.id, 0);
    }

    // Additional cross-workspace edges
    if (opts?.crossWsEdges) {
      const step = Math.max(1, Math.floor(fileIds.length / opts.crossWsEdges));
      for (let i = 0; i < opts.crossWsEdges && i * step + step < fileIds.length; i++) {
        const srcNode = store.getNodeId('file', fileIds[i * step]!);
        const tgtNode = store.getNodeId('file', fileIds[i * step + step]!);
        if (srcNode && tgtNode) {
          insertEdge.run(srcNode, tgtNode, edgeType.id, 1);
        }
      }
    }
  })();

  return { db, store };
}
