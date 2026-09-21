/**
 * TRA-1780 (Reviewer C on PR #1318): the fast symbol path wipes a file's
 * outgoing edges and must re-save persist-time `otherEdges`, which no
 * resolver re-emits. A comment-only edit keeps symbols structurally
 * identical (fast path) but must preserve Python `py_inherits` /
 * `py_uses_decorator` rows in scoped runs and in `indexAll(true)` alike.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

let tmpRoot: string;
let store: Store;
let pipeline: IndexingPipeline;

function makeConfig(): TraceMcpConfig {
  return {
    root: tmpRoot,
    include: ['**/*.py'],
    exclude: ['__pycache__/**'],
    plugins: [],
  };
}

function edgeCounts(): Record<string, number> {
  const rows = store.db
    .prepare(
      `SELECT et.name AS t, COUNT(*) AS c
       FROM edges e JOIN edge_types et ON et.id = e.edge_type_id
       WHERE et.name IN ('py_inherits', 'py_uses_decorator')
       GROUP BY et.name`,
    )
    .all() as Array<{ t: string; c: number }>;
  return Object.fromEntries(rows.map((r) => [r.t, r.c]));
}

describe('Fast path preserves persist-time otherEdges (TRA-1780)', () => {
  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fastpath-other-'));
    fs.mkdirSync(path.join(tmpRoot, 'mod'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'mod/__init__.py'),
      `"""Package marker so the module has a stable symbol table."""\nVALUE = 1\n`,
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'mod/models.py'),
      `"""Models module."""\n\n\ndef tracked(func):\n    return func\n\n\nclass Base:\n    pass\n\n\n@tracked\nclass Item(Base):\n    pass\n`,
    );
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    pipeline = new IndexingPipeline(store, registry, makeConfig(), tmpRoot);
    await pipeline.indexAll();
  });

  it('comment-only edit keeps py_inherits/py_uses_decorator (scoped == full)', async () => {
    const before = edgeCounts();
    expect(before.py_inherits).toBeGreaterThan(0);
    expect(before.py_uses_decorator).toBeGreaterThan(0);

    // Comment-only: symbols structurally identical → fast symbol path.
    fs.appendFileSync(path.join(tmpRoot, 'mod/models.py'), '# touch: no semantic change\n');
    const r = await pipeline.indexFiles(['mod/models.py']);
    expect(r.indexed).toBe(1);
    expect(edgeCounts()).toEqual(before);

    await pipeline.indexAll(true);
    expect(edgeCounts()).toEqual(before);
  });
});
