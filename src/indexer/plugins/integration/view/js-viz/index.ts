/**
 * JsVisualizationPlugin — marker detection for common JS/Vue presentation,
 * visualization, and UI-widget libraries that don't warrant their own plugin.
 *
 *   Visualization / content:
 *     - chart.js / vue-chartjs   → chart component / config files
 *     - recharts                 → chart component (React)
 *     - marked                   → markdown renderer usage
 *
 *   Toasts / overlays / command UI:
 *     - vue-sonner / sonner      → toast invocation
 *     - cmdk                     → command palette
 *
 *   Forms / inputs / pickers:
 *     - react-hook-form          → form component
 *     - @vuepic/vue-datepicker   → datepicker component (Vue)
 *
 *   Animation:
 *     - framer-motion            → animation component
 *
 * Tags files via `frameworkRole` only. No edge extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const TRACKED_PACKAGES = [
  'chart.js',
  'vue-chartjs',
  'marked',
  'vue-sonner',
  'sonner',
  'recharts',
  'framer-motion',
  'react-hook-form',
  'cmdk',
  '@vuepic/vue-datepicker',
];

const CHARTJS_IMPORT_RE = /(?:from|require\()\s*['"](?:chart\.js|chart\.js\/auto)['"]/;
const CHARTJS_NEW_RE = /new\s+Chart\s*\(/;

const VUE_CHARTJS_IMPORT_RE = /(?:from|require\()\s*['"]vue-chartjs['"]/;

const MARKED_IMPORT_RE = /(?:from|require\()\s*['"]marked['"]/;

const VUE_SONNER_IMPORT_RE = /(?:from|require\()\s*['"]vue-sonner['"]/;
const SONNER_IMPORT_RE = /(?:from|require\()\s*['"]sonner['"]/;

const RECHARTS_IMPORT_RE = /(?:from|require\()\s*['"]recharts['"]/;

const FRAMER_MOTION_IMPORT_RE = /(?:from|require\()\s*['"]framer-motion['"]/;

const REACT_HOOK_FORM_IMPORT_RE = /(?:from|require\()\s*['"]react-hook-form['"]/;

const CMDK_IMPORT_RE = /(?:from|require\()\s*['"]cmdk['"]/;

const VUE_DATEPICKER_IMPORT_RE = /(?:from|require\()\s*['"]@vuepic\/vue-datepicker['"]/;

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
    version: '1.1.0',
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

    // Order matters: more specific / composite markers first. A file gets a
    // single `frameworkRole`, so when multiple libraries coexist (e.g. chart.js
    // + vue-chartjs, or sonner in the same file as a form), the more meaningful
    // tag should win.
    if (VUE_CHARTJS_IMPORT_RE.test(source)) {
      result.frameworkRole = 'vue_chart_component';
    } else if (RECHARTS_IMPORT_RE.test(source)) {
      result.frameworkRole = 'chart_component';
    } else if (CHARTJS_IMPORT_RE.test(source) || CHARTJS_NEW_RE.test(source)) {
      result.frameworkRole = 'chart_config';
    } else if (VUE_SONNER_IMPORT_RE.test(source) || SONNER_IMPORT_RE.test(source)) {
      result.frameworkRole = 'toast_invocation';
    } else if (CMDK_IMPORT_RE.test(source)) {
      result.frameworkRole = 'command_palette';
    } else if (REACT_HOOK_FORM_IMPORT_RE.test(source)) {
      result.frameworkRole = 'form_component';
    } else if (VUE_DATEPICKER_IMPORT_RE.test(source)) {
      result.frameworkRole = 'datepicker_component';
    } else if (FRAMER_MOTION_IMPORT_RE.test(source)) {
      result.frameworkRole = 'animation_component';
    } else if (MARKED_IMPORT_RE.test(source)) {
      result.frameworkRole = 'markdown_render';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
