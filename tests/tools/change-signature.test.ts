import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';
import { changeSignature, parseParamList, splitArgs } from '../../src/tools/refactoring/change-signature.js';

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
// UNIT: PARAM PARSING
// ════════════════════════════════════════════════════════════════════════

describe('parseParamList', () => {
  it('parses empty param list', () => {
    expect(parseParamList('', 'typescript')).toEqual([]);
  });

  it('parses simple TS params', () => {
    const params = parseParamList('a: string, b: number', 'typescript');
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe('a');
    expect(params[0].type).toBe('string');
    expect(params[1].name).toBe('b');
    expect(params[1].type).toBe('number');
  });

  it('parses params with defaults', () => {
    const params = parseParamList('a: string, b = 42', 'typescript');
    expect(params[0].name).toBe('a');
    expect(params[1].name).toBe('b');
    expect(params[1].default_value).toBe('42');
  });

  it('parses params with generic types', () => {
    const params = parseParamList('items: Array<string>, cb: (a: number) => void', 'typescript');
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe('items');
    expect(params[0].type).toBe('Array<string>');
  });

  it('parses Python params', () => {
    const params = parseParamList('self, name: str, age: int = 25', 'python');
    expect(params).toHaveLength(3);
    expect(params[0].name).toBe('self');
    expect(params[1].name).toBe('name');
    expect(params[1].type).toBe('str');
    expect(params[2].name).toBe('age');
    expect(params[2].default_value).toBe('25');
  });

  it('parses Go params', () => {
    const params = parseParamList('name string, age int', 'go');
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe('name');
    expect(params[0].type).toBe('string');
    expect(params[1].name).toBe('age');
    expect(params[1].type).toBe('int');
  });
});

describe('splitArgs', () => {
  it('splits simple args', () => {
    expect(splitArgs('a, b, c')).toEqual(['a', ' b', ' c']);
  });

  it('handles nested calls', () => {
    const args = splitArgs('foo(1, 2), bar(3)');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('foo(1, 2)');
  });

  it('handles generic types', () => {
    const args = splitArgs('Array<string, number>, other');
    expect(args).toHaveLength(2);
  });

  it('handles string literals with commas', () => {
    const args = splitArgs('"hello, world", 42');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('"hello, world"');
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION: CHANGE SIGNATURE
// ════════════════════════════════════════════════════════════════════════

describe('changeSignature', () => {
  let store: Store;
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns error for unknown symbol', () => {
    store = createTestStore();
    const result = changeSignature(store, '/tmp', 'nope#function', [{ add_param: { name: 'x' } }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
  });

  it('returns error for non-function symbol', () => {
    store = createTestStore();
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'Foo', { kind: 'class', lineStart: 1, lineEnd: 3 });
    const result = changeSignature(store, '/tmp', 'src/a.ts::Foo#class', [{ add_param: { name: 'x' } }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a function');
  });

  it('returns error with no changes', () => {
    store = createTestStore();
    const result = changeSignature(store, '/tmp', 'nope#function', []);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No changes');
  });

  it('adds a parameter to a function', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function greet(name: string) {\n  return "hello " + name;\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'greet', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(store, tmpDir, 'src/a.ts::greet#function', [
      { add_param: { name: 'greeting', type: 'string', default_value: '"hello"' } },
    ], false);

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('greeting: string = "hello"');
  });

  it('removes a parameter', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function add(a: number, b: number, c: number) {\n  return a + b + c;\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'add', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(store, tmpDir, 'src/a.ts::add#function', [
      { remove_param: { name: 'c' } },
    ], false);

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('a: number, b: number)');
    expect(content).not.toContain('c: number');
  });

  it('renames a parameter in definition', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function calc(x: number, y: number) {\n  return x + y;\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'calc', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(store, tmpDir, 'src/a.ts::calc#function', [
      { rename_param: { old_name: 'x', new_name: 'left' } },
    ], false);

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('left: number');
    expect(content).not.toContain('(x: number');
  });

  it('reorders parameters', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function mix(a: string, b: number, c: boolean) {\n  return [a, b, c];\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'mix', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(store, tmpDir, 'src/a.ts::mix#function', [
      { reorder_params: ['c', 'a', 'b'] },
    ], false);

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('c: boolean, a: string, b: number');
  });

  it('updates call sites when removing a param', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function add(a: number, b: number, c: number) {\n  return a + b + c;\n}\n',
      'src/main.ts': "import { add } from './utils';\nconst result = add(1, 2, 3);\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'add', { kind: 'function', lineStart: 1, lineEnd: 3, metadata: { exported: true } });

    // Create edge: main calls add
    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(store, tmpDir, 'src/utils.ts::add#function', [
      { remove_param: { name: 'c' } },
    ], false);

    expect(result.success).toBe(true);

    // Definition should be updated
    const utilsContent = readFile(tmpDir, 'src/utils.ts');
    expect(utilsContent).toContain('a: number, b: number)');

    // Call site should be updated
    const mainContent = readFile(tmpDir, 'src/main.ts');
    expect(mainContent).toContain('add(1, 2)');
    expect(mainContent).not.toContain('add(1, 2, 3)');
  });

  it('updates call sites when reordering params', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function format(name: string, age: number) {\n  return `${name} is ${age}`;\n}\n',
      'src/main.ts': "import { format } from './utils';\nconst s = format('Alice', 30);\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'format', { kind: 'function', lineStart: 1, lineEnd: 3, metadata: { exported: true } });

    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(store, tmpDir, 'src/utils.ts::format#function', [
      { reorder_params: ['age', 'name'] },
    ], false);

    expect(result.success).toBe(true);

    const mainContent = readFile(tmpDir, 'src/main.ts');
    expect(mainContent).toContain("format(30, 'Alice')");
  });

  it('dry run produces edits but does not modify files', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function greet(name: string) {\n  return "hello " + name;\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'greet', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const originalContent = readFile(tmpDir, 'src/a.ts');
    const result = changeSignature(store, tmpDir, 'src/a.ts::greet#function', [
      { add_param: { name: 'greeting', type: 'string' } },
    ], true); // dry_run = true

    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);
    // File should be unchanged
    expect(readFile(tmpDir, 'src/a.ts')).toBe(originalContent);
  });

  it('adds param without default inserts placeholder at call sites', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function greet(name: string) {\n  return "hello " + name;\n}\n',
      'src/main.ts': "import { greet } from './utils';\ngreet('world');\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'greet', { kind: 'function', lineStart: 1, lineEnd: 3, metadata: { exported: true } });

    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(store, tmpDir, 'src/utils.ts::greet#function', [
      { add_param: { name: 'greeting', type: 'string' } },
    ], false);

    expect(result.success).toBe(true);

    // Call site should have placeholder
    const mainContent = readFile(tmpDir, 'src/main.ts');
    expect(mainContent).toContain('undefined');
  });

  it('handles multiple changes in one call', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'function process(a: number, b: string, c: boolean) {\n  return [a, b, c];\n}\n',
    });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'process', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(store, tmpDir, 'src/a.ts::process#function', [
      { remove_param: { name: 'c' } },
      { rename_param: { old_name: 'a', new_name: 'input' } },
      { add_param: { name: 'options', type: 'Options', default_value: '{}' } },
    ], false);

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('input: number');
    expect(content).not.toContain('c: boolean');
    expect(content).toContain('options: Options = {}');
  });
});
