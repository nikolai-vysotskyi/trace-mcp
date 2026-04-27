import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../src/db/store.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';
import { planRefactoring } from '../../src/tools/refactoring/plan-refactoring.js';

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

function readFile(projectRoot: string, relPath: string): string {
  return fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
}

// ════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════

describe('planRefactoring', () => {
  let store: Store;
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('previews rename without applying', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function foo() { return 1; }\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'foo', { lineStart: 1, lineEnd: 1, metadata: { exported: true } });

    const result = planRefactoring(store, tmpDir, {
      type: 'rename',
      symbol_id: 'src/a.ts::foo#function',
      new_name: 'bar',
    });

    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);
    // File should be unchanged (dry run)
    expect(readFile(tmpDir, 'src/a.ts')).toContain('function foo()');
  });

  it('previews move symbol without applying', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function foo() {\n  return 1;\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'foo', { lineStart: 1, lineEnd: 3, metadata: { exported: true } });

    const result = planRefactoring(store, tmpDir, {
      type: 'move',
      symbol_id: 'src/a.ts::foo#function',
      target_file: 'src/b.ts',
    });

    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);
    // Source file unchanged
    expect(readFile(tmpDir, 'src/a.ts')).toContain('function foo()');
    // Target not created
    expect(fs.existsSync(path.join(tmpDir, 'src/b.ts'))).toBe(false);
  });

  it('previews move file without applying', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export const x = 1;\n',
    });
    insertFile(store, 'src/a.ts');

    const result = planRefactoring(store, tmpDir, {
      type: 'move',
      source_file: 'src/a.ts',
      new_path: 'src/moved.ts',
    });

    expect(result.success).toBe(true);
    // File not moved
    expect(fs.existsSync(path.join(tmpDir, 'src/a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src/moved.ts'))).toBe(false);
  });

  it('previews extract function without applying', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function main() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n',
    });
    const _fileId = insertFile(store, 'src/a.ts');

    const result = planRefactoring(store, tmpDir, {
      type: 'extract',
      file_path: 'src/a.ts',
      start_line: 2,
      end_line: 3,
      function_name: 'initVars',
    });

    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);
    // File unchanged
    expect(readFile(tmpDir, 'src/a.ts')).not.toContain('initVars');
  });

  it('previews signature change without applying', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function greet(name: string) {\n  return "hello " + name;\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'greet', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = planRefactoring(store, tmpDir, {
      type: 'signature',
      symbol_id: 'src/a.ts::greet#function',
      changes: [{ add_param: { name: 'greeting', type: 'string' } }],
    });

    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);
    // File unchanged
    expect(readFile(tmpDir, 'src/a.ts')).not.toContain('greeting');
  });

  it('returns error for missing rename params', () => {
    store = createTestStore();
    const result = planRefactoring(store, '/tmp', { type: 'rename' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('symbol_id');
  });

  it('returns error for missing move params', () => {
    store = createTestStore();
    const result = planRefactoring(store, '/tmp', { type: 'move' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Move requires');
  });

  it('returns error for missing extract params', () => {
    store = createTestStore();
    const result = planRefactoring(store, '/tmp', { type: 'extract' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Extract requires');
  });

  it('returns error for missing signature params', () => {
    store = createTestStore();
    const result = planRefactoring(store, '/tmp', { type: 'signature' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Signature change requires');
  });

  it('returns error for unknown type', () => {
    store = createTestStore();
    const result = planRefactoring(store, '/tmp', { type: 'unknown' as any });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown refactoring type');
  });
});
