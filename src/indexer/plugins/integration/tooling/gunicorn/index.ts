/**
 * GunicornPlugin — detects the `gunicorn` WSGI server.
 *
 * Gunicorn is usually run via CLI (`gunicorn module:app`) and configured via
 * `gunicorn.conf.py`. This plugin:
 *   1. Tags `gunicorn.conf.py` files as `wsgi_server_config` and extracts `bind`
 *      and `wsgi_app` keys.
 *   2. Tags Python files that subclass `gunicorn.app.base.BaseApplication` as
 *      `wsgi_server_custom`.
 *   3. Emits `wsgi_server_runs` edges from the config-file namespace to a
 *      synthetic `wsgi-app::<module:attr>` target.
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const PACKAGES = ['gunicorn'] as const;

// gunicorn.conf.py keys
const WSGI_APP_RE = /^\s*wsgi_app\s*=\s*(?:(?:f|r|b)?["']([^"']+)["'])/m;
const BIND_RE = /^\s*bind\s*=\s*(?:(?:f|r|b)?["']([^"']+)["']|\[([^\]]+)\])/m;
const WORKERS_RE = /^\s*workers\s*=\s*(\d+)/m;
const WORKER_CLASS_RE = /^\s*worker_class\s*=\s*(?:(?:f|r|b)?["']([^"']+)["'])/m;

// Custom application subclass: class X(gunicorn.app.base.BaseApplication)
const CUSTOM_APP_RE = /class\s+\w+\s*\([^)]*\bgunicorn\.app\.base\.BaseApplication\b[^)]*\)/;
const GUNICORN_IMPORT_RE = /^\s*(?:import\s+gunicorn|from\s+gunicorn(?:\.\w+)?\s+import)\b/m;

function isGunicornConfig(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('/gunicorn.conf.py') ||
    lower.endsWith('\\gunicorn.conf.py') ||
    lower === 'gunicorn.conf.py'
  );
}

export class GunicornPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'gunicorn',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'wsgi_server_runs',
          category: 'python-server',
          description: 'gunicorn config/custom app → WSGI app reference',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    if (isGunicornConfig(filePath)) {
      result.frameworkRole = 'wsgi_server_config';
      return ok(result);
    }

    if (CUSTOM_APP_RE.test(source)) {
      result.frameworkRole = 'wsgi_server_custom';
    } else if (GUNICORN_IMPORT_RE.test(source)) {
      result.frameworkRole = 'wsgi_server_import';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'python') continue;
      if (!isGunicornConfig(file.path)) continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id);

      const wsgiAppMatch = WSGI_APP_RE.exec(source);
      if (!wsgiAppMatch) continue;
      const appRef = wsgiAppMatch[1];
      const line = lineOfIndex(source, wsgiAppMatch.index);
      const encl = findEnclosingSymbol(symbols, line) ?? symbols[0];
      if (!encl) continue;

      const bindMatch = BIND_RE.exec(source);
      const workersMatch = WORKERS_RE.exec(source);
      const workerClassMatch = WORKER_CLASS_RE.exec(source);
      const metadata: Record<string, unknown> = {
        wsgi_app: appRef,
        line,
        file: file.path,
      };
      if (bindMatch) metadata.bind = bindMatch[1] ?? bindMatch[2];
      if (workersMatch) metadata.workers = parseInt(workersMatch[1], 10);
      if (workerClassMatch) metadata.worker_class = workerClassMatch[1];

      edges.push({
        edgeType: 'wsgi_server_runs',
        sourceNodeType: 'symbol',
        sourceRefId: encl.id,
        targetSymbolId: `wsgi-app::${appRef}`,
        metadata,
        resolution: 'text_matched',
      });
    }

    return ok(edges);
  }
}
