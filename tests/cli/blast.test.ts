/**
 * Behavioral tests for src/cli/blast.ts — `trace blast` and `trace impact`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbInstance = { close: vi.fn() };
const mockGetFile = vi.fn();
const mockGetSymbolsByFile = vi.fn();
const mockGetSymbolBySymbolId = vi.fn();
const mockCountSymbolsByName = vi.fn();

const storeInstance = {
  db: dbInstance,
  getFile: mockGetFile,
  getSymbolsByFile: mockGetSymbolsByFile,
  getSymbolBySymbolId: mockGetSymbolBySymbolId,
  countSymbolsByName: mockCountSymbolsByName,
};

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.endsWith('.db')) return true;
        return actual.default.existsSync(p);
      }),
    },
  };
});

vi.mock('../../src/config.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/config.js')>()),
  loadConfig: vi.fn(),
}));

vi.mock('../../src/db/schema.js', () => ({
  initializeDatabase: vi.fn(() => dbInstance),
}));

vi.mock('../../src/db/store.js', () => ({
  Store: vi.fn(function Store() {
    return storeInstance;
  }),
}));

vi.mock('../../src/global.js', () => ({
  ensureGlobalDirs: vi.fn(),
  getDbPath: vi.fn(() => '/idx/test.db'),
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/test'),
  hasRootMarkers: vi.fn(() => true),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(() => ({ dbPath: '/idx/test.db' })),
}));

vi.mock('../../src/tools/git/git-analysis.js', () => ({
  isGitRepo: vi.fn(() => true),
}));

vi.mock('../../src/tools/analysis/impact.js', () => ({
  getChangeImpact: vi.fn(),
}));

vi.mock('../../src/tools/quality/changed-symbols.js', () => ({
  getChangedSymbols: vi.fn(),
}));

vi.mock('../../src/tools/shared/resolve.js', () => ({
  resolveSymbolInput: vi.fn(),
}));

const { blastCommand } = await import('../../src/cli/blast.js');
const { loadConfig } = await import('../../src/config.js');
const { getChangeImpact } = await import('../../src/tools/analysis/impact.js');
const { getChangedSymbols } = await import('../../src/tools/quality/changed-symbols.js');
const { resolveSymbolInput } = await import('../../src/tools/shared/resolve.js');
const { isGitRepo } = await import('../../src/tools/git/git-analysis.js');
const fs = (await import('node:fs')).default;

const mockLoadConfig = vi.mocked(loadConfig);
const mockGetChangeImpact = vi.mocked(getChangeImpact);
const mockGetChangedSymbols = vi.mocked(getChangedSymbols);
const mockResolveSymbolInput = vi.mocked(resolveSymbolInput);
const mockIsGitRepo = vi.mocked(isGitRepo);
const mockFsExistsSync = vi.mocked(fs.existsSync);

async function run(args: string[]): Promise<void> {
  await blastCommand.parseAsync(['node', 'trace-blast', ...args]);
}

class ProcessExitSignal extends Error {
  code?: number;
  constructor(code?: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function okImpact(level: 'low' | 'medium' | 'high' | 'critical' = 'low', score = 25) {
  return {
    isOk: () => true,
    isErr: () => false,
    value: {
      target: { path: 'src/foo.ts', symbolName: 'foo', kind: 'function' },
      summary: {
        totalFiles: 2,
        totalSymbols: 3,
        maxDepth: 2,
        crossBoundary: false,
        publicApiAffected: 0,
        untestedDependents: 0,
        highComplexityDependents: 0,
        sentence: 'Impact summary sentence.',
      },
      risk: {
        score,
        level,
        publicApiBreaking: false,
        untestedRatio: 0,
        maxComplexity: 5,
        mitigations: ['Run tests'],
      },
      totalAffected: 3,
      dependents: [
        {
          path: 'src/bar.ts',
          depth: 1,
          edgeTypes: ['calls'],
          symbols: [{ symbolId: 's2', symbolName: 'bar', symbolKind: 'function' }],
        },
      ],
      affectedTests: { total: 1, files: ['tests/bar.test.ts'] },
      breakingChanges: [],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
  } as any;
}

function okChangedSymbols(symbols: Array<{ symbolId: string; name: string; file: string }> = []) {
  return {
    isOk: () => true,
    isErr: () => false,
    value: {
      since: 'origin/main',
      until: 'HEAD',
      changedFiles: symbols.length ? 1 : 0,
      changedSymbols: symbols.map((s) => ({
        symbolId: s.symbolId,
        name: s.name,
        kind: 'function',
        fqn: s.name,
        file: s.file,
        changeKind: 'modified' as const,
        linesChanged: 10,
        blastRadius: 5,
      })),
      summary: { added: 0, modified: symbols.length, removed: 0, renamed: 0 },
      staleFiles: [],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Result stub
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockResolvedValue({
    isOk: () => true,
    isErr: () => false,
    value: { root: '/proj/test' },
    // biome-ignore lint/suspicious/noExplicitAny: minimal config stub
  } as any);

  mockFsExistsSync.mockImplementation((p: unknown) => {
    if (typeof p === 'string' && (p.endsWith('.db') || p === '/proj/test')) return true;
    return false;
  });
  mockIsGitRepo.mockReturnValue(true);
  mockGetFile.mockReturnValue(undefined);
  mockGetSymbolsByFile.mockReturnValue([]);
  mockGetSymbolBySymbolId.mockReturnValue({ symbol_id: 's1', name: 'foo', file_id: 1 });
  mockCountSymbolsByName.mockReturnValue(0);
  mockResolveSymbolInput.mockReturnValue(null);

  mockGetChangeImpact.mockReturnValue(okImpact());
  mockGetChangedSymbols.mockResolvedValue(okChangedSymbols());

  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code);
  }) as any);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('trace blast — command aliases & basics', () => {
  it('has alias "impact"', () => {
    expect(blastCommand.aliases()).toContain('impact');
  });

  it('fails if db does not exist', async () => {
    mockFsExistsSync.mockReturnValue(false);
    await expect(run(['src/foo.ts'])).rejects.toThrow(ProcessExitSignal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Project not indexed'));
  });
});

describe('trace blast — target mode', () => {
  it('analyzes a target file when found in store', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });

    await run(['src/foo.ts']);

    expect(mockGetChangeImpact).toHaveBeenCalledWith(
      storeInstance,
      expect.objectContaining({ filePath: 'src/foo.ts' }),
      3,
      200,
      '/proj/test',
    );
  });

  it('resolves line number in target file:line', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });
    mockGetSymbolsByFile.mockReturnValue([
      { symbol_id: 'sym_fn', name: 'myFunc', line_start: 10, line_end: 25 },
    ]);

    await run(['src/foo.ts:15']);

    expect(mockGetChangeImpact).toHaveBeenCalledWith(
      storeInstance,
      expect.objectContaining({ filePath: 'src/foo.ts', symbolId: 'sym_fn' }),
      3,
      200,
      '/proj/test',
    );
  });

  it('resolves target as a symbol when not a file', async () => {
    mockGetFile.mockReturnValue(undefined);
    mockResolveSymbolInput.mockReturnValue({
      symbol: { symbol_id: 'sym_123', name: 'myHelper', fqn: 'pkg.myHelper' } as any,
      file: { id: 2, path: 'src/helper.ts' } as any,
      resolved_via: 'symbol_id',
    });

    await run(['myHelper']);

    expect(mockGetChangeImpact).toHaveBeenCalledWith(
      storeInstance,
      expect.objectContaining({ symbolId: 'sym_123', fqn: 'pkg.myHelper' }),
      3,
      200,
      '/proj/test',
    );
  });

  it('errors when target is not found as file or symbol', async () => {
    mockGetFile.mockReturnValue(undefined);
    mockResolveSymbolInput.mockReturnValue(null);

    await expect(run(['nonexistent.ts'])).rejects.toThrow(ProcessExitSignal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found in project index'));
  });

  it('warns when file exists on disk but is not indexed', async () => {
    mockGetFile.mockReturnValue(undefined);
    mockResolveSymbolInput.mockReturnValue(null);
    mockFsExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && (p.endsWith('.db') || p.includes('unindexed.ts'))) return true;
      return false;
    });

    await expect(run(['unindexed.ts'])).rejects.toThrow(ProcessExitSignal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('exists on disk but is not indexed'),
    );
  });

  it('warns when multiple symbols match the given name', async () => {
    mockGetFile.mockReturnValue(undefined);
    mockResolveSymbolInput.mockReturnValue(null);
    mockCountSymbolsByName.mockReturnValue(3);

    await expect(run(['duplicateName'])).rejects.toThrow(ProcessExitSignal);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Multiple symbols (3) match name'),
    );
  });
});

describe('trace blast — diff mode', () => {
  it('runs git diff when target is omitted', async () => {
    mockGetChangedSymbols.mockResolvedValue(
      okChangedSymbols([{ symbolId: 's1', name: 'handleReq', file: 'src/api.ts' }]),
    );

    await run([]);

    expect(mockGetChangedSymbols).toHaveBeenCalledWith(
      storeInstance,
      '/proj/test',
      expect.objectContaining({ includeBlastRadius: true }),
    );
    expect(mockGetChangeImpact).toHaveBeenCalledWith(
      storeInstance,
      expect.objectContaining({ symbolIds: ['s1'] }),
      3,
      200,
      '/proj/test',
    );
  });

  it('handles empty diff gracefully', async () => {
    mockGetChangedSymbols.mockResolvedValue(okChangedSymbols([]));

    await run([]);

    expect(mockGetChangeImpact).not.toHaveBeenCalled();
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('No changed symbols detected in diff range');
  });

  it('errors if not a git repo in diff mode', async () => {
    mockIsGitRepo.mockReturnValue(false);

    await expect(run([])).rejects.toThrow(ProcessExitSignal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires a git repository'));
  });

  it('rejects unsafe git refs', async () => {
    await expect(run(['--since', '; rm -rf /;'])).rejects.toThrow(ProcessExitSignal);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid git ref'));
  });

  it('filters git diff to target file when --diff is passed with target', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });
    mockGetChangedSymbols.mockResolvedValue(
      okChangedSymbols([
        { symbolId: 's1', name: 'fooFn', file: 'src/foo.ts' },
        { symbolId: 's2', name: 'otherFn', file: 'src/other.ts' },
      ]),
    );

    await run(['src/foo.ts', '--diff']);

    expect(mockGetChangeImpact).toHaveBeenCalledWith(
      storeInstance,
      expect.objectContaining({ symbolIds: ['s1'] }),
      3,
      200,
      '/proj/test',
    );
  });
});

describe('trace blast — options, formatting & exit codes', () => {
  it('supports --json flag and emits valid JSON report', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });

    await run(['src/foo.ts', '--json']);

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.mode).toBe('target');
    expect(parsed.totalAffected).toBe(3);
    expect(parsed.risk.score).toBe(25);
  });

  it('passes custom --depth and --max-dependents', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });

    await run(['src/foo.ts', '--depth', '5', '--max-dependents', '50']);

    expect(mockGetChangeImpact).toHaveBeenCalledWith(
      storeInstance,
      expect.anything(),
      5,
      50,
      '/proj/test',
    );
  });

  it('fails with exit code 1 when risk meets or exceeds --fail-on threshold', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });
    mockGetChangeImpact.mockReturnValue(okImpact('high', 80));

    await expect(run(['src/foo.ts', '--fail-on', 'high'])).rejects.toThrow(ProcessExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes when risk is below --fail-on threshold', async () => {
    mockGetFile.mockReturnValue({ id: 1, path: 'src/foo.ts' });
    mockGetChangeImpact.mockReturnValue(okImpact('low', 20));

    await run(['src/foo.ts', '--fail-on', 'high']);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
