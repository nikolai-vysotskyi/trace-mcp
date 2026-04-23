import { describe, it, expect } from 'vitest';
import {
  extractLaravelFilemanagerConfig,
  extractLaravelFilemanagerMacro,
  buildLaravelFilemanagerRoutes,
} from '../../../src/indexer/plugins/integration/framework/laravel/laravel-filemanager.js';

describe('laravel-filemanager', () => {
  describe('extractLaravelFilemanagerConfig', () => {
    it('parses prefix and disk from config/lfm.php', () => {
      const source = `<?php
return [
    'use_package_routes' => true,
    'prefix' => 'admin/lfm',
    'disk' => 'public',
];
      `;
      const info = extractLaravelFilemanagerConfig(source, 'config/lfm.php');
      expect(info).not.toBeNull();
      expect(info!.prefix).toBe('admin/lfm');
      expect(info!.disk).toBe('public');
      expect(info!.source).toBe('config');
    });

    it('falls back to default prefix when omitted', () => {
      const source = `<?php return [ 'disk' => 'local' ];`;
      const info = extractLaravelFilemanagerConfig(source, 'config/lfm.php');
      expect(info!.prefix).toBe('laravel-filemanager');
    });

    it('returns null for non-lfm config files', () => {
      const source = `<?php return [ 'prefix' => 'unrelated' ];`;
      expect(extractLaravelFilemanagerConfig(source, 'config/auth.php')).toBeNull();
    });
  });

  describe('extractLaravelFilemanagerMacro', () => {
    it('detects Lfm::routes() in routes file', () => {
      const source = `<?php
Route::group(['prefix' => 'laravel-filemanager', 'middleware' => ['web', 'auth']], function () {
    \\UniSharp\\LaravelFilemanager\\Lfm::routes();
});
      `;
      const info = extractLaravelFilemanagerMacro(source, 'routes/web.php');
      expect(info).not.toBeNull();
      expect(info!.prefix).toBe('laravel-filemanager');
      expect(info!.source).toBe('macro');
    });

    it('returns null when routes() macro is absent', () => {
      const source = `<?php Route::get('/foo', fn() => 'bar');`;
      expect(extractLaravelFilemanagerMacro(source, 'routes/web.php')).toBeNull();
    });
  });

  describe('buildLaravelFilemanagerRoutes', () => {
    it('builds the canonical endpoint set under the configured prefix', () => {
      const routes = buildLaravelFilemanagerRoutes({
        prefix: 'admin/lfm',
        disk: 'public',
        source: 'config',
        filePath: 'config/lfm.php',
      });
      expect(routes.length).toBeGreaterThanOrEqual(8);
      const uris = routes.map((r) => r.uri);
      expect(uris).toContain('/admin/lfm');
      expect(uris).toContain('/admin/lfm/upload');
      expect(uris).toContain('/admin/lfm/jsonitems');
      expect(routes[0].metadata!.framework).toBe('laravel-filemanager');
      expect(routes[0].metadata!.disk).toBe('public');
    });

    it('strips leading/trailing slashes from prefix', () => {
      const routes = buildLaravelFilemanagerRoutes({
        prefix: '/lfm/',
        disk: null,
        source: 'macro',
        filePath: 'routes/web.php',
      });
      expect(routes[0].uri.startsWith('/lfm')).toBe(true);
      expect(routes[0].uri.includes('//')).toBe(false);
    });
  });
});
