/**
 * TRA-2682: Laravel storage/framework sessions, views, caches, and storage/logs
 * produced high-frequency watcher churn events (335+ FSEvent drops), triggering
 * repeated full-walk reconciles and V8 heap accumulation.
 *
 * Requirements:
 *  1. `isHotChurnPath` identifies storage/framework/* and storage/logs/* as hot churn.
 *  2. Real source files containing 'storage' in their paths/names are not false positives.
 *  3. `HOT_CHURN_NATIVE_IGNORE_GLOBS` includes storage/framework and storage/logs.
 *  4. `loadConfig` keeps storage and bootstrap/cache in essentialExcludes
 *     even when custom excludes are specified.
 */
import { describe, expect, it } from 'vitest';
import picomatch from 'picomatch';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOT_CHURN_NATIVE_IGNORE_GLOBS, isHotChurnPath } from '../../utils/hot-churn.js';
import { loadConfig } from '../../config.js';

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
    ];

    for (const p of legitPaths) {
      expect(isHotChurnPath(p), `Expected isHotChurnPath("${p}") to be false`).toBe(false);
    }
  });

  it('includes storage/framework and storage/logs in HOT_CHURN_NATIVE_IGNORE_GLOBS', () => {
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/storage/framework/**');
    expect(HOT_CHURN_NATIVE_IGNORE_GLOBS).toContain('**/storage/logs/**');

    const isIgnored = picomatch(HOT_CHURN_NATIVE_IGNORE_GLOBS, { dot: true });
    expect(isIgnored('storage/framework/sessions/abc123xyz')).toBe(true);
    expect(isIgnored('/var/www/storage/framework/views/template.php')).toBe(true);
    expect(isIgnored('storage/logs/laravel.log')).toBe(true);
    expect(isIgnored('app/Services/StorageService.php')).toBe(false);
  });

  it('retains **/storage/** and **/bootstrap/cache/** in essentialExcludes with custom config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra-2682-config-'));
    try {
      // User specifies custom exclude array that overrides defaults
      writeFileSync(
        join(dir, '.trace-mcp.json'),
        JSON.stringify({
          exclude: ['custom-vendor/**'],
        }),
      );

      const configResult = await loadConfig(dir);
      expect(configResult.isOk()).toBe(true);
      const config = configResult._unsafeUnwrap();

      expect(config.exclude).toContain('**/storage/**');
      expect(config.exclude).toContain('**/bootstrap/cache/**');
      expect(config.exclude).toContain('custom-vendor/**');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
