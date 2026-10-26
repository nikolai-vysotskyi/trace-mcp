/**
 * TRA-2640 / TRA-2581: Codex ephemeral runtime state churn protection.
 *
 * Systematic temporary files in Codex roots (`node_repl/active_execs/*`,
 * `tmp/arg0-macos/*`, and `plugins/cache/** /plugin-install-*`) are created
 * and unlinked rapidly during execution. When discovered before unlink,
 * reading them raced with deletion, causing hundreds of L40 `Cannot read file`
 * ENOENT warnings and falsely marking index runs with errors.
 *
 * Requirements:
 *  1. `isHotChurnPath` identifies `node_repl/active_execs/*`, `tmp/arg0-macos/*` (and `tmp/arg0-*`),
 *     and `plugins/cache/** /plugin-install-*` as hot churn.
 *  2. Real source files under `src/`, `lib/`, etc. are preserved without false positives.
 *  3. `HOT_CHURN_NATIVE_IGNORE_GLOBS` covers the ephemeral prefixes.
 *  4. `collectFiles` drops ephemeral paths during full walk.
 *  5. Deletion of temporary files after discovery does not produce L40 warnings and does
 *     not break the rest of the index (`errors === 0`).
 *  6. Non-churn missing files (`src/vanished.ts`) still log warnings (no over-suppression).
 *  7. `cannotReadEnoentKey` groups ephemeral paths if unhandled transient files reach dedup.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('TRA-2640 / TRA-2581: isHotChurnPath and ignore globs', () => {
  it('identifies Codex ephemeral execution and plugin install files as hot churn', () => {
    const churnPaths = [
      'node_repl/active_execs/12345.json',
      'node_repl/active_execs/abc-def-uuid.json',
      '/Users/test/.codex/node_repl/active_execs/sess-99.json',
      'node_repl\\active_execs\\12345.json',
      'tmp/arg0-macos/exec-trampoline',
      'tmp/arg0-macos/80521-subproc',
      '/Users/test/.codex/tmp/arg0-macos/80521-subproc',
      'tmp/arg0-linux/80521-subproc',
      'tmp\\arg0-macos\\80521-subproc',
      'plugins/cache/openai-curated-remote/plugin-install-abc123/package.json',
      'plugins/cache/openai-curated-remote/plugin-install-abc123/lib/index.js',
      '/Users/test/.codex/plugins/cache/custom-remote/plugin-install-999/manifest.json',
      'plugins\\cache\\openai-curated-remote\\plugin-install-abc123\\index.js',
    ];

    for (const p of churnPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be true`).toBe(true);
    }
  });

  it('preserves legitimate application and library source files', () => {
    const legitPaths = [
      'src/node_repl/active_execs/manager.ts',
      'lib/node_repl/active_execs/parser.js',
      'packages/repl/node_repl/active_execs/types.d.ts',
      'src/tmp/arg0-macos/trampoline.c',
      'src/plugins/cache/plugin-install-helper.ts',
      'src/main.ts',
      'tests/node_repl.test.ts',
      'tests/tmp_arg0.test.ts',
      'plugins/installed/my-plugin/index.js',
      'plugins/config.json',
      // TRA-2718: legitimate application source files under app/...
      'app/node_repl/active_execs/handler.ts',
      'app/tmp/arg0-macos/handler.ts',
      'app/plugins/cache/openai/plugin-install-abc/handler.ts',
    ];

    for (const p of legitPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be false`).toBe(false);
    }
  });

  it('includes ephemeral prefixes in HOT_CHURN_NATIVE_IGNORE_GLOBS', () => {
    // TRA-2718: Scoped to root or .codex/ subtrees so app/... and src/... are not ignored natively
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('node_repl/active_execs/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/.codex/node_repl/active_execs/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('tmp/arg0-*/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/.codex/tmp/arg0-*/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('plugins/cache/**/plugin-install-*/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain(
      '**/.codex/plugins/cache/**/plugin-install-*/**',
    );

    const isIgnored = picomatch([...HOT_CHURN_NATIVE_IGNORE_GLOBS], { dot: true });
    expect(isIgnored('node_repl/active_execs/1.json')).toBe(true);
    expect(isIgnored('tmp/arg0-macos/tramp1')).toBe(true);
    expect(isIgnored('tmp/arg0-linux/tramp1')).toBe(true);
    expect(isIgnored('plugins/cache/openai/plugin-install-123/file.js')).toBe(true);
    expect(isIgnored('.codex/node_repl/active_execs/1.json')).toBe(true);
    expect(isIgnored('.codex/tmp/arg0-macos/tramp1')).toBe(true);
    expect(isIgnored('.codex/plugins/cache/openai/plugin-install-123/file.js')).toBe(true);
    expect(isIgnored('src/node_repl/index.ts')).toBe(false);
    expect(isIgnored('src/node_repl/active_execs/manager.ts')).toBe(false);
    expect(isIgnored('app/node_repl/active_execs/handler.ts')).toBe(false);
    expect(isIgnored('app/tmp/arg0-macos/handler.ts')).toBe(false);
    expect(isIgnored('app/plugins/cache/openai/plugin-install-123/file.js')).toBe(false);
  });
});

describe('TRA-2640 / TRA-2581: collectFiles and walk filtering', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tra-2640-walk-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collectFiles drops ephemeral paths during full walk while preserving source code', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    mkdirSync(join(tmpDir, 'node_repl', 'active_execs'), { recursive: true });
    mkdirSync(join(tmpDir, 'tmp', 'arg0-macos'), { recursive: true });
    mkdirSync(
      join(tmpDir, 'plugins', 'cache', 'openai-curated-remote', 'plugin-install-abc', 'sub'),
      { recursive: true },
    );

    writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(tmpDir, 'node_repl', 'active_execs', '1.json'), '{"id":1}\n');
    writeFileSync(join(tmpDir, 'tmp', 'arg0-macos', 'exec1'), 'binary-trampoline');
    writeFileSync(
      join(
        tmpDir,
        'plugins',
        'cache',
        'openai-curated-remote',
        'plugin-install-abc',
        'sub',
        'module.js',
      ),
      'module.exports = {};\n',
    );

    const result = await collectFiles({
      config: TraceMcpConfigSchema.parse({}),
      rootPath: tmpDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(result.files).toContain('src/index.ts');
    expect(result.files).not.toContain('node_repl/active_execs/1.json');
    expect(result.files).not.toContain('tmp/arg0-macos/exec1');
    expect(result.files.some((f) => f.includes('plugin-install-abc'))).toBe(false);
  });
});

describe('TRA-2640 / TRA-2581: post-discovery deletion and ENOENT handling', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'tra-2640-index-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, 'src'), { recursive: true });
    mkdirSync(join(projDir, 'node_repl', 'active_execs'), { recursive: true });
    mkdirSync(join(projDir, 'tmp', 'arg0-macos'), { recursive: true });
    mkdirSync(join(projDir, 'plugins', 'cache', 'openai-curated-remote', 'plugin-install-123'), {
      recursive: true,
    });

    writeFileSync(join(projDir, 'src', 'main.ts'), 'export const main = 42;\n');
    writeFileSync(join(projDir, 'node_repl', 'active_execs', '1.json'), '{"pid":1}\n');
    writeFileSync(join(projDir, 'node_repl', 'active_execs', '2.json'), '{"pid":2}\n');
    writeFileSync(join(projDir, 'tmp', 'arg0-macos', 'exec1'), 'tramp-1');
    writeFileSync(join(projDir, 'tmp', 'arg0-macos', 'exec2'), 'tramp-2');
    writeFileSync(
      join(
        projDir,
        'plugins',
        'cache',
        'openai-curated-remote',
        'plugin-install-123',
        'package.json',
      ),
      '{"name":"temp"}\n',
    );

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

  it('handles post-discovery deletion of ephemeral files without L40 warnings or breaking the index', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

    // Simulate discovery queuing paths that existed on disk
    const discoveredPaths = [
      'src/main.ts',
      'node_repl/active_execs/1.json',
      'node_repl/active_execs/2.json',
      'tmp/arg0-macos/exec1',
      'tmp/arg0-macos/exec2',
      'plugins/cache/openai-curated-remote/plugin-install-123/package.json',
    ];

    // Ephemeral files disappear AFTER discovery (external process unlinks them)
    rmSync(join(projDir, 'node_repl'), { recursive: true, force: true });
    rmSync(join(projDir, 'tmp'), { recursive: true, force: true });
    rmSync(join(projDir, 'plugins'), { recursive: true, force: true });

    // Run indexing on the discovered set
    const result = await pipeline.indexFiles(discoveredPaths);

    // Expected ENOENTs must NOT log L40 "Cannot read file" warnings
    const cannotReadWarns = warnSpy.mock.calls.filter(([, msg]) => msg === 'Cannot read file');
    expect(cannotReadWarns).toHaveLength(0);

    // Must not break the rest of the index: 0 errors, main.ts successfully indexed
    expect(result.errors).toBe(0);
    expect(result.indexed).toBe(1);

    // Legitimate symbols from main.ts are present in store
    const symbols = store.findSymbolsByName('main');
    expect(symbols.length).toBeGreaterThan(0);
  });

  it('FileExtractor directly skips vanished ephemeral paths at debug level', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const extractor = makeExtractor(projDir);

    // Files deleted from disk
    rmSync(join(projDir, 'node_repl'), { recursive: true, force: true });
    rmSync(join(projDir, 'tmp'), { recursive: true, force: true });

    const resRepl = await extractor.extract('node_repl/active_execs/80.json', false);
    const resArg0 = await extractor.extract('tmp/arg0-macos/40', false);

    expect(resRepl.kind).toBe('skipped');
    expect(resArg0.kind).toBe('skipped');
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

  it('groups ephemeral paths in cannotReadEnoentKey if unhandled transient files reach dedup', async () => {
    // If churn filter is bypassed, rate limiting still groups unique IDs into one key
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

    const extractor = makeExtractor(projDir);

    // Extracting multiple distinct paths under the same ephemeral prefix
    // Even if isHotChurnPath was disabled, grouping prevents 80/40 warnings.
    // Here we test cannotReadEnoentKey through the rate limiter:
    resetCannotReadEnoentDedupForTests();

    // Use a helper path that tests the regex grouping
    await extractor.extract('src/node_repl/active_execs/1.json', false);
    await extractor.extract('src/node_repl/active_execs/2.json', false);

    // Both are grouped under node_repl/active_execs/*
    expect(warnSpy.mock.calls.filter(([, msg]) => msg === 'Cannot read file')).toHaveLength(1);
    expect(
      debugSpy.mock.calls.some(([, msg]) => msg === 'Cannot read file (repeat suppressed)'),
    ).toBe(true);
  });
});
