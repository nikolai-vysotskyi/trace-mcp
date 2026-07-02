/**
 * Behavioral tests for src/cli/bundles.ts — `trace-mcp bundles list|export|remove`.
 *
 * Drives the real `bundlesCommand` (a commander.js Command with subcommands)
 * through `.parseAsync`, with the underlying `../bundles.js` persistence
 * layer and project-resolution helpers fully mocked. No real bundle files,
 * DB, or project registry are touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/bundles.js', () => ({
  ensureBundlesDir: vi.fn(),
  exportBundle: vi.fn(),
  listBundles: vi.fn(),
  removeBundle: vi.fn(),
}));

vi.mock('../../src/global.js', () => ({
  ensureGlobalDirs: vi.fn(),
  getDbPath: vi.fn((root: string) => `/idx/fallback-${root}.db`),
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(() => null),
}));

const { bundlesCommand } = await import('../../src/cli/bundles.js');
const { ensureBundlesDir, exportBundle, listBundles, removeBundle } = await import(
  '../../src/bundles.js'
);
const { getProject } = await import('../../src/registry.js');

const mockEnsureBundlesDir = vi.mocked(ensureBundlesDir);
const mockExportBundle = vi.mocked(exportBundle);
const mockListBundles = vi.mocked(listBundles);
const mockRemoveBundle = vi.mocked(removeBundle);
const mockGetProject = vi.mocked(getProject);

async function run(args: string[]): Promise<void> {
  await bundlesCommand.parseAsync(['node', 'trace-mcp-bundles', ...args]);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProject.mockReturnValue(null);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

function printed(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('bundles list', () => {
  it('prints a hint when there are no installed bundles', async () => {
    mockListBundles.mockReturnValue([]);

    await run(['list']);

    expect(mockEnsureBundlesDir).toHaveBeenCalled();
    expect(printed()).toContain('No bundles installed.');
    expect(printed()).toContain('trace-mcp bundles export');
  });

  it('lists each installed bundle with symbol/edge/size stats', async () => {
    mockListBundles.mockReturnValue([
      {
        package: 'react',
        version: '19.1.0',
        file: 'react-19.1.0.bundle',
        symbols: 1200,
        edges: 3400,
        size_bytes: 2_048_000,
        created_at: '2026-06-01T00:00:00.000Z',
        sha256: 'abc123',
      },
    ]);

    await run(['list']);

    const out = printed();
    expect(out).toContain('react@19.1.0');
    expect(out).toContain('Symbols: 1200');
    expect(out).toContain('Edges: 3400');
    expect(out).toContain('2000KB');
    expect(out).toContain('2026-06-01T00:00:00.000Z');
  });
});

describe('bundles export', () => {
  it('exports the current project index using the registry dbPath when registered', async () => {
    mockGetProject.mockReturnValue({
      name: 'myapp',
      root: '/proj/current',
      dbPath: '/idx/myapp-abc123.db',
      lastIndexed: null,
      addedAt: 'x',
    });
    mockExportBundle.mockReturnValue({
      package: 'myapp',
      version: '1.0.0',
      file: 'myapp-1.0.0.bundle',
      symbols: 500,
      edges: 900,
      size_bytes: 512_000,
      created_at: '2026-07-02T00:00:00.000Z',
      sha256: 'deadbeef',
    });

    await run(['export', '--package', 'myapp', '--version', '1.0.0']);

    expect(mockExportBundle).toHaveBeenCalledWith('/idx/myapp-abc123.db', 'myapp', '1.0.0');
    const out = printed();
    expect(out).toContain('Bundle exported: myapp@1.0.0');
    expect(out).toContain('SHA256: deadbeef');
    expect(out).toContain('Symbols: 500');
  });

  it('falls back to getDbPath when the project is not registered', async () => {
    mockGetProject.mockReturnValue(null);
    mockExportBundle.mockReturnValue({
      package: 'unreg',
      version: '0.1.0',
      file: 'unreg-0.1.0.bundle',
      symbols: 10,
      edges: 5,
      size_bytes: 1024,
      created_at: 'x',
      sha256: 'x',
    });

    await run(['export', '--package', 'unreg', '--version', '0.1.0']);

    expect(mockExportBundle).toHaveBeenCalledWith(
      '/idx/fallback-/proj/current.db',
      'unreg',
      '0.1.0',
    );
  });

  it('requires --package and --version (commander enforces requiredOption)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exportSub = bundlesCommand.commands.find((c) => c.name() === 'export');
    exportSub?.exitOverride();
    try {
      await expect(run(['export', '--package', 'onlypkg'])).rejects.toThrow(
        /required option.*--version/,
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(mockExportBundle).not.toHaveBeenCalled();
  });
});

describe('bundles remove', () => {
  it('reports the removed count when bundles were found', async () => {
    mockRemoveBundle.mockReturnValue(2);

    await run(['remove', '--package', 'react']);

    expect(mockRemoveBundle).toHaveBeenCalledWith('react', undefined);
    expect(printed()).toContain('Removed 2 bundle(s) for react');
  });

  it('scopes removal to a specific version when --version is passed', async () => {
    mockRemoveBundle.mockReturnValue(1);

    await run(['remove', '--package', 'react', '--version', '18.0.0']);

    expect(mockRemoveBundle).toHaveBeenCalledWith('react', '18.0.0');
  });

  it('reports zero found when nothing matches', async () => {
    mockRemoveBundle.mockReturnValue(0);

    await run(['remove', '--package', 'nonexistent', '--version', '9.9.9']);

    expect(printed()).toContain('No bundles found for nonexistent@9.9.9');
  });
});
