/**
 * Behavioral tests for src/cli/status.ts — `trace-mcp status`.
 *
 * Drives the real `statusCommand` through `.parseAsync` with `better-sqlite3`,
 * `../progress.js`, `../registry.js`, `../project-root.js`, and `node:fs`
 * fully mocked. No real SQLite database or project directory is touched.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbInstance = {
  pragma: vi.fn(),
  prepare: vi.fn(),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function Database() {
    return dbInstance;
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn() },
    existsSync: vi.fn(),
  };
});

vi.mock('../../src/progress.js', () => ({
  isServerRunning: vi.fn(() => false),
  readProgressFromDb: vi.fn(() => null),
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(() => null),
}));

vi.mock('../../src/global.js', () => ({
  getDbPath: vi.fn((root: string) => `/idx/fallback-${root}.db`),
}));

const { statusCommand } = await import('../../src/cli/status.js');
const { isServerRunning, readProgressFromDb } = await import('../../src/progress.js');
const { findProjectRoot } = await import('../../src/project-root.js');
const { getProject } = await import('../../src/registry.js');

const mockExistsSync = vi.mocked(fs.existsSync);
const mockIsServerRunning = vi.mocked(isServerRunning);
const mockReadProgressFromDb = vi.mocked(readProgressFromDb);
const mockFindProjectRoot = vi.mocked(findProjectRoot);
const mockGetProject = vi.mocked(getProject);

async function run(args: string[]): Promise<void> {
  await statusCommand.parseAsync(['node', 'trace-mcp-status', ...args]);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function printed(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindProjectRoot.mockReturnValue('/proj/current');
  mockGetProject.mockReturnValue(null);
  mockExistsSync.mockReturnValue(true);
  mockIsServerRunning.mockReturnValue(false);
  mockReadProgressFromDb.mockReturnValue(null);
  dbInstance.prepare.mockReturnValue({
    get: vi.fn(() => ({ files: 0, symbols: 0, edges: 0 })),
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

describe('status — no index found', () => {
  it('reports missing index and exits 1 when the DB file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    await run([]);

    expect(printed()).toContain('No index found for /proj/current');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('status — empty index', () => {
  it('reports the empty-index hint when there is no progress and no stats', async () => {
    await run([]);

    expect(printed()).toContain('Index is empty');
    expect(printed()).toContain('0 files');
  });

  it('reports server-running-waiting when server is up but nothing indexed yet', async () => {
    mockIsServerRunning.mockReturnValue(true);

    await run([]);

    expect(printed()).toContain('Server is running, waiting for initial indexing');
  });
});

describe('status — indexed project (no active progress)', () => {
  beforeEach(() => {
    dbInstance.prepare.mockReturnValue({
      get: vi.fn(() => ({ files: 42, symbols: 500, edges: 900 })),
    });
  });

  it('reports up to date when server is running', async () => {
    mockIsServerRunning.mockReturnValue(true);

    await run([]);

    expect(printed()).toContain('Index is up to date');
    expect(printed()).toContain('42 files');
    expect(printed()).toContain('500 symbols');
    expect(printed()).toContain('900 edges');
  });

  it('reports indexed-but-server-not-running when server is down', async () => {
    mockIsServerRunning.mockReturnValue(false);

    await run([]);

    expect(printed()).toContain('Project indexed (server not running');
  });
});

describe('status — active progress', () => {
  it('renders per-pipeline running/completed/error phases', async () => {
    mockReadProgressFromDb.mockReturnValue({
      indexing: {
        phase: 'running',
        processed: 30,
        total: 100,
        startedAt: 1,
        completedAt: 0,
        percentage: 30,
        elapsedMs: 5_000,
      },
      summarization: {
        phase: 'completed',
        processed: 100,
        total: 100,
        startedAt: 1,
        completedAt: 2,
        percentage: 100,
        elapsedMs: 10_000,
      },
      embedding: {
        phase: 'error',
        processed: 0,
        total: 0,
        startedAt: 1,
        completedAt: 0,
        percentage: null,
        elapsedMs: 0,
        error: 'embedding provider unreachable',
      },
    });

    await run([]);

    const out = printed();
    expect(out).toMatch(/Indexing:\s+running\s+30\/100 \(30%\)/);
    expect(out).toMatch(/Summarization:\s+completed\s+100\/100 \(100%\)/);
    expect(out).toMatch(/Embedding:\s+error\s+embedding provider unreachable/);
  });

  it('formats elapsed time in minutes+seconds for long-running phases', async () => {
    mockReadProgressFromDb.mockReturnValue({
      indexing: {
        phase: 'running',
        processed: 1,
        total: 10,
        startedAt: 1,
        completedAt: 0,
        percentage: 10,
        elapsedMs: 125_000, // 2m 5s
      },
      summarization: {
        phase: 'idle',
        processed: 0,
        total: 0,
        startedAt: 0,
        completedAt: 0,
        percentage: null,
        elapsedMs: 0,
      },
      embedding: {
        phase: 'idle',
        processed: 0,
        total: 0,
        startedAt: 0,
        completedAt: 0,
        percentage: null,
        elapsedMs: 0,
      },
    });

    await run([]);

    expect(printed()).toContain('2m 5s elapsed');
  });
});

describe('status --json', () => {
  it('emits a JSON payload with projectRoot, stats, progress, serverRunning', async () => {
    mockIsServerRunning.mockReturnValue(true);
    dbInstance.prepare.mockReturnValue({
      get: vi.fn(() => ({ files: 5, symbols: 20, edges: 15 })),
    });

    await run(['--json']);

    const out = printed();
    const parsed = JSON.parse(out);
    expect(parsed.projectRoot).toBe('/proj/current');
    expect(parsed.stats).toEqual({ files: 5, symbols: 20, edges: 15 });
    expect(parsed.serverRunning).toBe(true);
    expect(parsed.progress).toBeNull();
  });
});

describe('status — dbPath resolution', () => {
  it('uses the registry dbPath when the project is registered', async () => {
    mockGetProject.mockReturnValue({
      name: 'myapp',
      root: '/proj/current',
      dbPath: '/idx/myapp-registered.db',
      lastIndexed: null,
      addedAt: 'x',
    });

    await run(['--json']);

    expect(mockExistsSync).toHaveBeenCalledWith('/idx/myapp-registered.db');
  });

  it('falls back to getDbPath when the project is not registered', async () => {
    mockGetProject.mockReturnValue(null);

    await run(['--json']);

    expect(mockExistsSync).toHaveBeenCalledWith('/idx/fallback-/proj/current.db');
  });

  it('falls back to process.cwd() when findProjectRoot throws', async () => {
    mockFindProjectRoot.mockImplementation(() => {
      throw new Error('no markers');
    });

    await run(['--json']);

    const out = printed();
    const parsed = JSON.parse(out);
    expect(parsed.projectRoot).toBe(process.cwd());
  });
});
