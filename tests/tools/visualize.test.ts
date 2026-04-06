import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';
import { visualizeGraph, getDependencyDiagram } from '../../src/tools/analysis/visualize.js';

describe('visualizeGraph', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
    tmpDir = createTmpDir('viz-');

    // Create a small graph: files with symbols and edges
    const f1 = store.insertFile('src/auth.ts', 'typescript', 'h1', 200);
    const f2 = store.insertFile('src/user.ts', 'typescript', 'h2', 300);
    const f3 = store.insertFile('src/db.ts', 'typescript', 'h3', 150);
    const f4 = store.insertFile('lib/utils.ts', 'typescript', 'h4', 100);

    // Insert symbols
    const s1 = store.insertSymbol(f1, {
      symbolId: 'src/auth.ts::login#function', name: 'login', kind: 'function',
      fqn: 'login', byteStart: 0, byteEnd: 50, lineStart: 1, lineEnd: 5,
    });
    const s2 = store.insertSymbol(f2, {
      symbolId: 'src/user.ts::User#class', name: 'User', kind: 'class',
      fqn: 'User', byteStart: 0, byteEnd: 100, lineStart: 1, lineEnd: 20,
    });
    const s3 = store.insertSymbol(f3, {
      symbolId: 'src/db.ts::query#function', name: 'query', kind: 'function',
      fqn: 'query', byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 5,
    });

    // Create edges between files
    const n1 = store.getNodeId('file', f1)!;
    const n2 = store.getNodeId('file', f2)!;
    const n3 = store.getNodeId('file', f3)!;
    const n4 = store.getNodeId('file', f4)!;

    store.insertEdge(n1, n2, 'imports');
    store.insertEdge(n2, n3, 'imports');
    store.insertEdge(n1, n4, 'imports');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('generates HTML file for project scope', () => {
    const outputPath = path.join(tmpDir, 'graph.html');
    const result = visualizeGraph(store, {
      scope: 'project',
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.outputPath).toBe(outputPath);
    expect(data.nodes).toBeGreaterThan(0);
    expect(data.edges).toBeGreaterThan(0);
    expect(data.communities).toBeGreaterThan(0);

    // HTML file exists and contains D3 + data
    const html = fs.readFileSync(outputPath, 'utf-8');
    expect(html).toContain('d3.v7.min.js');
    expect(html).toContain('const DATA');
    expect(html).toContain('trace-mcp Graph');
  });

  it('generates HTML for directory scope', () => {
    const outputPath = path.join(tmpDir, 'graph-dir.html');
    const result = visualizeGraph(store, {
      scope: 'src/',
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.nodes).toBeGreaterThanOrEqual(3); // 3 files in src/
  });

  it('generates HTML for single file scope', () => {
    const outputPath = path.join(tmpDir, 'graph-file.html');
    const result = visualizeGraph(store, {
      scope: 'src/auth.ts',
      depth: 1,
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.nodes).toBeGreaterThanOrEqual(1);
  });

  it('returns error for empty scope result', () => {
    const result = visualizeGraph(store, {
      scope: 'nonexistent/',
      output: path.join(tmpDir, 'empty.html'),
    });

    expect(result.isErr()).toBe(true);
  });

  it('supports layout option', () => {
    const outputPath = path.join(tmpDir, 'graph-hier.html');
    const result = visualizeGraph(store, {
      scope: 'project',
      layout: 'hierarchical',
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
    const html = fs.readFileSync(outputPath, 'utf-8');
    expect(html).toContain('hierarchical');
  });

  it('supports colorBy option', () => {
    const outputPath = path.join(tmpDir, 'graph-lang.html');
    const result = visualizeGraph(store, {
      scope: 'project',
      colorBy: 'language',
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
  });

  it('detects communities', () => {
    const outputPath = path.join(tmpDir, 'graph-comm.html');
    const result = visualizeGraph(store, {
      scope: 'project',
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.communities).toBeGreaterThanOrEqual(1);
  });

  it('does not crash with many nodes', () => {
    // Insert 200 files
    for (let i = 0; i < 200; i++) {
      store.insertFile(`gen/file${i}.ts`, 'typescript', `hg${i}`, 50);
    }

    const outputPath = path.join(tmpDir, 'graph-large.html');
    const result = visualizeGraph(store, {
      scope: 'project',
      depth: 1,
      output: outputPath,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    // Should have capped at reasonable number
    expect(data.nodes).toBeLessThanOrEqual(600);
  });
});

describe('getDependencyDiagram', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();

    const f1 = store.insertFile('src/auth.ts', 'typescript', 'h1', 200);
    const f2 = store.insertFile('src/user.ts', 'typescript', 'h2', 300);

    store.insertSymbol(f1, {
      symbolId: 'src/auth.ts::login#function', name: 'login', kind: 'function',
      byteStart: 0, byteEnd: 50, lineStart: 1, lineEnd: 5,
    });
    store.insertSymbol(f2, {
      symbolId: 'src/user.ts::User#class', name: 'User', kind: 'class',
      byteStart: 0, byteEnd: 100, lineStart: 1, lineEnd: 20,
    });

    const n1 = store.getNodeId('file', f1)!;
    const n2 = store.getNodeId('file', f2)!;
    store.insertEdge(n1, n2, 'imports');
  });

  it('generates Mermaid diagram', () => {
    const result = getDependencyDiagram(store, {
      scope: 'project',
      format: 'mermaid',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.format).toBe('mermaid');
    expect(data.diagram).toContain('graph LR');
    expect(data.nodes).toBeGreaterThan(0);
  });

  it('generates DOT diagram', () => {
    const result = getDependencyDiagram(store, {
      scope: 'project',
      format: 'dot',
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.format).toBe('dot');
    expect(data.diagram).toContain('digraph G');
  });

  it('respects maxNodes limit', () => {
    // Add many files
    for (let i = 0; i < 50; i++) {
      store.insertFile(`gen/file${i}.ts`, 'typescript', `hg${i}`, 50);
    }

    const result = getDependencyDiagram(store, {
      scope: 'project',
      maxNodes: 5,
    });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.nodes).toBeLessThanOrEqual(5);
  });
});
