/**
 * IoredisPlugin — detects Redis clients (ioredis, redis, bullmq, bull, @upstash/redis)
 * and tags files with roles for connection creation, pub/sub, streams, and command usage.
 *
 * Pass 1 (extractNodes) — file role tagging:
 *   1. Strong Redis-specific signals (Streams, pub/sub pairs, pipeline, typed commands)
 *      — tag files even when they don't import redis directly (shared-client pattern).
 *   2. Generic signals (get/set/del/keys) — only trust them when the file imports a redis pkg.
 *
 * Pass 2 (resolveEdges) — symbol-level edges:
 *   - redis_pubsub: enclosing symbol → redis-channel::<name> (per .publish / .subscribe)
 *   - redis_stream: enclosing symbol → redis-stream::<name>  (per .xadd)
 *   - redis_queue:  enclosing symbol → redis-queue::<name>   (per new Queue/Worker/...)
 *   Target strings are phantom (no backing symbol) — the engine stores them as self-loops
 *   with the resource name preserved in edge metadata.
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

const REDIS_PACKAGES = [
  'ioredis',
  'redis',
  'ioredis-mock',
  'bullmq',
  'bull',
  '@upstash/redis',
  'node-redis',
];

const CONNECTION_RE =
  /new\s+(?:Redis|IORedis|IoRedis)(?:\.Cluster)?\s*\(/;
const CREATE_CLIENT_RE =
  /\bcreateClient\s*\(\s*\{/;
const BULLMQ_QUEUE_RE =
  /new\s+(?:Queue|Worker|QueueEvents|QueueScheduler|FlowProducer)\s*\(\s*['"`]/;

const STREAM_RE =
  /\.(?:xadd|xread|xreadgroup|xrange|xrevrange|xgroup|xack|xlen|xpending|xclaim)\s*\(/i;
const PUBLISH_RE =
  /\.(?:publish|sPublish)\s*\(/;
const SUBSCRIBE_RE =
  /\.(?:p?subscribe|sSubscribe|pSubscribe)\s*\(/;
const PIPELINE_RE =
  /\.(?:pipeline|multi)\s*\(\s*\)/;

const TYPED_COMMAND_RE =
  /\.(?:h(?:get|set|mset|mget|getall|del|incrby|incrbyfloat|exists|keys|vals|len)|l(?:push|pop|range|len|rem|trim|index|set)|r(?:push|poplpush)|z(?:add|range|rem|score|rangebyscore|revrange|rank|incrby|card)|s(?:add|members|rem|ismember|inter|union|diff|card)|expire|pexpire|expireat|ttl|pttl|persist|incr|incrby|decr|decrby|setex|setnx|psetex|getset)\s*\(/gi;

const GENERIC_COMMAND_RE =
  /\.(?:get|set|del|keys|scan|eval|evalsha|ping|quit|flushdb|flushall|exists|dbsize)\s*\(/g;

const REDIS_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*['"](?:ioredis|ioredis-mock|redis|bullmq|bull|@upstash\/redis|node-redis)['"]/;

const PUBLISH_NAME_RE =
  /\.(?:publish|sPublish)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const SUBSCRIBE_NAME_RE =
  /\.(?:p?subscribe|sSubscribe|pSubscribe)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const XADD_NAME_RE =
  /\.xadd\s*\(\s*['"`]([^'"`]+)['"`]/g;
const QUEUE_NAME_RE =
  /new\s+(Queue|Worker|QueueEvents|QueueScheduler|FlowProducer)\s*\(\s*['"`]([^'"`]+)['"`]/g;

function countMatches(re: RegExp, source: string): number {
  if (!re.global && !re.sticky) throw new Error('countMatches requires a global regex');
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(source) !== null) n++;
  re.lastIndex = 0;
  return n;
}

export class IoredisPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'ioredis',
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
      for (const pkg of REDIS_PACKAGES) {
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
      for (const p of REDIS_PACKAGES) {
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
        { name: 'redis_connects', category: 'redis', description: 'Redis client connection creation' },
        { name: 'redis_pubsub', category: 'redis', description: 'Redis pub/sub channel operation' },
        { name: 'redis_stream', category: 'redis', description: 'Redis Streams operation' },
        { name: 'redis_queue', category: 'redis', description: 'BullMQ/Bull queue definition' },
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

    const hasImport = REDIS_IMPORT_RE.test(source);
    const hasConnection = CONNECTION_RE.test(source);
    const hasCreateClient = CREATE_CLIENT_RE.test(source);
    const hasBullmqQueue = BULLMQ_QUEUE_RE.test(source);
    const hasStream = STREAM_RE.test(source);
    const hasPublish = PUBLISH_RE.test(source);
    const hasSubscribe = SUBSCRIBE_RE.test(source);
    const hasPipeline = PIPELINE_RE.test(source);
    const typedCommandCount = countMatches(TYPED_COMMAND_RE, source);
    const hasGenericCommand = GENERIC_COMMAND_RE.test(source);

    if (hasConnection || hasCreateClient) {
      result.frameworkRole = 'redis_client';
    } else if (hasBullmqQueue) {
      result.frameworkRole = 'redis_queue';
    } else if (hasStream) {
      result.frameworkRole = 'redis_stream';
    } else if ((hasPublish && hasSubscribe) || (hasImport && (hasPublish || hasSubscribe))) {
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
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id);

      const emit = (
        re: RegExp,
        edgeType: string,
        resourcePrefix: string,
        op: string,
        nameGroup: number,
      ) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
          const line = lineOfIndex(source, m.index);
          const encl = findEnclosingSymbol(symbols, line);
          if (!encl) continue;
          const name = m[nameGroup];
          edges.push({
            edgeType,
            sourceNodeType: 'symbol',
            sourceRefId: encl.id,
            targetSymbolId: `${resourcePrefix}::${name}`,
            metadata: {
              op,
              [resourcePrefix === 'redis-channel' ? 'channel'
                : resourcePrefix === 'redis-stream' ? 'stream'
                : 'queue']: name,
              line,
              file: file.path,
            },
            resolution: 'text_matched',
          });
        }
      };

      emit(PUBLISH_NAME_RE, 'redis_pubsub', 'redis-channel', 'publish', 1);
      emit(SUBSCRIBE_NAME_RE, 'redis_pubsub', 'redis-channel', 'subscribe', 1);
      emit(XADD_NAME_RE, 'redis_stream', 'redis-stream', 'xadd', 1);

      // Queue has a different shape — op is the constructor kind.
      QUEUE_NAME_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = QUEUE_NAME_RE.exec(source)) !== null) {
        const line = lineOfIndex(source, m.index);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) continue;
        const kind = m[1];
        const name = m[2];
        edges.push({
          edgeType: 'redis_queue',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `redis-queue::${name}`,
          metadata: {
            op: kind.charAt(0).toLowerCase() + kind.slice(1),
            queue: name,
            line,
            file: file.path,
          },
          resolution: 'text_matched',
        });
      }
    }

    return ok(edges);
  }
}
