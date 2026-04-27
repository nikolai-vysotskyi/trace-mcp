/**
 * DataFetchingPlugin — detects React Query (TanStack Query) and SWR projects,
 * extracts useQuery/useMutation/useSWR hooks that reference API endpoints.
 */
import fs from 'node:fs';
import { globalRe } from '../../../../../utils/regex.js';
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

/**
 * Match useQuery({ queryKey: [...], queryFn: () => fetch('...') })
 * Match useQuery(['key'], () => fetch('...'))
 * Match useMutation({ mutationFn: ... fetch('...') })
 */
const USE_QUERY_OBJECT_RE =
  /\b(useQuery|useInfiniteQuery)\s*\(\s*\{[^}]*?queryFn\s*:\s*[^}]*?fetch\s*\(\s*[`'"](\/[^'"`$]*?)['"`]/g;

const USE_QUERY_ARRAY_RE =
  /\b(useQuery|useInfiniteQuery)\s*\(\s*\[[^\]]*\]\s*,\s*(?:\([^)]*\)\s*=>|function\s*\([^)]*\)\s*\{)[^)]*?fetch\s*\(\s*[`'"](\/[^'"`$]*?)['"`]/g;

const USE_MUTATION_RE =
  /\b(useMutation)\s*\(\s*\{[^}]*?mutationFn\s*:\s*[^}]*?fetch\s*\(\s*[`'"](\/[^'"`$]*?)['"`][^)]*?(?:method\s*:\s*['"`](\w+)['"`])?/g;

/**
 * Match useSWR('/api/...', fetcher)
 * Match useSWR(() => `/api/...`, fetcher)
 */
const USE_SWR_STRING_RE = /\buseSWR\s*\(\s*['"`](\/[^'"`$]*?)['"`]/g;

const USE_SWR_FUNCTION_RE = /\buseSWR\s*\(\s*\(\s*\)\s*=>\s*[`'"](\/[^'"`$]*?)['"`]/g;

/**
 * Template literal fetch patterns with interpolation.
 * e.g., fetch(`/api/users/${id}`) → '/api/users/:param'
 */
const FETCH_TEMPLATE_RE = /fetch\s*\(\s*`(\/[^`]*?)\$\{[^}]+\}([^`]*?)`/g;

interface DataFetchingHook {
  hook: string;
  endpoint: string | null;
  method: string;
}

/** Normalize template literal endpoints: replace ${...} with :param */
function normalizeEndpoint(raw: string): string {
  return raw.replace(/\$\{[^}]+\}/g, ':param');
}

/** Extract data fetching hooks (useQuery, useMutation, useSWR) from source code. */
export function extractDataFetchingHooks(source: string): DataFetchingHook[] {
  const hooks: DataFetchingHook[] = [];
  const seen = new Set<string>();

  function add(hook: string, endpoint: string | null, method: string) {
    const key = `${hook}:${endpoint}:${method}`;
    if (!seen.has(key)) {
      seen.add(key);
      hooks.push({ hook, endpoint, method });
    }
  }

  // useQuery with object syntax
  let match: RegExpExecArray | null;
  const queryObjRe = globalRe(USE_QUERY_OBJECT_RE);
  while ((match = queryObjRe.exec(source)) !== null) {
    add(match[1], match[2], 'FETCH');
  }

  // useQuery with array key syntax
  const queryArrRe = globalRe(USE_QUERY_ARRAY_RE);
  while ((match = queryArrRe.exec(source)) !== null) {
    add(match[1], match[2], 'FETCH');
  }

  // useMutation
  const mutationRe = globalRe(USE_MUTATION_RE);
  while ((match = mutationRe.exec(source)) !== null) {
    const method = match[3]?.toUpperCase() || 'POST';
    add(match[1], match[2], method);
  }

  // useSWR with string key
  const swrStringRe = globalRe(USE_SWR_STRING_RE);
  while ((match = swrStringRe.exec(source)) !== null) {
    add('useSWR', match[1], 'FETCH');
  }

  // useSWR with arrow function key
  const swrFuncRe = globalRe(USE_SWR_FUNCTION_RE);
  while ((match = swrFuncRe.exec(source)) !== null) {
    add('useSWR', match[1], 'FETCH');
  }

  // Template literal fetch with interpolation (any useQuery/useSWR context)
  const templateRe = globalRe(FETCH_TEMPLATE_RE);
  while ((match = templateRe.exec(source)) !== null) {
    const endpoint = normalizeEndpoint(`${match[1]}\${x}${match[2]}`);
    // Determine context: is this inside useQuery, useMutation, or useSWR?
    const before = source.slice(Math.max(0, match.index - 200), match.index);
    let hook = 'fetch';
    if (/useSWR\s*\(/.test(before)) hook = 'useSWR';
    else if (/useMutation\s*\(/.test(before)) hook = 'useMutation';
    else if (/useQuery\s*\(/.test(before)) hook = 'useQuery';
    else if (/useInfiniteQuery\s*\(/.test(before)) hook = 'useInfiniteQuery';
    add(hook, endpoint, 'FETCH');
  }

  return hooks;
}

export class DataFetchingPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'data-fetching',
    version: '1.0.0',
    priority: 30,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('@tanstack/react-query' in deps || 'swr' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return '@tanstack/react-query' in deps || 'swr' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'fetches_endpoint',
          category: 'data-fetching',
          description: 'useQuery/useSWR call referencing an API endpoint',
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
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const hooks = extractDataFetchingHooks(source);
    if (hooks.length > 0) {
      result.frameworkRole = 'data_fetching';
      for (const hook of hooks) {
        if (hook.endpoint) {
          result.routes!.push({
            method: hook.method,
            uri: hook.endpoint,
          });
        }
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
