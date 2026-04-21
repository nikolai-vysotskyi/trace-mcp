/**
 * Jinja2Plugin — detects the Jinja2 template engine (Python) and extracts
 * template render edges (Environment.get_template, Template.render, render_template).
 *
 * Also indexes .j2 / .jinja / .jinja2 files as template files.
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
import { hasPythonDep } from '../../_shared/python-deps.js';

const IMPORT_RE = /^\s*(?:from\s+jinja2(?:\.\w+)?\s+import|import\s+jinja2)\b/m;

// env.get_template('name.html') | Environment(...).get_template('x')
const GET_TEMPLATE_RE =
  /\.get_template\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

// template.render(...) — catch only if preceded by get_template call (heuristic: same file)
const RENDER_CALL_RE =
  /\.render(?:_async)?\s*\(/g;

// Flask integration: render_template('name.html')
const RENDER_TEMPLATE_RE =
  /\brender_template(?:_string)?\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

// select_template(['a.html', 'b.html'])
const SELECT_TEMPLATE_RE =
  /\.select_template\s*\(\s*\[\s*([^\]]+)\]/g;

export class Jinja2Plugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'jinja2',
    version: '1.0.0',
    priority: 35,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'jinja2') || hasPythonDep(ctx, 'Jinja2');
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'jinja2_render', category: 'view', description: 'Jinja2 template render (get_template / render_template)' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    // Index .j2/.jinja/.jinja2 files as template view files
    if (/\.(j2|jinja2?|j2\.html)$/i.test(filePath) || language === 'jinja') {
      return ok({ status: 'ok', symbols: [], frameworkRole: 'jinja2_template' });
    }

    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    if (!IMPORT_RE.test(source) && !source.includes('render_template') && !source.includes('get_template')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    for (const m of source.matchAll(GET_TEMPLATE_RE)) {
      result.edges!.push({
        edgeType: 'jinja2_render',
        metadata: { template: m[1], via: 'get_template', filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(RENDER_TEMPLATE_RE)) {
      result.edges!.push({
        edgeType: 'jinja2_render',
        metadata: { template: m[1], via: 'render_template', filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(SELECT_TEMPLATE_RE)) {
      const names = [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1]);
      for (const name of names) {
        result.edges!.push({
          edgeType: 'jinja2_render',
          metadata: { template: name, via: 'select_template', filePath, line: findLine(m.index ?? 0) },
        });
      }
    }

    // Mark files with any render activity (even if only .render() with no template hint)
    if (result.edges!.length > 0) {
      result.frameworkRole = 'jinja2_views';
    } else if (RENDER_CALL_RE.test(source) && IMPORT_RE.test(source)) {
      result.frameworkRole = 'jinja2_views';
    } else if (IMPORT_RE.test(source)) {
      result.frameworkRole = 'jinja2_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
