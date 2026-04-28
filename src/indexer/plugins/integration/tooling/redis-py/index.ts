/**
 * RedisPyPlugin — detects the Python `redis` package (sync and async variants)
 * and mirrors the JS ioredis plugin's role-and-edge coverage.
 *
 * Detection (Pass 1 / extractNodes):
 *   - redis_client   — file creates a Redis connection (Redis(), StrictRedis(), ConnectionPool())
 *   - redis_pubsub   — .publish / .subscribe / .pubsub() on a redis client
 *   - redis_stream   — .xadd / .xread / .xreadgroup / ...
 *   - redis_usage    — generic commands (get/set/hget/lpush/...) with a redis import
 *
 * Edges (Pass 2 / resolveEdges):
 *   - redis_pubsub: enclosing symbol → redis-channel::<name>  (per .publish / .subscribe literal)
 *   - redis_stream: enclosing symbol → redis-stream::<name>   (per .xadd literal)
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const PACKAGES = ['redis'] as const;

// `import redis` or `from redis import ...` (including `from redis.asyncio import Redis`).
const REDIS_IMPORT_RE = /^\s*(?:import\s+redis(?:\s+as\s+\w+)?|from\s+redis(?:\.\w+)?\s+import)\b/m;
// Named import of Redis-like classes (for bare-call detection).
// Two forms: single-line `from redis import A, B` and parenthesized multi-line
// `from redis import (\n    A,\n    B,\n)`.
const FROM_REDIS_CLASS_RE =
  /\bfrom\s+redis(?:\.asyncio|\.cluster)?\s+import\s+(?:\(([^)]*)\)|([^#\n]*))/g;
// `import redis as alias` — track alias for bare `alias.Redis()` detection.
const IMPORT_REDIS_ALIAS_RE = /\bimport\s+redis(?:\.(?:asyncio|cluster))?\s+as\s+(\w+)/g;

// Connection creation — qualified forms.
const QUALIFIED_CONNECTION_RE =
  /\bredis(?:\s*\.\s*asyncio|\s*\.\s*cluster)?\s*\.\s*(?:Redis|StrictRedis|RedisCluster)\s*\(/;
const QUALIFIED_POOL_RE =
  /\bredis(?:\s*\.\s*asyncio|\s*\.\s*cluster)?\s*\.\s*(?:Blocking)?ConnectionPool(?:\s*\.\s*from_url)?\s*\(/;

// Pub/sub
const PUBSUB_FN_RE = /\.\s*pubsub\s*\(\s*\)/;
const PUBLISH_RE = /\.\s*publish\s*\(/;
const SUBSCRIBE_RE = /\.\s*(?:p?subscribe|p?unsubscribe)\s*\(/;

// Streams — uniquely redis.
const STREAM_RE =
  /\.\s*(?:xadd|xread|xreadgroup|xrange|xrevrange|xgroup|xack|xlen|xpending|xclaim)\s*\(/i;

// Pipelines / transactions
const PIPELINE_RE = /\.\s*(?:pipeline|transaction)\s*\(/;

// Typed commands — strong evidence even without import.
const TYPED_COMMAND_RE =
  /\.\s*(?:h(?:get|set|mset|mget|getall|del|incrby|exists|keys|vals|len)|l(?:push|pop|range|len|rem|trim|index|set)|r(?:push|pop|poplpush)|z(?:add|range|rem|score|rangebyscore|revrange|rank|incrby|card)|s(?:add|members|rem|ismember|inter|union|diff|card)|expire|pexpire|expireat|ttl|pttl|persist|incr|incrby|decr|decrby|setex|setnx|psetex|getset)\s*\(/gi;

// Generic commands — only trust with an import to avoid FP on Map.get / requests.get / etc.
const GENERIC_COMMAND_RE =
  /\.\s*(?:get|set|delete|keys|scan|eval|evalsha|ping|flushdb|flushall|exists|dbsize)\s*\(/g;

// Edge patterns
const PUBLISH_NAME_RE = /\.\s*publish\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["'])/g;
const SUBSCRIBE_NAME_RE = /\.\s*(?:p?subscribe)\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["'])/g;
const XADD_NAME_RE = /\.\s*xadd\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["'])/g;

function countMatches(re: RegExp, source: string): number {
  if (!re.global && !re.sticky) throw new Error('countMatches requires a global regex');
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(source) !== null) n++;
  re.lastIndex = 0;
  return n;
}

function parseRedisNamedImports(source: string): Set<string> {
  const names = new Set<string>();
  FROM_REDIS_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_REDIS_CLASS_RE.exec(source)) !== null) {
    // Group 1 = parenthesized multi-line body; Group 2 = single-line.
    const body = (m[1] ?? m[2] ?? '').replace(/\\/g, ' ');
    for (const raw of body.split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0]).trim();
      if (local && /^[A-Za-z_]\w*$/.test(local)) names.add(local);
    }
  }
  return names;
}

function parseRedisModuleAliases(source: string): string[] {
  const aliases: string[] = [];
  IMPORT_REDIS_ALIAS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_REDIS_ALIAS_RE.exec(source)) !== null) {
    aliases.push(m[1]);
  }
  return aliases;
}

export class RedisPyPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'redis-py',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'redis_connects',
          category: 'redis',
          description: 'Redis client connection creation',
        },
        { name: 'redis_pubsub', category: 'redis', description: 'Redis pub/sub channel operation' },
        { name: 'redis_stream', category: 'redis', description: 'Redis Streams operation' },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    const hasImport = REDIS_IMPORT_RE.test(source);
    const namedImports = parseRedisNamedImports(source);
    const aliases = parseRedisModuleAliases(source);

    let hasConnection = QUALIFIED_CONNECTION_RE.test(source) || QUALIFIED_POOL_RE.test(source);
    // Bare `Redis(host=...)` — only when Redis is imported from `redis`.
    if (!hasConnection && (namedImports.has('Redis') || namedImports.has('StrictRedis'))) {
      if (/\b(?:Redis|StrictRedis)\s*\(/.test(source)) hasConnection = true;
    }
    if (!hasConnection && namedImports.has('ConnectionPool')) {
      if (/\bConnectionPool(?:\s*\.\s*from_url)?\s*\(/.test(source)) hasConnection = true;
    }
    // Aliased module: `import redis as r; r.Redis(...)` / `r.ConnectionPool(...)`.
    if (!hasConnection && aliases.length > 0) {
      for (const alias of aliases) {
        const aliasEscaped = alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const re = new RegExp(
          `\\b${aliasEscaped}\\s*\\.\\s*(?:Redis|StrictRedis|RedisCluster|(?:Blocking)?ConnectionPool(?:\\s*\\.\\s*from_url)?)\\s*\\(`,
        );
        if (re.test(source)) {
          hasConnection = true;
          break;
        }
      }
    }

    const hasStream = STREAM_RE.test(source);
    const hasPublish = PUBLISH_RE.test(source);
    const hasSubscribe = SUBSCRIBE_RE.test(source);
    const hasPubsubFn = PUBSUB_FN_RE.test(source);
    const hasPipeline = PIPELINE_RE.test(source);
    const typedCommandCount = countMatches(TYPED_COMMAND_RE, source);
    const hasGenericCommand = GENERIC_COMMAND_RE.test(source);

    if (hasConnection) {
      result.frameworkRole = 'redis_client';
    } else if (hasStream) {
      result.frameworkRole = 'redis_stream';
    } else if (
      (hasPublish && hasSubscribe) ||
      hasPubsubFn ||
      (hasImport && (hasPublish || hasSubscribe))
    ) {
      result.frameworkRole = 'redis_pubsub';
    } else if (hasPipeline) {
      result.frameworkRole = 'redis_usage';
    } else if (typedCommandCount >= 2) {
      result.frameworkRole = 'redis_usage';
    } else if (hasImport && (typedCommandCount > 0 || hasGenericCommand)) {
      result.frameworkRole = 'redis_usage';
    } else if (hasImport) {
      result.frameworkRole = 'redis_usage';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'python') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id);

      const emit = (re: RegExp, edgeType: string, resourcePrefix: string, op: string) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
          const line = lineOfIndex(source, m.index);
          const encl = findEnclosingSymbol(symbols, line);
          if (!encl) continue;
          const name = m[1];
          const resourceKey =
            resourcePrefix === 'redis-channel'
              ? 'channel'
              : resourcePrefix === 'redis-stream'
                ? 'stream'
                : 'resource';
          edges.push({
            edgeType,
            sourceNodeType: 'symbol',
            sourceRefId: encl.id,
            targetSymbolId: `${resourcePrefix}::${name}`,
            metadata: { op, [resourceKey]: name, line, file: file.path },
            resolution: 'text_matched',
          });
        }
      };

      emit(PUBLISH_NAME_RE, 'redis_pubsub', 'redis-channel', 'publish');
      emit(SUBSCRIBE_NAME_RE, 'redis_pubsub', 'redis-channel', 'subscribe');
      emit(XADD_NAME_RE, 'redis_stream', 'redis-stream', 'xadd');
    }

    return ok(edges);
  }
}
