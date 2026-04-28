/**
 * unisharp/laravel-filemanager extraction.
 *
 * Detects:
 * - config/lfm.php — package config file (marks route prefix, storage disk)
 * - LaravelFilemanager::routes() / Lfm::routes() macro calls that register
 *   the file manager route group in a web.php / admin.php router.
 * - Blade directives / views embedding the filemanager standalone popup:
 *     {{ asset('vendor/laravel-filemanager/...') }}
 *     data-lfm-* attributes
 *
 * Emits routes with an `lfm` tag so the project map surfaces them even when
 * they are declared implicitly by the package.
 */
import type { RawRoute } from '../../../../../plugin-api/types.js';

const LFM_ROUTES_CALL_RE = /\b(?:LaravelFilemanager|Lfm)\s*::\s*routes\s*\(\s*\)/;

const LFM_CONFIG_PREFIX_RE = /['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/;

const LFM_CONFIG_DISK_RE = /['"]disk['"]\s*=>\s*['"]([^'"]+)['"]/;

const LFM_ROUTE_PREFIX_RE =
  /Route\s*::\s*group\s*\(\s*\[[^\]]*['"]prefix['"]\s*=>\s*['"]([^'"]*lfm|laravel-filemanager|filemanager[^'"]*)['"]/i;

export interface LaravelFilemanagerRoutes {
  prefix: string;
  disk: string | null;
  source: 'macro' | 'config' | 'route';
  filePath: string;
}

/**
 * Produce synthetic routes for the known file manager endpoints under the
 * configured prefix. The package registers ~10 internal endpoints; we list
 * the user-observable ones so coverage/reporting can find them.
 */
const LFM_ENDPOINTS: Array<{ method: string; path: string; handler: string }> = [
  { method: 'GET', path: '', handler: 'LfmController@show' },
  { method: 'GET', path: '/upload', handler: 'UploadController@upload' },
  { method: 'POST', path: '/upload', handler: 'UploadController@upload' },
  { method: 'GET', path: '/download', handler: 'DownloadController@getDownload' },
  { method: 'GET', path: '/jsonitems', handler: 'ItemsController@getItems' },
  { method: 'POST', path: '/newfolder', handler: 'FolderController@getAddfolder' },
  { method: 'POST', path: '/rename', handler: 'RenameController@getRename' },
  { method: 'POST', path: '/delete', handler: 'DeleteController@getDelete' },
  { method: 'POST', path: '/crop', handler: 'CropController@getCrop' },
  { method: 'POST', path: '/resize', handler: 'ResizeController@performResize' },
];

export function extractLaravelFilemanagerConfig(
  source: string,
  filePath: string,
): LaravelFilemanagerRoutes | null {
  if (!filePath.endsWith('config/lfm.php')) return null;
  const prefix = source.match(LFM_CONFIG_PREFIX_RE)?.[1] ?? 'laravel-filemanager';
  const disk = source.match(LFM_CONFIG_DISK_RE)?.[1] ?? null;
  return { prefix, disk, source: 'config', filePath };
}

export function extractLaravelFilemanagerMacro(
  source: string,
  filePath: string,
): LaravelFilemanagerRoutes | null {
  if (!LFM_ROUTES_CALL_RE.test(source)) return null;
  const prefixMatch = source.match(LFM_ROUTE_PREFIX_RE);
  const prefix = prefixMatch?.[1] ?? 'laravel-filemanager';
  return { prefix, disk: null, source: 'macro', filePath };
}

export function buildLaravelFilemanagerRoutes(info: LaravelFilemanagerRoutes): RawRoute[] {
  const base = `/${info.prefix.replace(/^\/+|\/+$/g, '')}`;
  return LFM_ENDPOINTS.map((e) => ({
    method: e.method,
    uri: `${base}${e.path}`,
    handler: `UniSharp\\LaravelFilemanager\\Controllers\\${e.handler}`,
    metadata: {
      framework: 'laravel-filemanager',
      source: info.source,
      disk: info.disk,
      declaredIn: info.filePath,
    },
  }));
}
