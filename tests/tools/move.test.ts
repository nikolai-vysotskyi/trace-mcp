import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';
import { applyMove } from '../../src/tools/refactoring/move.js';

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, 'hash_' + filePath, 100);
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
    symbolIdOverride?: string;
  } = {},
): number {
  const file = store.getFileById(fileId);
  const filePath = file?.path ?? `file_${fileId}`;
  const kind = opts.kind ?? 'function';
  const symbolId = opts.symbolIdOverride ?? `${filePath}::${name}#${kind}`;
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

function insertEdge(
  store: Store,
  srcNodeId: number,
  tgtNodeId: number,
  edgeType: string,
): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType, true);
}

function readFile(projectRoot: string, relPath: string): string {
  return fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
}

// ════════════════════════════════════════════════════════════════════════
// MOVE SYMBOL
// ════════════════════════════════════════════════════════════════════════

describe('applyMove — symbol mode', () => {
  let store: Store;
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns error for unknown symbol', () => {
    store = createTestStore();
    const result = applyMove(store, '/tmp', { mode: 'symbol', symbol_id: 'nope#function', target_file: 'b.ts', dry_run: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
  });

  it('returns error when symbol has no line range', () => {
    store = createTestStore();
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'foo', { lineStart: undefined, lineEnd: undefined });
    const result = applyMove(store, '/tmp', { mode: 'symbol', symbol_id: 'src/a.ts::foo#function', target_file: 'b.ts', dry_run: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no line range');
  });

  it('detects collision in target file', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function foo() { return 1; }\n',
      'src/b.ts': 'export function foo() { return 2; }\n',
    });
    const fileA = insertFile(store, 'src/a.ts');
    const fileB = insertFile(store, 'src/b.ts');
    insertSymbol(store, fileA, 'foo', { lineStart: 1, lineEnd: 1, metadata: { exported: true } });
    insertSymbol(store, fileB, 'foo', { lineStart: 1, lineEnd: 1, metadata: { exported: true } });

    const result = applyMove(store, tmpDir, { mode: 'symbol', symbol_id: 'src/a.ts::foo#function', target_file: 'src/b.ts', dry_run: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Name collision');
  });

  it('moves a symbol to a new file (dry run)', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 2;\n}\n',
    });
    const fileA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileA, 'foo', { lineStart: 1, lineEnd: 3, metadata: { exported: true } });
    insertSymbol(store, fileA, 'bar', { lineStart: 5, lineEnd: 7, metadata: { exported: true } });

    const result = applyMove(store, tmpDir, { mode: 'symbol', symbol_id: 'src/a.ts::foo#function', target_file: 'src/b.ts', dry_run: true });
    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);
    // Dry run: source file should be unchanged
    expect(readFile(tmpDir, 'src/a.ts')).toContain('export function foo()');
    // Target file should NOT exist
    expect(fs.existsSync(path.join(tmpDir, 'src/b.ts'))).toBe(false);
  });

  it('moves a symbol to a new file (apply)', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function foo() {\n  return 1;\n}\n\nexport function bar() {\n  return 2;\n}\n',
    });
    const fileA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileA, 'foo', { lineStart: 1, lineEnd: 3, metadata: { exported: true } });
    insertSymbol(store, fileA, 'bar', { lineStart: 5, lineEnd: 7, metadata: { exported: true } });

    const result = applyMove(store, tmpDir, { mode: 'symbol', symbol_id: 'src/a.ts::foo#function', target_file: 'src/b.ts', dry_run: false });
    expect(result.success).toBe(true);

    // Source file should no longer contain foo
    const sourceContent = readFile(tmpDir, 'src/a.ts');
    expect(sourceContent).not.toContain('export function foo()');
    expect(sourceContent).toContain('export function bar()');

    // Target file should contain foo
    const targetContent = readFile(tmpDir, 'src/b.ts');
    expect(targetContent).toContain('export function foo()');
  });

  it('moves a symbol to an existing file', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function foo() {\n  return 1;\n}\n',
      'src/b.ts': 'export function bar() {\n  return 2;\n}\n',
    });
    const fileA = insertFile(store, 'src/a.ts');
    const fileB = insertFile(store, 'src/b.ts');
    insertSymbol(store, fileA, 'foo', { lineStart: 1, lineEnd: 3, metadata: { exported: true } });
    insertSymbol(store, fileB, 'bar', { lineStart: 1, lineEnd: 3, metadata: { exported: true } });

    const result = applyMove(store, tmpDir, { mode: 'symbol', symbol_id: 'src/a.ts::foo#function', target_file: 'src/b.ts', dry_run: false });
    expect(result.success).toBe(true);

    const targetContent = readFile(tmpDir, 'src/b.ts');
    expect(targetContent).toContain('export function bar()');
    expect(targetContent).toContain('export function foo()');
  });

  it('updates imports in dependent files when moving a symbol', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function helper() { return 1; }\n',
      'src/target.ts': '// target file\n',
      'src/consumer.ts': "import { helper } from './utils';\nconsole.log(helper());\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const consumerFileId = insertFile(store, 'src/consumer.ts');
    insertFile(store, 'src/target.ts');

    const symId = insertSymbol(store, utilsFileId, 'helper', { lineStart: 1, lineEnd: 1, metadata: { exported: true } });

    // Create graph edges: consumer → utils (file-level import)
    const utilsNodeId = store.createNode('file', utilsFileId);
    const consumerNodeId = store.createNode('file', consumerFileId);
    store.ensureEdgeType('imports', 'structural', 'File imports');
    insertEdge(store, consumerNodeId, utilsNodeId, 'imports');

    const result = applyMove(store, tmpDir, { mode: 'symbol', symbol_id: 'src/utils.ts::helper#function', target_file: 'src/target.ts', dry_run: false });
    expect(result.success).toBe(true);

    // Consumer should now import from target
    const consumerContent = readFile(tmpDir, 'src/consumer.ts');
    expect(consumerContent).toContain('./target');
    expect(consumerContent).not.toContain('./utils');
  });

  it('includes JSDoc/decorators when moving symbol', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': '/** Does stuff */\nexport function foo() {\n  return 1;\n}\n',
    });
    const fileA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileA, 'foo', { lineStart: 2, lineEnd: 4, metadata: { exported: true } });

    const result = applyMove(store, tmpDir, { mode: 'symbol', symbol_id: 'src/a.ts::foo#function', target_file: 'src/b.ts', dry_run: false });
    expect(result.success).toBe(true);

    const targetContent = readFile(tmpDir, 'src/b.ts');
    expect(targetContent).toContain('/** Does stuff */');
    expect(targetContent).toContain('export function foo()');
  });
});

// ════════════════════════════════════════════════════════════════════════
// MOVE FILE
// ════════════════════════════════════════════════════════════════════════

describe('applyMove — file mode', () => {
  let store: Store;
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns error when source file not found', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({});
    const result = applyMove(store, tmpDir, { mode: 'file', source_file: 'nope.ts', new_path: 'moved.ts', dry_run: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Source file not found');
  });

  it('returns error when target already exists', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export const x = 1;\n',
      'src/b.ts': 'export const y = 2;\n',
    });
    insertFile(store, 'src/a.ts');
    const result = applyMove(store, tmpDir, { mode: 'file', source_file: 'src/a.ts', new_path: 'src/b.ts', dry_run: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Target path already exists');
  });

  it('moves a file and updates import paths in importers', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils/helper.ts': 'export function help() { return 1; }\n',
      'src/main.ts': "import { help } from './utils/helper';\nconsole.log(help());\n",
    });
    const helperFileId = insertFile(store, 'src/utils/helper.ts');
    const mainFileId = insertFile(store, 'src/main.ts');

    // Create edge: main → helper
    const helperNodeId = store.createNode('file', helperFileId);
    const mainNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('imports', 'structural', 'File imports');
    insertEdge(store, mainNodeId, helperNodeId, 'imports');

    const result = applyMove(store, tmpDir, {
      mode: 'file',
      source_file: 'src/utils/helper.ts',
      new_path: 'src/lib/helper.ts',
      dry_run: false,
    });
    expect(result.success).toBe(true);

    // Old file should be gone, new file should exist
    expect(fs.existsSync(path.join(tmpDir, 'src/utils/helper.ts'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'src/lib/helper.ts'))).toBe(true);

    // Main should now import from new location
    const mainContent = readFile(tmpDir, 'src/main.ts');
    expect(mainContent).toContain('./lib/helper');
    expect(mainContent).not.toContain('./utils/helper');
  });

  it('dry run does not move file or modify importers', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export const x = 1;\n',
      'src/main.ts': "import { x } from './a';\n",
    });
    const aFileId = insertFile(store, 'src/a.ts');
    const mainFileId = insertFile(store, 'src/main.ts');

    const aNodeId = store.createNode('file', aFileId);
    const mainNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('imports', 'structural', 'File imports');
    insertEdge(store, mainNodeId, aNodeId, 'imports');

    const result = applyMove(store, tmpDir, {
      mode: 'file',
      source_file: 'src/a.ts',
      new_path: 'src/moved/a.ts',
      dry_run: true,
    });
    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);

    // File should NOT have moved
    expect(fs.existsSync(path.join(tmpDir, 'src/a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/moved/a.ts'))).toBe(false);

    // Importer should be unchanged
    expect(readFile(tmpDir, 'src/main.ts')).toContain("./a");
  });

  it('updates own relative imports when file moves to different directory', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils/helper.ts': "import { config } from '../config';\nexport function help() { return config; }\n",
      'src/config.ts': 'export const config = {};\n',
    });
    const helperFileId = insertFile(store, 'src/utils/helper.ts');

    const result = applyMove(store, tmpDir, {
      mode: 'file',
      source_file: 'src/utils/helper.ts',
      new_path: 'src/lib/deep/helper.ts',
      dry_run: false,
    });
    expect(result.success).toBe(true);

    // The moved file's own imports should be updated
    const movedContent = readFile(tmpDir, 'src/lib/deep/helper.ts');
    expect(movedContent).toContain('../../config');
    expect(movedContent).not.toContain("'../config'");
  });

  it('creates parent directories for target if needed', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export const x = 1;\n',
    });
    insertFile(store, 'src/a.ts');

    const result = applyMove(store, tmpDir, {
      mode: 'file',
      source_file: 'src/a.ts',
      new_path: 'src/deep/nested/dir/a.ts',
      dry_run: false,
    });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/deep/nested/dir/a.ts'))).toBe(true);
  });
});
