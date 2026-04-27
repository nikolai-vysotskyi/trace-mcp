/**
 * NeverthrowPlugin — detects Result-type error handling libraries (neverthrow,
 * ts-results, oxide.ts, true-myth) and extracts Result/Ok/Err usage patterns,
 * andThen chains, and error mapping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok as okResult, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const RESULT_PACKAGES = ['neverthrow', 'ts-results', 'oxide.ts', 'true-myth', '@badrap/result'];

// Result<T, E>, ResultAsync<T, E>
const RESULT_TYPE_RE = /(?:Result|ResultAsync|Ok|Err)\s*<[^>]+>/g;

// .andThen(...), .map(...), .mapErr(...), .orElse(...), .match(...)
const CHAIN_RE = /\.\s*(?:andThen|map|mapErr|orElse|match|unwrapOr|isOk|isErr)\s*\(/g;

// ok(...), err(...), okAsync(...), errAsync(...)
const _CONSTRUCTOR_RE = /\b(?:ok|err|okAsync|errAsync)\s*\(/g;

// fromPromise(...), fromThrowable(...)
const WRAPPER_RE = /\b(?:fromPromise|fromThrowable|safeTry)\s*\(/g;

// Import detection
const RESULT_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*(?:neverthrow|ts-results|oxide\.ts|true-myth)\b/;

export class NeverthrowPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'neverthrow',
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
      for (const pkg of RESULT_PACKAGES) {
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
      for (const p of RESULT_PACKAGES) {
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
          name: 'result_chain',
          category: 'error-handling',
          description: 'Result type chain (andThen/map/mapErr)',
        },
        {
          name: 'result_wraps',
          category: 'error-handling',
          description: 'fromPromise/fromThrowable wrapper',
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
      return okResult({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasImport = RESULT_IMPORT_RE.test(source);
    const hasResultType = RESULT_TYPE_RE.test(source);
    const hasChain = CHAIN_RE.test(source);
    const hasWrapper = WRAPPER_RE.test(source);

    if (hasWrapper && hasImport) {
      result.frameworkRole = 'result_boundary';
    } else if (hasChain && hasResultType) {
      result.frameworkRole = 'result_chain';
    } else if (hasResultType || hasImport) {
      result.frameworkRole = 'result_usage';
    }

    return okResult(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return okResult([]);
  }
}
