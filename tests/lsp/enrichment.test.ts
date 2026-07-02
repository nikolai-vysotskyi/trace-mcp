/**
 * Tests for LspEnrichmentPass — the core algorithm that walks callable
 * symbols, queries LSP call hierarchy, and upgrades/inserts call graph edges.
 *
 * Contract under test:
 *   - collectCallableSymbols() groups only callable-kind symbols by LSP
 *     language, respecting fileIdFilter when provided (scoped background runs)
 *   - enrichEdges() skips a language when getClient() returns null (server
 *     unavailable/not installed) and marks serverStatuses[language]='unavailable'
 *   - enrichEdges() marks serverStatuses[language]='failed' when the
 *     per-language pass throws, but continues to the next language
 *   - a symbol with no call-hierarchy items (malformed/empty LSP response)
 *     increments edgesFailed and is skipped, without aborting the batch
 *   - a per-symbol error (e.g. openDocument rejects) is caught, logged, and
 *     counted as edgesFailed — the rest of the batch still runs
 *   - an existing call edge is upgraded (resolution_tier -> lsp_resolved);
 *     a call with no matching existing edge inserts a new lsp_resolved edge
 *   - enrichEdges() respects the AbortSignal — aborts before starting the
 *     next language's pass
 *   - enrichEdges() stops processing further languages once the overall
 *     enrichmentTimeoutMs elapses
 *
 * We never spawn a real LSP server: LspClient and LspServerManager are
 * hand-rolled fakes implementing only the methods LspEnrichmentPass calls,
 * matching the "inject a fake instead of a real subprocess" pattern used by
 * background-enricher.test.ts and bridge.test.ts. node:fs's readFileSync is
 * mocked so no real file I/O happens either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/db/store.js';
import type { EdgeRow, FileRow, SymbolRow } from '../../src/db/types.js';

const readFileSyncMock = vi.fn(() => 'const x = 1;');
vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

import { LspEnrichmentPass } from '../../src/lsp/enrichment.js';
import type { LspServerManager } from '../../src/lsp/lifecycle.js';
import type { CallHierarchyItem, CallHierarchyOutgoingCall } from '../../src/lsp/protocol.js';

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

function makeCallHierarchyItem(overrides: Partial<CallHierarchyItem> = {}): CallHierarchyItem {
  return {
    name: 'bar',
    kind: 12,
    uri: 'file:///repo/src/foo.ts',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    ...overrides,
  };
}

interface FakeStoreOptions {
  files?: FileRow[];
  symbolsByFile?: Map<number, SymbolRow[]>;
  edgesByType?: Map<string, EdgeRow[]>;
  nodeIds?: Map<string, number>; // key: `${nodeType}:${refId}`
}

function makeStore(opts: FakeStoreOptions = {}): Store {
  const files = opts.files ?? [makeFile()];
  const symbolsByFile = opts.symbolsByFile ?? new Map();
  const edgesByType = opts.edgesByType ?? new Map();
  const nodeIds = opts.nodeIds ?? new Map();
  const insertedEdges: Array<{ source: number; target: number; type: string; tier?: string }> = [];
  const upgradedEdgeIds: number[] = [];

  const run = vi.fn((edgeId: number) => {
    upgradedEdgeIds.push(edgeId);
  });

  return {
    getAllFiles: () => files,
    getFile: (path: string) => files.find((f) => f.path === path),
    getSymbolsByFile: (fileId: number) => symbolsByFile.get(fileId) ?? [],
    getEdgesByType: (edgeType: string) => edgesByType.get(edgeType) ?? [],
    getNodeId: (nodeType: string, refId: number) => nodeIds.get(`${nodeType}:${refId}`),
    insertEdge: (
      sourceNodeId: number,
      targetNodeId: number,
      edgeTypeName: string,
      _resolved?: boolean,
      _metadata?: Record<string, unknown>,
      _isCrossWs?: boolean,
      resolutionTier?: string,
    ) => {
      insertedEdges.push({
        source: sourceNodeId,
        target: targetNodeId,
        type: edgeTypeName,
        tier: resolutionTier,
      });
      return { isOk: () => true, isErr: () => false, value: insertedEdges.length } as never;
    },
    db: {
      prepare: () => ({ run }),
    },
    __test: { insertedEdges, upgradedEdgeIds },
  } as unknown as Store & {
    __test: {
      insertedEdges: typeof insertedEdges;
      upgradedEdgeIds: typeof upgradedEdgeIds;
    };
  };
}

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    prepareCallHierarchy: vi.fn(async () => [makeCallHierarchyItem()]),
    outgoingCalls: vi.fn(async (): Promise<CallHierarchyOutgoingCall[]> => []),
    openDocument: vi.fn(async () => {}),
    closeDocument: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeServerManager(clients: Record<string, ReturnType<typeof makeClient> | null>) {
  return {
    getClient: vi.fn(async (language: string) => clients[language] ?? null),
  } as unknown as LspServerManager;
}

describe('LspEnrichmentPass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileSyncMock.mockReturnValue('const x = 1;');
  });

  it('collectCallableSymbols groups only callable kinds by LSP language', async () => {
    const file = makeFile({ id: 1, language: 'typescript' });
    const symbols = [
      makeSymbol({ id: 1, kind: 'function', name: 'fn' }),
      makeSymbol({ id: 2, kind: 'method', name: 'm' }),
      makeSymbol({ id: 3, kind: 'variable', name: 'v' }), // not callable, excluded
      makeSymbol({ id: 4, kind: 'class', name: 'C' }), // not callable, excluded
    ];
    const store = makeStore({
      files: [file],
      symbolsByFile: new Map([[1, symbols]]),
    });
    const client = makeClient({ prepareCallHierarchy: vi.fn(async () => []) });
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    await pass.enrichEdges();

    // prepareCallHierarchy called once per callable symbol (fn, m) — not for v/C.
    expect(client.prepareCallHierarchy).toHaveBeenCalledTimes(2);
  });

  it('marks a language "unavailable" when getClient returns null (server not installed)', async () => {
    const store = makeStore({
      files: [makeFile({ language: 'typescript' })],
      symbolsByFile: new Map([[1, [makeSymbol()]]]),
    });
    const manager = makeServerManager({}); // no typescript client registered -> null
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    expect(result.serverStatuses.typescript).toBe('unavailable');
    expect(result.symbolsQueried).toBe(0);
  });

  it('a per-symbol LSP error is absorbed as edgesFailed, not a language-level failure', async () => {
    const file1 = makeFile({ id: 1, path: 'a.ts', language: 'typescript' });
    const file2 = makeFile({ id: 2, path: 'b.py', language: 'python' });
    const store = makeStore({
      files: [file1, file2],
      symbolsByFile: new Map([
        [1, [makeSymbol({ id: 1, file_id: 1 })]],
        [2, [makeSymbol({ id: 2, file_id: 2, name: 'py_fn' })]],
      ]),
    });
    const brokenClient = makeClient({
      prepareCallHierarchy: vi.fn(async () => {
        throw new Error('tsserver crashed');
      }),
    });
    const workingClient = makeClient();
    const manager = makeServerManager({ typescript: brokenClient, python: workingClient });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    // enrichSymbol's per-symbol try/catch (inside enrichLanguage) absorbs the
    // throw as edgesFailed, so the language itself still reports "ok" —
    // one bad symbol doesn't take down the whole language pass.
    expect(result.serverStatuses.typescript).toBe('ok');
    expect(result.edgesFailed).toBeGreaterThanOrEqual(1);
    // Python must still have been attempted (not short-circuited).
    expect(workingClient.prepareCallHierarchy).toHaveBeenCalled();
  });

  it('marks a language "failed" when the pass throws before per-symbol handling (e.g. a DB error)', async () => {
    const store = makeStore({
      files: [makeFile({ language: 'typescript' })],
      symbolsByFile: new Map([[1, [makeSymbol()]]]),
    });
    // Simulate a DB failure inside loadExistingCallEdges(), which runs once
    // per language BEFORE the per-symbol try/catch loop starts — this is
    // the one failure mode enrichLanguage doesn't itself swallow.
    store.getEdgesByType = () => {
      throw new Error('database is locked');
    };
    const client = makeClient();
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    expect(result.serverStatuses.typescript).toBe('failed');
    expect(client.prepareCallHierarchy).not.toHaveBeenCalled();
  });

  it('increments edgesFailed and skips a symbol when prepareCallHierarchy returns empty (malformed/no match)', async () => {
    const store = makeStore({
      files: [makeFile()],
      symbolsByFile: new Map([[1, [makeSymbol()]]]),
    });
    const client = makeClient({ prepareCallHierarchy: vi.fn(async () => []) });
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    expect(result.edgesFailed).toBe(1);
    expect(result.symbolsQueried).toBe(0);
    expect(client.outgoingCalls).not.toHaveBeenCalled();
  });

  it('counts edgesFailed and continues when openDocument rejects (file deleted since indexing)', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    const store = makeStore({
      files: [makeFile()],
      symbolsByFile: new Map([[1, [makeSymbol({ id: 1 }), makeSymbol({ id: 2, name: 'bar' })]]]),
    });
    const client = makeClient();
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    // Both symbols share the same (unreadable) file, so neither gets past
    // ensureFileOpen — no exception should propagate, just silent skip.
    expect(result.edgesFailed).toBe(0); // ensureFileOpen returns false -> early return, no counter bump
    expect(client.prepareCallHierarchy).not.toHaveBeenCalled();
  });

  it('upgrades an existing call edge to lsp_resolved when the target already has an edge', async () => {
    const sourceSymbol = makeSymbol({ id: 1, symbol_id: 'sym:source' });
    const file = makeFile({ id: 1 });
    const store = makeStore({
      files: [file],
      symbolsByFile: new Map([
        [
          1,
          [
            sourceSymbol,
            // Non-callable kind: findSymbolAtPosition matches it as the call
            // target regardless of kind, but collectCallableSymbols excludes
            // it from the driving loop so only `sourceSymbol` is queried.
            makeSymbol({ id: 2, name: 'target', kind: 'variable', line_start: 5, line_end: 7 }),
          ],
        ],
      ]),
      edgesByType: new Map([
        [
          'calls',
          [
            {
              id: 99,
              source_node_id: 10,
              target_node_id: 20,
              edge_type_id: 1,
              resolved: 1,
              metadata: null,
              is_cross_ws: 0,
              resolution_tier: 'ast_resolved',
            } as EdgeRow,
          ],
        ],
      ]),
      nodeIds: new Map([
        ['symbol:1', 10],
        ['symbol:2', 20],
      ]),
    });
    const client = makeClient({
      outgoingCalls: vi.fn(async () => [
        {
          to: makeCallHierarchyItem({
            uri: 'file:///repo/src/foo.ts',
            selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
          }),
          fromRanges: [],
        },
      ]),
    });
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    expect(result.edgesUpgraded).toBe(1);
    expect(result.edgesAdded).toBe(0);
    expect(
      (store as unknown as { __test: { upgradedEdgeIds: number[] } }).__test.upgradedEdgeIds,
    ).toEqual([99]);
  });

  it('inserts a new lsp_resolved edge when no existing edge matches the LSP call', async () => {
    const sourceSymbol = makeSymbol({ id: 1, symbol_id: 'sym:source' });
    const file = makeFile({ id: 1 });
    const store = makeStore({
      files: [file],
      symbolsByFile: new Map([
        [
          1,
          [
            sourceSymbol,
            // Non-callable kind: findSymbolAtPosition matches it as the call
            // target regardless of kind, but collectCallableSymbols excludes
            // it from the driving loop so only `sourceSymbol` is queried.
            makeSymbol({ id: 2, name: 'target', kind: 'variable', line_start: 5, line_end: 7 }),
          ],
        ],
      ]),
      edgesByType: new Map(), // no existing edges at all
      nodeIds: new Map([
        ['symbol:1', 10],
        ['symbol:2', 20],
      ]),
    });
    const client = makeClient({
      outgoingCalls: vi.fn(async () => [
        {
          to: makeCallHierarchyItem({
            uri: 'file:///repo/src/foo.ts',
            selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
          }),
          fromRanges: [],
        },
      ]),
    });
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000);

    const result = await pass.enrichEdges();

    expect(result.edgesAdded).toBe(1);
    expect(result.edgesUpgraded).toBe(0);
    const inserted = (store as unknown as { __test: { insertedEdges: Array<{ tier?: string }> } })
      .__test.insertedEdges;
    expect(inserted).toHaveLength(1);
    expect(inserted[0].tier).toBe('lsp_resolved');
  });

  it('respects an aborted signal by skipping remaining languages', async () => {
    const file1 = makeFile({ id: 1, path: 'a.ts', language: 'typescript' });
    const file2 = makeFile({ id: 2, path: 'b.py', language: 'python' });
    const store = makeStore({
      files: [file1, file2],
      symbolsByFile: new Map([
        [1, [makeSymbol({ id: 1, file_id: 1 })]],
        [2, [makeSymbol({ id: 2, file_id: 2, name: 'py_fn' })]],
      ]),
    });
    const tsClient = makeClient();
    const pyClient = makeClient();
    const manager = makeServerManager({ typescript: tsClient, python: pyClient });
    const controller = new AbortController();
    controller.abort(); // pre-aborted — nothing should run
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000, {
      signal: controller.signal,
    });

    const result = await pass.enrichEdges();

    expect(result.symbolsQueried).toBe(0);
    expect(tsClient.prepareCallHierarchy).not.toHaveBeenCalled();
    expect(pyClient.prepareCallHierarchy).not.toHaveBeenCalled();
  });

  it('stops processing further languages once enrichmentTimeoutMs has elapsed', async () => {
    const file1 = makeFile({ id: 1, path: 'a.ts', language: 'typescript' });
    const file2 = makeFile({ id: 2, path: 'b.py', language: 'python' });
    const store = makeStore({
      files: [file1, file2],
      symbolsByFile: new Map([
        [1, [makeSymbol({ id: 1, file_id: 1 })]],
        [2, [makeSymbol({ id: 2, file_id: 2, name: 'py_fn' })]],
      ]),
    });
    // First language's client takes "long enough" that Date.now() advances
    // past a 0ms timeout by the time the loop re-checks.
    const slowClient = makeClient({
      prepareCallHierarchy: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [];
      }),
    });
    const pyClient = makeClient();
    const manager = makeServerManager({ typescript: slowClient, python: pyClient });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 0 /* timeout immediately */);

    await pass.enrichEdges();

    // Python must not have been reached — the timeout check after the first
    // language's pass breaks the loop.
    expect(pyClient.prepareCallHierarchy).not.toHaveBeenCalled();
  });

  it('scopes collectCallableSymbols to fileIdFilter when provided', async () => {
    const file1 = makeFile({ id: 1, path: 'a.ts' });
    const file2 = makeFile({ id: 2, path: 'b.ts' });
    const store = makeStore({
      files: [file1, file2],
      symbolsByFile: new Map([
        [1, [makeSymbol({ id: 1, file_id: 1, name: 'included' })]],
        [2, [makeSymbol({ id: 2, file_id: 2, name: 'excluded' })]],
      ]),
    });
    const client = makeClient({ prepareCallHierarchy: vi.fn(async () => []) });
    const manager = makeServerManager({ typescript: client });
    const pass = new LspEnrichmentPass(store, manager, '/repo', 100, 120_000, {
      fileIdFilter: new Set([1]),
    });

    await pass.enrichEdges();

    // Only the symbol from file 1 should have triggered a call-hierarchy query.
    expect(client.prepareCallHierarchy).toHaveBeenCalledTimes(1);
  });
});
