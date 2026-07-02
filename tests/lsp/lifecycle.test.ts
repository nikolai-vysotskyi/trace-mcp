/**
 * Tests for LspServerManager — lazy-start + concurrent-limit + shutdown
 * lifecycle for LSP server processes.
 *
 * Contract under test (per the module's own doc comment):
 *   - getClient() starts a server lazily, only for the requested language
 *   - a live client for an already-running language is reused, not restarted
 *   - a language that previously failed to start is never retried
 *     (the `failed` set gates all future getClient() calls for it)
 *   - the concurrent-server limit (`maxConcurrent`) is enforced: once that
 *     many languages are alive, getClient() for a new language returns null
 *     without attempting to spawn
 *   - a server that starts but doesn't support call hierarchy is shut down
 *     immediately and marked failed (never returned to the caller)
 *   - a server whose initialize() throws (crash / bad binary / timeout) is
 *     marked failed and getClient() returns null, without throwing out
 *   - activeLanguages() reflects only currently-alive clients
 *   - shutdownAll() shuts down every client, clears both the client map and
 *     the failed set (so a fresh manager instance could retry), and never
 *     throws even if one client's shutdown() rejects
 *
 * We never spawn a real LSP server: LspClient is mocked at the module
 * boundary (same seam bridge.test.ts uses for LspServerManager itself) so
 * getClient()'s decision logic is tested in isolation from the real
 * JSON-RPC/subprocess machinery already covered by client.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspServerSpec } from '../../src/lsp/config.js';

const initializeMock = vi.fn(async () => ({ capabilities: {} }));
const shutdownMock = vi.fn(async () => {});
let supportsCallHierarchyValue = true;
let isAliveValue = true;

vi.mock('../../src/lsp/client.js', () => ({
  LspClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = initializeMock;
    this.shutdown = shutdownMock;
    this.isAlive = () => isAliveValue;
    Object.defineProperty(this, 'supportsCallHierarchy', {
      get: () => supportsCallHierarchyValue,
    });
  }),
}));

import { LspServerManager } from '../../src/lsp/lifecycle.js';

function makeSpec(overrides: Partial<LspServerSpec> = {}): LspServerSpec {
  return {
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('LspServerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supportsCallHierarchyValue = true;
    isAliveValue = true;
    initializeMock.mockResolvedValue({ capabilities: {} });
  });

  it('starts a server lazily and returns the client on success', async () => {
    const manager = new LspServerManager([makeSpec()], '/repo', 2);

    const client = await manager.getClient('typescript');

    expect(client).not.toBeNull();
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(manager.activeLanguages()).toEqual(['typescript']);
  });

  it('returns null immediately for a language with no matching spec', async () => {
    const manager = new LspServerManager([makeSpec({ language: 'typescript' })], '/repo', 2);

    const client = await manager.getClient('python');

    expect(client).toBeNull();
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it('reuses an already-running client instead of starting a new one', async () => {
    const manager = new LspServerManager([makeSpec()], '/repo', 2);

    const first = await manager.getClient('typescript');
    const second = await manager.getClient('typescript');

    expect(first).toBe(second);
    expect(initializeMock).toHaveBeenCalledTimes(1); // not restarted
  });

  it('does not reuse a client that is no longer alive — starts a fresh one', async () => {
    const manager = new LspServerManager([makeSpec()], '/repo', 2);

    await manager.getClient('typescript');
    isAliveValue = false; // simulate the process having died
    await manager.getClient('typescript');

    expect(initializeMock).toHaveBeenCalledTimes(2);
  });

  it('never retries a language that previously failed to start', async () => {
    initializeMock.mockRejectedValueOnce(new Error('spawn ENOENT'));
    const manager = new LspServerManager([makeSpec()], '/repo', 2);

    const first = await manager.getClient('typescript');
    expect(first).toBeNull();

    const second = await manager.getClient('typescript');
    expect(second).toBeNull();
    // initialize() only attempted once — the `failed` set gated the retry.
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it('enforces the concurrent-server limit — a new language is refused once the cap is hit', async () => {
    const specs = [
      makeSpec({ language: 'typescript', command: 'tsserver' }),
      makeSpec({ language: 'python', command: 'pyright' }),
    ];
    const manager = new LspServerManager(specs, '/repo', 1); // cap = 1

    const ts = await manager.getClient('typescript');
    expect(ts).not.toBeNull();

    const py = await manager.getClient('python');
    expect(py).toBeNull();
    // The second language's initialize() must never have been attempted —
    // the cap check happens before spawning.
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it('shuts down and marks failed a server that does not support call hierarchy', async () => {
    supportsCallHierarchyValue = false;
    const manager = new LspServerManager([makeSpec()], '/repo', 2);

    const client = await manager.getClient('typescript');

    expect(client).toBeNull();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(manager.activeLanguages()).toEqual([]);

    // Subsequent calls must not retry (now in the failed set).
    await manager.getClient('typescript');
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it('marks a language failed (without throwing) when initialize() rejects', async () => {
    initializeMock.mockRejectedValueOnce(new Error('timed out waiting for server'));
    const manager = new LspServerManager([makeSpec()], '/repo', 2);

    await expect(manager.getClient('typescript')).resolves.toBeNull();
  });

  it('activeLanguages() only reports languages with a currently-alive client', async () => {
    const specs = [
      makeSpec({ language: 'typescript', command: 'tsserver' }),
      makeSpec({ language: 'python', command: 'pyright' }),
    ];
    const manager = new LspServerManager(specs, '/repo', 2);

    await manager.getClient('typescript');
    await manager.getClient('python');
    expect(manager.activeLanguages().sort()).toEqual(['python', 'typescript']);
  });

  it('shutdownAll() shuts down every client and clears both the client and failed sets', async () => {
    initializeMock.mockRejectedValueOnce(new Error('python server missing'));
    const specs = [
      makeSpec({ language: 'typescript', command: 'tsserver' }),
      makeSpec({ language: 'python', command: 'pyright' }),
    ];
    const manager = new LspServerManager(specs, '/repo', 2);

    await manager.getClient('typescript'); // succeeds
    await manager.getClient('python'); // fails, goes into `failed`

    await manager.shutdownAll();

    expect(shutdownMock).toHaveBeenCalledTimes(1); // only the live ts client
    expect(manager.activeLanguages()).toEqual([]);

    // failed set was cleared too — a language that failed before shutdownAll
    // gets a fresh attempt afterward (e.g. daemon restart scenario).
    initializeMock.mockClear();
    initializeMock.mockResolvedValueOnce({ capabilities: {} });
    const retried = await manager.getClient('python');
    expect(retried).not.toBeNull();
  });

  it('shutdownAll() never throws even if a client shutdown() rejects', async () => {
    shutdownMock.mockRejectedValueOnce(new Error('process already dead'));
    const manager = new LspServerManager([makeSpec()], '/repo', 2);
    await manager.getClient('typescript');

    await expect(manager.shutdownAll()).resolves.toBeUndefined();
    expect(manager.activeLanguages()).toEqual([]);
  });
});
