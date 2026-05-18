/**
 * Regression tests for P1-2: get_dead_code / get_dead_exports false positives.
 *
 * Bug 1 — intra-file usage missed:
 *   `export const CANARY_PATH = ...; function foo(p = CANARY_PATH) { ... }`
 *   was flagged dead with confidence 1 because the indexer didn't emit a
 *   `calls`/`references` edge for the default-arg use. The intra-file usage
 *   signal now reads the file directly when projectRoot is provided.
 *
 * Bug 2 — framework entry points flagged at confidence 1:
 *   VSCode `activate`/`deactivate`, React root `App`, Next.js route loaders,
 *   electron main entries, package.json bin/main targets — all surfaced at
 *   confidence 1 despite being framework-discovered. They now get a
 *   confidence multiplier in [0.3, 0.5] so they drop below the default
 *   threshold of 0.5.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getDeadCodeV2 } from '../../src/tools/refactoring/dead-code.js';
import { createTestStore } from '../test-utils.js';

function insertFile(store: Store, filePath: string, lang = 'typescript', size = 200): number {
  return store.insertFile(filePath, lang, `hash_${filePath}`, size);
}

function insertExportedSymbol(
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
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind: opts.kind ?? 'function',
    byteStart: 0,
    byteEnd: 100,
    lineStart: opts.lineStart,
    lineEnd: opts.lineEnd,
    metadata: { exported: true, ...(opts.metadata ?? {}) },
  });
}

describe('getDeadCodeV2 — intra-file usage signal (P1-2 bug 1)', () => {
  let store: Store;
  let tmpRoot: string;

  beforeEach(() => {
    store = createTestStore();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-dead-intra-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('does NOT flag a symbol used as a default-arg value in the same file', () => {
    // Mirror src/runtime/embedding-drift.ts:
    //   line 23  →  export const CANARY_PATH = ...
    //   line 102 →  const file = opts.filePath ?? CANARY_PATH;
    // The indexer doesn't emit a calls/references edge for default-arg use,
    // so before this fix CANARY_PATH surfaced at confidence 1.
    const rel = 'src/runtime/embedding-drift.ts';
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      [
        '// header',
        'import path from "node:path";',
        '',
        'export const CANARY_PATH = path.join("/tmp", "canary.json");',
        '',
        'export async function checkEmbeddingDrift(opts: { filePath?: string } = {}) {',
        '  const file = opts.filePath ?? CANARY_PATH;',
        '  return file;',
        '}',
        '',
      ].join('\n'),
    );

    const fId = insertFile(store, rel);
    insertExportedSymbol(store, fId, 'CANARY_PATH', {
      kind: 'variable',
      lineStart: 4,
      lineEnd: 4,
    });

    const result = getDeadCodeV2(store, { projectRoot: tmpRoot });
    const hit = result.dead_symbols.find((s) => s.name === 'CANARY_PATH');
    expect(hit, 'CANARY_PATH is used as a default arg in the same file — must not be dead').toBe(
      undefined,
    );
  });

  it('still flags a genuinely-unused export when only its declaration line mentions the name', () => {
    const rel = 'src/lib.ts';
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      ['// nothing else references trulyDead', 'export const trulyDead = 42;', ''].join('\n'),
    );
    const fId = insertFile(store, rel);
    insertExportedSymbol(store, fId, 'trulyDead', { kind: 'variable', lineStart: 2, lineEnd: 2 });

    const result = getDeadCodeV2(store, { projectRoot: tmpRoot });
    const hit = result.dead_symbols.find((s) => s.name === 'trulyDead');
    expect(hit, 'trulyDead is genuinely dead and must still be reported').toBeDefined();
  });

  it('emits an intra-file rescue warning when at least one symbol is saved', () => {
    const rel = 'src/util.ts';
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      ['export const HELPER = 1;', 'function uses() { return HELPER + 1; }', ''].join('\n'),
    );
    const fId = insertFile(store, rel);
    insertExportedSymbol(store, fId, 'HELPER', { kind: 'variable', lineStart: 1, lineEnd: 1 });

    const result = getDeadCodeV2(store, { projectRoot: tmpRoot });
    expect(result._warnings?.some((w) => /intra-file usage signal rescued/i.test(w))).toBe(true);
  });

  it('ignores matches that live inside comments (cheap docblock filter)', () => {
    const rel = 'src/commented.ts';
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      [
        '// This file mentions ONLY_IN_COMMENT in a comment.',
        '// Another reference: ONLY_IN_COMMENT',
        'export const ONLY_IN_COMMENT = 42;',
        '',
      ].join('\n'),
    );
    const fId = insertFile(store, rel);
    insertExportedSymbol(store, fId, 'ONLY_IN_COMMENT', {
      kind: 'variable',
      lineStart: 3,
      lineEnd: 3,
    });

    const result = getDeadCodeV2(store, { projectRoot: tmpRoot });
    const hit = result.dead_symbols.find((s) => s.name === 'ONLY_IN_COMMENT');
    expect(hit, 'comment-only mentions must not count as intra-file usage').toBeDefined();
  });

  it('keeps historic 3-signal denominator when projectRoot is not supplied', () => {
    // Without projectRoot the intra-file signal cannot run; we should fall back
    // to the original 3-signal behavior so embedded callers (no projectRoot)
    // get the same confidence numbers they did before this fix.
    const fA = insertFile(store, 'src/a.ts');
    insertExportedSymbol(store, fA, 'fullyDead');

    const result = getDeadCodeV2(store); // no projectRoot
    expect(result.dead_symbols[0].confidence).toBe(1);
    // signals.intra_file_usage still serialized — defaults to true (no evidence)
    expect(result.dead_symbols[0].signals.intra_file_usage).toBe(true);
  });
});

describe('getDeadCodeV2 — framework entry-point downgrade (P1-2 bug 2)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('downgrades VSCode `activate` to confidence <= 0.4', () => {
    const fId = insertFile(store, 'packages/vscode-extension/src/extension.ts');
    insertExportedSymbol(store, fId, 'activate');

    const result = getDeadCodeV2(store, { threshold: 0 });
    const hit = result.dead_symbols.find((s) => s.name === 'activate');
    expect(hit, 'activate should be present with a downgraded score').toBeDefined();
    expect(hit!.confidence).toBeLessThanOrEqual(0.4);
    expect(hit!.signals.entry_point_multiplier).toBeLessThan(1);
    expect(hit!.signals.entry_point_reason).toMatch(/vscode|entry_point_name|package_json/i);
  });

  it('downgrades VSCode `deactivate` symmetrically with `activate`', () => {
    const fId = insertFile(store, 'packages/vscode-extension/src/extension.ts');
    insertExportedSymbol(store, fId, 'deactivate');

    const result = getDeactivateConfidence();
    expect(result.hit, 'deactivate should be present with a downgraded score').toBeDefined();
    expect(result.hit!.confidence).toBeLessThanOrEqual(0.4);

    function getDeactivateConfidence() {
      const r = getDeadCodeV2(store, { threshold: 0 });
      return { hit: r.dead_symbols.find((s) => s.name === 'deactivate') };
    }
  });

  it('hides `activate` from the default threshold (>= 0.5) entirely', () => {
    const fId = insertFile(store, 'packages/vscode-extension/src/extension.ts');
    insertExportedSymbol(store, fId, 'activate');

    const result = getDeadCodeV2(store); // default threshold 0.5
    expect(result.dead_symbols.find((s) => s.name === 'activate')).toBeUndefined();
  });

  it('downgrades React App in packages/app/src/renderer/App.tsx', () => {
    const fId = insertFile(store, 'packages/app/src/renderer/App.tsx', 'tsx');
    insertExportedSymbol(store, fId, 'App', { kind: 'function' });

    const result = getDeadCodeV2(store, { threshold: 0 });
    const hit = result.dead_symbols.find((s) => s.name === 'App');
    expect(hit, 'App should appear with a downgraded score').toBeDefined();
    expect(hit!.confidence).toBeLessThanOrEqual(0.5);
    expect(hit!.signals.entry_point_reason).toMatch(/app_root|react_app_root|entry_point_name/i);
  });

  it('does NOT report React App when import edge from main.tsx is present', () => {
    // Real-world: packages/app/src/renderer/main.tsx imports App from App.tsx.
    // call_graph signal flips to false (notReferenced=false → hard skip).
    const fApp = insertFile(store, 'packages/app/src/renderer/App.tsx', 'tsx');
    const fMain = insertFile(store, 'packages/app/src/renderer/main.tsx', 'tsx');
    const appSymId = insertExportedSymbol(store, fApp, 'App');
    const appNode = store.getNodeId('symbol', appSymId)!;
    const callerSymId = store.insertSymbol(fMain, {
      symbolId: 'sym:main',
      name: 'main',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
    });
    const callerNode = store.getNodeId('symbol', callerSymId)!;
    store.insertEdge(callerNode, appNode, 'calls', true);

    const result = getDeadCodeV2(store);
    expect(result.dead_symbols.find((s) => s.name === 'App')).toBeUndefined();
  });

  it('downgrades Next.js route loader/action exports', () => {
    const fId = insertFile(store, 'app/users/[id]/page.tsx', 'tsx');
    insertExportedSymbol(store, fId, 'generateMetadata');

    const result = getDeadCodeV2(store, { threshold: 0 });
    const hit = result.dead_symbols.find((s) => s.name === 'generateMetadata');
    expect(
      hit,
      'generateMetadata in app router should appear with a downgraded score',
    ).toBeDefined();
    expect(hit!.confidence).toBeLessThanOrEqual(0.5);
  });

  it('downgrades serverless handler files', () => {
    const fId = insertFile(store, 'lambdas/user-create.ts');
    insertExportedSymbol(store, fId, 'handler');

    const result = getDeadCodeV2(store, { threshold: 0 });
    const hit = result.dead_symbols.find((s) => s.name === 'handler');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeLessThanOrEqual(0.4);
    expect(hit!.signals.entry_point_reason).toMatch(/serverless_handler|entry_point_name/i);
  });

  it('downgrades package.json main/bin targets via projectRoot', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-dead-pkg-'));
    try {
      fs.writeFileSync(
        path.join(tmpRoot, 'package.json'),
        JSON.stringify({
          name: 'demo',
          main: 'dist/index.js',
          bin: { 'demo-cli': 'dist/cli.js' },
        }),
      );

      const fId = insertFile(store, 'dist/cli.js', 'javascript');
      insertExportedSymbol(store, fId, 'run');

      const result = getDeadCodeV2(store, { threshold: 0, projectRoot: tmpRoot });
      const hit = result.dead_symbols.find((s) => s.name === 'run');
      expect(hit).toBeDefined();
      expect(hit!.signals.entry_point_reason).toBe('package_json_entry');
      expect(hit!.confidence).toBeLessThanOrEqual(0.4);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits an entry-point downgrade warning summarising the count', () => {
    insertExportedSymbol(store, insertFile(store, 'src/extension.ts'), 'activate');
    insertExportedSymbol(store, insertFile(store, 'lambdas/h.ts'), 'handler');

    const result = getDeadCodeV2(store, { threshold: 0 });
    expect(result._warnings?.some((w) => /entry points/i.test(w) && /downgraded/i.test(w))).toBe(
      true,
    );
  });

  it('leaves ordinary symbols at multiplier 1.0 with no entry-point reason', () => {
    const fId = insertFile(store, 'src/utils/random-helper.ts');
    insertExportedSymbol(store, fId, 'randomHelper');

    const result = getDeadCodeV2(store);
    const hit = result.dead_symbols.find((s) => s.name === 'randomHelper');
    expect(hit).toBeDefined();
    expect(hit!.signals.entry_point_multiplier).toBe(1);
    expect(hit!.signals.entry_point_reason).toBeNull();
    expect(hit!.confidence).toBe(1);
  });
});
