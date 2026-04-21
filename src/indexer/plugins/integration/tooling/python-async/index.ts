/**
 * PythonAsyncPlugin — detects async runtime/IO packages (anyio, aiofiles).
 *
 * Extracts:
 * - aiofiles.open('path', 'r'|'w') — async file I/O edges
 * - anyio task group / to_thread / create_task_group primitives — for topology
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

const PACKAGES = ['anyio', 'aiofiles'] as const;

const IMPORT_RE = /^\s*(?:from\s+(?:anyio|aiofiles)(?:\.\w+)*\s+import|import\s+(?:anyio|aiofiles))\b/m;

// aiofiles.open('path', 'mode') — captures path + mode
const AIOFILES_OPEN_RE =
  /\baiofiles\s*\.\s*open\s*\(\s*(?:f|r|b)?["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/g;

// anyio.to_thread.run_sync / anyio.create_task_group / anyio.run / anyio.Event / anyio.open_file
const ANYIO_PRIMITIVE_RE =
  /\banyio\s*\.\s*(to_thread\.\w+|to_process\.\w+|create_task_group|run|sleep|Event|Semaphore|Lock|Condition|CapacityLimiter|open_file|open_process)\b/g;

export class PythonAsyncPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'python-async',
    version: '1.0.0',
    priority: 45,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'async_file_io', category: 'async', description: 'Async file open (aiofiles.open)' },
        { name: 'async_primitive', category: 'async', description: 'anyio primitive usage (task group, to_thread, lock, etc.)' },
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
    const hasImport = IMPORT_RE.test(source);
    if (!hasImport && !source.includes('aiofiles.') && !source.includes('anyio.')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    for (const m of source.matchAll(AIOFILES_OPEN_RE)) {
      result.edges!.push({
        edgeType: 'async_file_io',
        metadata: { target: m[1], mode: m[2] ?? 'r', filePath, line: findLine(m.index ?? 0) },
      });
    }

    const seenPrimitives = new Set<string>();
    for (const m of source.matchAll(ANYIO_PRIMITIVE_RE)) {
      if (seenPrimitives.has(m[1])) continue;
      seenPrimitives.add(m[1]);
      result.edges!.push({
        edgeType: 'async_primitive',
        metadata: { api: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    if (result.edges!.length > 0) {
      result.frameworkRole = 'async_runtime';
    } else if (hasImport) {
      result.frameworkRole = 'async_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
