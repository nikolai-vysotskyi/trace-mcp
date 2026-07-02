/**
 * Tests for the symbol <-> LSP position mapping helpers — pure functions,
 * no process/network/filesystem I/O, so no mocking is needed here.
 *
 * Contract under test:
 *   - symbolToLspPosition converts trace-mcp's 1-based line_start to LSP's
 *     0-based line, always at character 0, using an absolute file:// URI
 *   - lspUriToRelPath converts a file:// URI back to a path relative to
 *     rootPath, and rejects (returns null) any URI that resolves outside
 *     rootPath (path traversal / cross-root safety) or fails to parse
 *   - findSymbolAtPosition maps an LSP (uri, 0-based line) back to the
 *     trace-mcp symbol whose line range contains it, preferring the
 *     narrowest (most specific) match when ranges are nested — and returns
 *     null for an unknown file, a file with no symbols, or a line outside
 *     every symbol's range
 *   - getLanguageId maps file extensions to LSP language IDs, including
 *     case-insensitivity, and returns null for unrecognized extensions
 */
import { describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import type { FileRow, SymbolRow } from '../../src/db/types.js';
import {
  findSymbolAtPosition,
  getLanguageId,
  lspUriToRelPath,
  symbolToLspPosition,
} from '../../src/lsp/mappers.js';

function makeFile(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: 1,
    path: 'src/foo.ts',
    language: 'typescript',
    framework_role: null,
    status: 'active',
    content_hash: null,
    byte_length: null,
    indexed_at: '2026-01-01T00:00:00Z',
    metadata: null,
    workspace: null,
    gitignored: 0,
    mtime_ms: null,
    ...overrides,
  };
}

function makeSymbol(overrides: Partial<SymbolRow> = {}): SymbolRow {
  return {
    id: 1,
    file_id: 1,
    symbol_id: 'sym:1',
    name: 'foo',
    kind: 'function',
    fqn: null,
    parent_id: null,
    signature: 'function foo()',
    summary: null,
    byte_start: 0,
    byte_end: 20,
    line_start: 1,
    line_end: 3,
    metadata: null,
    ...overrides,
  };
}

function makeStore(files: FileRow[], symbolsByFile: Map<number, SymbolRow[]>): Store {
  return {
    getFile: (path: string) => files.find((f) => f.path === path),
    getSymbolsByFile: (fileId: number) => symbolsByFile.get(fileId) ?? [],
  } as unknown as Store;
}

describe('symbolToLspPosition', () => {
  it('converts 1-based line_start to a 0-based LSP line at character 0', () => {
    const symbol = makeSymbol({ line_start: 10 });
    const file = makeFile({ path: 'src/foo.ts' });

    const pos = symbolToLspPosition(symbol, file, '/repo');

    expect(pos.line).toBe(9);
    expect(pos.character).toBe(0);
    expect(pos.uri).toBe('file:///repo/src/foo.ts');
  });

  it('defaults to line 1 (LSP line 0) when line_start is null', () => {
    const symbol = makeSymbol({ line_start: null });
    const file = makeFile();

    const pos = symbolToLspPosition(symbol, file, '/repo');

    expect(pos.line).toBe(0);
  });

  it('resolves the URI relative to rootPath for a nested file path', () => {
    const symbol = makeSymbol();
    const file = makeFile({ path: 'src/nested/deep/foo.ts' });

    const pos = symbolToLspPosition(symbol, file, '/repo');

    expect(pos.uri).toBe('file:///repo/src/nested/deep/foo.ts');
  });
});

describe('lspUriToRelPath', () => {
  it('converts a file:// URI under rootPath to a relative path', () => {
    const rel = lspUriToRelPath('file:///repo/src/foo.ts', '/repo');
    expect(rel).toBe('src/foo.ts');
  });

  it('rejects a URI that resolves outside rootPath (path traversal safety)', () => {
    const rel = lspUriToRelPath('file:///etc/passwd', '/repo');
    expect(rel).toBeNull();
  });

  it('rejects a URI in a sibling directory (../ escape)', () => {
    const rel = lspUriToRelPath('file:///repo-other/src/foo.ts', '/repo');
    expect(rel).toBeNull();
  });

  it('returns null for a malformed URI', () => {
    const rel = lspUriToRelPath('not a valid uri at all', '/repo');
    expect(rel).toBeNull();
  });

  it('round-trips with symbolToLspPosition for the same file/rootPath', () => {
    const symbol = makeSymbol();
    const file = makeFile({ path: 'src/foo.ts' });
    const pos = symbolToLspPosition(symbol, file, '/repo');

    const rel = lspUriToRelPath(pos.uri, '/repo');

    expect(rel).toBe(file.path);
  });
});

describe('findSymbolAtPosition', () => {
  it('finds the symbol whose line range contains the given 0-based LSP line', () => {
    const file = makeFile({ id: 1, path: 'src/foo.ts' });
    const symbol = makeSymbol({ id: 1, line_start: 5, line_end: 10 });
    const store = makeStore([file], new Map([[1, [symbol]]]));

    // LSP line 6 (0-based) => trace-mcp line 7, inside [5, 10].
    const result = findSymbolAtPosition(store, '/repo', 'file:///repo/src/foo.ts', 6);

    expect(result?.symbol.id).toBe(1);
  });

  it('prefers the narrowest (most specific) symbol when ranges are nested', () => {
    const file = makeFile({ id: 1, path: 'src/foo.ts' });
    const outer = makeSymbol({
      id: 1,
      name: 'OuterClass',
      kind: 'class',
      line_start: 1,
      line_end: 100,
    });
    const inner = makeSymbol({
      id: 2,
      name: 'innerMethod',
      kind: 'method',
      line_start: 10,
      line_end: 15,
    });
    const store = makeStore([file], new Map([[1, [outer, inner]]]));

    // trace-mcp line 12 is inside both ranges — must pick the narrower one.
    const result = findSymbolAtPosition(store, '/repo', 'file:///repo/src/foo.ts', 11);

    expect(result?.symbol.id).toBe(2);
  });

  it('returns null when the URI does not resolve to a known file', () => {
    const store = makeStore([], new Map());

    const result = findSymbolAtPosition(store, '/repo', 'file:///repo/src/unknown.ts', 0);

    expect(result).toBeNull();
  });

  it('returns null when the file has no symbols at all', () => {
    const file = makeFile({ id: 1, path: 'src/empty.ts' });
    const store = makeStore([file], new Map());

    const result = findSymbolAtPosition(store, '/repo', 'file:///repo/src/empty.ts', 0);

    expect(result).toBeNull();
  });

  it('returns null when the line falls outside every symbol range', () => {
    const file = makeFile({ id: 1, path: 'src/foo.ts' });
    const symbol = makeSymbol({ id: 1, line_start: 5, line_end: 10 });
    const store = makeStore([file], new Map([[1, [symbol]]]));

    // trace-mcp line 500 — nowhere near [5, 10].
    const result = findSymbolAtPosition(store, '/repo', 'file:///repo/src/foo.ts', 499);

    expect(result).toBeNull();
  });

  it('falls back to line_start when a symbol has no line_end', () => {
    const file = makeFile({ id: 1, path: 'src/foo.ts' });
    const symbol = makeSymbol({ id: 1, line_start: 5, line_end: null });
    const store = makeStore([file], new Map([[1, [symbol]]]));

    // trace-mcp line 5 (0-based LSP line 4) is a single-line match.
    const exact = findSymbolAtPosition(store, '/repo', 'file:///repo/src/foo.ts', 4);
    expect(exact?.symbol.id).toBe(1);

    const outside = findSymbolAtPosition(store, '/repo', 'file:///repo/src/foo.ts', 5);
    expect(outside).toBeNull();
  });
});

describe('getLanguageId', () => {
  it.each([
    ['foo.ts', 'typescript'],
    ['foo.tsx', 'typescript'],
    ['foo.js', 'typescript'],
    ['foo.jsx', 'typescript'],
    ['foo.mts', 'typescript'],
    ['foo.cts', 'typescript'],
    ['foo.py', 'python'],
    ['foo.pyi', 'python'],
    ['foo.go', 'go'],
    ['foo.rs', 'rust'],
    ['foo.cs', 'csharp'],
    ['foo.csx', 'csharp'],
  ])('maps %s -> %s', (path, expected) => {
    expect(getLanguageId(path)).toBe(expected);
  });

  it('is case-insensitive on the extension', () => {
    expect(getLanguageId('Foo.TS')).toBe('typescript');
    expect(getLanguageId('Bar.PY')).toBe('python');
  });

  it('returns null for an unrecognized extension', () => {
    expect(getLanguageId('foo.txt')).toBeNull();
    expect(getLanguageId('README.md')).toBeNull();
  });

  it('returns null for a file with no extension', () => {
    expect(getLanguageId('Makefile')).toBeNull();
  });
});
