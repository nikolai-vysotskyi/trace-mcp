/**
 * TRA-2682: Laravel storage/framework sessions, views, caches, and storage/logs
 * produced high-frequency watcher churn events (335+ FSEvent drops), triggering
 * repeated full-walk reconciles and V8 heap accumulation.
 *
 * Requirements:
 *  1. `isHotChurnPath` identifies storage/framework/* and storage/logs/* as hot churn.
 *  2. Real source files containing 'storage' in their paths/names are not false positives.
 *  3. `HOT_CHURN_NATIVE_IGNORE_GLOBS` includes storage/framework and storage/logs.
 *  4. `collectFiles` drops Laravel storage churn during full-walk while preserving
 *     legitimate source files even under storage/framework and storage/logs paths.
 */
import { describe, expect, it } from 'vitest';
import picomatch from 'picomatch';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOT_CHURN_NATIVE_IGNORE_GLOBS, isHotChurnPath } from '../../utils/hot-churn.js';
import { loadConfig } from '../../config.js';
import { collectFiles } from '../file-collector.js';

describe('TRA-2682: storage/framework and storage/logs churn protection', () => {
  it('identifies Laravel storage/framework and storage/logs as hot churn', () => {
    const churnPaths = [
      'storage/framework/sessions/ciE1BfFvNvd0jWvWzQzKq9v2k1',
      '/var/www/my-app/storage/framework/sessions/4b2e67f2a1b9',
      'storage/framework/views/94f71a93e36e3b5e.php',
      '/var/www/my-app/storage/framework/views/94f71a93e36e3b5e.php',
      'storage/framework/cache/data/9f/8e/9f8e43b123',
      '/var/www/my-app/storage/framework/cache/data/9f/8e/9f8e43b123',
      'storage/logs/laravel.log',
      '/var/www/my-app/storage/logs/laravel.log',
      'storage/logs/laravel-2026-10-25.log',
      'storage\\framework\\sessions\\ciE1BfFvNvd0jWvWzQzKq9v2k1',
      'storage\\logs\\laravel.log',
    ];

    for (const p of churnPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be true`).toBe(true);
    }
  });

  it('does not classify real application code or tests as hot churn', () => {
    const legitPaths = [
      'app/Services/StorageService.php',
      'src/storage.ts',
      'src/utils/storage-helper.ts',
      'tests/Unit/StorageTest.php',
      'packages/storage-s3/index.ts',
      'app/Http/Controllers/StorageController.php',
      // Regressions from Reviewer B and Reviewer E reviews (TRA-2682):
      'src/storage/sessions/redis_session_store.ts',
      'src/storage/framework/adapter.ts',
      'src/framework/storage/helper.ts',
      'src/storage/logs/audit_logger.ts',
      'storage/framework/adapter.ts',
      'storage/logs/logger.go',
      'src/storage/db.ts',
    ];

    for (const p of legitPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be false`).toBe(false);
    }
  });

  it('includes storage/framework and storage/logs in HOT_CHURN_NATIVE_IGNORE_GLOBS', () => {
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/storage/framework/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/storage/logs/**');

    const isIgnored = picomatch([...HOT_CHURN_NATIVE_IGNORE_GLOBS], { dot: true });
    expect(isIgnored('storage/framework/sessions/abc123xyz')).toBe(true);
    expect(isIgnored('/var/www/storage/framework/views/template.php')).toBe(true);
    expect(isIgnored('storage/logs/laravel.log')).toBe(true);
    expect(isIgnored('app/Services/StorageService.php')).toBe(false);
    expect(isIgnored('src/storage/sessions/redis.ts')).toBe(false);
  });

  it('collectFiles drops Laravel storage churn during full-walk while preserving legitimate source code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra-2682-walk-'));
    try {
      // Create source files under storage subdirectories
      mkdirSync(join(dir, 'src', 'storage', 'framework'), { recursive: true });
      mkdirSync(join(dir, 'src', 'storage', 'logs'), { recursive: true });
      mkdirSync(join(dir, 'storage', 'logs'), { recursive: true });
      mkdirSync(join(dir, 'storage', 'framework', 'sessions'), { recursive: true });
      mkdirSync(join(dir, 'storage', 'framework', 'views'), { recursive: true });

      writeFileSync(
        join(dir, 'src', 'storage', 'framework', 'adapter.ts'),
        'export const adapter = 1;\n',
      );
      writeFileSync(
        join(dir, 'src', 'storage', 'logs', 'audit_logger.ts'),
        'export const logger = 2;\n',
      );
      writeFileSync(join(dir, 'storage', 'logs', 'logger.go'), 'package main\nfunc main() {}\n');

      // Create transient Laravel churn files
      writeFileSync(
        join(dir, 'storage', 'framework', 'sessions', 'ciE1BfFvNvd0jWvWzQ'),
        'session_data\n',
      );
      writeFileSync(
        join(dir, 'storage', 'framework', 'views', '94f71a93e36e3b5e.php'),
        '<?php echo "view";\n',
      );
      writeFileSync(join(dir, 'storage', 'logs', 'laravel.log'), '[2026-10-25] error\n');

      // User project with custom exclude overrides defaults (or standard config)
      writeFileSync(
        join(dir, '.trace-mcp.json'),
        JSON.stringify({
          exclude: ['custom-vendor/**'],
        }),
      );

      const config = (await loadConfig(dir))._unsafeUnwrap();
      const result = await collectFiles({
        config,
        rootPath: dir,
        workspaces: [],
        traceignore: undefined,
        maxFiles: 10_000,
      });

      // Legitimate source code files MUST be collected
      expect(result.files).toContain('src/storage/framework/adapter.ts');
      expect(result.files).toContain('src/storage/logs/audit_logger.ts');
      expect(result.files).toContain('storage/logs/logger.go');

      // Transient Laravel churn files MUST be dropped by isHotChurnPath filter
      expect(result.files).not.toContain('storage/framework/sessions/ciE1BfFvNvd0jWvWzQ');
      expect(result.files).not.toContain('storage/framework/views/94f71a93e36e3b5e.php');
      expect(result.files).not.toContain('storage/logs/laravel.log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
