import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../src/db/store.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';
import {
  applyRename,
  removeDeadCode,
  extractFunction,
  applyCodemod,
} from '../../src/tools/refactoring/refactor.js';

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
  metadata?: Record<string, unknown>,
): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType, true, metadata);
}

function readFile(projectRoot: string, relPath: string): string {
  return fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
}

// ════════════════════════════════════════════════════════════════════════
// APPLY RENAME
// ════════════════════════════════════════════════════════════════════════

describe('applyRename', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns error for unknown symbol', () => {
    const result = applyRename(store, '/tmp', 'nonexistent#function', 'newName');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
  });

  it('returns error when new name equals old name', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function foo() {}' }, 'refactor-test-');
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'foo');

    const result = applyRename(store, tmpDir, 'src/a.ts::foo#function', 'foo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('same as the current name');
  });

  it('aborts on naming conflict in same file', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function foo() {}\nfunction bar() {}' });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'foo');
    insertSymbol(store, fA, 'bar');

    const result = applyRename(store, tmpDir, 'src/a.ts::foo#function', 'bar');
    expect(result.success).toBe(false);
    expect(result.error).toContain('conflicts');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('renames symbol in definition file', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function oldName() {\n  return oldName;\n}\n',
    });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'oldName');

    const result = applyRename(store, tmpDir, 'src/a.ts::oldName#function', 'newName');
    expect(result.success).toBe(true);
    expect(result.files_modified).toContain('src/a.ts');
    expect(result.edits.length).toBe(2); // two lines contain 'oldName'

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('newName');
    expect(content).not.toContain('oldName');
  });

  it('renames across importing files', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function myFunc() {}\n',
      'src/b.ts': 'import { myFunc } from "./a";\nmyFunc();\n',
    });
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertSymbol(store, fA, 'myFunc');

    // B imports A
    const nodeB = store.getNodeId('file', fB)!;
    const nodeA = store.getNodeId('file', fA)!;
    insertEdge(store, nodeB, nodeA, 'esm_imports');

    const result = applyRename(store, tmpDir, 'src/a.ts::myFunc#function', 'renamedFunc');
    expect(result.success).toBe(true);
    expect(result.files_modified).toContain('src/a.ts');
    expect(result.files_modified).toContain('src/b.ts');

    const aContent = readFile(tmpDir, 'src/a.ts');
    expect(aContent).toContain('renamedFunc');
    expect(aContent).not.toContain('myFunc');

    const bContent = readFile(tmpDir, 'src/b.ts');
    expect(bContent).toContain('renamedFunc');
    expect(bContent).not.toContain('myFunc');
  });

  it('respects word boundaries (does not rename substrings)', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function get() {}\nfunction getAll() {}\nfunction doGet() {}\n',
    });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'get');

    const result = applyRename(store, tmpDir, 'src/a.ts::get#function', 'fetch');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('fetch');
    expect(content).toContain('getAll'); // NOT renamed
    expect(content).toContain('doGet'); // NOT renamed
    expect(content).not.toMatch(/\bget\b/);
  });

  it('warns when file missing on disk', () => {
    tmpDir = createTmpFixture({});
    const fA = insertFile(store, 'src/missing.ts');
    insertSymbol(store, fA, 'foo');

    const result = applyRename(store, tmpDir, 'src/missing.ts::foo#function', 'bar');
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('not found on disk'))).toBe(true);
    expect(result.files_modified).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// REMOVE DEAD CODE
// ════════════════════════════════════════════════════════════════════════

describe('removeDeadCode', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns error for unknown symbol', () => {
    const result = removeDeadCode(store, '/tmp', 'nonexistent#function');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
  });

  it('refuses to remove symbol with incoming references', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function used() {}' });
    const fA = insertFile(store, 'src/a.ts');
    const symDbId = insertSymbol(store, fA, 'used', { lineStart: 1, lineEnd: 1 });
    const fB = insertFile(store, 'src/b.ts');

    // Create a call edge from B to the symbol
    const symNodeId = store.getNodeId('symbol', symDbId)!;
    const callerDbId = insertSymbol(store, fB, 'caller', { lineStart: 1, lineEnd: 1 });
    const callerNodeId = store.getNodeId('symbol', callerDbId)!;
    insertEdge(store, callerNodeId, symNodeId, 'calls');

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::used#function');
    expect(result.success).toBe(false);
    expect(result.error).toContain('incoming reference');
    expect(result.error).toContain('caller');
  });

  it('returns error when symbol has no line range', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function noLines() {}' });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'noLines'); // no lineStart/lineEnd

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::noLines#function');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no line range');
  });

  it('removes dead symbol from file', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const x = 1;',
        'export function deadFunc() {',
        '  return 42;',
        '}',
        'const y = 2;',
      ].join('\n'),
    });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'deadFunc', { lineStart: 2, lineEnd: 4 });

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::deadFunc#function');
    expect(result.success).toBe(true);
    expect(result.files_modified).toContain('src/a.ts');

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).not.toContain('deadFunc');
    expect(content).toContain('const x = 1;');
    expect(content).toContain('const y = 2;');
  });

  it('removes JSDoc and decorators above the symbol', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const keep = 1;',
        '/** This is a dead func */',
        '@deprecated',
        'export function deadFunc() {',
        '  return 42;',
        '}',
        'const alsoKeep = 2;',
      ].join('\n'),
    });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'deadFunc', { lineStart: 4, lineEnd: 6 });

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::deadFunc#function');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).not.toContain('deadFunc');
    expect(content).not.toContain('deprecated');
    expect(content).not.toContain('dead func');
    expect(content).toContain('const keep = 1;');
    expect(content).toContain('const alsoKeep = 2;');
  });

  it('warns about orphaned imports when last export removed', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function onlyExport() {\n  return 1;\n}\n',
      'src/b.ts': 'import { onlyExport } from "./a";\n',
    });
    const fA = insertFile(store, 'src/a.ts');
    const fB = insertFile(store, 'src/b.ts');
    insertSymbol(store, fA, 'onlyExport', {
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });

    // B imports A
    const nodeB = store.getNodeId('file', fB)!;
    const nodeA = store.getNodeId('file', fA)!;
    insertEdge(store, nodeB, nodeA, 'esm_imports');

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::onlyExport#function');
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('last exported symbol'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('src/b.ts'))).toBe(true);
  });

  it('cleans up consecutive blank lines after removal', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const before = 1;',
        '',
        'export function dead() {',
        '  return 0;',
        '}',
        '',
        'const after = 2;',
      ].join('\n'),
    });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'dead', { lineStart: 3, lineEnd: 5 });

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::dead#function');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    // Should not have 3+ consecutive newlines
    expect(content).not.toMatch(/\n\n\n/);
    expect(content).toContain('const before = 1;');
    expect(content).toContain('const after = 2;');
  });
});

// ════════════════════════════════════════════════════════════════════════
// EXTRACT FUNCTION
// ════════════════════════════════════════════════════════════════════════

describe('extractFunction', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns error for missing file', () => {
    tmpDir = createTmpFixture({});
    const result = extractFunction(store, tmpDir, 'src/nope.ts', 1, 3, 'extracted');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for invalid line range', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'line1\nline2\n' });
    const result = extractFunction(store, tmpDir, 'src/a.ts', 5, 10, 'extracted');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid line range');
  });

  it('returns error for inverted range (start > end)', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'line1\nline2\nline3\n' });
    const result = extractFunction(store, tmpDir, 'src/a.ts', 3, 1, 'extracted');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid line range');
  });

  it('extracts simple TS function with no params/returns', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'function main() {',
        '  console.log("hello");',
        '  console.log("world");',
        '  return 0;',
        '}',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/a.ts', 2, 3, 'greet');
    expect(result.success).toBe(true);
    expect(result.files_modified).toContain('src/a.ts');

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('greet();');
    expect(content).toContain('function greet()');
  });

  it('detects parameters from outer scope', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const items = [1, 2, 3];',
        'const multiplier = 2;',
        '// start extract',
        'const result = items.map(x => x * multiplier);',
        '// end extract',
        'return result;',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/a.ts', 4, 4, 'transform');
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('parameter'))).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    // The call site should pass params
    expect(content).toContain('transform(');
    // The function should accept params
    expect(content).toContain('function transform(');
  });

  it('detects return values used after extraction', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const input = 10;',
        'const doubled = input * 2;',
        'const tripled = input * 3;',
        'console.log(doubled + tripled);',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/a.ts', 2, 3, 'compute');
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('return value'))).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    // Should have destructured return
    expect(content).toContain('function compute(');
    expect(content).toMatch(/return/);
  });

  it('generates Python syntax for .py files', () => {
    tmpDir = createTmpFixture({
      'src/main.py': [
        'data = [1, 2, 3]',
        'total = sum(data)',
        'average = total / len(data)',
        'print(average)',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/main.py', 2, 3, 'compute_stats');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/main.py');
    expect(content).toContain('def compute_stats(');
    expect(content).not.toContain('function ');
  });

  it('generates Go syntax for .go files', () => {
    tmpDir = createTmpFixture({
      'src/main.go': [
        'package main',
        '',
        'func main() {',
        '  x := 10',
        '  y := x * 2',
        '  fmt.Println(y)',
        '}',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/main.go', 4, 5, 'compute');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/main.go');
    expect(content).toContain('func compute(');
    expect(content).not.toContain('function ');
    expect(content).not.toContain('def ');
  });

  it('preserves lines before and after extraction', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': [
        'const header = "start";',
        'const a = 1;',
        'const b = 2;',
        'const footer = "end";',
      ].join('\n'),
    });

    const result = extractFunction(store, tmpDir, 'src/a.ts', 2, 3, 'setup');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('const header = "start";');
    expect(content).toContain('const footer = "end";');
  });
});

// ════════════════════════════════════════════════════════════════════════
// APPLY CODEMOD
// ════════════════════════════════════════════════════════════════════════

describe('applyCodemod', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('dry_run returns preview without writing', () => {
    tmpDir = createTmpFixture({
      'tests/a.test.ts': "it('works', () => {\n  doStuff();\n});\n",
      'tests/b.test.ts': "it('also works', () => {\n  doOther();\n});\n",
    });

    const result = applyCodemod(
      tmpDir,
      "it\\('([^']+)',\\s*\\(\\)",
      "it('$1', async ()",
      'tests/**/*.test.ts',
      {
        dryRun: true,
      },
    );

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.total_replacements).toBe(2);
    expect(result.total_files).toBe(2);
    expect(result.files_modified).toHaveLength(0); // dry run — no writes

    // Files should be unchanged
    expect(readFile(tmpDir, 'tests/a.test.ts')).toContain('() => {');
    expect(readFile(tmpDir, 'tests/a.test.ts')).not.toContain('async');
  });

  it('applies changes when dry_run=false', () => {
    tmpDir = createTmpFixture({
      'tests/a.test.ts': "it('works', () => {\n  doStuff();\n});\n",
      'tests/b.test.ts': "it('also works', () => {\n  doOther();\n});\n",
    });

    const result = applyCodemod(
      tmpDir,
      "it\\('([^']+)',\\s*\\(\\)",
      "it('$1', async ()",
      'tests/**/*.test.ts',
      {
        dryRun: false,
      },
    );

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.files_modified).toHaveLength(2);

    expect(readFile(tmpDir, 'tests/a.test.ts')).toContain('async ()');
    expect(readFile(tmpDir, 'tests/b.test.ts')).toContain('async ()');
  });

  it('returns error for invalid regex', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'hello' });
    const result = applyCodemod(tmpDir, '(unclosed', 'x', 'src/**', { dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid regex');
  });

  it('returns error when no files match glob', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'hello' });
    const result = applyCodemod(tmpDir, 'hello', 'bye', 'nonexistent/**/*.xyz', { dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No files matched');
  });

  it('returns error when no content matches pattern', () => {
    tmpDir = createTmpFixture({ 'src/a.ts': 'hello world' });
    const result = applyCodemod(tmpDir, 'zzzzz', 'x', 'src/**', { dryRun: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No matches found');
  });

  it('filter_content narrows scope', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': "import { foo } from './foo';\nconst x = foo();\n",
      'src/b.ts': 'const y = 42;\n',
    });

    const result = applyCodemod(tmpDir, 'const', 'let', 'src/**/*.ts', {
      dryRun: true,
      filterContent: 'foo',
    });

    expect(result.success).toBe(true);
    expect(result.total_files).toBe(1);
    // Only a.ts matches because it contains 'foo'
    expect(result.matches[0].file).toBe('src/a.ts');
  });

  it('blocks large changes without confirm_large', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      files[`src/file${i}.ts`] = 'const x = 1;\n';
    }
    tmpDir = createTmpFixture(files);

    const result = applyCodemod(tmpDir, 'const', 'let', 'src/**/*.ts', {
      dryRun: false,
    });

    // Should be forced into dry_run mode
    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.warnings.some((w) => w.includes('confirm_large'))).toBe(true);
    expect(result.files_modified).toHaveLength(0);
  });

  it('allows large changes with confirm_large=true', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      files[`src/file${i}.ts`] = 'const x = 1;\n';
    }
    tmpDir = createTmpFixture(files);

    const result = applyCodemod(tmpDir, 'const', 'let', 'src/**/*.ts', {
      dryRun: false,
      confirmLarge: true,
    });

    expect(result.success).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.files_modified).toHaveLength(25);
  });

  it('skips binary files', () => {
    tmpDir = createTmpFixture({
      'assets/icon.png': 'fake binary content with const keyword',
      'src/a.ts': 'const x = 1;\n',
    });

    const result = applyCodemod(tmpDir, 'const', 'let', '**/*', { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.total_files).toBe(1);
    expect(result.matches[0].file).toBe('src/a.ts');
  });

  it('provides context lines in preview', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'line1\nline2\nconst target = 1;\nline4\nline5\n',
    });

    const result = applyCodemod(tmpDir, 'const target', 'let target', 'src/**', { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.matches[0].context_before.length).toBeGreaterThan(0);
    expect(result.matches[0].context_after.length).toBeGreaterThan(0);
  });

  it('supports multiline mode', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'if (cond) {\n  doA();\n  doB();\n}\n',
    });

    const result = applyCodemod(
      tmpDir,
      'if \\(cond\\) \\{\\n  doA\\(\\);',
      'if (cond) {\n  doX();',
      'src/**',
      {
        dryRun: false,
        multiline: true,
      },
    );

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('doX()');
    expect(content).not.toContain('doA()');
  });

  it('handles multiple matches per file', () => {
    tmpDir = createTmpFixture({
      'src/a.ts': "it('test1', () => {});\nit('test2', () => {});\nit('test3', () => {});\n",
    });

    const result = applyCodemod(
      tmpDir,
      "it\\('([^']+)',\\s*\\(\\)",
      "it('$1', async ()",
      'src/**',
      {
        dryRun: false,
      },
    );

    expect(result.success).toBe(true);
    expect(result.total_replacements).toBe(3);
    const content = readFile(tmpDir, 'src/a.ts');
    // All 3 callbacks should now be async
    expect((content.match(/async \(\)/g) || []).length).toBe(3);
    // No non-async callbacks left
    expect(content).not.toMatch(/,\s*\(\)\s*=>/);
  });
});
