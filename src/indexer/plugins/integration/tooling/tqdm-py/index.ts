/**
 * TqdmPyPlugin — detects tqdm (Python progress bars) and tags loop instrumentation.
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
import { hasPythonDep } from '../../_shared/python-deps.js';

const IMPORT_RE = /^\s*(?:from\s+tqdm(?:\.\w+)?\s+import|import\s+tqdm)\b/m;

// tqdm(iterable) / trange(n) / tqdm.tqdm(...) / tqdm.auto.tqdm(...)
const TQDM_CALL_RE =
  /\b(?:tqdm(?:\s*\.\s*(?:auto|notebook|asyncio|rich|contrib\.\w+))?\s*\.\s*tqdm|tqdm|trange)\s*\(/g;

export class TqdmPyPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'tqdm-py',
    version: '1.0.0',
    priority: 50,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'tqdm');
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'progress_bar',
          category: 'tooling',
          description: 'tqdm progress bar instrumentation',
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
    const hasImport = IMPORT_RE.test(source);
    if (!hasImport && !source.includes('tqdm') && !source.includes('trange')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    if (hasImport) {
      for (const m of source.matchAll(TQDM_CALL_RE)) {
        result.edges!.push({
          edgeType: 'progress_bar',
          metadata: { filePath, line: findLine(m.index ?? 0) },
        });
      }
    }

    if (result.edges!.length > 0) {
      result.frameworkRole = 'progress_instrumentation';
    } else if (hasImport) {
      result.frameworkRole = 'tqdm_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
