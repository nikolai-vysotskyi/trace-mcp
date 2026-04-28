/**
 * UvicornPlugin — detects the `uvicorn` ASGI server.
 *
 * Tags files that import uvicorn or call `uvicorn.run(app, ...)`, and emits
 * asgi_server_runs edges from the enclosing symbol to a synthetic app reference
 * (e.g. `asgi-app::main:app` or `asgi-app::app`).
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const PACKAGES = ['uvicorn'] as const;

const UVICORN_IMPORT_RE =
  /^\s*(?:import\s+uvicorn(?:\s+as\s+\w+)?|from\s+uvicorn(?:\.\w+)?\s+import)\b/m;
const UVICORN_RUN_RE = /\buvicorn\s*\.\s*run\s*\(/;

// First positional arg of uvicorn.run(...) — the ASGI app reference.
// Captures identifiers, dotted names, or string literals like "main:app".
const UVICORN_RUN_ARG_RE =
  /\buvicorn\s*\.\s*run\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["']|([A-Za-z_][\w.]*))/g;

// Named import: `from uvicorn import run` → plain `run(app, ...)` calls.
const FROM_UVICORN_RUN_IMPORT_RE = /\bfrom\s+uvicorn\s+import\s+(?:[^;\n]*\brun\b[^;\n]*)/;
const BARE_RUN_ARG_RE = /(?:^|[^.\w])run\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["']|([A-Za-z_][\w.]*))/g;

export class UvicornPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'uvicorn',
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
          name: 'asgi_server_runs',
          category: 'python-server',
          description: 'uvicorn.run() → ASGI app reference',
        },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    const hasImport = UVICORN_IMPORT_RE.test(source);
    const hasRun = UVICORN_RUN_RE.test(source);
    const hasFromRun = FROM_UVICORN_RUN_IMPORT_RE.test(source);

    if (hasRun || (hasFromRun && /\brun\s*\(/.test(source))) {
      result.frameworkRole = 'asgi_server';
    } else if (hasImport) {
      result.frameworkRole = 'asgi_server_import';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'python') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id);

      const hasFromRun = FROM_UVICORN_RUN_IMPORT_RE.test(source);

      const emit = (appRef: string, idx: number) => {
        const line = lineOfIndex(source, idx);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) return;
        edges.push({
          edgeType: 'asgi_server_runs',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `asgi-app::${appRef}`,
          metadata: { app: appRef, line, file: file.path },
          resolution: 'text_matched',
        });
      };

      UVICORN_RUN_ARG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = UVICORN_RUN_ARG_RE.exec(source)) !== null) {
        const appRef = (m[1] ?? m[2] ?? '').trim();
        if (appRef) emit(appRef, m.index);
      }

      // `from uvicorn import run` → bare `run(app, ...)` calls
      if (hasFromRun) {
        BARE_RUN_ARG_RE.lastIndex = 0;
        while ((m = BARE_RUN_ARG_RE.exec(source)) !== null) {
          const appRef = (m[1] ?? m[2] ?? '').trim();
          if (appRef) emit(appRef, m.index);
        }
      }
    }

    return ok(edges);
  }
}
