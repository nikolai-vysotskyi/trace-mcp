/**
 * Tests for LspBridge — the LSP enrichment orchestrator (entry point).
 *
 * Contract under test:
 *   - enrich() short-circuits to an empty result when the index has no
 *     LSP-supported languages (never touches server resolution)
 *   - enrich() short-circuits to an empty result when resolveServers()
 *     finds no available servers (LSP tooling not installed) — the
 *     "LSP server unavailable / not installed" scenario
 *   - enrich() constructs LspServerManager with the configured concurrency
 *     limit and LspEnrichmentPass with the configured batch size / timeout,
 *     then returns whatever the pass reports (upgraded/added/failed/etc.)
 *   - enrich() propagates fileIdFilter/signal through to LspEnrichmentPass
 *     so a scoped background run only touches the requested files
 *   - a failing/throwing enrichment pass propagates out of enrich() —
 *     callers (BackgroundLspEnricher) are responsible for catching, per
 *     the "background work must never throw out" contract documented there
 *   - shutdown() is a no-op when enrich() was never called (no server
 *     manager constructed yet) and delegates to shutdownAll() otherwise
 *
 * We never spawn a real LSP server: LspServerManager and LspEnrichmentPass
 * are mocked at the module boundary (same seam BackgroundLspEnricher's
 * tests use — inject a fake instead of touching the real subprocess path),
 * and resolveServers is mocked directly to avoid `execSync('which ...')`
 * PATH lookups too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import type { FileRow } from '../../src/db/types.js';

const shutdownAllMock = vi.fn(async () => {});
const enrichEdgesMock = vi.fn();
const serverManagerCtor = vi.fn();
const enrichmentPassCtor = vi.fn();

vi.mock('../../src/lsp/lifecycle.js', () => ({
  LspServerManager: vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
    serverManagerCtor(...args);
    return { shutdownAll: shutdownAllMock };
  }),
}));

vi.mock('../../src/lsp/enrichment.js', () => ({
  LspEnrichmentPass: vi.fn().mockImplementation(function (this: unknown, ...args: unknown[]) {
    enrichmentPassCtor(...args);
    return { enrichEdges: enrichEdgesMock };
  }),
}));

vi.mock('../../src/lsp/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lsp/config.js')>();
  return {
    ...actual,
    resolveServers: vi.fn(),
  };
});

import { LspBridge } from '../../src/lsp/bridge.js';
import { resolveServers } from '../../src/lsp/config.js';

const resolveServersMock = vi.mocked(resolveServers);

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

function makeStore(files: FileRow[]): Store {
  return {
    getAllFiles: () => files,
  } as unknown as Store;
}

function makeConfig(overrides: Partial<NonNullable<TraceMcpConfig['lsp']>> = {}): TraceMcpConfig {
  return {
    lsp: {
      enabled: true,
      servers: {},
      auto_detect: true,
      max_concurrent_servers: 2,
      enrichment_timeout_ms: 120_000,
      batch_size: 100,
      ...overrides,
    },
  } as unknown as TraceMcpConfig;
}

const emptyResult = {
  edgesUpgraded: 0,
  edgesAdded: 0,
  edgesFailed: 0,
  symbolsQueried: 0,
  durationMs: 0,
  serverStatuses: {},
};

describe('LspBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty result without resolving servers when no LSP-supported languages are indexed', async () => {
    // A file with an unrecognized/null language never maps through
    // fileLanguageToLspLanguage, so detectIndexedLanguages() finds nothing.
    const store = makeStore([makeFile({ language: 'brainfuck' }), makeFile({ language: null })]);
    const bridge = new LspBridge(store, makeConfig(), '/repo');

    const result = await bridge.enrich();

    expect(result).toEqual(emptyResult);
    expect(resolveServersMock).not.toHaveBeenCalled();
    expect(serverManagerCtor).not.toHaveBeenCalled();
  });

  it('returns an empty result when no LSP servers are available (not installed / unavailable)', async () => {
    const store = makeStore([makeFile({ language: 'typescript' })]);
    resolveServersMock.mockReturnValue([]); // simulates "tsserver not on PATH"
    const bridge = new LspBridge(store, makeConfig(), '/repo');

    const result = await bridge.enrich();

    expect(result).toEqual(emptyResult);
    expect(resolveServersMock).toHaveBeenCalledWith(
      expect.anything(),
      '/repo',
      new Set(['typescript']),
    );
    expect(serverManagerCtor).not.toHaveBeenCalled();
    expect(enrichEdgesMock).not.toHaveBeenCalled();
  });

  it('runs a successful enrichment pass and returns its result', async () => {
    const store = makeStore([makeFile({ language: 'typescript' })]);
    resolveServersMock.mockReturnValue([
      { language: 'typescript', command: 'npx', args: [], timeoutMs: 30_000 },
    ]);
    const passResult = {
      edgesUpgraded: 3,
      edgesAdded: 1,
      edgesFailed: 0,
      symbolsQueried: 4,
      durationMs: 42,
      serverStatuses: { typescript: 'ok' as const },
    };
    enrichEdgesMock.mockResolvedValue(passResult);

    const bridge = new LspBridge(store, makeConfig({ max_concurrent_servers: 3 }), '/repo');
    const result = await bridge.enrich();

    expect(result).toEqual(passResult);
    expect(serverManagerCtor).toHaveBeenCalledWith(
      expect.any(Array),
      '/repo',
      3, // max_concurrent_servers passed through
    );
    expect(enrichEdgesMock).toHaveBeenCalledTimes(1);
  });

  it('passes fileIdFilter and signal through to LspEnrichmentPass (scoped background runs)', async () => {
    const store = makeStore([makeFile({ language: 'typescript' })]);
    resolveServersMock.mockReturnValue([
      { language: 'typescript', command: 'npx', args: [], timeoutMs: 30_000 },
    ]);
    enrichEdgesMock.mockResolvedValue(emptyResult);

    const filter = new Set([1, 2, 3]);
    const controller = new AbortController();
    const bridge = new LspBridge(
      store,
      makeConfig({ batch_size: 50, enrichment_timeout_ms: 5_000 }),
      '/repo',
    );
    await bridge.enrich({ fileIdFilter: filter, signal: controller.signal });

    expect(enrichmentPassCtor).toHaveBeenCalledWith(
      store,
      expect.anything(), // the mocked LspServerManager instance
      '/repo',
      50, // batch_size
      5_000, // enrichment_timeout_ms
      { fileIdFilter: filter, signal: controller.signal },
    );
  });

  it('propagates errors thrown by the enrichment pass (caller owns catch/retry)', async () => {
    const store = makeStore([makeFile({ language: 'typescript' })]);
    resolveServersMock.mockReturnValue([
      { language: 'typescript', command: 'npx', args: [], timeoutMs: 30_000 },
    ]);
    enrichEdgesMock.mockRejectedValue(new Error('tsserver crashed mid-batch'));

    const bridge = new LspBridge(store, makeConfig(), '/repo');

    await expect(bridge.enrich()).rejects.toThrow('tsserver crashed mid-batch');
  });

  it('shutdown() is a no-op when enrich() was never called', async () => {
    const store = makeStore([]);
    const bridge = new LspBridge(store, makeConfig(), '/repo');

    await bridge.shutdown();

    expect(shutdownAllMock).not.toHaveBeenCalled();
  });

  it('shutdown() delegates to the server manager after a run and clears it', async () => {
    const store = makeStore([makeFile({ language: 'typescript' })]);
    resolveServersMock.mockReturnValue([
      { language: 'typescript', command: 'npx', args: [], timeoutMs: 30_000 },
    ]);
    enrichEdgesMock.mockResolvedValue(emptyResult);

    const bridge = new LspBridge(store, makeConfig(), '/repo');
    await bridge.enrich();
    await bridge.shutdown();

    expect(shutdownAllMock).toHaveBeenCalledTimes(1);

    // Calling shutdown again after clearing must not re-invoke shutdownAll.
    await bridge.shutdown();
    expect(shutdownAllMock).toHaveBeenCalledTimes(1);
  });

  it('detects multiple indexed languages and passes the full set to resolveServers', async () => {
    const store = makeStore([
      makeFile({ id: 1, path: 'a.ts', language: 'typescript' }),
      makeFile({ id: 2, path: 'b.py', language: 'python' }),
      makeFile({ id: 3, path: 'c.txt', language: 'plaintext' }), // unsupported, filtered out
    ]);
    resolveServersMock.mockReturnValue([]);

    const bridge = new LspBridge(store, makeConfig(), '/repo');
    await bridge.enrich();

    expect(resolveServersMock).toHaveBeenCalledWith(
      expect.anything(),
      '/repo',
      new Set(['typescript', 'python']),
    );
  });
});
