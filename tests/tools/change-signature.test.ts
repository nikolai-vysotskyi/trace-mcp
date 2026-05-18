import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import {
  changeSignature,
  parseParamList,
  splitArgs,
} from '../../src/tools/refactoring/change-signature.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

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
    const result = changeSignature(store, '/tmp', 'src/a.ts::Foo#class', [
      { add_param: { name: 'x' } },
    ]);
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

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::greet#function',
      [{ add_param: { name: 'greeting', type: 'string', default_value: '"hello"' } }],
      false,
    );

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

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::add#function',
      [{ remove_param: { name: 'c' } }],
      false,
    );

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

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::calc#function',
      [{ rename_param: { old_name: 'x', new_name: 'left' } }],
      false,
    );

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

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::mix#function',
      [{ reorder_params: ['c', 'a', 'b'] }],
      false,
    );

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('c: boolean, a: string, b: number');
  });

  it('updates call sites when removing a param', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts':
        'export function add(a: number, b: number, c: number) {\n  return a + b + c;\n}\n',
      'src/main.ts': "import { add } from './utils';\nconst result = add(1, 2, 3);\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'add', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });

    // Create edge: main calls add
    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::add#function',
      [{ remove_param: { name: 'c' } }],
      false,
    );

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
      'src/utils.ts':
        'export function format(name: string, age: number) {\n  return `${name} is ${age}`;\n}\n',
      'src/main.ts': "import { format } from './utils';\nconst s = format('Alice', 30);\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'format', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });

    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::format#function',
      [{ reorder_params: ['age', 'name'] }],
      false,
    );

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
    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::greet#function',
      [{ add_param: { name: 'greeting', type: 'string' } }],
      true,
    ); // dry_run = true

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
    const symDbId = insertSymbol(store, utilsFileId, 'greet', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });

    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::greet#function',
      [{ add_param: { name: 'greeting', type: 'string' } }],
      false,
    );

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

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::process#function',
      [
        { remove_param: { name: 'c' } },
        { rename_param: { old_name: 'a', new_name: 'input' } },
        { add_param: { name: 'options', type: 'Options', default_value: '{}' } },
      ],
      false,
    );

    expect(result.success).toBe(true);
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('input: number');
    expect(content).not.toContain('c: boolean');
    expect(content).toContain('options: Options = {}');
  });
});

// ════════════════════════════════════════════════════════════════════════
// REGRESSION: P0-D — edit-shape bugs
// ════════════════════════════════════════════════════════════════════════

describe('changeSignature emitted-edit shape (P0-D regression)', () => {
  let store: Store;
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  // ── Bug 1: trailing `;` preservation at multi-line call sites ──────────

  it('preserves trailing `;` on multi-line call sites (Bug 1)', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function compute(a: number, b: number) {\n  return a + b;\n}\n',
      // Call site spans multiple lines and ends with `;`
      'src/main.ts':
        "import { compute } from './utils';\n" +
        'const v = compute(\n' +
        '  1,\n' +
        '  2,\n' +
        ');\n',
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'compute', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::compute#function',
      [{ add_param: { name: 'extra', type: 'boolean', default_value: 'false', position: 0 } }],
      false,
    );

    expect(result.success).toBe(true);

    // The emitted edit for the call site must end with `;` to avoid
    // statement fusion when the diff is applied.
    const callSiteEdit = result.edits.find((e) => e.file === 'src/main.ts');
    expect(callSiteEdit).toBeDefined();
    expect(callSiteEdit!.new_text.endsWith(';')).toBe(true);
    // Original ended with `;` too — trailing char must match
    expect(callSiteEdit!.original_text.trimEnd().endsWith(';')).toBe(true);

    // And the on-disk file must remain a valid statement.
    const mainContent = readFile(tmpDir, 'src/main.ts');
    expect(mainContent).toContain(');');
    expect(mainContent).not.toMatch(/\)\nimport/); // no statement fusion
  });

  it('preserves trailing characters after multi-line call (chained .then) (Bug 1)', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function load(url: string, opts: Opts) {\n  return fetch(url);\n}\n',
      'src/main.ts':
        "import { load } from './utils';\n" + "load(\n  '/api',\n  {},\n).then((r) => r.json());\n",
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'load', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::load#function',
      [{ remove_param: { name: 'opts' } }],
      false,
    );

    expect(result.success).toBe(true);
    const callSiteEdit = result.edits.find((e) => e.file === 'src/main.ts');
    expect(callSiteEdit).toBeDefined();
    // The trailing `.then((r) => r.json());` MUST be preserved on the rewritten line.
    expect(callSiteEdit!.new_text).toContain('.then((r) => r.json());');

    const mainContent = readFile(tmpDir, 'src/main.ts');
    expect(mainContent).toContain('.then((r) => r.json());');
  });

  // ── Bug 2: def-site range is tight (signature only, no body) ───────────

  it('emits a TIGHT signature-only range for the definition (Bug 2)', () => {
    // Build a 100-line function. The body is large and unchanged.
    const bodyLines = Array.from({ length: 100 }, (_, i) => `  const x${i} = ${i};`).join('\n');
    const source = `function huge(a: number, b: string) {\n${bodyLines}\n  return a;\n}\n`;
    store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': source });
    const fileId = insertFile(store, 'src/a.ts');
    const totalLines = source.split('\n').length - 1; // file ends with \n
    insertSymbol(store, fileId, 'huge', {
      kind: 'function',
      lineStart: 1,
      lineEnd: totalLines,
    });

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::huge#function',
      [{ add_param: { name: 'extra', type: 'boolean', default_value: 'false', position: 0 } }],
      false,
    );

    expect(result.success).toBe(true);
    const defEdit = result.edits.find((e) => e.file === 'src/a.ts');
    expect(defEdit).toBeDefined();

    // The emitted edit must NOT contain the 100-line body.
    const newTextLines = defEdit!.new_text.split('\n').length;
    const oldTextLines = defEdit!.original_text.split('\n').length;
    expect(newTextLines).toBeLessThanOrEqual(3);
    expect(oldTextLines).toBeLessThanOrEqual(3);

    // It must contain the new param and the return-type / brace context.
    expect(defEdit!.new_text).toContain('extra: boolean = false');
    expect(defEdit!.new_text).toContain('function huge(');

    // Sanity: must NOT contain anything from the body.
    expect(defEdit!.new_text).not.toContain('const x50');
  });

  // ── Bug 2 + multi-line signature: indentation preserved ────────────────

  it('handles a multi-line signature without garbling indentation', () => {
    const source =
      'function foo(\n' +
      '  a: number,\n' +
      '  b: string,\n' +
      '): boolean {\n' +
      '  return a > 0 && b.length > 0;\n' +
      '}\n';
    store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': source });
    const fileId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fileId, 'foo', { kind: 'function', lineStart: 1, lineEnd: 6 });

    const result = changeSignature(
      store,
      tmpDir,
      'src/a.ts::foo#function',
      [{ add_param: { name: 'c', type: 'boolean', default_value: 'false' } }],
      false,
    );

    expect(result.success).toBe(true);

    // The on-disk file must be syntactically intact: return-type and body preserved.
    const content = readFile(tmpDir, 'src/a.ts');
    expect(content).toContain('): boolean {');
    expect(content).toContain('return a > 0 && b.length > 0;');
    expect(content).toContain('c: boolean = false');

    // The emitted edit range must cover only the signature portion.
    const defEdit = result.edits.find((e) => e.file === 'src/a.ts');
    expect(defEdit).toBeDefined();
    // original_text covers 4 lines: `function foo(`, `  a:...`, `  b:...`, `): boolean {`
    expect(defEdit!.original_text.split('\n').length).toBe(4);
    // new_text collapses params onto one line — should be a single line containing `function foo(... ): boolean {`
    expect(defEdit!.new_text.split('\n').length).toBe(1);
    expect(defEdit!.new_text).toContain('): boolean {');
    // No body bleed
    expect(defEdit!.new_text).not.toContain('return a > 0');
  });

  // ── JSX call site: `;` not erroneously added ───────────────────────────

  it('does not erroneously add `;` to a call inside JSX (Bug 1 negative)', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function handleClick(x: number) {\n  return x;\n}\n',
      // Call site lives inside a JSX attribute — must NOT receive a trailing `;`.
      'src/Button.tsx':
        "import { handleClick } from './utils';\n" +
        'export const Btn = (x: number) => (\n' +
        '  <Button onClick={() => handleClick(x)} />\n' +
        ');\n',
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const jsxFileId = insertFile(store, 'src/Button.tsx');
    const symDbId = insertSymbol(store, utilsFileId, 'handleClick', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    const symNodeId = store.createNode('symbol', symDbId);
    const jsxFileNodeId = store.createNode('file', jsxFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(jsxFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::handleClick#function',
      [{ add_param: { name: 'flag', type: 'boolean', default_value: 'false' } }],
      false,
    );

    expect(result.success).toBe(true);

    // The call-site is single-line; the on-disk file must keep the JSX syntactically valid.
    const jsxContent = readFile(tmpDir, 'src/Button.tsx');
    // Must still match the JSX self-closing tag — no rogue `;` injected after `)}`
    expect(jsxContent).toContain('<Button onClick={() => handleClick(x)} />');
    expect(jsxContent).not.toMatch(/handleClick\(x\);}/); // not `);}` (stray semicolon)
  });

  // ── trailing-char round-trip — original vs new ─────────────────────────

  it('call-site edits preserve the trailing char from the original (round-trip)', () => {
    store = createTestStore();
    tmpDir = createTmpFixture({
      'src/utils.ts': 'export function ping(a: number, b: number) {\n  return a + b;\n}\n',
      'src/main.ts':
        "import { ping } from './utils';\n" +
        // Three call sites with different trailing contexts:
        'ping(1, 2);\n' + // expression statement
        'const arr = [ping(3, 4), 5];\n' + // arg-list comma context
        'ping(\n  6,\n  7,\n);\n', // multi-line ending in `;`
    });
    const utilsFileId = insertFile(store, 'src/utils.ts');
    const mainFileId = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFileId, 'ping', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    const symNodeId = store.createNode('symbol', symDbId);
    const mainFileNodeId = store.createNode('file', mainFileId);
    store.ensureEdgeType('calls', 'structural', 'Function calls');
    store.insertEdge(mainFileNodeId, symNodeId, 'calls', true);

    const result = changeSignature(
      store,
      tmpDir,
      'src/utils.ts::ping#function',
      [{ add_param: { name: 'tag', type: 'string', default_value: '"x"' } }],
      false,
    );

    expect(result.success).toBe(true);
    const callEdits = result.edits.filter((e) => e.file === 'src/main.ts');
    expect(callEdits.length).toBeGreaterThanOrEqual(1);
    // For each edit, the last non-newline char of new_text must match the original.
    for (const e of callEdits) {
      const lastOrig = e.original_text.trimEnd().slice(-1);
      const lastNew = e.new_text.trimEnd().slice(-1);
      expect(lastNew).toBe(lastOrig);
    }
  });
});
