/**
 * TreeSitterPlugin — detects projects using tree-sitter for parsing and
 * extracts grammar definitions, query patterns, and parser usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const TREE_SITTER_PACKAGES = [
  'tree-sitter',
  'web-tree-sitter',
  'tree-sitter-wasms',
  'tree-sitter-typescript',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-java',
  'tree-sitter-php',
  'tree-sitter-ruby',
  'tree-sitter-c',
  'tree-sitter-cpp',
  'tree-sitter-c-sharp',
  'tree-sitter-kotlin',
  'tree-sitter-scala',
  'tree-sitter-swift',
  'tree-sitter-dart',
];

// Parser.setLanguage(...), parser.parse(...)
const PARSER_USAGE_RE = /(?:parser|Parser)\s*\.\s*(?:setLanguage|parse|getLanguage)\s*\(/g;

// Tree-sitter query patterns: (function_declaration name: (identifier) @name)
const QUERY_PATTERN_RE = /\(\s*\w+(?:_\w+)*\s+(?:name|value|body):\s*\(\w+\)\s*@\w+/g;

// tree-sitter import
const TS_IMPORT_RE = /(?:import|require)\s*(?:\(|{)?\s*.*(?:tree-sitter|Parser)\b/;

export class TreeSitterPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'tree-sitter',
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
      for (const pkg of TREE_SITTER_PACKAGES) {
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
      for (const p of TREE_SITTER_PACKAGES) {
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
        {
          name: 'ts_parser_usage',
          category: 'tree-sitter',
          description: 'Tree-sitter parser usage',
        },
        {
          name: 'ts_query_pattern',
          category: 'tree-sitter',
          description: 'Tree-sitter query pattern',
        },
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

    const hasImport = TS_IMPORT_RE.test(source);
    const hasParserUsage = PARSER_USAGE_RE.test(source);
    const hasQueryPatterns = QUERY_PATTERN_RE.test(source);

    if (hasQueryPatterns) {
      result.frameworkRole = 'tree_sitter_queries';
    } else if (hasParserUsage) {
      result.frameworkRole = 'tree_sitter_parser';
    } else if (hasImport) {
      result.frameworkRole = 'tree_sitter_client';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
