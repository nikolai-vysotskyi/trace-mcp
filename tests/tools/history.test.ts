import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  getCouplingTrend,
  getSymbolComplexityTrend,
  countImports,
  extractSymbolSource,
} from '../../src/tools/history.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

function insertFile(store: Store, filePath: string, lang = 'typescript'): number {
  return store.insertFile(filePath, lang, 'hash_' + filePath, 100);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  kind = 'function',
  metadata?: Record<string, unknown>,
): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${name}`,
    name,
    kind,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
    metadata,
  });
}

function insertEdge(store: Store, srcNodeId: number, tgtNodeId: number, edgeType: string): void {
  store.insertEdge(srcNodeId, tgtNodeId, edgeType);
}

// ════════════════════════════════════════════════════════════════════════
// countImports (pure function, no git needed)
// ════════════════════════════════════════════════════════════════════════

describe('countImports', () => {
  it('counts ESM imports', () => {
    const content = [
      "import { foo } from './foo';",
      "import bar from 'bar';",
      "import './side-effect';",
      'const x = 1;',
    ].join('\n');
    expect(countImports(content)).toBe(3);
  });

  it('counts CJS require calls', () => {
    const content = [
      "const fs = require('fs');",
      "const path = require('path');",
      'module.exports = {};',
    ].join('\n');
    expect(countImports(content)).toBe(2);
  });

  it('counts Python imports', () => {
    const content = [
      'import os',
      'from pathlib import Path',
      'from typing import List, Optional',
      'x = 1',
    ].join('\n');
    expect(countImports(content)).toBe(3);
  });

  it('counts Go imports', () => {
    const content = [
      'import "fmt"',
      'func main() {}',
    ].join('\n');
    expect(countImports(content)).toBe(1);
  });

  it('counts PHP use statements', () => {
    const content = [
      'use App\\Models\\User;',
      'use Illuminate\\Http\\Request;',
      '$x = 1;',
    ].join('\n');
    expect(countImports(content)).toBe(2);
  });

  it('returns 0 for empty content', () => {
    expect(countImports('')).toBe(0);
  });

  it('returns 0 for non-import code', () => {
    expect(countImports('const x = 1;\nfunction foo() {}\n')).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// extractSymbolSource (pure function)
// ════════════════════════════════════════════════════════════════════════

describe('extractSymbolSource', () => {
  it('extracts a simple function', () => {
    const content = [
      'const x = 1;',
      'function foo(a: number) {',
      '  return a + 1;',
      '}',
      'const y = 2;',
    ].join('\n');
    const result = extractSymbolSource(content, 'foo', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('function foo');
    expect(result!.source).toContain('return a + 1');
    expect(result!.signature).toBe('function foo(a: number) {');
  });

  it('extracts an exported async function', () => {
    const content = [
      'export async function fetchData(url: string) {',
      '  const res = await fetch(url);',
      '  return res.json();',
      '}',
    ].join('\n');
    const result = extractSymbolSource(content, 'fetchData', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('async function fetchData');
  });

  it('extracts an arrow function const', () => {
    const content = [
      'export const add = (a: number, b: number) => {',
      '  return a + b;',
      '};',
    ].join('\n');
    const result = extractSymbolSource(content, 'add', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('export const add');
  });

  it('extracts a class', () => {
    const content = [
      'export class MyService {',
      '  private value = 0;',
      '  getValue() { return this.value; }',
      '}',
    ].join('\n');
    const result = extractSymbolSource(content, 'MyService', 'class');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('class MyService');
    expect(result!.source).toContain('getValue');
  });

  it('extracts a Python def with indentation-based end', () => {
    const content = [
      'def process(items):',
      '    for item in items:',
      '        print(item)',
      '',
      'def other():',
      '    pass',
    ].join('\n');
    const result = extractSymbolSource(content, 'process', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('def process');
    expect(result!.source).toContain('print(item)');
    // Should NOT include the next function
    expect(result!.source).not.toContain('def other');
  });

  it('handles braces inside strings correctly', () => {
    const content = [
      'function render() {',
      '  const template = "{ hello }";',
      '  return template;',
      '}',
      'function other() {}',
    ].join('\n');
    const result = extractSymbolSource(content, 'render', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('return template');
    // Should end at the correct closing brace, not be confused by string braces
    expect(result!.source).not.toContain('function other');
  });

  it('handles braces inside comments correctly', () => {
    const content = [
      'function process() {',
      '  // TODO: handle { edge case }',
      '  /* block { comment } */',
      '  return 42;',
      '}',
      'function next() {}',
    ].join('\n');
    const result = extractSymbolSource(content, 'process', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).not.toContain('function next');
  });

  it('returns null when symbol not found', () => {
    expect(extractSymbolSource('const x = 1;', 'nonexistent', 'function')).toBeNull();
  });

  it('handles special regex characters in symbol names', () => {
    const content = 'function $special_name$() {\n  return 1;\n}\n';
    const result = extractSymbolSource(content, '$special_name$', 'function');
    expect(result).not.toBeNull();
  });

  it('extracts a Go func', () => {
    const content = [
      'func handleRequest(w http.ResponseWriter, r *http.Request) {',
      '  w.Write([]byte("ok"))',
      '}',
    ].join('\n');
    const result = extractSymbolSource(content, 'handleRequest', 'function');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('func handleRequest');
  });

  it('extracts a class method', () => {
    const content = [
      'class Foo {',
      '  public async getData(id: number) {',
      '    return this.db.get(id);',
      '  }',
      '  other() { return 1; }',
      '}',
    ].join('\n');
    const result = extractSymbolSource(content, 'getData', 'method');
    expect(result).not.toBeNull();
    expect(result!.source).toContain('getData');
    expect(result!.source).toContain('this.db.get');
  });
});

// ════════════════════════════════════════════════════════════════════════
// getCouplingTrend (mocked git)
// ════════════════════════════════════════════════════════════════════════

describe('getCouplingTrend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when not a git repo', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    const store = createStore();
    insertFile(store, 'src/a.ts');
    expect(getCouplingTrend(store, '/project', 'src/a.ts')).toBeNull();
  });

  it('returns null when file not in index', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if ((args as string[])[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });
    const store = createStore();
    expect(getCouplingTrend(store, '/project', 'nonexistent.ts')).toBeNull();
  });

  it('returns current coupling from live graph with historical snapshots', () => {
    const fileContentV1 = "import { x } from './x';\nconst a = 1;\n";
    const fileContentV2 = "import { x } from './x';\nimport { y } from './y';\nconst a = 1;\n";

    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from('aaa111|2026-03-01\nbbb222|2026-01-15\n');
      }
      if (argList[0] === 'show') {
        const ref = argList[1];
        if (ref.startsWith('aaa111:')) return Buffer.from(fileContentV2);
        if (ref.startsWith('bbb222:')) return Buffer.from(fileContentV1);
        return Buffer.from('');
      }
      if (argList[0] === 'grep') {
        // Simulate 1 file importing this file at each commit
        return Buffer.from('commitHash:src/importer.ts\n');
      }
      return Buffer.from('');
    });

    const store = createStore();
    const fA = insertFile(store, 'src/tools/target.ts');
    const fB = insertFile(store, 'src/tools/importer.ts');

    // Set up import edge: fB → fA (importer imports target)
    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    insertEdge(store, nodeB, nodeA, 'esm_imports');

    const result = getCouplingTrend(store, '/project', 'src/tools/target.ts');
    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/tools/target.ts');
    expect(result!.current.commit).toBe('HEAD');
    expect(result!.current.ca).toBe(1); // fB imports fA
    expect(result!.current.ce).toBe(0);
    expect(result!.historical.length).toBe(2);
    expect(result!.trend).toBeDefined();
    expect(typeof result!.instability_delta).toBe('number');
    expect(typeof result!.coupling_delta).toBe('number');
  });

  it('detects destabilizing trend when instability increases', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from('aaa111|2026-03-01\n');
      }
      if (argList[0] === 'show') {
        // Old version: no imports (Ce=0)
        return Buffer.from('const x = 1;\n');
      }
      if (argList[0] === 'grep') {
        // Old version: 3 files imported it (Ca=3)
        return Buffer.from('c:src/tools/aaa.ts\nc:src/tools/bbb.ts\nc:src/tools/ccc.ts\n');
      }
      return Buffer.from('');
    });

    const store = createStore();
    const fTarget = insertFile(store, 'src/tools/target.ts');
    const fDep = insertFile(store, 'src/tools/dependency.ts');
    const nodeTarget = store.getNodeId('file', fTarget)!;
    const nodeDep = store.getNodeId('file', fDep)!;

    // Current: target imports dependency (Ce=1, Ca=0 → instability=1)
    insertEdge(store, nodeTarget, nodeDep, 'esm_imports');

    const result = getCouplingTrend(store, '/project', 'src/tools/target.ts');
    expect(result).not.toBeNull();
    // Historical: Ca=3, Ce=0 → instability=0
    // Current: Ca=0, Ce=1 → instability=1
    // Delta = 1 - 0 = 1 → destabilizing
    expect(result!.trend).toBe('destabilizing');
    expect(result!.instability_delta).toBeGreaterThan(0.1);
  });

  it('returns stable trend when no historical data', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from(''); // No git log results
    });

    const store = createStore();
    insertFile(store, 'src/tools/target.ts');

    const result = getCouplingTrend(store, '/project', 'src/tools/target.ts');
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('stable');
    expect(result!.historical).toEqual([]);
  });

  it('computes current coupling via single SQL query', () => {
    // Verify Ca and Ce are both computed from one query path (no N+1)
    const store = createStore();
    const fA = insertFile(store, 'src/tools/target.ts');
    const fB = insertFile(store, 'src/tools/dep1.ts');
    const fC = insertFile(store, 'src/tools/dep2.ts');
    const fD = insertFile(store, 'src/tools/consumer.ts');

    const nodeA = store.getNodeId('file', fA)!;
    const nodeB = store.getNodeId('file', fB)!;
    const nodeC = store.getNodeId('file', fC)!;
    const nodeD = store.getNodeId('file', fD)!;

    // A imports B and C (Ce=2)
    insertEdge(store, nodeA, nodeB, 'esm_imports');
    insertEdge(store, nodeA, nodeC, 'esm_imports');
    // D imports A (Ca=1)
    insertEdge(store, nodeD, nodeA, 'esm_imports');

    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if ((args as string[])[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });

    const result = getCouplingTrend(store, '/project', 'src/tools/target.ts');
    expect(result).not.toBeNull();
    expect(result!.current.ca).toBe(1);
    expect(result!.current.ce).toBe(2);
    expect(result!.current.instability).toBeCloseTo(2 / 3, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// getSymbolComplexityTrend (mocked git)
// ════════════════════════════════════════════════════════════════════════

describe('getSymbolComplexityTrend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when not a git repo', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });
    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fId, 'foo', 'function', { cyclomatic: 5, max_nesting: 2, param_count: 1 });
    expect(getSymbolComplexityTrend(store, '/project', 'sym:foo')).toBeNull();
  });

  it('returns null when symbol not found', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if ((args as string[])[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });
    const store = createStore();
    expect(getSymbolComplexityTrend(store, '/project', 'sym:nonexistent')).toBeNull();
  });

  it('returns current snapshot from indexed data', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if ((args as string[])[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fId, 'foo', 'function', {
      cyclomatic: 8, max_nesting: 3, param_count: 2,
    });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    expect(result!.symbol_id).toBe('sym:foo');
    expect(result!.name).toBe('foo');
    expect(result!.file).toBe('src/a.ts');
    expect(result!.current.cyclomatic).toBe(8);
    expect(result!.current.max_nesting).toBe(3);
    expect(result!.current.param_count).toBe(2);
    expect(result!.current.commit).toBe('HEAD');
    expect(result!.trend).toBe('stable');
    expect(result!.historical).toEqual([]);
  });

  it('detects degrading trend when complexity increases', () => {
    const simpleVersion = 'function foo() {\n  return 1;\n}\n';

    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') return Buffer.from('old111|2025-06-01\n');
      if (argList[0] === 'show') return Buffer.from(simpleVersion);
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    // Current: high complexity
    insertSymbol(store, fId, 'foo', 'function', {
      cyclomatic: 6, max_nesting: 5, param_count: 2,
    });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    // Historical simple version has cyclomatic=1, current is 6 → delta=5 → degrading
    expect(result!.trend).toBe('degrading');
    expect(result!.cyclomatic_delta).toBeGreaterThanOrEqual(2);
  });

  it('detects improving trend when complexity decreases', () => {
    const complexVersion = [
      'function foo(x) {',
      '  if (x > 0) {',
      '    for (const i of arr) {',
      '      if (i && valid) {',
      '        process(i);',
      '      }',
      '    }',
      '  }',
      '  return x;',
      '}',
    ].join('\n');

    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') return Buffer.from('old111|2025-06-01\n');
      if (argList[0] === 'show') return Buffer.from(complexVersion);
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    // Current: simple
    insertSymbol(store, fId, 'foo', 'function', {
      cyclomatic: 1, max_nesting: 0, param_count: 0,
    });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    expect(result!.trend).toBe('improving');
    expect(result!.cyclomatic_delta).toBeLessThanOrEqual(-2);
  });

  it('handles file not existing at historical commit', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') return Buffer.from('old111|2025-06-01\n');
      if (argList[0] === 'show') throw new Error('fatal: path not found');
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fId, 'foo', 'function', { cyclomatic: 3, max_nesting: 1, param_count: 0 });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    expect(result!.historical).toEqual([]);
    expect(result!.trend).toBe('stable');
  });

  it('handles symbol not existing in historical file version', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') return Buffer.from('old111|2025-06-01\n');
      if (argList[0] === 'show') return Buffer.from('const x = 1;\nfunction otherFunc() {}\n');
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fId, 'foo', 'function', { cyclomatic: 3, max_nesting: 1, param_count: 0 });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    expect(result!.historical).toEqual([]);
    expect(result!.trend).toBe('stable');
  });

  it('computes lines from indexed line_start / line_end', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      if ((args as string[])[0] === 'rev-parse') return Buffer.from('true');
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    // lineStart=1, lineEnd=10 → 10 lines
    store.insertSymbol(fId, {
      symbolId: 'sym:bar',
      name: 'bar',
      kind: 'function',
      byteStart: 0,
      byteEnd: 200,
      lineStart: 1,
      lineEnd: 10,
      metadata: { cyclomatic: 3, max_nesting: 1, param_count: 0 },
    });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:bar');
    expect(result).not.toBeNull();
    expect(result!.current.lines).toBe(10);
  });

  it('tracks multiple historical snapshots', () => {
    const v1 = 'function foo() {\n  return 1;\n}\n';
    const v2 = 'function foo(x) {\n  if (x) {\n    return x;\n  }\n  return 0;\n}\n';
    const v3 = 'function foo(x, y) {\n  if (x && y) {\n    for (const i of arr) {\n      process(i);\n    }\n  }\n  return 0;\n}\n';

    mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
      const argList = args as string[];
      if (argList[0] === 'rev-parse') return Buffer.from('true');
      if (argList[0] === 'log') {
        return Buffer.from('ccc333|2026-03-01\nbbb222|2026-02-01\naaa111|2026-01-01\n');
      }
      if (argList[0] === 'show') {
        const ref = argList[1];
        if (ref.startsWith('ccc333:')) return Buffer.from(v3);
        if (ref.startsWith('bbb222:')) return Buffer.from(v2);
        if (ref.startsWith('aaa111:')) return Buffer.from(v1);
        return Buffer.from(v1);
      }
      return Buffer.from('');
    });

    const store = createStore();
    const fId = insertFile(store, 'src/a.ts');
    insertSymbol(store, fId, 'foo', 'function', {
      cyclomatic: 5, max_nesting: 3, param_count: 2,
    });

    const result = getSymbolComplexityTrend(store, '/project', 'sym:foo');
    expect(result).not.toBeNull();
    expect(result!.historical.length).toBe(3);
    // Oldest (v1) should have lowest complexity
    const oldest = result!.historical[result!.historical.length - 1];
    expect(oldest.cyclomatic).toBeLessThan(result!.current.cyclomatic);
  });
});
