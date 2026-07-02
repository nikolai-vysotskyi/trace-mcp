/**
 * Behavioral tests for src/cli/remove.ts — `trace-mcp remove [dir]`.
 *
 * Drives the real `removeCommand` (a commander.js Command) through
 * `.parseAsync`, with every collaborator mocked: registry lookups, config
 * removal, topology cleanup, filesystem, and the @clack/prompts confirm
 * dialog. This exercises the actual option-parsing + branching logic
 * (not-registered / single-project / multi-root with 0, 1, or 2+ remaining
 * children / --force / --keep-db / --json) without touching a real project,
 * DB file, or terminal prompt.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(), unlinkSync: vi.fn() },
    existsSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../../src/config.js', () => ({
  removeProjectConfig: vi.fn(),
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(),
}));

vi.mock('../../src/registry.js', () => ({
  findParentProject: vi.fn(),
  getProject: vi.fn(),
  unregisterProject: vi.fn(),
}));

vi.mock('../../src/topology/topology-db.js', () => ({
  TopologyStore: vi.fn(function TopologyStore() {
    return {
      removeByRepoRoot: vi.fn(() => ({ subprojects: 0, services: 0 })),
      close: vi.fn(),
    };
  }),
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  confirm: vi.fn(async () => true),
  log: { warn: vi.fn(), info: vi.fn() },
}));

const { removeCommand } = await import('../../src/cli/remove.js');
const { findProjectRoot } = await import('../../src/project-root.js');
const { findParentProject, getProject, unregisterProject } = await import('../../src/registry.js');
const { removeProjectConfig } = await import('../../src/config.js');
const p = await import('@clack/prompts');

const mockExistsSync = vi.mocked(fs.existsSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);
const mockFindProjectRoot = vi.mocked(findProjectRoot);
const mockFindParentProject = vi.mocked(findParentProject);
const mockGetProject = vi.mocked(getProject);
const mockUnregisterProject = vi.mocked(unregisterProject);
const mockRemoveProjectConfig = vi.mocked(removeProjectConfig);

async function run(args: string[]): Promise<void> {
  await removeCommand.parseAsync(['node', 'trace-mcp-remove', ...args]);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockFindParentProject.mockReturnValue(null);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  vi.mocked(p.confirm)
    .mockReset()
    .mockImplementation(async () => true);
  vi.mocked(p.isCancel).mockReset().mockReturnValue(false);
});

describe('remove — not registered', () => {
  it('emits a not_registered JSON payload and does not touch fs/registry', async () => {
    mockFindProjectRoot.mockReturnValue('/proj/unregistered');
    mockGetProject.mockReturnValue(null);

    await run(['/proj/unregistered', '--json']);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"status":"not_registered"');
    expect(mockUnregisterProject).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('falls back to the resolved dir when findProjectRoot throws', async () => {
    mockFindProjectRoot.mockImplementation(() => {
      throw new Error('no root markers');
    });
    mockGetProject.mockReturnValue(null);

    await run(['/proj/no-markers', '--json']);

    expect(mockGetProject).toHaveBeenCalledWith('/proj/no-markers');
  });
});

describe('remove — single project', () => {
  const entry = {
    name: 'myapp',
    root: '/proj/myapp',
    dbPath: '/idx/myapp-abc123.db',
    lastIndexed: null,
    addedAt: 'x',
  };

  beforeEach(() => {
    mockFindProjectRoot.mockReturnValue('/proj/myapp');
    mockGetProject.mockReturnValue(entry);
  });

  it('--force --json removes without prompting and deletes the DB', async () => {
    await run(['/proj/myapp', '--force', '--json']);

    expect(p.confirm).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalledWith(entry.dbPath);
    expect(mockRemoveProjectConfig).toHaveBeenCalledWith(entry.root);
    expect(mockUnregisterProject).toHaveBeenCalledWith(entry.root);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"status": "removed"');
    expect(printed).toContain('"dbDeleted": true');
  });

  it('--keep-db skips deleting the database file', async () => {
    await run(['/proj/myapp', '--force', '--keep-db', '--json']);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"dbDeleted": false');
  });

  it('respects a declined confirmation prompt (non-JSON, no --force)', async () => {
    vi.mocked(p.confirm).mockResolvedValue(false);

    await run(['/proj/myapp']);

    expect(mockUnregisterProject).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalled();
  });

  it('treats an isCancel() prompt result as a cancellation', async () => {
    vi.mocked(p.isCancel).mockReturnValue(true);

    await run(['/proj/myapp']);

    expect(mockUnregisterProject).not.toHaveBeenCalled();
  });

  it('proceeds without prompting when --force is set, even without --json', async () => {
    await run(['/proj/myapp', '--force']);

    expect(p.confirm).not.toHaveBeenCalled();
    expect(mockUnregisterProject).toHaveBeenCalledWith(entry.root);
  });

  it('does not unlink the DB when it does not exist on disk', async () => {
    mockExistsSync.mockReturnValue(false);

    await run(['/proj/myapp', '--force', '--json']);

    expect(mockUnlinkSync).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"dbDeleted": false');
  });
});

describe('remove — multi-root child', () => {
  const parent = {
    name: 'monorepo',
    root: '/proj/monorepo',
    dbPath: '/idx/monorepo-abc123.db',
    type: 'multi-root',
    children: ['/proj/monorepo/a', '/proj/monorepo/b'],
  };

  it('removing the entire multi-root when 0 children remain', async () => {
    mockFindProjectRoot.mockReturnValue('/proj/monorepo/a');
    mockFindParentProject.mockReturnValue({
      ...parent,
      children: ['/proj/monorepo/a'],
    });

    await run(['/proj/monorepo/a', '--force', '--json']);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"status": "removed_multi_root"');
    expect(mockUnregisterProject).toHaveBeenCalledWith(parent.root);
  });

  it('converts to a single project when exactly 1 child remains', async () => {
    mockFindProjectRoot.mockReturnValue('/proj/monorepo/a');
    mockFindParentProject.mockReturnValue(parent);

    await run(['/proj/monorepo/a', '--force', '--json']);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"status": "excluded_from_multi_root"');
    expect(printed).toContain('"remaining": "b"');
    expect(printed).toMatch(/trace-mcp add \/proj\/monorepo\/b/);
  });

  it('keeps the multi-root registered (with a re-add hint) when 2+ children remain', async () => {
    mockFindProjectRoot.mockReturnValue('/proj/monorepo/a');
    mockFindParentProject.mockReturnValue({
      ...parent,
      children: ['/proj/monorepo/a', '/proj/monorepo/b', '/proj/monorepo/c'],
    });

    await run(['/proj/monorepo/a', '--force', '--json']);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"status": "excluded_from_multi_root"');
    expect(printed).toMatch(/"remaining": \[\s*"b",\s*"c"\s*\]/);
    // Parent is unregistered either way — user must re-add.
    expect(mockUnregisterProject).toHaveBeenCalledWith(parent.root);
  });

  it('respects a declined confirmation for multi-root removal (non-JSON)', async () => {
    mockFindProjectRoot.mockReturnValue('/proj/monorepo/a');
    mockFindParentProject.mockReturnValue(parent);
    vi.mocked(p.confirm).mockResolvedValue(false);

    await run(['/proj/monorepo/a']);

    expect(mockUnregisterProject).not.toHaveBeenCalled();
  });
});
