/**
 * Behavioural coverage for `applyRename()` (the `apply_rename` MCP tool).
 *
 * Focused on the dry_run path so source files in tests are never mutated.
 *   - dry_run preview produces edits identical to planRefactoring({type:'rename'})
 *   - collision aborts with a clear reason (warnings populated)
 *   - output shape: { success, tool, edits, files_modified, warnings }
 *   - non-existent symbol returns clean "Symbol not found" error
 *   - dry_run leaves files on disk untouched (mtime check)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { planRefactoring } from '../../../src/tools/refactoring/plan-refactoring.js';
import { applyRename } from '../../../src/tools/refactoring/refactor.js';
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

describe('applyRename() — behavioural contract (dry_run path)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('dry_run preview produces edits matching planRefactoring rename output', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function oldName() {\n  return oldName + 1;\n}\n',
    });
    const fid = insertFile(store, 'src/a.ts');
    insertSymbol(store, fid, 'oldName', { lineStart: 1, lineEnd: 3 });

    const planned = planRefactoring(store, tmpDir, {
      type: 'rename',
      symbol_id: 'src/a.ts::oldName#function',
      new_name: 'newName',
    });
    const applied = applyRename(store, tmpDir, 'src/a.ts::oldName#function', 'newName', true);

    expect(applied.success).toBe(true);
    expect(applied.edits.length).toBe(planned.edits.length);
    // Edits should target the same file
    expect(applied.edits.map((e) => e.file).sort()).toEqual(
      planned.edits.map((e) => e.file).sort(),
    );
  });

  it('collision aborts the run with a clear reason and warnings populated', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function oldName() {}\nfunction blocker() {}\n',
    });
    const fid = insertFile(store, 'src/a.ts');
    insertSymbol(store, fid, 'oldName', { lineStart: 1, lineEnd: 1 });
    insertSymbol(store, fid, 'blocker', { lineStart: 2, lineEnd: 2 });

    const result = applyRename(store, tmpDir, 'src/a.ts::oldName#function', 'blocker', true);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('conflicts');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('output shape pinned: success, tool, edits, files_modified, warnings', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': 'export function hello() { return 1; }\n' });
    const fid = insertFile(store, 'src/a.ts');
    insertSymbol(store, fid, 'hello', { lineStart: 1, lineEnd: 1 });

    const result = applyRename(store, tmpDir, 'src/a.ts::hello#function', 'hi', true);

    expect(result.tool).toBe('apply_rename');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('edits');
    expect(result).toHaveProperty('files_modified');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.edits)).toBe(true);
    expect(Array.isArray(result.files_modified)).toBe(true);
  });

  it('non-existent symbol returns clean "Symbol not found" error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/a.ts': '// empty\n' });

    const result = applyRename(store, tmpDir, 'src/ghost.ts::missing#function', 'newName', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
    expect(result.edits).toEqual([]);
    expect(result.files_modified).toEqual([]);
  });

  it('dry_run does NOT modify files on disk (mtime check)', async () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/a.ts': 'export function targetFn() {\n  return targetFn;\n}\n',
    });
    const fid = insertFile(store, 'src/a.ts');
    insertSymbol(store, fid, 'targetFn', { lineStart: 1, lineEnd: 3 });

    const before = snapshotMtimes(tmpDir);
    await new Promise((r) => setTimeout(r, 5));

    const result = applyRename(store, tmpDir, 'src/a.ts::targetFn#function', 'renamedFn', true);

    expect(result.success).toBe(true);
    expect(result.edits.length).toBeGreaterThan(0);

    const after = snapshotMtimes(tmpDir);
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
    // File content unchanged too
    const content = fs.readFileSync(path.join(tmpDir, 'src/a.ts'), 'utf-8');
    expect(content).toContain('targetFn');
    expect(content).not.toContain('renamedFn');
  });
});
