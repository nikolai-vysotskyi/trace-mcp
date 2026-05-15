/**
 * Behavioural coverage for `visualizeGraph()` (the `visualize_graph` MCP tool).
 * The existing tests/tools/visualize.test.ts covers happy-path HTML rendering.
 * This file pins the caller-facing contract:
 *
 *  - writing the HTML file at the requested `output` path (file exists, non-empty)
 *  - granularity='file' vs 'symbol' produces different node counts on the same
 *    seeded graph
 *  - maxFiles caps file-granularity seed input (no more than the cap on the file
 *    side of the graph)
 *  - layout='hierarchical'/'force'/'radial' all return a string outputPath and
 *    write a non-empty HTML file
 *  - output envelope shape pinned: { outputPath, nodes, edges, communities }
 *  - empty/unindexed scope returns Err — not a thrown exception
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { visualizeGraph } from '../../../src/tools/analysis/visualize.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../../test-utils.js';

function seedGraph(store: Store): void {
  // Three files in src/, each with 2 symbols, wired with file→file imports.
  const f1 = store.insertFile('src/auth.ts', 'typescript', 'h1', 200);
  const f2 = store.insertFile('src/user.ts', 'typescript', 'h2', 300);
  const f3 = store.insertFile('src/db.ts', 'typescript', 'h3', 150);

  const symbols = [
    { fid: f1, name: 'login', kind: 'function' },
    { fid: f1, name: 'logout', kind: 'function' },
    { fid: f2, name: 'User', kind: 'class' },
    { fid: f2, name: 'Admin', kind: 'class' },
    { fid: f3, name: 'query', kind: 'function' },
    { fid: f3, name: 'connect', kind: 'function' },
  ];
  for (const s of symbols) {
    const file = store.getFileById(s.fid)!;
    store.insertSymbol(s.fid, {
      symbolId: `${file.path}::${s.name}#${s.kind}`,
      name: s.name,
      kind: s.kind,
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 5,
    } as never);
  }

  const n1 = store.getNodeId('file', f1)!;
  const n2 = store.getNodeId('file', f2)!;
  const n3 = store.getNodeId('file', f3)!;
  store.insertEdge(n1, n2, 'imports');
  store.insertEdge(n2, n3, 'imports');
  store.insertEdge(n1, n3, 'imports');
}

describe('visualizeGraph() — behavioural contract', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
    tmpDir = createTmpDir('viz-behav-');
    seedGraph(store);
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('writes an HTML file at the requested output path with non-empty content', () => {
    const outputPath = path.join(tmpDir, 'out.html');
    const result = visualizeGraph(store, { scope: 'project', output: outputPath });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    const html = fs.readFileSync(outputPath, 'utf-8');
    expect(html.length).toBeGreaterThan(100);
    // Should look like an HTML document.
    expect(html.toLowerCase()).toContain('<html');
  });

  it('output envelope shape pinned: { outputPath, nodes, edges, communities }', () => {
    const outputPath = path.join(tmpDir, 'shape.html');
    const result = visualizeGraph(store, { scope: 'project', output: outputPath });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data).toHaveProperty('outputPath');
    expect(data).toHaveProperty('nodes');
    expect(data).toHaveProperty('edges');
    expect(data).toHaveProperty('communities');
    expect(typeof data.outputPath).toBe('string');
    expect(typeof data.nodes).toBe('number');
    expect(typeof data.edges).toBe('number');
    expect(typeof data.communities).toBe('number');
  });

  it('granularity="file" vs "symbol" produces different node counts on the same graph', () => {
    const fileOut = path.join(tmpDir, 'file.html');
    const symbolOut = path.join(tmpDir, 'symbol.html');

    const fileResult = visualizeGraph(store, {
      scope: 'project',
      granularity: 'file',
      output: fileOut,
    });
    const symbolResult = visualizeGraph(store, {
      scope: 'project',
      granularity: 'symbol',
      output: symbolOut,
    });

    expect(fileResult.isOk()).toBe(true);
    expect(symbolResult.isOk()).toBe(true);
    const fileData = fileResult._unsafeUnwrap();
    const symbolData = symbolResult._unsafeUnwrap();
    // The seed has 3 files and 6 symbols — node counts must differ.
    expect(fileData.nodes).not.toBe(symbolData.nodes);
  });

  it('layout="hierarchical"/"force"/"radial" all return a string outputPath + non-empty HTML', () => {
    for (const layout of ['hierarchical', 'force', 'radial'] as const) {
      const outputPath = path.join(tmpDir, `layout-${layout}.html`);
      const result = visualizeGraph(store, {
        scope: 'project',
        layout,
        output: outputPath,
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(typeof data.outputPath).toBe('string');
      expect(fs.existsSync(outputPath)).toBe(true);
      expect(fs.readFileSync(outputPath, 'utf-8').length).toBeGreaterThan(100);
    }
  });

  it('maxFiles caps the file-granularity seed input', () => {
    // Add lots more files to make the cap meaningful.
    for (let i = 0; i < 50; i++) {
      store.insertFile(`extra/file${i}.ts`, 'typescript', `he${i}`, 50);
    }
    const cappedOut = path.join(tmpDir, 'capped.html');
    const uncappedOut = path.join(tmpDir, 'uncapped.html');

    const capped = visualizeGraph(store, {
      scope: 'project',
      granularity: 'file',
      maxFiles: 5,
      output: cappedOut,
    });
    const uncapped = visualizeGraph(store, {
      scope: 'project',
      granularity: 'file',
      output: uncappedOut,
    });

    expect(capped.isOk()).toBe(true);
    expect(uncapped.isOk()).toBe(true);
    // Capped run should have fewer or equal nodes; explicitly more than 5 is fine
    // since the cap is on *seed* files, but the cap must keep things smaller than
    // the uncapped run when extras exist.
    expect(capped._unsafeUnwrap().nodes).toBeLessThan(uncapped._unsafeUnwrap().nodes);
  });

  it('empty / unindexed scope returns Err — not a thrown exception', () => {
    const result = visualizeGraph(store, {
      scope: 'nonexistent-directory/',
      output: path.join(tmpDir, 'empty.html'),
    });
    expect(result.isErr()).toBe(true);
  });
});
