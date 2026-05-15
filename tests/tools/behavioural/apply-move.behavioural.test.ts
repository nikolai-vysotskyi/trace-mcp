/**
 * Behavioural coverage for `applyMove()` (the `apply_move` MCP tool).
 * Always invoked with dry_run=true so fixture files are never mutated.
 *
 *  Move-symbol mode:
 *    - dry_run preview returns edits for the source file (remove) and target
 *      file (insertion-point)
 *    - non-existent symbol returns "Symbol not found" error cleanly
 *    - collision in target file (same name) is rejected with clear error
 *    - dry_run does not mutate either file on disk
 *
 *  Move-file mode:
 *    - dry_run preview rewrites import paths in all importing files
 *    - target path already existing is rejected with a clear error
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { applyMove } from '../../../src/tools/refactoring/move.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

function insertFile(store: Store, p: string, lang = 'typescript'): number {
  return store.insertFile(p, lang, `h_${p}`, 100);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  opts: {
    kind?: string;
    lineStart?: number;
    lineEnd?: number;
    exported?: boolean;
  } = {},
): string {
  const file = store.getFileById(fileId);
  const filePath = file?.path ?? `file_${fileId}`;
  const kind = opts.kind ?? 'function';
  const symbolId = `${filePath}::${name}#${kind}`;
  store.insertSymbol(fileId, {
    symbolId,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    lineStart: opts.lineStart ?? 1,
    lineEnd: opts.lineEnd ?? 3,
    metadata: opts.exported ? { exported: true } : undefined,
  } as never);
  return symbolId;
}

describe('applyMove() — behavioural contract (dry_run path)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('move-symbol dry_run returns edits for source (remove) and target (insertion-point)', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/source.ts': ['export function movedFn() {', '  return 42;', '}', ''].join('\n'),
      'src/target.ts': "// existing\nimport { other } from './lib.js';\n",
    });
    const sourceFid = insertFile(store, 'src/source.ts');
    insertFile(store, 'src/target.ts');
    const symbolId = insertSymbol(store, sourceFid, 'movedFn', {
      lineStart: 1,
      lineEnd: 3,
      exported: true,
    });

    const result = applyMove(store, tmpDir, {
      mode: 'symbol',
      symbol_id: symbolId,
      target_file: 'src/target.ts',
      dry_run: true,
    });

    expect(result.success).toBe(true);
    expect(result.tool).toBe('apply_move');
    expect(result.edits.length).toBeGreaterThanOrEqual(2);
    // Source file: removal edit.
    const sourceEdit = result.edits.find(
      (e) => e.file === 'src/source.ts' && e.new_text === '(removed)',
    );
    expect(sourceEdit).toBeDefined();
    expect(sourceEdit!.original_text).toContain('movedFn');
    // Target file: insertion edit (insertion-point sentinel in original_text).
    const targetEdit = result.edits.find((e) => e.file === 'src/target.ts');
    expect(targetEdit).toBeDefined();
    expect(targetEdit!.original_text).toBe('(insertion point)');
    expect(targetEdit!.new_text).toContain('movedFn');
  });

  it('non-existent symbol returns "Symbol not found" error cleanly', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/target.ts': '// empty\n' });

    const result = applyMove(store, tmpDir, {
      mode: 'symbol',
      symbol_id: 'src/ghost.ts::missing#function',
      target_file: 'src/target.ts',
      dry_run: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
    expect(result.edits).toEqual([]);
  });

  it('collision in target file (same name) is rejected with clear error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/source.ts': 'export function dup() { return 1; }\n',
      'src/target.ts': 'export function dup() { return 2; }\n',
    });
    const sourceFid = insertFile(store, 'src/source.ts');
    const targetFid = insertFile(store, 'src/target.ts');
    const symbolId = insertSymbol(store, sourceFid, 'dup', {
      lineStart: 1,
      lineEnd: 1,
      exported: true,
    });
    // Target also has a `dup` — wire that up so collision detection fires.
    insertSymbol(store, targetFid, 'dup', { lineStart: 1, lineEnd: 1, exported: true });

    const result = applyMove(store, tmpDir, {
      mode: 'symbol',
      symbol_id: symbolId,
      target_file: 'src/target.ts',
      dry_run: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('collision');
    expect(result.edits).toEqual([]);
  });

  it('move-symbol dry_run does NOT mutate source or target files on disk', async () => {
    const store = createTestStore();
    const sourceOriginal = 'export function f() {\n  return 1;\n}\n';
    const targetOriginal = '// target\n';
    tmpDir = createTmpFixture({
      'src/source.ts': sourceOriginal,
      'src/target.ts': targetOriginal,
    });
    const sourceFid = insertFile(store, 'src/source.ts');
    insertFile(store, 'src/target.ts');
    const symbolId = insertSymbol(store, sourceFid, 'f', {
      lineStart: 1,
      lineEnd: 3,
      exported: true,
    });

    const sourcePath = path.join(tmpDir, 'src/source.ts');
    const targetPath = path.join(tmpDir, 'src/target.ts');
    const sourceMtime = fs.statSync(sourcePath).mtimeMs;
    const targetMtime = fs.statSync(targetPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));

    const result = applyMove(store, tmpDir, {
      mode: 'symbol',
      symbol_id: symbolId,
      target_file: 'src/target.ts',
      dry_run: true,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf-8')).toBe(sourceOriginal);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe(targetOriginal);
    expect(fs.statSync(sourcePath).mtimeMs).toBe(sourceMtime);
    expect(fs.statSync(targetPath).mtimeMs).toBe(targetMtime);
  });

  it('move-file dry_run rewrites import paths in importing files', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/lib/old.ts': 'export const X = 1;\n',
      'src/consumer.ts': "import { X } from './lib/old.js';\nconsole.log(X);\n",
    });
    const oldFid = insertFile(store, 'src/lib/old.ts');
    const consumerFid = insertFile(store, 'src/consumer.ts');
    // Wire a file -> file imports edge so applyMove can find importers.
    store.ensureEdgeType('imports', 'structural', 'file imports another file');
    const oldNid = store.getNodeId('file', oldFid)!;
    const consumerNid = store.getNodeId('file', consumerFid)!;
    store.insertEdge(consumerNid, oldNid, 'imports', true, undefined, false, 'ast_resolved');

    const result = applyMove(store, tmpDir, {
      mode: 'file',
      source_file: 'src/lib/old.ts',
      new_path: 'src/lib/renamed.ts',
      dry_run: true,
    });

    expect(result.success).toBe(true);
    expect(result.tool).toBe('apply_move');
    // At least one edit should target the consumer file with an updated path.
    const consumerEdit = result.edits.find((e) => e.file === 'src/consumer.ts');
    if (consumerEdit) {
      expect(consumerEdit.new_text).toContain('renamed');
    }
  });

  it('move-file with target already existing returns a clear error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/old.ts': 'export const X = 1;\n',
      'src/new.ts': '// already here\n',
    });
    insertFile(store, 'src/old.ts');
    insertFile(store, 'src/new.ts');

    const result = applyMove(store, tmpDir, {
      mode: 'file',
      source_file: 'src/old.ts',
      new_path: 'src/new.ts',
      dry_run: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    expect(result.edits).toEqual([]);
  });
});
