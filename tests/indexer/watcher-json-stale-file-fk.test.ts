/**
 * TRA-2551: Watcher reindex of JSON files (and any language files) must not fail
 * with `SqliteError: FOREIGN KEY constraint failed` when file rows or parent symbols
 * vanish mid-pass.
 *
 * During async extraction across files, watcher delete events (`pipeline.deleteFiles`)
 * or dropped-event rescans can delete rows from `files` or `symbols`. If `FilePersister`
 * or `SymbolRepository` blindly trusted pre-extraction `existingId` or `parent_id`,
 * SQLite aborted the transaction on `file_id REFERENCES files(id)` or `parent_id REFERENCES symbols(id)`
 * constraint failures, aborting the entire batch (e.g. 57 files failing with L50 telemetry).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { JsonLanguagePlugin } from '../../src/indexer/plugins/language/json-lang/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';
import { FilePersister } from '../../src/indexer/file-persister.js';
import type { PipelineState, FileExtraction } from '../../src/indexer/pipeline-state.js';

describe('watcher-json-stale-file-fk (TRA-2551)', () => {
  let rootDir: string;
  let pipeline: IndexingPipeline;
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2551-'));
    fs.mkdirSync(path.join(rootDir, '.claude-plugin'), { recursive: true });

    fs.writeFileSync(
      path.join(rootDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(
        {
          name: 'marketplace',
          version: '1.0.0',
          plugins: ['alpha', 'beta'],
          config: { enabled: true },
        },
        null,
        2,
      ),
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new JsonLanguagePlugin());
    const config: TraceMcpConfig = {
      root: rootDir,
      include: ['**/*.json', '.claude-plugin/**/*.json'],
      exclude: [],
      plugins: [],
    };
    pipeline = new IndexingPipeline(store, registry, config, rootDir);
  });

  afterEach(async () => {
    await pipeline.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function fakeState(): PipelineState {
    const internals = pipeline as unknown as {
      store: PipelineState['store'];
      registry: PipelineState['registry'];
      config: PipelineState['config'];
    };
    return {
      store: internals.store,
      registry: internals.registry,
      config: internals.config,
      rootPath: rootDir,
      workspaces: [],
      isIncremental: true,
      changedFileIds: new Set(),
      pendingImports: new Map(),
      fileContentCache: new Map(),
      gitignore: undefined,
    };
  }

  it('file row deleted mid-pass while still on disk is re-created without FK failure', async () => {
    await pipeline.indexAll();
    const relPath = '.claude-plugin/marketplace.json';
    const originalFile = store.getFile(relPath);
    expect(originalFile).toBeDefined();
    const oldFileId = originalFile!.id;

    const oldSymbols = store.getSymbolsByFile(oldFileId);
    expect(oldSymbols.length).toBeGreaterThan(0);

    // Mock extraction result captured BEFORE deletion
    const extraction: FileExtraction = {
      relPath,
      existingId: oldFileId,
      hash: 'new-hash-1234',
      contentSize: 120,
      language: 'json',
      workspace: null,
      gitignored: false,
      status: 'ok',
      frameworkRole: null,
      mtimeMs: Date.now(),
      symbols: [
        {
          name: 'name',
          kind: 'constant',
          byteStart: 2,
          byteEnd: 24,
        },
        {
          name: 'plugins',
          kind: 'constant',
          byteStart: 40,
          byteEnd: 70,
        },
      ],
      otherEdges: [],
      importEdges: [],
      routes: [],
      components: [],
      migrations: [],
      ormModels: [],
      ormAssociations: [],
      rnScreens: [],
      frameworkExtracts: [],
    };

    // Simulate watcher delete event deleting the file row mid-pass
    store.deleteFile(oldFileId);
    expect(store.getFileById(oldFileId)).toBeUndefined();
    expect(store.getFile(relPath)).toBeUndefined();

    // Persist extraction
    const persister = new FilePersister(fakeState(), () => {});
    const { persistedCount, persistedPaths } = await persister.persistBatch([extraction]);

    expect(persistedCount).toBe(1);
    expect(persistedPaths).toEqual([relPath]);

    // Verify file and symbols are recreated with valid FK
    const newFile = store.getFile(relPath);
    expect(newFile).toBeDefined();
    expect(newFile!.content_hash).toBe('new-hash-1234');

    const newSymbols = store.getSymbolsByFile(newFile!.id);
    expect(newSymbols.length).toBe(2);
    expect(newSymbols.map((s) => s.name).sort()).toEqual(['name', 'plugins']);
  });

  it('file deleted from disk and DB mid-pass is safely skipped without ghost row or FK failure', async () => {
    await pipeline.indexAll();
    const relPath = '.claude-plugin/marketplace.json';
    const originalFile = store.getFile(relPath);
    const oldFileId = originalFile!.id;

    const extraction: FileExtraction = {
      relPath,
      existingId: oldFileId,
      hash: 'new-hash-1234',
      contentSize: 120,
      language: 'json',
      workspace: null,
      gitignored: false,
      status: 'ok',
      frameworkRole: null,
      mtimeMs: Date.now(),
      symbols: [
        {
          name: 'name',
          kind: 'constant',
          byteStart: 2,
          byteEnd: 24,
        },
      ],
      otherEdges: [],
      importEdges: [],
      routes: [],
      components: [],
      migrations: [],
      ormModels: [],
      ormAssociations: [],
      rnScreens: [],
      frameworkExtracts: [],
    };

    // Delete both from DB and from disk
    store.deleteFile(oldFileId);
    fs.rmSync(path.join(rootDir, relPath), { force: true });

    const persister = new FilePersister(fakeState(), () => {});
    const { persistedCount, persistedPaths } = await persister.persistBatch([extraction]);

    expect(persistedCount).toBe(0);
    expect(persistedPaths).toEqual([]);
    expect(store.getFile(relPath)).toBeUndefined();
  });

  it('parent symbol deleted mid-pass falls back to null parentId without FK violation', () => {
    const fileId = store.insertFile('test.json', 'json', 'hash1', 100);
    const deadParentId = 999999;

    expect(() => {
      store.insertSymbols(fileId, [
        {
          symbolId: 'test.json::child#constant',
          name: 'child',
          kind: 'constant',
          parentSymbolId: 'dead-parent-symbol',
          byteStart: 0,
          byteEnd: 10,
        },
      ]);
    }).not.toThrow();

    const syms = store.getSymbolsByFile(fileId);
    expect(syms.length).toBe(1);
    expect(syms[0].parent_id).toBeNull();
  });

  it('incremental pipeline reindex succeeds after file churn', async () => {
    await pipeline.indexAll();
    const relPath = '.claude-plugin/marketplace.json';

    // Update content on disk
    fs.writeFileSync(
      path.join(rootDir, relPath),
      JSON.stringify({ updated: true, items: [1, 2, 3] }, null, 2),
    );

    const result = await pipeline.indexFiles([relPath]);
    expect(result.errors).toBe(0);
    expect(result.indexed).toBe(1);

    const f = store.getFile(relPath);
    expect(f).toBeDefined();
    const syms = store.getSymbolsByFile(f!.id);
    expect(syms.map((s) => s.name).sort()).toEqual(['items', 'updated']);
  });
});
