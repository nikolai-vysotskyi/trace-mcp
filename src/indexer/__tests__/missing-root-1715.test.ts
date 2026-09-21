/**
 * TRA-1715: the daemon rescanned roots that no longer exist on disk (deleted
 * task workdirs) — 3317 `Cannot read file` warns with no root and no cause,
 * a pipeline that "completed" with 100% errors, and /health still `ready`.
 *
 * Two pins here:
 *  1. `indexAll` on a vanished root is a zero-work no-op that PRESERVES the
 *     stored index. Without the guard the full walk resolves to zero files
 *     and `reconcileScope` drops every indexed row — a healthy index
 *     destroyed for what may be a transient unmount.
 *  2. The `Cannot read file` record carries `rootPath` + errno `code` +
 *     message, so the daemon log alone answers which project lost which
 *     file and why (ENOENT vs EACCES).
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { FileExtractor } from '../file-extractor.js';
import { IndexingPipeline } from '../pipeline.js';
import { buildProjectContext } from '../project-context.js';

let tmpHome: string;
let projDir: string;
let db: Database.Database;
let store: Store;
let pipeline: IndexingPipeline;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-missing-root-'));
  projDir = join(tmpHome, 'proj');
  mkdirSync(join(projDir, 'src'), { recursive: true });
  writeFileSync(join(projDir, 'src', 'a.ts'), 'export function a(): number { return 1; }\n');

  // The index DB lives OUTSIDE the project root (like the daemon's global
  // index dir), so deleting the root does not delete the index with it.
  db = initializeDatabase(join(tmpHome, 'index.db'));
  store = new Store(db);
  pipeline = new IndexingPipeline(
    store,
    PluginRegistry.createWithDefaults(),
    TraceMcpConfigSchema.parse({}),
    projDir,
  );
});

afterEach(async () => {
  await pipeline.dispose?.();
  try {
    db.close();
  } catch {
    /* best-effort */
  }
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('indexAll on a vanished root (TRA-1715)', () => {
  it('returns a zero-work result and preserves the stored index', async () => {
    const first = await pipeline.indexAll();
    expect(first.errors).toBe(0);
    expect(first.indexed).toBeGreaterThan(0);
    const symbolsBefore = store.getStats().totalSymbols;
    expect(symbolsBefore).toBeGreaterThan(0);

    // The task finished and its workdir was removed from under the daemon.
    rmSync(projDir, { recursive: true, force: true });

    const r = await pipeline.indexAll();
    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
    expect(r.errors).toBe(0);
    // No scope reconcile ran: every previously indexed row survives.
    expect(store.getStats().totalSymbols).toBe(symbolsBefore);
  });
});

describe('Cannot read file diagnostics (TRA-1715)', () => {
  it('logs rootPath + errno code + message, not just the file', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const extractor = new FileExtractor({
      registry: PluginRegistry.createWithDefaults(),
      rootPath: join(tmpHome, 'gone-root'),
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpHome),
      existingFiles: new Map(),
    });

    const res = await extractor.extract('src/a.ts', false);
    expect(res.kind).toBe('error');

    const call = warnSpy.mock.calls.find(([, msg]) => msg === 'Cannot read file');
    expect(call).toBeDefined();
    expect(call![0]).toMatchObject({
      file: 'src/a.ts',
      rootPath: join(tmpHome, 'gone-root'),
      code: 'ENOENT',
    });
    expect(String((call![0] as Record<string, unknown>).error)).toMatch(/ENOENT/);
  });
});
