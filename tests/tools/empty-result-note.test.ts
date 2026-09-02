import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { findReferences } from '../../src/tools/framework/references.js';
import {
  buildEmptyResultNote,
  callEdgeResolution,
  EMPTY_RESULT_NOTE_MAX_LEN,
} from '../../src/tools/shared/empty-note.js';
import { createTestStore, createTmpDir } from '../test-utils.js';

/**
 * Add a file that really exists on disk (so freshness resolves to 'fresh')
 * plus a symbol in it, and return the graph node id of the symbol.
 */
function addSymbol(
  store: Store,
  root: string,
  relPath: string,
  language: string,
  name: string,
): number {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, `// ${name}\n`);
  const existing = store.getFile(relPath);
  const fileId =
    existing?.id ??
    store.insertFile(relPath, language, null, null, null, Math.floor(fs.statSync(abs).mtimeMs));
  const symbolDbId = store.insertSymbol(fileId, {
    symbolId: `${relPath}::${name}#function`,
    name,
    kind: 'function' as never,
    byteStart: 0,
    byteEnd: 10,
    lineStart: 1,
    lineEnd: 2,
  });
  return store.getNodeId('symbol', symbolDbId)!;
}

/** Wire `count` call edges into the store, `resolvedCount` of them at a resolved tier. */
function addCallEdges(
  store: Store,
  root: string,
  language: string,
  ext: string,
  count: number,
  resolvedCount: number,
): void {
  const sink = addSymbol(store, root, `src/sink${ext}`, language, 'sink');
  for (let i = 0; i < count; i++) {
    const src = addSymbol(store, root, `src/caller${i}${ext}`, language, `caller${i}`);
    store.insertEdge(
      src,
      sink,
      'calls',
      true,
      undefined,
      false,
      i < resolvedCount ? 'ast_resolved' : 'text_matched',
    );
  }
}

describe('empty-result note', () => {
  let store: Store;
  let root: string;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    store.ensureEdgeType('references', 'code', 'Symbol references');
    root = createTmpDir('trace-mcp-empty-note-');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('emits no caveat for a language whose call edges resolve well', () => {
    addCallEdges(store, root, 'typescript', '.ts', 40, 40);
    const target = 'src/lonely.ts';
    addSymbol(store, root, target, 'typescript', 'lonely');

    expect(buildEmptyResultNote(store, root, target)).toBeUndefined();
  });

  it('emits a caveat for a language whose call edges mostly do not resolve', () => {
    addCallEdges(store, root, 'ruby', '.rb', 40, 4);
    const target = 'src/lonely.rb';
    addSymbol(store, root, target, 'ruby', 'lonely');

    const note = buildEmptyResultNote(store, root, target);
    expect(note).toBeDefined();
    // Derived from the stored tiers, not from a hand-written list of languages.
    expect(note).toContain('10%');
    expect(note).toContain('ruby');
  });

  it('is scoped per language — a weak neighbour does not taint a strong one', () => {
    addCallEdges(store, root, 'ruby', '.rb', 40, 0);
    addCallEdges(store, root, 'typescript', '.ts', 40, 40);
    addSymbol(store, root, 'src/lonely.ts', 'typescript', 'lonely');
    addSymbol(store, root, 'src/lonely.rb', 'ruby', 'lonely');

    expect(buildEmptyResultNote(store, root, 'src/lonely.ts')).toBeUndefined();
    expect(buildEmptyResultNote(store, root, 'src/lonely.rb')).toBeDefined();
  });

  it('flags a language with no call edges indexed at all', () => {
    addCallEdges(store, root, 'typescript', '.ts', 40, 40);
    addSymbol(store, root, 'src/lonely.go', 'go', 'Lonely');

    expect(buildEmptyResultNote(store, root, 'src/lonely.go')).toContain('No go call edges');
  });

  it('flags a target that was never indexed', () => {
    expect(buildEmptyResultNote(store, root, 'src/ghost.ts')).toContain('not in the index');
  });

  it('flags an index that is behind the working tree', () => {
    addCallEdges(store, root, 'typescript', '.ts', 40, 40);
    const target = 'src/edited.ts';
    addSymbol(store, root, target, 'typescript', 'edited');
    const abs = path.join(root, target);
    const future = Date.now() + 60_000;
    fs.utimesSync(abs, future / 1000, future / 1000);

    expect(buildEmptyResultNote(store, root, target)).toContain('Index is behind');
  });

  it('never exceeds the note budget, even for a long path', () => {
    const longPath = `src/${'nested/'.repeat(40)}deep.rb`;
    addCallEdges(store, root, 'ruby', '.rb', 40, 0);
    addSymbol(store, root, longPath, 'ruby', 'deep');

    const note = buildEmptyResultNote(store, root, longPath)!;
    expect(note.length).toBeLessThanOrEqual(EMPTY_RESULT_NOTE_MAX_LEN);
  });

  it('leaves non-empty responses byte-identical', () => {
    addCallEdges(store, root, 'ruby', '.rb', 40, 0);
    const before = JSON.stringify(
      findReferences(store, { symbolId: 'src/sink.rb::sink#function' })._unsafeUnwrap(),
    );

    const result = findReferences(store, { symbolId: 'src/sink.rb::sink#function' });
    const value = result._unsafeUnwrap();
    expect(value.total).toBeGreaterThan(0);
    expect(JSON.stringify(value)).toBe(before);
    expect(Object.keys(value)).not.toContain('empty_result_note');
  });

  it('reports the resolved share it derived the note from', () => {
    addCallEdges(store, root, 'ruby', '.rb', 10, 3);
    expect(callEdgeResolution(store, 'ruby')).toEqual({ total: 10, resolved: 3, share: 0.3 });
  });
});
