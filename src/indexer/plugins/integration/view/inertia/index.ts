/**
 * InertiaPlugin — detects Inertia::render() calls in PHP controllers
 * and links them to Vue page components.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

interface InertiaRenderCall {
  pageName: string;
  propNames: string[];
  line: number;
}

/** Regex for Inertia::render('Page/Name', [...]) or inertia('Page/Name', [...]) */
const INERTIA_RENDER_RE =
  /(?:Inertia::render|inertia)\(\s*['"]([\w/.-]+)['"]\s*(?:,\s*\[([^\]]*)\])?\s*\)/g;

/** Extract array keys from a PHP associative array literal */
const ARRAY_KEY_RE = /['"](\w+)['"]\s*=>/g;

export function extractInertiaRenders(source: string): InertiaRenderCall[] {
  const calls: InertiaRenderCall[] = [];
  let match: RegExpExecArray | null;

  const re = new RegExp(INERTIA_RENDER_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    const pageName = match[1];
    const propsBlock = match[2] ?? '';
    const propNames: string[] = [];

    let keyMatch: RegExpExecArray | null;
    const keyRe = new RegExp(ARRAY_KEY_RE.source, 'g');
    while ((keyMatch = keyRe.exec(propsBlock)) !== null) {
      propNames.push(keyMatch[1]);
    }

    // Find line number
    const before = source.substring(0, match.index);
    const line = before.split('\n').length;

    calls.push({ pageName, propNames, line });
  }

  return calls;
}

export function resolvePagePath(pageName: string): string {
  return `resources/js/Pages/${pageName}.vue`;
}

export class InertiaPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'inertia',
    version: '1.0.0',
    priority: 20,
    category: 'view',
    dependencies: ['laravel', 'vue-framework'],
  };

  detect(ctx: ProjectContext): boolean {
    // Check composer.json for inertiajs/inertia-laravel
    if (ctx.composerJson) {
      const req = ctx.composerJson.require as Record<string, string> | undefined;
      if (req?.['inertiajs/inertia-laravel']) return true;
    }

    // Check package.json for @inertiajs/vue3 or @inertiajs/react
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('@inertiajs/vue3' in deps || '@inertiajs/react' in deps) return true;
    }

    // Fallback: read from disk
    try {
      const composerPath = path.join(ctx.rootPath, 'composer.json');
      const content = fs.readFileSync(composerPath, 'utf-8');
      const json = JSON.parse(content);
      const req = json.require as Record<string, string> | undefined;
      if (req?.['inertiajs/inertia-laravel']) return true;
    } catch { /* ignore */ }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      if ('@inertiajs/vue3' in deps || '@inertiajs/react' in deps) return true;
    } catch { /* ignore */ }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'inertia_renders', category: 'inertia', description: 'Controller renders Vue page via Inertia' },
        { name: 'passes_props', category: 'inertia', description: 'Controller passes props to Vue page' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'php') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const renders = extractInertiaRenders(source);

    if (renders.length === 0) {
      return ok({ status: 'ok', symbols: [] });
    }

    // Store Inertia render metadata on the file for pass 2
    return ok({
      status: 'ok',
      symbols: [],
      frameworkRole: 'inertia_controller',
    });
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    for (const file of allFiles) {
      if (file.language !== 'php') continue;

      let source: string;
      try {
        source = fs.readFileSync(path.resolve(ctx.rootPath, file.path), 'utf-8');
      } catch { continue; }

      const renders = extractInertiaRenders(source);
      if (renders.length === 0) continue;

      const symbols = ctx.getSymbolsByFile(file.id);
      const controllerClass = symbols.find((s) => s.kind === 'class');
      if (!controllerClass) continue;

      for (const render of renders) {
        const pagePath = resolvePagePath(render.pageName);
        const pageFile = allFiles.find((f) => f.path === pagePath);
        if (!pageFile) continue;

        const pageSymbols = ctx.getSymbolsByFile(pageFile.id);
        const pageComponent = pageSymbols.find((s) => s.kind === 'class');
        if (!pageComponent) continue;

        // Find the method that contains this render call by line range
        const method = symbols.find(
          (s) => s.kind === 'method' &&
            s.lineStart != null && s.lineEnd != null &&
            render.line >= s.lineStart &&
            render.line <= s.lineEnd,
        );
        const sourceSymbol = method ?? controllerClass;

        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: sourceSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: pageComponent.id,
          edgeType: 'inertia_renders',
          metadata: {
            pageName: render.pageName,
            propNames: render.propNames,
          },
        });

        // passes_props edge for each prop
        if (render.propNames.length > 0) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: sourceSymbol.id,
            targetNodeType: 'symbol',
            targetRefId: pageComponent.id,
            edgeType: 'passes_props',
            metadata: {
              propNames: render.propNames,
              pageName: render.pageName,
            },
          });
        }
      }
    }

    return ok(edges);
  }
}

/**
 * Detect prop mismatches between PHP-side Inertia::render props and Vue defineProps.
 */
interface PropMismatch {
  pageName: string;
  pagePath: string;
  phpProps: string[];
  vueProps: string[];
  missingInVue: string[];
  missingInPhp: string[];
}

export function detectPropMismatches(
  inertiaRenders: { pageName: string; propNames: string[] }[],
  vuePages: Map<string, string[]>,
): PropMismatch[] {
  const mismatches: PropMismatch[] = [];

  for (const render of inertiaRenders) {
    const pagePath = resolvePagePath(render.pageName);
    const vueProps = vuePages.get(render.pageName);
    if (!vueProps) continue;

    const missingInVue = render.propNames.filter((p) => !vueProps.includes(p));
    const missingInPhp = vueProps.filter((p) => !render.propNames.includes(p));

    if (missingInVue.length > 0 || missingInPhp.length > 0) {
      mismatches.push({
        pageName: render.pageName,
        pagePath,
        phpProps: render.propNames,
        vueProps,
        missingInVue,
        missingInPhp,
      });
    }
  }

  return mismatches;
}
