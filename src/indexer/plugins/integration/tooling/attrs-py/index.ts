/**
 * AttrsPyPlugin — detects the attrs / attr library (Python) and extracts
 * dataclass-like class definitions marked with @attr.s / @attrs.define / @attrs.frozen.
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

const PACKAGES = ['attrs', 'attr'] as const;

const IMPORT_RE = /^\s*(?:from\s+(?:attr|attrs)(?:\.\w+)*\s+import|import\s+(?:attr|attrs))\b/m;

// @attr.s / @attr.s(auto_attribs=True) / @attrs.define / @attrs.frozen / @attr.define
// Captures the decorator followed by the next `class Name:` definition.
const DECORATED_CLASS_RE =
  /@\s*(?:attr|attrs)\s*\.\s*(s|define|frozen|mutable|attrs)\s*(?:\([^)]*\))?\s*(?:\n\s*)+class\s+([A-Z]\w+)\s*(?:\(([^)]*)\))?\s*:/g;

// attr.ib() / attrs.field() — counts of attribute fields (no individual edges, just used for frameworkRole)
const FIELD_CALL_RE = /\b(?:attr\s*\.\s*ib|attrs\s*\.\s*field|attr\s*\.\s*attrib)\s*\(/g;

export class AttrsPyPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'attrs-py',
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
        {
          name: 'attrs_class',
          category: 'dataclass',
          description: '@attr.s / @attrs.define decorated class',
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
    if (!hasImport && !source.includes('@attr.') && !source.includes('@attrs.')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    for (const m of source.matchAll(DECORATED_CLASS_RE)) {
      result.edges!.push({
        edgeType: 'attrs_class',
        metadata: {
          decorator: m[1],
          className: m[2],
          bases: (m[3] ?? '').trim(),
          filePath,
          line: findLine(m.index ?? 0),
        },
      });
    }

    const fieldCount = [...source.matchAll(FIELD_CALL_RE)].length;

    if (result.edges!.length > 0 || fieldCount > 0) {
      result.frameworkRole = 'attrs_models';
    } else if (hasImport) {
      result.frameworkRole = 'attrs_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
