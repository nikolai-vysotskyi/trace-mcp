import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { applyRename, removeDeadCode, extractFunction } from '../../src/tools/refactor.js';

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

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

/** Create a temp directory with files for filesystem-dependent tests. */
function createTempProject(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }
  return tmpDir;
}

function readFile(projectRoot: string, relPath: string): string {
  return fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
}

function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════
// APPLY RENAME
// ════════════════════════════════════════════════════════════════════════

describe('applyRename', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createStore();
  });

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it('returns error for unknown symbol', () => {
    const result = applyRename(store, '/tmp', 'nonexistent#function', 'newName');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
  });

  it('returns error when new name equals old name', () => {
    tmpDir = createTempProject({ 'src/a.ts': 'export function foo() {}' });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'foo');

    const result = applyRename(store, tmpDir, 'src/a.ts::foo#function', 'foo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('same as the current name');
  });

  it('aborts on naming conflict in same file', () => {
    tmpDir = createTempProject({ 'src/a.ts': 'export function foo() {}\nfunction bar() {}' });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'foo');
    insertSymbol(store, fA, 'bar');

    const result = applyRename(store, tmpDir, 'src/a.ts::foo#function', 'bar');
    expect(result.success).toBe(false);
    expect(result.error).toContain('conflicts');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('renames symbol in definition file', () => {
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
      'src/a.ts': 'export function get() {}\nfunction getAll() {}\nfunction doGet() {}\n',
    });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'get');

    const result = applyRename(store, tmpDir, 'src/a.ts::get#function', 'fetch');
    expect(result.success).toBe(true);

    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('fetch');
    expect(content).toContain('getAll');  // NOT renamed
    expect(content).toContain('doGet');   // NOT renamed
    expect(content).not.toMatch(/\bget\b/);
  });

  it('warns when file missing on disk', () => {
    tmpDir = createTempProject({});
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
    store = createStore();
  });

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it('returns error for unknown symbol', () => {
    const result = removeDeadCode(store, '/tmp', 'nonexistent#function');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
  });

  it('refuses to remove symbol with incoming references', () => {
    tmpDir = createTempProject({ 'src/a.ts': 'export function used() {}' });
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
    tmpDir = createTempProject({ 'src/a.ts': 'export function noLines() {}' });
    const fA = insertFile(store, 'src/a.ts');
    insertSymbol(store, fA, 'noLines'); // no lineStart/lineEnd

    const result = removeDeadCode(store, tmpDir, 'src/a.ts::noLines#function');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no line range');
  });

  it('removes dead symbol from file', () => {
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    store = createStore();
  });

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it('returns error for missing file', () => {
    tmpDir = createTempProject({});
    const result = extractFunction(store, tmpDir, 'src/nope.ts', 1, 3, 'extracted');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for invalid line range', () => {
    tmpDir = createTempProject({ 'src/a.ts': 'line1\nline2\n' });
    const result = extractFunction(store, tmpDir, 'src/a.ts', 5, 10, 'extracted');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid line range');
  });

  it('returns error for inverted range (start > end)', () => {
    tmpDir = createTempProject({ 'src/a.ts': 'line1\nline2\nline3\n' });
    const result = extractFunction(store, tmpDir, 'src/a.ts', 3, 1, 'extracted');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid line range');
  });

  it('extracts simple TS function with no params/returns', () => {
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
    tmpDir = createTempProject({
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
