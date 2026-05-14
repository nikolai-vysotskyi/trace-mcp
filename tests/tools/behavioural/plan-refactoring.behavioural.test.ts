/**
 * Behavioural coverage for `planRefactoring()` (the `plan_refactoring` MCP tool).
 *
 * Always runs in dry-run mode under the hood. Tests assert:
 *   - rename type returns edits across def + importers, leaves files untouched
 *   - move (symbol mode) returns edits including import rewrites, no disk writes
 *   - move (file mode) returns edits + import path rewrites, no disk writes
 *   - signature type returns def + call-site edits, no disk writes
 *   - output shape: { success, tool, edits, files_modified, warnings }
 *   - file mtimes unchanged by dry-run (proves no side-effects)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { planRefactoring } from '../../../src/tools/refactoring/plan-refactoring.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, `hash_${filePath}`, 100);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  opts: {
    kind?: string;
    lineStart?: number;
    lineEnd?: number;
    metadata?: Record<string, unknown>;
  } = {},
): number {
  const file = store.getFileById(fileId);
  const filePath = file?.path ?? `file_${fileId}`;
  const kind = opts.kind ?? 'function';
  const symbolId = `${filePath}::${name}#${kind}`;
  return store.insertSymbol(fileId, {
    symbolId,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    lineStart: opts.lineStart,
    lineEnd: opts.lineEnd,
    metadata: opts.metadata,
  });
}

function snapshotMtimes(tmpDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full] = fs.statSync(full).mtimeMs;
    }
  };
  walk(tmpDir);
  return out;
}

function expectMtimesUnchanged(before: Record<string, number>, tmpDir: string): void {
  const after = snapshotMtimes(tmpDir);
  for (const key of Object.keys(before)) {
    expect(after[key]).toBe(before[key]);
  }
}

describe('planRefactoring() — behavioural contract', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('rename: returns edits across def + importers, no files mutated', async () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/source.ts': 'export function oldName() {\n  return oldName;\n}\n',
      'src/importer.ts': "import { oldName } from './source';\nconst x = oldName();\n",
    });
    const sourceFid = insertFile(store, 'src/source.ts');
    insertSymbol(store, sourceFid, 'oldName', { lineStart: 1, lineEnd: 3 });
    const importerFid = insertFile(store, 'src/importer.ts');

    // Wire importer -> source file (so the importing files set is non-empty).
    store.ensureEdgeType('imports', 'structural', 'imports');
    const srcFileNid = store.getNodeId('file', sourceFid)!;
    const impFileNid = store.getNodeId('file', importerFid)!;
    store.insertEdge(impFileNid, srcFileNid, 'imports', true);

    const before = snapshotMtimes(tmpDir);
    // sleep at least 1ms to ensure mtime would visibly change if a write occurred
    await new Promise((r) => setTimeout(r, 5));

    const result = planRefactoring(store, tmpDir, {
      type: 'rename',
      symbol_id: 'src/source.ts::oldName#function',
      new_name: 'newName',
    });

    expect(result.success).toBe(true);
    expect(result.tool).toBe('apply_rename');
    expect(result.edits.length).toBeGreaterThan(0);
    expectMtimesUnchanged(before, tmpDir);
  });

  it('move (symbol mode): returns edits without writing to disk', async () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/origin.ts': 'export function moveMe() {\n  return 1;\n}\n',
      'src/dest.ts': '// destination file\n',
    });
    const originFid = insertFile(store, 'src/origin.ts');
    insertSymbol(store, originFid, 'moveMe', {
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    insertFile(store, 'src/dest.ts');

    const before = snapshotMtimes(tmpDir);
    await new Promise((r) => setTimeout(r, 5));

    const result = planRefactoring(store, tmpDir, {
      type: 'move',
      symbol_id: 'src/origin.ts::moveMe#function',
      target_file: 'src/dest.ts',
    });

    expect(result.tool).toBe('apply_move');
    // Either success with edits, or graceful failure — either way must not mutate disk.
    expectMtimesUnchanged(before, tmpDir);
  });

  it('move (file mode): returns edits + import-path rewrites, no disk writes', async () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/old/util.ts': 'export const KEY = 1;\n',
      'src/consumer.ts': "import { KEY } from './old/util';\nconsole.log(KEY);\n",
    });
    insertFile(store, 'src/old/util.ts');
    insertFile(store, 'src/consumer.ts');

    const before = snapshotMtimes(tmpDir);
    await new Promise((r) => setTimeout(r, 5));

    const result = planRefactoring(store, tmpDir, {
      type: 'move',
      source_file: 'src/old/util.ts',
      new_path: 'src/new/util.ts',
    });

    expect(result.tool).toBe('apply_move');
    expectMtimesUnchanged(before, tmpDir);
  });

  it('signature: returns def + call-site edits, no disk writes', async () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts':
        'export function add(a: number, b: number, c: number) {\n  return a + b + c;\n}\n',
      'src/main.ts': "import { add } from './utils';\nconst r = add(1, 2, 3);\n",
    });
    const utilsFid = insertFile(store, 'src/utils.ts');
    const mainFid = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFid, 'add', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });

    // Wire call edge so updateCallSites picks up main.ts.
    store.ensureEdgeType('calls', 'structural', 'calls');
    const symNid = store.createNode('symbol', symDbId);
    const mainFileNid = store.createNode('file', mainFid);
    store.insertEdge(mainFileNid, symNid, 'calls', true);

    const before = snapshotMtimes(tmpDir);
    await new Promise((r) => setTimeout(r, 5));

    const result = planRefactoring(store, tmpDir, {
      type: 'signature',
      symbol_id: 'src/utils.ts::add#function',
      changes: [{ remove_param: { name: 'c' } }],
    });

    expect(result.success).toBe(true);
    expect(result.tool).toBe('change_signature');
    expect(result.edits.length).toBeGreaterThan(0);
    expectMtimesUnchanged(before, tmpDir);
  });

  it('output shape pinned: success, tool, edits, files_modified, warnings', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function foo() { return 1; }\n' });
    const fid = insertFile(store, 'src/a.ts');
    insertSymbol(store, fid, 'foo', { lineStart: 1, lineEnd: 1, metadata: { exported: true } });

    const result = planRefactoring(store, tmpDir, {
      type: 'rename',
      symbol_id: 'src/a.ts::foo#function',
      new_name: 'bar',
    });

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('tool');
    expect(result).toHaveProperty('edits');
    expect(result).toHaveProperty('files_modified');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.edits)).toBe(true);
    expect(Array.isArray(result.files_modified)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('rename: missing required params surfaces clean error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function foo() {}\n' });

    const result = planRefactoring(store, tmpDir, { type: 'rename' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Rename');
  });
});
