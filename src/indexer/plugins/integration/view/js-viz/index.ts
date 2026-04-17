/**
 * JsVisualizationPlugin — marker detection for common JS/Vue visualization +
 * presentation libraries that don't warrant their own plugin:
 *
 *   - chart.js / vue-chartjs    → chart component / config files
 *   - marked                    → markdown renderer usage
 *   - vue-sonner                → toast invocation
 *
 * Tags files via `frameworkRole` only. No edge extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

const TRACKED_PACKAGES = ['chart.js', 'vue-chartjs', 'marked', 'vue-sonner'];

const CHARTJS_IMPORT_RE = /(?:from|require\()\s*['"](?:chart\.js|chart\.js\/auto)['"]/;
const CHARTJS_NEW_RE = /new\s+Chart\s*\(/;

const VUE_CHARTJS_IMPORT_RE = /(?:from|require\()\s*['"]vue-chartjs['"]/;

const MARKED_IMPORT_RE = /(?:from|require\()\s*['"]marked['"]/;

const VUE_SONNER_IMPORT_RE = /(?:from|require\()\s*['"]vue-sonner['"]/;

function hasAnyTrackedPackage(deps: Record<string, string> | undefined): boolean {
  if (!deps) return false;
  for (const pkg of TRACKED_PACKAGES) {
    if (pkg in deps) return true;
  }
  return false;
}

export class JsVisualizationPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'js-viz',
    version: '1.0.0',
    priority: 40,
    category: 'view',
    dependencies: [],
  };

  private enabled = false;

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (hasAnyTrackedPackage(deps)) {
        this.enabled = true;
        return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      if (hasAnyTrackedPackage(deps)) {
        this.enabled = true;
        return true;
      }
    } catch {
      // ignore — no package.json or unparseable
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!this.enabled) {
      return ok({ status: 'ok', symbols: [] });
    }
    if (!['typescript', 'javascript', 'vue'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasChartjs = CHARTJS_IMPORT_RE.test(source) || CHARTJS_NEW_RE.test(source);
    const hasVueChartjs = VUE_CHARTJS_IMPORT_RE.test(source);
    const hasMarked = MARKED_IMPORT_RE.test(source);
    const hasVueSonner = VUE_SONNER_IMPORT_RE.test(source);

    if (hasVueChartjs) {
      result.frameworkRole = 'vue_chart_component';
    } else if (hasChartjs) {
      result.frameworkRole = 'chart_config';
    } else if (hasVueSonner) {
      result.frameworkRole = 'toast_invocation';
    } else if (hasMarked) {
      result.frameworkRole = 'markdown_render';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
