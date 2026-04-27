/**
 * SupabasePlugin — detects @supabase/supabase-js usage and extracts data-access edges.
 *
 * Pass 1 (extractNodes) — tag files with framework roles based on import + client/query
 *   signals (client, query, storage, realtime, auth).
 * Pass 2 (resolveEdges) — emit symbol-level edges for each resolvable resource:
 *   - supabase_query:    symbol → supabase-table::<name>  (select/insert/update/delete/upsert)
 *   - supabase_rpc:      symbol → supabase-rpc::<name>
 *   - supabase_storage:  symbol → supabase-bucket::<name> (upload/download/remove/list)
 *   - supabase_realtime: symbol → supabase-channel::<name>
 *
 * Only literal arguments are captured — dynamic names (variables, env vars, interpolation)
 * cannot be resolved statically and would only add noise.
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
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const SUPABASE_PACKAGES = [
  '@supabase/supabase-js',
  '@supabase/ssr', // SSR helpers — re-export createClient
  '@supabase/auth-helpers-nextjs',
  '@supabase/auth-helpers-react',
];

const SUPABASE_IMPORT_RE = /(?:import|require)\s*(?:\(|{)?\s*.*['"]@supabase\/[\w-]+['"]/;

const CREATE_CLIENT_RE =
  /\bcreateClient(?:Component(?:Client)?|ServerComponentClient|BrowserClient|ServerClient|RouteHandlerClient)?\s*\(/;

const AUTH_CALL_RE =
  /\.auth\s*\.\s*(?:signUp|signIn(?:WithPassword|WithOAuth|WithOtp|WithIdToken|Anonymously)?|signOut|getUser|getSession|onAuthStateChange|resetPasswordForEmail|updateUser|verifyOtp|refreshSession|setSession|exchangeCodeForSession)\s*\(/;

const FROM_TABLE_RE = /\.from\s*\(\s*['"`]([A-Za-z_][\w.]*)['"`]\s*\)/g;

const RPC_RE = /\.rpc\s*\(\s*['"`]([A-Za-z_][\w]*)['"`]/g;

const STORAGE_FROM_RE = /\.storage\s*\.\s*from\s*\(\s*['"`]([A-Za-z_][\w-]*)['"`]\s*\)/g;

const CHANNEL_RE = /\.channel\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Query op methods that can follow `.from('table')` in a chain.
const QUERY_OP_RE = /\.(select|insert|update|upsert|delete)\s*\(/;

// Storage op methods that can follow `.storage.from('bucket')`.
const STORAGE_OP_RE =
  /\.(upload|uploadToSignedUrl|download|remove|list|move|copy|createSignedUrl|createSignedUrls|createSignedUploadUrl|getPublicUrl)\s*\(/;

// Lookahead in characters when scanning a chain from `.from(...)` to the op method.
const CHAIN_LOOKAHEAD = 400;

type QueryOp = 'select' | 'insert' | 'update' | 'upsert' | 'delete';
type StorageOp =
  | 'upload'
  | 'uploadToSignedUrl'
  | 'download'
  | 'remove'
  | 'list'
  | 'move'
  | 'copy'
  | 'createSignedUrl'
  | 'createSignedUrls'
  | 'createSignedUploadUrl'
  | 'getPublicUrl';

function findChainedOp<T extends string>(
  source: string,
  startIdx: number,
  re: RegExp,
): { op: T; opIdx: number } | undefined {
  const window = source.slice(startIdx, startIdx + CHAIN_LOOKAHEAD);
  const m = window.match(re);
  if (!m || m.index === undefined) return undefined;
  return { op: m[1] as T, opIdx: startIdx + m.index };
}

function hasSupabasePackage(deps: Record<string, string> | undefined): boolean {
  if (!deps) return false;
  for (const pkg of SUPABASE_PACKAGES) {
    if (pkg in deps) return true;
  }
  return false;
}

export class SupabasePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'supabase',
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
      if (hasSupabasePackage(deps)) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return hasSupabasePackage(deps);
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'supabase_query',
          category: 'supabase',
          description: 'Supabase table query (select/insert/update/delete/upsert)',
        },
        {
          name: 'supabase_rpc',
          category: 'supabase',
          description: 'Supabase stored-procedure call',
        },
        {
          name: 'supabase_storage',
          category: 'supabase',
          description: 'Supabase storage bucket operation',
        },
        {
          name: 'supabase_realtime',
          category: 'supabase',
          description: 'Supabase realtime channel subscription',
        },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    const hasImport = SUPABASE_IMPORT_RE.test(source);
    if (!hasImport) return ok(result);

    const hasCreateClient = CREATE_CLIENT_RE.test(source);
    const hasAuth = AUTH_CALL_RE.test(source);
    // Reset lastIndex on global regexes before using with .test.
    FROM_TABLE_RE.lastIndex = 0;
    const hasQuery = FROM_TABLE_RE.test(source);
    STORAGE_FROM_RE.lastIndex = 0;
    const hasStorage = STORAGE_FROM_RE.test(source);
    CHANNEL_RE.lastIndex = 0;
    const hasRealtime = CHANNEL_RE.test(source);
    RPC_RE.lastIndex = 0;
    const hasRpc = RPC_RE.test(source);

    if (hasCreateClient) {
      result.frameworkRole = 'supabase_client';
    } else if (hasStorage) {
      result.frameworkRole = 'supabase_storage';
    } else if (hasRealtime) {
      result.frameworkRole = 'supabase_realtime';
    } else if (hasAuth) {
      result.frameworkRole = 'supabase_auth';
    } else if (hasQuery || hasRpc) {
      result.frameworkRole = 'supabase_query';
    } else {
      result.frameworkRole = 'supabase_usage';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      if (!SUPABASE_IMPORT_RE.test(source)) continue;

      const symbols = ctx.getSymbolsByFile(file.id);

      const emit = (
        matchIdx: number,
        edgeType: string,
        targetPrefix: string,
        targetName: string,
        op: string,
        resourceKey: string,
      ) => {
        const line = lineOfIndex(source, matchIdx);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) return;
        edges.push({
          edgeType,
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `${targetPrefix}::${targetName}`,
          metadata: {
            op,
            [resourceKey]: targetName,
            line,
            file: file.path,
          },
          resolution: 'text_matched',
        });
      };

      // Queries: .from('table') followed (eventually) by .select/.insert/.update/.upsert/.delete
      FROM_TABLE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FROM_TABLE_RE.exec(source)) !== null) {
        const table = m[1];
        const afterIdx = m.index + m[0].length;
        const chained = findChainedOp<QueryOp>(source, afterIdx, QUERY_OP_RE);
        if (!chained) continue;
        emit(m.index, 'supabase_query', 'supabase-table', table, chained.op, 'table');
      }

      // RPC calls
      RPC_RE.lastIndex = 0;
      while ((m = RPC_RE.exec(source)) !== null) {
        const proc = m[1];
        emit(m.index, 'supabase_rpc', 'supabase-rpc', proc, 'rpc', 'procedure');
      }

      // Storage operations
      STORAGE_FROM_RE.lastIndex = 0;
      while ((m = STORAGE_FROM_RE.exec(source)) !== null) {
        const bucket = m[1];
        const afterIdx = m.index + m[0].length;
        const chained = findChainedOp<StorageOp>(source, afterIdx, STORAGE_OP_RE);
        if (!chained) continue;
        emit(m.index, 'supabase_storage', 'supabase-bucket', bucket, chained.op, 'bucket');
      }

      // Realtime channels
      CHANNEL_RE.lastIndex = 0;
      while ((m = CHANNEL_RE.exec(source)) !== null) {
        const channel = m[1];
        emit(m.index, 'supabase_realtime', 'supabase-channel', channel, 'subscribe', 'channel');
      }
    }

    return ok(edges);
  }
}
