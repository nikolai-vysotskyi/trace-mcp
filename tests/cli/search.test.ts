import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, store } = vi.hoisted(() => ({
  db: { close: vi.fn() },
  store: {
    getSymbolBySymbolId: vi.fn(() => null),
    getSymbolByFqn: vi.fn(() => null),
    getFile: vi.fn(() => null),
  },
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(),
  hasRootMarkers: vi.fn(() => false),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(),
  resolveRegisteredAncestor: vi.fn(),
}));

vi.mock('../../src/db/schema.js', () => ({
  initializeDatabase: vi.fn(() => db),
}));

vi.mock('../../src/db/store.js', () => ({
  Store: vi.fn(function Store() {
    return { ...store, db };
  }),
}));

const { searchCommand } = await import('../../src/cli/search.js');
const { findProjectRoot, hasRootMarkers } = await import('../../src/project-root.js');
const { getProject, resolveRegisteredAncestor } = await import('../../src/registry.js');
const { initializeDatabase } = await import('../../src/db/schema.js');

describe('search project resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue('/markerless/project/src');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(findProjectRoot).mockImplementation(() => {
      throw new Error('No project root markers found');
    });
    vi.mocked(hasRootMarkers).mockReturnValue(false);
    vi.mocked(resolveRegisteredAncestor).mockReturnValue(null);
    vi.mocked(getProject).mockReturnValue(null);
  });

  it('searches the registered ancestor when cwd has no root markers', async () => {
    const entry = {
      name: 'project',
      root: '/markerless/project',
      dbPath: '/index/project.db',
      lastIndexed: null,
      addedAt: '2026-10-26T00:00:00Z',
    };
    vi.mocked(resolveRegisteredAncestor).mockReturnValue(entry);
    vi.mocked(getProject).mockReturnValue(entry);

    await searchCommand.parseAsync(['node', 'trace-mcp', 'missing', '--mode', 'get', '--json']);

    expect(resolveRegisteredAncestor).toHaveBeenCalledWith('/markerless/project/src');
    expect(getProject).not.toHaveBeenCalled();
    expect(initializeDatabase).toHaveBeenCalledWith('/index/project.db');
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ mode: 'get', item: null }, null, 2));
    expect(process.exit).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalled();
  });
});
