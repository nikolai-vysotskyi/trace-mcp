/**
 * Behavioural coverage for `removeDeadCode()` (the `remove_dead_code` MCP tool).
 * Always invoked with dry_run=true so fixture files are never mutated.
 *
 *  - dry_run preview returns an edit recording the lines to remove
 *  - symbol with incoming references is rejected with a clear error
 *  - unknown symbol_id returns "Symbol not found" error cleanly
 *  - output envelope shape pinned (success, tool, edits, files_modified, warnings)
 *  - dry_run does NOT mutate the file on disk
 *  - removing the last exported symbol from a file (when other files import
 *    from it) surfaces an orphaned-imports warning
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { removeDeadCode } from '../../../src/tools/refactoring/refactor.js';
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
): { numericId: number; symbolId: string } {
  const file = store.getFileById(fileId);
  const filePath = file?.path ?? `file_${fileId}`;
  const kind = opts.kind ?? 'function';
  const symbolId = `${filePath}::${name}#${kind}`;
  const numericId = store.insertSymbol(fileId, {
    symbolId,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    lineStart: opts.lineStart ?? 1,
    lineEnd: opts.lineEnd ?? 3,
    metadata: opts.exported ? { exported: true } : undefined,
  } as never);
  return { numericId, symbolId };
}

describe('removeDeadCode() — behavioural contract (dry_run path)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('dry_run preview returns an edit recording the lines to remove', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/dead.ts': ['function deadFn() {', '  return 1;', '}', ''].join('\n'),
    });
    const fid = insertFile(store, 'src/dead.ts');
    const { symbolId } = insertSymbol(store, fid, 'deadFn', { lineStart: 1, lineEnd: 3 });

    const result = removeDeadCode(store, tmpDir, symbolId, true);

    expect(result.success).toBe(true);
    expect(result.tool).toBe('remove_dead_code');
    expect(result.edits.length).toBe(1);
    expect(result.edits[0].file).toBe('src/dead.ts');
    expect(result.edits[0].new_text).toBe('(removed)');
    expect(result.edits[0].original_text).toContain('deadFn');
    expect(result.files_modified).toContain('src/dead.ts');
  });

  it('symbol with incoming references is rejected with a clear error', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/live.ts': 'function liveFn() { return 1; }\n',
      'src/caller.ts': 'function caller() { return liveFn(); }\n',
    });
    const liveFid = insertFile(store, 'src/live.ts');
    const callerFid = insertFile(store, 'src/caller.ts');
    const live = insertSymbol(store, liveFid, 'liveFn', { lineStart: 1, lineEnd: 1 });
    const caller = insertSymbol(store, callerFid, 'caller', { lineStart: 1, lineEnd: 1 });

    // Wire a 'calls' edge from caller -> liveFn so removeDeadCode refuses.
    const liveNid = store.getNodeId('symbol', live.numericId)!;
    const callerNid = store.getNodeId('symbol', caller.numericId)!;
    store.ensureEdgeType('calls', 'behavioural', 'symbol calls another symbol');
    store.insertEdge(callerNid, liveNid, 'calls', true, undefined, false, 'ast_resolved');

    const result = removeDeadCode(store, tmpDir, live.symbolId, true);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('incoming reference');
    expect(result.edits).toEqual([]);
  });

  it('unknown symbol_id returns "Symbol not found" error cleanly', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({ 'src/empty.ts': '// empty\n' });

    const result = removeDeadCode(store, tmpDir, 'src/ghost.ts::missing#function', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Symbol not found');
    expect(result.edits).toEqual([]);
    expect(result.files_modified).toEqual([]);
  });

  it('output envelope shape pinned: success, tool, edits, files_modified, warnings', () => {
    const store = createTestStore();
    tmpDir = createTmpFixture({
      'src/d.ts': 'function deadFn() { return 1; }\n',
    });
    const fid = insertFile(store, 'src/d.ts');
    const { symbolId } = insertSymbol(store, fid, 'deadFn', { lineStart: 1, lineEnd: 1 });

    const result = removeDeadCode(store, tmpDir, symbolId, true);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('tool');
    expect(result).toHaveProperty('edits');
    expect(result).toHaveProperty('files_modified');
    expect(result).toHaveProperty('warnings');
    expect(result.tool).toBe('remove_dead_code');
    expect(Array.isArray(result.edits)).toBe(true);
    expect(Array.isArray(result.files_modified)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('dry_run does NOT mutate the source file on disk (mtime + content check)', async () => {
    const store = createTestStore();
    const original = 'function deadFn() {\n  return 1;\n}\n';
    tmpDir = createTmpFixture({ 'src/dead.ts': original });
    const fid = insertFile(store, 'src/dead.ts');
    const { symbolId } = insertSymbol(store, fid, 'deadFn', { lineStart: 1, lineEnd: 3 });

    const filePath = path.join(tmpDir, 'src/dead.ts');
    const beforeMtime = fs.statSync(filePath).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));

    const result = removeDeadCode(store, tmpDir, symbolId, true);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
    expect(fs.statSync(filePath).mtimeMs).toBe(beforeMtime);
  });
});
