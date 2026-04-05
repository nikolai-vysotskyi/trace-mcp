/**
 * CosmiconfigPlugin — detects config-loading libraries (cosmiconfig, lilconfig,
 * rc, dotenv) and extracts config search patterns and load calls.
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

const CONFIG_PACKAGES = ['cosmiconfig', 'lilconfig', 'rc', 'dotenv', 'envalid', 'env-var'];

// cosmiconfig('name'), lilconfig('name')
const EXPLORER_RE =
  /(?:cosmiconfig|lilconfig|cosmiconfigSync|lilconfigSync)\(\s*['"]([^'"]+)['"]/g;

// explorer.search(), explorer.load('path')
const SEARCH_RE =
  /(?:explorer|result)\s*\.\s*(?:search|load)\s*\(/g;

// dotenv.config(), config()
const DOTENV_RE =
  /(?:dotenv\.config|config)\s*\(\s*(?:\{[^}]*\})?\s*\)/g;

// Import detection
const CONFIG_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*(?:cosmiconfig|lilconfig|dotenv)\b/;

export class CosmiconfigPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'cosmiconfig',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of CONFIG_PACKAGES) {
        if (pkg in deps) return true;
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
      for (const p of CONFIG_PACKAGES) {
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
        { name: 'config_search', category: 'config', description: 'Config file search/load' },
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

    const hasImport = CONFIG_IMPORT_RE.test(source);
    const hasExplorer = EXPLORER_RE.test(source);
    const hasDotenv = DOTENV_RE.test(source);

    if (hasExplorer) {
      result.frameworkRole = 'config_loader';
    } else if (hasDotenv) {
      result.frameworkRole = 'env_loader';
    } else if (hasImport) {
      result.frameworkRole = 'config_usage';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
