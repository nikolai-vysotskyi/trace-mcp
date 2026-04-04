/**
 * TrpcPlugin — detects tRPC projects and extracts router definitions,
 * procedures (query, mutation, subscription).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../plugin-api/types.js';

// Match procedure name + type. Uses [\s\S]{0,500}? to bridge .input(...) chains
// with nested parens that [^)]* can't handle.
const PROCEDURE_RE =
  /(\w+)\s*:\s*\w*[Pp]rocedure[\s\S]{0,500}?\.(query|mutation|subscription)\s*\(/g;

const ROUTER_RE =
  /(?:t\.router|router)\s*\(\s*\{/g;

export interface TrpcProcedure {
  name: string;
  type: 'query' | 'mutation' | 'subscription';
}

/** Extract tRPC procedure definitions from source code. */
export function extractTrpcProcedures(source: string): TrpcProcedure[] {
  const procedures: TrpcProcedure[] = [];
  const re = new RegExp(PROCEDURE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    procedures.push({
      name: match[1],
      type: match[2] as TrpcProcedure['type'],
    });
  }
  return procedures;
}

export class TrpcPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'trpc',
    version: '1.0.0',
    priority: 25,
    category: 'api',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('@trpc/server' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return '@trpc/server' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'trpc_procedure', category: 'trpc', description: 'Procedure defined in router' },
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
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    // Check for router definitions
    const hasRouter = new RegExp(ROUTER_RE.source, 'g').test(source);

    const procedures = extractTrpcProcedures(source);
    if (procedures.length > 0) {
      result.frameworkRole = hasRouter ? 'trpc_router' : 'trpc_procedure';
      for (const proc of procedures) {
        result.routes!.push({
          method: proc.type.toUpperCase() as string,
          uri: proc.name,
        });
      }
    } else if (hasRouter) {
      result.frameworkRole = 'trpc_router';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
