/**
 * TRA-3119: Codex CLI shell state snapshot churn protection.
 *
 * Codex writes a shell state snapshot per session to
 * `shell_snapshots/<uuid>.<ts>.sh` and prunes old ones per its own retention
 * policy. When the indexer discovers a snapshot just before Codex prunes it,
 * reading it races with deletion, producing L40 `Cannot read file` ENOENT
 * warnings (137 observed on a live daemon) without any real indexing failure.
 *
 * Requirements:
 *  1. `isHotChurnPath` identifies `shell_snapshots/*.sh` as hot churn.
 *  2. Real source files under `src/`, `lib/`, etc. and non-`.sh` files under
 *     `shell_snapshots/` are preserved without false positives.
 *  3. `HOT_CHURN_NATIVE_IGNORE_GLOBS` covers the prefix.
 *  4. `collectFiles` drops the ephemeral path during full walk.
 *  5. Deletion of a snapshot after discovery does not produce an L40 warning
 *     and does not break the rest of the index (`errors === 0`).
 *  6. Non-churn missing files (`src/vanished.ts`) still log warnings (no over-suppression).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import picomatch from 'picomatch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { HOT_CHURN_NATIVE_IGNORE_GLOBS, isHotChurnPath } from '../../utils/hot-churn.js';
import { collectFiles } from '../file-collector.js';
import { FileExtractor, resetCannotReadEnoentDedupForTests } from '../file-extractor.js';
import { IndexingPipeline } from '../pipeline.js';
import { buildProjectContext } from '../project-context.js';

function makeExtractor(rootPath: string): FileExtractor {
  return new FileExtractor({
    registry: PluginRegistry.createWithDefaults(),
    rootPath,
    workspaces: [],
    gitignore: undefined,
    fileContentCache: new Map(),
    buildProjectContext: () => buildProjectContext(rootPath),
    existingFiles: new Map(),
  });
}

describe('TRA-3119: isHotChurnPath and ignore globs', () => {
  it('identifies Codex shell snapshot files as hot churn', () => {
    const churnPaths = [
      'shell_snapshots/01a1f055-3b3f-7560-9114-3b500ceca38b.1795033480007626000.sh',
      'shell_snapshots/abc.sh',
      '/Users/test/.codex/shell_snapshots/01a1f055.1795033480007626000.sh',
      'shell_snapshots\\01a1f055.1795033480007626000.sh',
    ];

    for (const p of churnPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be true`).toBe(true);
    }
  });

  it('preserves legitimate application source files and non-script snapshot entries', () => {
    const legitPaths = [
      'src/shell_snapshots/manager.ts',
      'lib/shell_snapshots/parser.ts',
      'packages/term/shell_snapshots/types.d.ts',
      'app/shell_snapshots/handler.sh',
      'src/main.ts',
      'tests/shell_snapshots.test.ts',
      'shell_snapshots/README.md',
      'shell_snapshots/manifest.json',
    ];

    for (const p of legitPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be false`).toBe(false);
    }
  });

  it('includes shell_snapshots prefix in HOT_CHURN_NATIVE_IGNORE_GLOBS', () => {
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('shell_snapshots/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/.codex/shell_snapshots/**');

    const isIgnored = picomatch([...HOT_CHURN_NATIVE_IGNORE_GLOBS], { dot: true });
    expect(isIgnored('shell_snapshots/abc.1795033480007626000.sh')).toBe(true);
    expect(isIgnored('.codex/shell_snapshots/abc.1795033480007626000.sh')).toBe(true);
    expect(isIgnored('app/shell_snapshots/handler.sh')).toBe(false);
  });
});

describe('TRA-3119: collectFiles and walk filtering', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tra-3119-walk-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collectFiles drops shell snapshots during full walk while preserving source code', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    mkdirSync(join(tmpDir, 'shell_snapshots'), { recursive: true });

    writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(tmpDir, 'shell_snapshots', 'abc.1795033480007626000.sh'), '#!/bin/bash\n');

    const result = await collectFiles({
      config: TraceMcpConfigSchema.parse({}),
      rootPath: tmpDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(result.files).toContain('src/index.ts');
    expect(result.files).not.toContain('shell_snapshots/abc.1795033480007626000.sh');
  });
});

describe('TRA-3119: post-discovery deletion and ENOENT handling', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'tra-3119-index-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, 'src'), { recursive: true });
    mkdirSync(join(projDir, 'shell_snapshots'), { recursive: true });

    writeFileSync(join(projDir, 'src', 'main.ts'), 'export const main = 42;\n');
    writeFileSync(join(projDir, 'shell_snapshots', '1.1795033480007626000.sh'), '#!/bin/bash\n');
    writeFileSync(join(projDir, 'shell_snapshots', '2.1795033480007627000.sh'), '#!/bin/bash\n');

    db = initializeDatabase(join(tmpHome, 'index.db'));
    store = new Store(db);
    pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      projDir,
    );
    resetCannotReadEnoentDedupForTests();
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

  it('handles post-discovery pruning of shell snapshots without L40 warnings or breaking the index', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const discoveredPaths = [
      'src/main.ts',
      'shell_snapshots/1.1795033480007626000.sh',
      'shell_snapshots/2.1795033480007627000.sh',
    ];

    // Codex prunes the snapshots AFTER discovery, before the indexer reads them.
    rmSync(join(projDir, 'shell_snapshots'), { recursive: true, force: true });

    const result = await pipeline.indexFiles(discoveredPaths);

    const cannotReadWarns = warnSpy.mock.calls.filter(([, msg]) => msg === 'Cannot read file');
    expect(cannotReadWarns).toHaveLength(0);

    expect(result.errors).toBe(0);
    expect(result.indexed).toBe(1);

    const symbols = store.findSymbolsByName('main');
    expect(symbols.length).toBeGreaterThan(0);
  });

  it('FileExtractor directly skips a vanished shell snapshot at debug level', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const extractor = makeExtractor(projDir);

    rmSync(join(projDir, 'shell_snapshots'), { recursive: true, force: true });

    const res = await extractor.extract('shell_snapshots/9.1795033480007628000.sh', false);

    expect(res.kind).toBe('skipped');
    expect(warnSpy.mock.calls.filter(([, msg]) => msg === 'Cannot read file')).toHaveLength(0);
    expect(debugSpy.mock.calls.some(([, msg]) => String(msg).includes('Hot-churn'))).toBe(true);
  });

  it('preserves Cannot read file warnings for legitimate missing source files (no over-suppression)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const extractor = makeExtractor(projDir);

    const res = await extractor.extract('src/nonexistent.ts', false);

    expect(res.kind).toBe('error');
    const cannotReadCall = warnSpy.mock.calls.find(([, msg]) => msg === 'Cannot read file');
    expect(cannotReadCall).toBeDefined();
    expect(cannotReadCall![0]).toMatchObject({
      file: 'src/nonexistent.ts',
      code: 'ENOENT',
    });
  });
});
