/**
 * PythonScientificPlugin — detects scientific computing packages
 * (numpy, scipy, scikit-image) and tags files that use them.
 *
 * Light-touch: marks the framework role for discovery/graph grouping.
 * Does not emit relational edges since these libs don't have
 * clear cross-symbol semantics (routes / models / handlers).
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

const PACKAGES = ['numpy', 'scipy', 'scikit-image'] as const;

const IMPORT_RE =
  /^\s*(?:from\s+(?:numpy|scipy|skimage)(?:\.\w+)*\s+import|import\s+(?:numpy|scipy|skimage)(?:\s+as\s+\w+)?)\b/m;

// np.array, np.zeros, np.ones, np.arange, np.linspace, np.random.*
const NP_ALLOC_RE = /\bnp\s*\.\s*(array|zeros|ones|empty|full|arange|linspace|asarray|eye|identity|random\.\w+)\s*\(/g;

// scipy.{optimize,signal,stats,interpolate,integrate,linalg,sparse,fft,ndimage}
const SCIPY_SUBMODULE_RE =
  /\bscipy\s*\.\s*(optimize|signal|stats|interpolate|integrate|linalg|sparse|fft|ndimage|spatial|special)\b/g;

// skimage.io.imread / skimage.filters.* — via attribute access
const SKIMAGE_SUBMODULE_RE =
  /\bskimage\s*\.\s*(io|filters|transform|color|feature|measure|morphology|segmentation|restoration|exposure|draw)\b/g;

// from skimage import io, filters, transform — via explicit submodule import
const SKIMAGE_IMPORT_RE =
  /^\s*from\s+skimage\s+import\s+([\w,\s]+)/gm;
const SKIMAGE_SUBMODULES = new Set(['io','filters','transform','color','feature','measure','morphology','segmentation','restoration','exposure','draw','spatial','util']);

export class PythonScientificPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'python-scientific',
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
        { name: 'scientific_usage', category: 'scientific', description: 'Scientific computing library usage (numpy/scipy/skimage)' },
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
    if (!hasImport && !source.includes('np.') && !source.includes('scipy.') && !source.includes('skimage.')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;
    const seenSubmodules = new Set<string>();

    for (const m of source.matchAll(NP_ALLOC_RE)) {
      result.edges!.push({
        edgeType: 'scientific_usage',
        metadata: { library: 'numpy', api: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(SCIPY_SUBMODULE_RE)) {
      const key = `scipy.${m[1]}`;
      if (seenSubmodules.has(key)) continue;
      seenSubmodules.add(key);
      result.edges!.push({
        edgeType: 'scientific_usage',
        metadata: { library: 'scipy', submodule: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(SKIMAGE_SUBMODULE_RE)) {
      const key = `skimage.${m[1]}`;
      if (seenSubmodules.has(key)) continue;
      seenSubmodules.add(key);
      result.edges!.push({
        edgeType: 'scientific_usage',
        metadata: { library: 'scikit-image', submodule: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(SKIMAGE_IMPORT_RE)) {
      const line = findLine(m.index ?? 0);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!SKIMAGE_SUBMODULES.has(name)) continue;
        const key = `skimage.${name}`;
        if (seenSubmodules.has(key)) continue;
        seenSubmodules.add(key);
        result.edges!.push({
          edgeType: 'scientific_usage',
          metadata: { library: 'scikit-image', submodule: name, filePath, line },
        });
      }
    }

    if (result.edges!.length > 0) {
      result.frameworkRole = 'scientific_code';
    } else if (hasImport) {
      result.frameworkRole = 'scientific_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
