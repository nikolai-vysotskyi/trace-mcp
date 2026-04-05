/**
 * BuildToolsPlugin — detects build tools (tsup, esbuild, rollup, webpack, vite,
 * turbopack, swc) and extracts entry points, output config, and build targets.
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

const BUILD_PACKAGES = [
  'tsup', 'esbuild', 'rollup', 'webpack', '@rspack/core',
  'vite', 'turbo', 'swc', '@swc/core', 'parcel',
];

const BUILD_CONFIG_FILES = [
  'tsup.config.ts', 'tsup.config.js',
  'rollup.config.ts', 'rollup.config.js', 'rollup.config.mjs',
  'webpack.config.ts', 'webpack.config.js',
  'vite.config.ts', 'vite.config.js',
  'esbuild.config.ts', 'esbuild.config.js',
  'turbo.json',
  '.swcrc',
];

// entry: ['src/index.ts'], entry: { main: 'src/index.ts' }
const ENTRY_RE =
  /entry\s*:\s*(?:\[([^\]]+)\]|\{([^}]+)\}|['"]([^'"]+)['"])/g;

// format: ['esm', 'cjs']
const FORMAT_RE =
  /format\s*:\s*\[([^\]]+)\]/g;

// target: 'node20', target: ['node20']
const TARGET_RE =
  /target\s*:\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"])/g;

// external: ['dep1', 'dep2']
const EXTERNAL_RE =
  /external\s*:\s*\[([^\]]+)\]/g;

// defineConfig or export default { ... }
const CONFIG_EXPORT_RE =
  /(?:defineConfig|export\s+default)\s*(?:\(\s*)?\{/;

export interface BuildConfig {
  entries: string[];
  formats: string[];
  targets: string[];
  externals: string[];
}

export function extractBuildConfig(source: string): BuildConfig {
  const config: BuildConfig = { entries: [], formats: [], targets: [], externals: [] };

  let m: RegExpExecArray | null;

  const entryRe = new RegExp(ENTRY_RE.source, 'g');
  while ((m = entryRe.exec(source)) !== null) {
    const raw = m[1] || m[2] || m[3] || '';
    const items = raw.match(/['"]([^'"]+)['"]/g);
    if (items) config.entries.push(...items.map((s) => s.replace(/['"]/g, '')));
  }

  const formatRe = new RegExp(FORMAT_RE.source, 'g');
  while ((m = formatRe.exec(source)) !== null) {
    const items = m[1].match(/['"]([^'"]+)['"]/g);
    if (items) config.formats.push(...items.map((s) => s.replace(/['"]/g, '')));
  }

  const targetRe = new RegExp(TARGET_RE.source, 'g');
  while ((m = targetRe.exec(source)) !== null) {
    const raw = m[1] || m[2] || '';
    const items = raw.match(/['"]([^'"]+)['"]/g);
    if (items) config.targets.push(...items.map((s) => s.replace(/['"]/g, '')));
    else if (m[2]) config.targets.push(m[2]);
  }

  const externalRe = new RegExp(EXTERNAL_RE.source, 'g');
  while ((m = externalRe.exec(source)) !== null) {
    const items = m[1].match(/['"]([^'"]+)['"]/g);
    if (items) config.externals.push(...items.map((s) => s.replace(/['"]/g, '')));
  }

  return config;
}

export class BuildToolsPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'build-tools',
    version: '1.0.0',
    priority: 35,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of BUILD_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    // Check for config files
    for (const cf of BUILD_CONFIG_FILES) {
      if (ctx.configFiles.includes(cf)) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of BUILD_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'build_entry', category: 'build', description: 'Build entry point' },
        { name: 'build_external', category: 'build', description: 'Externalized dependency' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const isConfigFile = BUILD_CONFIG_FILES.some((cf) => filePath.endsWith(cf.replace(/\.(ts|js|mjs)$/, '')));
    const hasConfigExport = CONFIG_EXPORT_RE.test(source);

    if (isConfigFile || hasConfigExport) {
      const config = extractBuildConfig(source);
      if (config.entries.length > 0 || config.formats.length > 0) {
        result.frameworkRole = 'build_config';
      }
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
