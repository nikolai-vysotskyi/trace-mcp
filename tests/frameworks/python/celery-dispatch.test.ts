/**
 * Regression: Celery task dispatch (`task.delay(...)` / `task.apply_async(...)`)
 * must create a call edge to the task FUNCTION, so the task appears in its
 * dispatchers' call graph and in get_change_impact for the task. Previously the
 * cross-file dispatch edge was emitted with an unresolvable file-path source and
 * a bare-name target (and no pass-2 resolver), so it was silently dropped and a
 * Celery task showed zero dependents.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../../test-utils.js';

describe('Celery .delay() / .apply_async() dispatch resolution', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-celery-');
    writeFixtureFile(
      tmpDir,
      'tasks.py',
      [
        'from celery import Celery',
        'celery_app = Celery("w")',
        '',
        '@celery_app.task',
        'def send_welcome_email(user_id: int) -> None:',
        '    pass',
        '',
        '@celery_app.task',
        'def rebuild_index() -> None:',
        '    pass',
      ].join('\n'),
    );
    writeFixtureFile(
      tmpDir,
      'service.py',
      [
        'from tasks import send_welcome_email, rebuild_index',
        '',
        'def register(user_id: int) -> None:',
        '    send_welcome_email.delay(user_id)',
        '    rebuild_index.apply_async()',
      ].join('\n'),
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    const config = {
      root: tmpDir,
      include: ['**/*.py'],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  afterAll(() => removeTmpDir(tmpDir));

  function callEdges(): string[] {
    return (
      store.db
        .prepare(`
      SELECT s1.name AS caller, s2.name AS callee
      FROM edges e
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      JOIN edge_types et ON e.edge_type_id = et.id
      WHERE et.name = 'calls'
    `)
        .all() as { caller: string; callee: string }[]
    ).map((e) => `${e.caller} → ${e.callee}`);
  }

  it('resolves task.delay() to the task function across files', () => {
    expect(callEdges()).toContain('register → send_welcome_email');
  });

  it('resolves task.apply_async() to the task function across files', () => {
    expect(callEdges()).toContain('register → rebuild_index');
  });
});
