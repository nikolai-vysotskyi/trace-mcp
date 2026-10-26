/**
 * TRA-2718: Hot-churn Codex filtering must not silently exclude legitimate
 * source files under app/node_repl, app/tmp, app/plugins, or source files
 * with standard extensions.
 *
 * Reproduction and verification:
 *  1. Full walk (collectFiles) on a project with app/node_repl/active_execs/handler.ts,
 *     app/tmp/arg0-macos/handler.ts, and app/plugins/cache/.../handler.ts must index
 *     those files while dropping Codex ephemeral files.
 *  2. FileWatcher must not ignore file change events for app/... sources either via
 *     native ignore globs or JS isHotChurnPath filter.
 *  3. HOT_CHURN_NATIVE_IGNORE_GLOBS and isHotChurnPath must be consistent:
 *     legitimate app/... sources are not ignored, while Codex churn files are ignored.
 */
import * as parcelWatcher from '@parcel/watcher';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, TraceMcpConfigSchema } from '../../config.js';
import { HOT_CHURN_NATIVE_IGNORE_GLOBS, isHotChurnPath } from '../../utils/hot-churn.js';
import { collectFiles } from '../file-collector.js';
import { FileWatcher } from '../watcher.js';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

describe('TRA-2718: Codex ephemeral churn vs app/... source files', () => {
  describe('isHotChurnPath and HOT_CHURN_NATIVE_IGNORE_GLOBS consistency', () => {
    it('does not classify legitimate app/... or source files as hot churn', () => {
      const appSources = [
        'app/node_repl/active_execs/handler.ts',
        'app/tmp/arg0-macos/handler.ts',
        'app/tmp/arg0-linux/worker.py',
        'app/plugins/cache/openai/plugin-install-abc/handler.ts',
        'app/plugins/cache/openai/plugin-install-abc/index.ts',
        'src/node_repl/active_execs/handler.ts',
        'src/tmp/arg0-macos/trampoline.c',
        'lib/node_repl/active_execs/parser.js',
        'packages/repl/node_repl/active_execs/types.d.ts',
      ];

      for (const p of appSources) {
        expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be false`).toBe(false);
      }
    });

    it('still identifies Codex ephemeral churn files as hot churn', () => {
      const codexChurn = [
        'node_repl/active_execs/12345.json',
        'node_repl/active_execs/abc-def-uuid.json',
        '/Users/test/.codex/node_repl/active_execs/sess-99.json',
        '.codex/node_repl/active_execs/12345.json',
        'tmp/arg0-macos/exec-trampoline',
        'tmp/arg0-macos/80521-subproc',
        '.codex/tmp/arg0-macos/80521-subproc',
        'tmp/arg0-linux/80521-subproc',
        'plugins/cache/openai-curated-remote/plugin-install-abc123/package.json',
        'plugins/cache/openai-curated-remote/plugin-install-abc123/lib/index.js',
        '.codex/plugins/cache/openai-curated-remote/plugin-install-abc123/lib/index.js',
        '/Users/test/.codex/plugins/cache/custom-remote/plugin-install-999/manifest.json',
        // TRA-2718 regression: files in root/codex directories without SOURCE_DIR_SEGMENTS prefix
        // are identified as Codex churn in lockstep with native watcher globs
        'node_repl/active_execs/handler.ts',
        'tmp/arg0-macos/trampoline.c',
        '.codex/node_repl/active_execs/handler.ts',
        '.codex/tmp/arg0-macos/trampoline.c',
      ];

      for (const p of codexChurn) {
        expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be true`).toBe(true);
      }
    });

    it('native watcher globs do not ignore app/... or source files, but ignore Codex churn', () => {
      const isIgnored = picomatch([...HOT_CHURN_NATIVE_IGNORE_GLOBS], { dot: true });

      // Legitimate source files under app/... or src/... must NOT be ignored by native globs
      expect(isIgnored('app/node_repl/active_execs/handler.ts')).toBe(false);
      expect(isIgnored('app/tmp/arg0-macos/handler.ts')).toBe(false);
      expect(isIgnored('app/plugins/cache/openai/plugin-install-abc/handler.ts')).toBe(false);
      expect(isIgnored('src/node_repl/active_execs/manager.ts')).toBe(false);

      // Codex churn files MUST be ignored by native globs
      expect(isIgnored('node_repl/active_execs/1.json')).toBe(true);
      expect(isIgnored('tmp/arg0-macos/tramp1')).toBe(true);
      expect(isIgnored('plugins/cache/openai/plugin-install-123/file.js')).toBe(true);
      expect(isIgnored('.codex/node_repl/active_execs/1.json')).toBe(true);
      expect(isIgnored('.codex/tmp/arg0-macos/tramp1')).toBe(true);
      expect(isIgnored('.codex/plugins/cache/openai/plugin-install-123/file.js')).toBe(true);
    });

    it('maintains strict consistency between isHotChurnPath and native watcher globs for all paths', () => {
      const isIgnored = picomatch([...HOT_CHURN_NATIVE_IGNORE_GLOBS], { dot: true });
      const testCases = [
        // App / source prefix paths: neither is hot churn nor natively ignored
        { path: 'app/node_repl/active_execs/handler.ts', expected: false },
        { path: 'app/tmp/arg0-macos/handler.ts', expected: false },
        { path: 'app/plugins/cache/openai/plugin-install-abc/handler.ts', expected: false },
        { path: 'src/node_repl/active_execs/manager.ts', expected: false },
        { path: 'src/tmp/arg0-macos/trampoline.c', expected: false },
        // Root and .codex paths: both isHotChurnPath and native globs agree (true)
        { path: 'node_repl/active_execs/1.json', expected: true },
        { path: 'node_repl/active_execs/handler.ts', expected: true },
        { path: 'tmp/arg0-macos/exec-trampoline', expected: true },
        { path: 'tmp/arg0-macos/trampoline.c', expected: true },
        { path: '.codex/node_repl/active_execs/1.json', expected: true },
        { path: '.codex/node_repl/active_execs/handler.ts', expected: true },
        { path: '.codex/tmp/arg0-macos/exec-trampoline', expected: true },
        { path: '.codex/tmp/arg0-macos/trampoline.c', expected: true },
        { path: 'plugins/cache/openai/plugin-install-123/file.js', expected: true },
        { path: '.codex/plugins/cache/openai/plugin-install-123/file.js', expected: true },
      ];

      for (const { path: p, expected } of testCases) {
        expect(isHotChurnPath(p), `isHotChurnPath("${p}")`).toBe(expected);
        expect(isIgnored(p), `nativeGlob("${p}")`).toBe(expected);
      }
    });
  });

  describe('full walk (collectFiles) and watcher updates in isolated /tmp project', () => {
    let tmpDir: string;
    let watcher: FileWatcher;
    let capturedCallback: (
      err: Error | null,
      events: Array<{ type: string; path: string }>,
    ) => Promise<void>;
    let pendingFn: (() => Promise<void>) | null = null;
    let flush: () => Promise<void>;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tra-2718-test-'));

      const setMock = vi.fn((fn: () => void) => {
        pendingFn = fn as unknown as () => Promise<void>;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      });
      const clearMock = vi.fn(() => {
        pendingFn = null;
      });
      flush = async () => {
        if (pendingFn) {
          const fn = pendingFn;
          pendingFn = null;
          await fn();
        }
      };
      watcher = new FileWatcher(
        setMock as unknown as typeof setTimeout,
        clearMock as unknown as typeof clearTimeout,
      );
      vi.mocked(parcelWatcher.subscribe).mockImplementation(async (_root, cb) => {
        capturedCallback = cb as typeof capturedCallback;
        return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
      });
    });

    afterEach(async () => {
      await watcher.stop();
      vi.clearAllMocks();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('collectFiles collects app/... source files while dropping Codex ephemeral churn', async () => {
      mkdirSync(join(tmpDir, 'app', 'node_repl', 'active_execs'), { recursive: true });
      mkdirSync(join(tmpDir, 'app', 'tmp', 'arg0-macos'), { recursive: true });
      mkdirSync(
        join(tmpDir, 'app', 'plugins', 'cache', 'openai-curated-remote', 'plugin-install-abc'),
        { recursive: true },
      );
      mkdirSync(join(tmpDir, 'node_repl', 'active_execs'), { recursive: true });
      mkdirSync(join(tmpDir, 'tmp', 'arg0-macos'), { recursive: true });
      mkdirSync(join(tmpDir, 'plugins', 'cache', 'openai-curated-remote', 'plugin-install-abc'), {
        recursive: true,
      });

      // Legitimate source files under app/...
      writeFileSync(
        join(tmpDir, 'app', 'node_repl', 'active_execs', 'handler.ts'),
        'export const h = 1;\n',
      );
      writeFileSync(
        join(tmpDir, 'app', 'tmp', 'arg0-macos', 'handler.ts'),
        'export const t = 2;\n',
      );
      writeFileSync(
        join(
          tmpDir,
          'app',
          'plugins',
          'cache',
          'openai-curated-remote',
          'plugin-install-abc',
          'handler.ts',
        ),
        'export const p = 3;\n',
      );

      // Codex ephemeral churn files
      writeFileSync(join(tmpDir, 'node_repl', 'active_execs', '12345.json'), '{"id":1}\n');
      writeFileSync(join(tmpDir, 'tmp', 'arg0-macos', 'exec-trampoline'), 'binary-trampoline');
      writeFileSync(
        join(
          tmpDir,
          'plugins',
          'cache',
          'openai-curated-remote',
          'plugin-install-abc',
          'scratch.tmp',
        ),
        'scratch\n',
      );

      writeFileSync(join(tmpDir, '.trace-mcp.json'), JSON.stringify({}));

      const config = (await loadConfig(tmpDir))._unsafeUnwrap();
      const result = await collectFiles({
        config,
        rootPath: tmpDir,
        workspaces: [],
        traceignore: undefined,
        maxFiles: 10_000,
      });

      // Legitimate app/... files MUST be collected
      expect(result.files).toContain('app/node_repl/active_execs/handler.ts');
      expect(result.files).toContain('app/tmp/arg0-macos/handler.ts');
      expect(result.files).toContain(
        'app/plugins/cache/openai-curated-remote/plugin-install-abc/handler.ts',
      );

      // Codex ephemeral churn files MUST be dropped
      expect(result.files).not.toContain('node_repl/active_execs/12345.json');
      expect(result.files).not.toContain('tmp/arg0-macos/exec-trampoline');
      expect(result.files).not.toContain(
        'plugins/cache/openai-curated-remote/plugin-install-abc/scratch.tmp',
      );
    });

    it('watcher updates app/... source files while dropping Codex ephemeral churn', async () => {
      const onChanges = vi.fn().mockResolvedValue(undefined);
      await watcher.start(
        tmpDir,
        TraceMcpConfigSchema.parse({ root: tmpDir, include: ['**/*'], exclude: [] }),
        onChanges,
      );

      // Simulate events for app/... sources and Codex churn
      await capturedCallback(null, [
        { type: 'update', path: join(tmpDir, 'app', 'node_repl', 'active_execs', 'handler.ts') },
        { type: 'update', path: join(tmpDir, 'app', 'tmp', 'arg0-macos', 'handler.ts') },
        { type: 'update', path: join(tmpDir, 'node_repl', 'active_execs', '12345.json') },
        { type: 'update', path: join(tmpDir, 'tmp', 'arg0-macos', 'exec-trampoline') },
      ]);
      await flush();

      // onChanges MUST be called with the app/... sources, and NOT with Codex churn
      expect(onChanges).toHaveBeenCalledTimes(1);
      const passedPaths = onChanges.mock.calls[0][0];
      expect(passedPaths).toContain(join(tmpDir, 'app', 'node_repl', 'active_execs', 'handler.ts'));
      expect(passedPaths).toContain(join(tmpDir, 'app', 'tmp', 'arg0-macos', 'handler.ts'));
      expect(passedPaths).not.toContain(join(tmpDir, 'node_repl', 'active_execs', '12345.json'));
      expect(passedPaths).not.toContain(join(tmpDir, 'tmp', 'arg0-macos', 'exec-trampoline'));
    });
  });
});
