/**
 * Behavioural coverage for `changeSignature()` (the `change_signature` MCP tool).
 *
 * All tests run with dry_run=true — disk is never mutated.
 *   - add_param: edits include def with the new param
 *   - remove_param: def edit drops the param; call-site edit drops the matching arg
 *   - rename_param: def shows the renamed param
 *   - reorder_params: def shows the new positional order; call sites reorder args
 *   - dry_run leaves files unchanged (mtime + content check)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { changeSignature } from '../../../src/tools/refactoring/change-signature.js';
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
  for (const entry of fs.readdirSync(tmpDir, { recursive: true }) as string[]) {
    const full = path.join(tmpDir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) out[full] = stat.mtimeMs;
    } catch {
      // ignore
    }
  }
  return out;
}

/** Wire a single call-edge from a "caller" file (no actual symbol needed) to the target symbol. */
function wireCallEdge(store: Store, callerFileId: number, calleeSymbolDbId: number): void {
  store.ensureEdgeType('calls', 'structural', 'calls');
  const targetNid = store.createNode('symbol', calleeSymbolDbId);
  const callerNid = store.createNode('file', callerFileId);
  store.insertEdge(callerNid, targetNid, 'calls', true);
}

describe('changeSignature() — behavioural contract (dry_run path)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('add_param: dry_run edits include def with new param', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/u.ts': 'export function greet(name: string) {\n  return name;\n}\n',
    });
    const fid = insertFile(store, 'src/u.ts');
    insertSymbol(store, fid, 'greet', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(
      store,
      tmpDir,
      'src/u.ts::greet#function',
      [{ add_param: { name: 'greeting', type: 'string', default_value: '"hi"' } }],
      true,
    );

    expect(result.success).toBe(true);
    expect(result.tool).toBe('change_signature');
    const defEdit = result.edits.find((e) => e.file === 'src/u.ts');
    expect(defEdit).toBeDefined();
    expect(defEdit!.new_text).toContain('greeting');
    expect(defEdit!.new_text).toContain('"hi"');
    // File content untouched
    expect(fs.readFileSync(path.join(tmpDir, 'src/u.ts'), 'utf-8')).not.toContain('greeting');
  });

  it('remove_param: def edit drops the param AND call site loses the arg', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/u.ts':
        'export function add(a: number, b: number, c: number) {\n  return a + b + c;\n}\n',
      'src/main.ts': "import { add } from './u';\nconst r = add(1, 2, 3);\n",
    });
    const utilsFid = insertFile(store, 'src/u.ts');
    const mainFid = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFid, 'add', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    wireCallEdge(store, mainFid, symDbId);

    const result = changeSignature(
      store,
      tmpDir,
      'src/u.ts::add#function',
      [{ remove_param: { name: 'c' } }],
      true,
    );

    expect(result.success).toBe(true);
    const defEdit = result.edits.find((e) => e.file === 'src/u.ts');
    expect(defEdit).toBeDefined();
    expect(defEdit!.new_text).toContain('a: number');
    expect(defEdit!.new_text).toContain('b: number');
    expect(defEdit!.new_text).not.toContain('c: number');

    const callEdit = result.edits.find((e) => e.file === 'src/main.ts');
    expect(callEdit).toBeDefined();
    expect(callEdit!.new_text).toContain('add(1, 2)');
    expect(callEdit!.new_text).not.toContain('add(1, 2, 3)');

    // Disk untouched
    expect(fs.readFileSync(path.join(tmpDir, 'src/main.ts'), 'utf-8')).toContain('add(1, 2, 3)');
  });

  it('rename_param: only def text shows the renamed parameter', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/u.ts': 'export function calc(x: number, y: number) {\n  return x + y;\n}\n',
    });
    const fid = insertFile(store, 'src/u.ts');
    insertSymbol(store, fid, 'calc', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const result = changeSignature(
      store,
      tmpDir,
      'src/u.ts::calc#function',
      [{ rename_param: { old_name: 'x', new_name: 'left' } }],
      true,
    );

    expect(result.success).toBe(true);
    const defEdit = result.edits.find((e) => e.file === 'src/u.ts');
    expect(defEdit).toBeDefined();
    expect(defEdit!.new_text).toContain('left: number');
    expect(defEdit!.new_text).not.toContain('(x: number');
  });

  it('reorder_params: def + call sites reordered positionally', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/u.ts':
        'export function format(name: string, age: number) {\n  return `${name}:${age}`;\n}\n',
      'src/main.ts': "import { format } from './u';\nconst s = format('Alice', 30);\n",
    });
    const utilsFid = insertFile(store, 'src/u.ts');
    const mainFid = insertFile(store, 'src/main.ts');
    const symDbId = insertSymbol(store, utilsFid, 'format', {
      kind: 'function',
      lineStart: 1,
      lineEnd: 3,
      metadata: { exported: true },
    });
    wireCallEdge(store, mainFid, symDbId);

    const result = changeSignature(
      store,
      tmpDir,
      'src/u.ts::format#function',
      [{ reorder_params: ['age', 'name'] }],
      true,
    );

    expect(result.success).toBe(true);
    const defEdit = result.edits.find((e) => e.file === 'src/u.ts');
    expect(defEdit).toBeDefined();
    expect(defEdit!.new_text).toContain('age: number, name: string');

    const callEdit = result.edits.find((e) => e.file === 'src/main.ts');
    expect(callEdit).toBeDefined();
    // Positionally swapped: arg that was 'Alice' is now after 30.
    expect(callEdit!.new_text).toContain("format(30, 'Alice')");
  });

  it('dry_run does NOT modify files on disk (mtime + content)', async () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/u.ts': 'export function calc(x: number, y: number) {\n  return x + y;\n}\n',
    });
    const fid = insertFile(store, 'src/u.ts');
    insertSymbol(store, fid, 'calc', { kind: 'function', lineStart: 1, lineEnd: 3 });

    const before = snapshotMtimes(tmpDir);
    await new Promise((r) => setTimeout(r, 5));

    const result = changeSignature(
      store,
      tmpDir,
      'src/u.ts::calc#function',
      [{ add_param: { name: 'z', type: 'number', default_value: '0' } }],
      true,
    );
    expect(result.success).toBe(true);

    const after = snapshotMtimes(tmpDir);
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
    const content = fs.readFileSync(path.join(tmpDir, 'src/u.ts'), 'utf-8');
    expect(content).not.toContain('z: number');
  });
});
