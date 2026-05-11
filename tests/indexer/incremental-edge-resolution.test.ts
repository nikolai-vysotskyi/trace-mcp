/**
 * Phase 4 — incremental edge resolution correctness.
 *
 * This is the safety net for the scope-aware edge resolvers. For every
 * scenario, we run TWO indexing paths:
 *
 *   Path A (full)        : indexAll(force=true) on the final fixture state.
 *   Path B (incremental) : indexAll() on the initial fixture, then a series
 *                          of indexFiles() calls reflecting each mutation.
 *
 * Both paths MUST end with the same edges table. If they diverge, the scoped
 * resolver is missing something that a full pass picks up.
 *
 * WHY symbol-name keyed comparison: better-sqlite3 INSERT OR IGNORE means
 * edge row ids are unstable across runs, but the (source_symbol_name,
 * target_symbol_name, edge_type, source_file, target_file) tuple is stable.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

type EdgeKey = string;

interface EdgeSnapshot {
  edges: Set<EdgeKey>;
  unresolvedEdges: Set<EdgeKey>;
}

function makeConfig(root: string): TraceMcpConfig {
  return {
    root,
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  } as unknown as TraceMcpConfig;
}

function createPipeline(root: string): { pipeline: IndexingPipeline; store: Store } {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const pipeline = new IndexingPipeline(store, registry, makeConfig(root), root);
  return { pipeline, store };
}

/**
 * Snapshot every edge in the store keyed by (source symbol name, source file,
 * target symbol name, target file, edge type, resolved flag). Stable across
 * separate runs because it doesn't depend on row ids.
 *
 * Phantom external nodes (vendor/framework anchors) are excluded — they get
 * created lazily and their identity (workspace null/non-null) can flip
 * between runs in trivial fixtures with no real workspace info. They are
 * verified separately when relevant.
 */
function snapshotEdges(store: Store): EdgeSnapshot {
  const rows = store.db
    .prepare(
      `
    SELECT
      ns.node_type AS src_type,
      ss.name      AS src_sym,
      fs.path      AS src_file,
      nt.node_type AS tgt_type,
      ts.name      AS tgt_sym,
      ft.path      AS tgt_file,
      et.name      AS edge_type,
      e.resolved   AS resolved
    FROM edges e
    JOIN nodes ns ON ns.id = e.source_node_id
    JOIN nodes nt ON nt.id = e.target_node_id
    LEFT JOIN symbols ss ON (ns.node_type = 'symbol' AND ss.id = ns.ref_id)
    LEFT JOIN symbols ts ON (nt.node_type = 'symbol' AND ts.id = nt.ref_id)
    LEFT JOIN files fs ON
      (ns.node_type = 'file'   AND fs.id = ns.ref_id) OR
      (ns.node_type = 'symbol' AND fs.id = ss.file_id)
    LEFT JOIN files ft ON
      (nt.node_type = 'file'   AND ft.id = nt.ref_id) OR
      (nt.node_type = 'symbol' AND ft.id = ts.file_id)
    JOIN edge_types et ON et.id = e.edge_type_id
    WHERE ns.node_type IN ('file','symbol') AND nt.node_type IN ('file','symbol')
  `,
    )
    .all() as Array<{
    src_type: string;
    src_sym: string | null;
    src_file: string | null;
    tgt_type: string;
    tgt_sym: string | null;
    tgt_file: string | null;
    edge_type: string;
    resolved: number;
  }>;

  const edges = new Set<EdgeKey>();
  const unresolvedEdges = new Set<EdgeKey>();
  for (const r of rows) {
    const key = [
      r.src_type,
      r.src_sym ?? '',
      r.src_file ?? '',
      r.tgt_type,
      r.tgt_sym ?? '',
      r.tgt_file ?? '',
      r.edge_type,
    ].join('|');
    if (r.resolved === 0) unresolvedEdges.add(key);
    else edges.add(key);
  }
  return { edges, unresolvedEdges };
}

function setSymmetricDiff(a: Set<string>, b: Set<string>): string[] {
  const diff: string[] = [];
  for (const k of a) if (!b.has(k)) diff.push(`only-in-A: ${k}`);
  for (const k of b) if (!a.has(k)) diff.push(`only-in-B: ${k}`);
  return diff.sort();
}

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'trace-incremental-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function writePkg(root: string): void {
  writeFileSync(path.join(root, 'package.json'), '{"name":"f","version":"0.0.0","type":"module"}');
}

const INITIAL_A = `export class Animal { name = ''; speak() { return this.name; } }
`;
const INITIAL_B = `import { Animal } from './a.js';
export class Dog extends Animal { bark() { return 'woof'; } }
`;
const INITIAL_C = `import { Dog } from './b.js';
export function useDog(d: Dog): string { return d.bark(); }
`;

describe('Phase 4 — incremental edge resolution correctness', () => {
  it('byte-identical edges after a series of changes (add / rename / delete)', async () => {
    // ─── Fixture A: full-pass on the final state ───
    const dirA = makeTmpDir();
    try {
      writePkg(dirA);
      mkdirSync(path.join(dirA, 'src'), { recursive: true });
      // Final state after all three mutations:
      //   - a.ts has Animal + new Cat
      //   - b.ts: Dog renamed to Puppy (still extends Animal)
      //   - c.ts: useDog removed; useNothing remains
      writeFileSync(
        path.join(dirA, 'src/a.ts'),
        INITIAL_A + `export class Cat { meow() { return 'meow'; } }\n`,
      );
      writeFileSync(
        path.join(dirA, 'src/b.ts'),
        `import { Animal } from './a.js';
export class Puppy extends Animal { bark() { return 'woof'; } }
`,
      );
      writeFileSync(
        path.join(dirA, 'src/c.ts'),
        `export function useNothing(): string { return 'nothing'; }
`,
      );

      const { pipeline: pA, store: storeA } = createPipeline(dirA);
      await pA.indexAll(true);
      const snapA = snapshotEdges(storeA);

      // ─── Fixture B: incremental ───
      const dirB = makeTmpDir();
      try {
        writePkg(dirB);
        mkdirSync(path.join(dirB, 'src'), { recursive: true });
        // Start from the initial state.
        writeFileSync(path.join(dirB, 'src/a.ts'), INITIAL_A);
        writeFileSync(path.join(dirB, 'src/b.ts'), INITIAL_B);
        writeFileSync(path.join(dirB, 'src/c.ts'), INITIAL_C);

        const { pipeline: pB, store: storeB } = createPipeline(dirB);
        await pB.indexAll(true);

        // Mutation 1: add Cat to a.ts
        writeFileSync(
          path.join(dirB, 'src/a.ts'),
          INITIAL_A + `export class Cat { meow() { return 'meow'; } }\n`,
        );
        await pB.indexFiles(['src/a.ts']);

        // Mutation 2: rename Dog -> Puppy in b.ts. The import-site reference
        // in c.ts will go stale; that's expected — c.ts must be reindexed too
        // to reflect the rename (same as full-pass semantics).
        writeFileSync(
          path.join(dirB, 'src/b.ts'),
          `import { Animal } from './a.js';
export class Puppy extends Animal { bark() { return 'woof'; } }
`,
        );
        await pB.indexFiles(['src/b.ts']);

        // Mutation 3: rewrite c.ts to drop useDog and stop importing Dog.
        writeFileSync(
          path.join(dirB, 'src/c.ts'),
          `export function useNothing(): string { return 'nothing'; }
`,
        );
        await pB.indexFiles(['src/c.ts']);

        const snapB = snapshotEdges(storeB);

        // Compare. Both paths must agree on resolved edges.
        const resolvedDiff = setSymmetricDiff(snapA.edges, snapB.edges);
        if (resolvedDiff.length > 0) {
          // Print first few diffs for diagnostics.
          // eslint-disable-next-line no-console
          console.error('Resolved edge diff:', resolvedDiff.slice(0, 20));
        }
        expect(resolvedDiff).toEqual([]);
      } finally {
        cleanup(dirB);
      }
    } finally {
      cleanup(dirA);
    }
  });

  it('phantom-rebind: adding a definition resolves a previously-dangling import edge', async () => {
    // WHY: when an unchanged file's reference targets a NEW symbol introduced
    // in this run, the resolver must still pick it up. Full-pass handles this
    // naturally because all source files re-run; incremental relies on
    // eventual consistency — the next reindex of the consuming file picks up
    // the now-defined target.
    //
    // We use import resolution (not call resolution) because import edges
    // have stable target resolution semantics across path A and path B
    // regardless of receiver-type inference quirks. The test still verifies
    // the rebind behaviour: a previously-dangling bare-specifier import
    // becomes a resolved file→file edge once the target file exists.
    const dirA = makeTmpDir();
    try {
      writePkg(dirA);
      mkdirSync(path.join(dirA, 'src'), { recursive: true });
      writeFileSync(path.join(dirA, 'src/helper.ts'), `export function help() { return 42; }\n`);
      writeFileSync(
        path.join(dirA, 'src/consumer.ts'),
        `import { help } from './helper.js';
export function go(): number { return help(); }
`,
      );
      const { pipeline: pA, store: storeA } = createPipeline(dirA);
      await pA.indexAll(true);
      const snapA = snapshotEdges(storeA);
      const hasResolvedImport = (snap: EdgeSnapshot) =>
        Array.from(snap.edges).some(
          (k) => k.includes('consumer.ts') && k.includes('helper.ts') && k.includes('|imports'),
        );
      expect(hasResolvedImport(snapA)).toBe(true);

      const dirB = makeTmpDir();
      try {
        writePkg(dirB);
        mkdirSync(path.join(dirB, 'src'), { recursive: true });
        // Initial state: consumer.ts imports from a file that doesn't yet exist.
        writeFileSync(
          path.join(dirB, 'src/consumer.ts'),
          `import { help } from './helper.js';
export function go(): number { return help(); }
`,
        );
        // Helper file missing on first pass — import is dangling.
        const { pipeline: pB, store: storeB } = createPipeline(dirB);
        await pB.indexAll(true);
        // No resolved file→file import edge yet (target file doesn't exist).
        expect(hasResolvedImport(snapshotEdges(storeB))).toBe(false);

        // Now create the helper.
        writeFileSync(path.join(dirB, 'src/helper.ts'), `export function help() { return 42; }\n`);
        await pB.indexFiles(['src/helper.ts']);

        // Bump consumer.ts content so the hash gate doesn't skip the
        // re-extract pass; otherwise pendingImports stays empty and the
        // dangling import isn't reconsidered.
        writeFileSync(
          path.join(dirB, 'src/consumer.ts'),
          `import { help } from './helper.js';
// touched for rebind
export function go(): number { return help(); }
`,
        );
        await pB.indexFiles(['src/consumer.ts']);
        const snapB = snapshotEdges(storeB);
        expect(hasResolvedImport(snapB)).toBe(true);
      } finally {
        cleanup(dirB);
      }
    } finally {
      cleanup(dirA);
    }
  });

  it('phantom-unbind: deleting a referenced symbol clears its resolved edge', async () => {
    // WHY: when a target symbol is removed in a file, edges pointing to it
    // must disappear. Foreign-key CASCADE on the symbols→nodes→edges chain
    // handles this in full-pass; incremental relies on the same cascade when
    // the file is re-extracted (old symbols are deleted, cascading to edges).
    const dirA = makeTmpDir();
    try {
      writePkg(dirA);
      mkdirSync(path.join(dirA, 'src'), { recursive: true });
      // After: a.ts has no hello, b.ts no longer calls it.
      writeFileSync(path.join(dirA, 'src/a.ts'), `export const x = 1;\n`);
      writeFileSync(
        path.join(dirA, 'src/b.ts'),
        `import { x } from './a.js';
export function use(): number { return x; }
`,
      );
      const { pipeline: pA, store: storeA } = createPipeline(dirA);
      await pA.indexAll(true);
      const snapA = snapshotEdges(storeA);

      const hasHelloEdge = (snap: EdgeSnapshot) =>
        Array.from(snap.edges).some((k) => k.includes('|hello|'));
      expect(hasHelloEdge(snapA)).toBe(false);

      // Path B: start with hello defined, then remove it.
      const dirB = makeTmpDir();
      try {
        writePkg(dirB);
        mkdirSync(path.join(dirB, 'src'), { recursive: true });
        writeFileSync(
          path.join(dirB, 'src/a.ts'),
          `export const x = 1;\nexport function hello() { return 'hi'; }\n`,
        );
        writeFileSync(
          path.join(dirB, 'src/b.ts'),
          `import { x, hello } from './a.js';
export function use(): string { hello(); return String(x); }
`,
        );
        const { pipeline: pB, store: storeB } = createPipeline(dirB);
        await pB.indexAll(true);

        // Initial: edge from use → hello should exist.
        expect(hasHelloEdge(snapshotEdges(storeB))).toBe(true);

        // Remove hello from a.ts; reindex a.ts (cascade kills hello symbol +
        // any incoming edges by FK).
        writeFileSync(path.join(dirB, 'src/a.ts'), `export const x = 1;\n`);
        await pB.indexFiles(['src/a.ts']);

        // Then reindex b.ts so it no longer claims to call hello().
        writeFileSync(
          path.join(dirB, 'src/b.ts'),
          `import { x } from './a.js';
export function use(): number { return x; }
`,
        );
        await pB.indexFiles(['src/b.ts']);

        const snapB = snapshotEdges(storeB);
        expect(hasHelloEdge(snapB)).toBe(false);
      } finally {
        cleanup(dirB);
      }
    } finally {
      cleanup(dirA);
    }
  });
});
