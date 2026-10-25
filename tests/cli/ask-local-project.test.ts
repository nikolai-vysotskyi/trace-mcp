import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = vi.hoisted(() => ({ db: { close: vi.fn() } }));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(),
  hasRootMarkers: vi.fn(() => false),
}));

vi.mock('../../src/registry.js', () => ({
  getProject: vi.fn(),
  resolveRegisteredAncestor: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn(async () => ({ isErr: () => false, value: {} })),
}));

vi.mock('../../src/db/schema.js', () => ({
  initializeDatabase: vi.fn(() => db),
}));

vi.mock('../../src/db/store.js', () => ({
  Store: vi.fn(function Store() {
    return { db };
  }),
}));

vi.mock('../../src/plugin-api/registry.js', () => ({
  PluginRegistry: { createWithDefaults: vi.fn(() => ({})) },
}));

vi.mock('../../src/ai/ask-shared.js', () => ({
  resolveProvider: vi.fn(() => {
    throw new Error('provider reached');
  }),
}));

const { askCommand } = await import('../../src/cli/ask.js');
const { findProjectRoot } = await import('../../src/project-root.js');
const { getProject, resolveRegisteredAncestor } = await import('../../src/registry.js');
const { initializeDatabase } = await import('../../src/db/schema.js');

describe('ask local project resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue('/markerless/project/src');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.mocked(findProjectRoot).mockImplementation(() => {
      throw new Error('No project root markers found');
    });
  });

  it('loads the registered ancestor when cwd has no root markers', async () => {
    const entry = {
      name: 'project',
      root: '/markerless/project',
      dbPath: '/index/project.db',
      lastIndexed: null,
      addedAt: '2026-10-26T00:00:00Z',
    };
    vi.mocked(resolveRegisteredAncestor).mockReturnValue(entry);
    vi.mocked(getProject).mockReturnValue(entry);

    await askCommand.parseAsync(['node', 'trace-mcp', 'What is here?']);

    expect(resolveRegisteredAncestor).toHaveBeenCalledWith('/markerless/project/src');
    expect(getProject).not.toHaveBeenCalled();
    expect(initializeDatabase).toHaveBeenCalledWith('/index/project.db');
    expect(console.error).toHaveBeenCalledWith('Error: provider reached');
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('No project found'));
    expect(db.close).toHaveBeenCalled();
  });
});
