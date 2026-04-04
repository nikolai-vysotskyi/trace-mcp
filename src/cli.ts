#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initializeDatabase } from './db/schema.js';
import { Store } from './db/store.js';
import { PluginRegistry } from './plugin-api/registry.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { PhpLanguagePlugin } from './indexer/plugins/language/php.js';
import { TypeScriptLanguagePlugin } from './indexer/plugins/language/typescript.js';
import { VueLanguagePlugin } from './indexer/plugins/language/vue.js';
import { PythonLanguagePlugin } from './indexer/plugins/language/python.js';
import { JavaLanguagePlugin } from './indexer/plugins/language/java.js';
import { KotlinLanguagePlugin } from './indexer/plugins/language/kotlin.js';
import { RubyLanguagePlugin } from './indexer/plugins/language/ruby.js';
import { GoLanguagePlugin } from './indexer/plugins/language/go.js';
import { LaravelPlugin } from './indexer/plugins/framework/laravel/index.js';
import { VueFrameworkPlugin } from './indexer/plugins/framework/vue/index.js';
import { InertiaPlugin } from './indexer/plugins/framework/inertia/index.js';
import { NuxtPlugin } from './indexer/plugins/framework/nuxt/index.js';
import { BladePlugin } from './indexer/plugins/framework/blade/index.js';
import { NestJSPlugin } from './indexer/plugins/framework/nestjs/index.js';
import { NextJSPlugin } from './indexer/plugins/framework/nextjs/index.js';
import { ExpressPlugin } from './indexer/plugins/framework/express/index.js';
import { MongoosePlugin } from './indexer/plugins/framework/mongoose/index.js';
import { SequelizePlugin } from './indexer/plugins/framework/sequelize/index.js';
import { ReactNativePlugin } from './indexer/plugins/framework/react-native/index.js';
import { PrismaPlugin, PrismaLanguagePlugin } from './indexer/plugins/framework/prisma/index.js';
import { GraphQLPlugin, GraphQLLanguagePlugin } from './indexer/plugins/framework/graphql/index.js';
import { TypeORMPlugin } from './indexer/plugins/framework/typeorm/index.js';
import { DrizzlePlugin } from './indexer/plugins/framework/drizzle/index.js';
import { DRFPlugin } from './indexer/plugins/framework/drf/index.js';
import { PydanticPlugin } from './indexer/plugins/framework/pydantic/index.js';
import { CeleryPlugin } from './indexer/plugins/framework/celery/index.js';
import { FastAPIPlugin } from './indexer/plugins/framework/fastapi/index.js';
import { FlaskPlugin } from './indexer/plugins/framework/flask/index.js';
import { SQLAlchemyPlugin } from './indexer/plugins/framework/sqlalchemy/index.js';
import { SpringPlugin } from './indexer/plugins/framework/spring/index.js';
import { RailsPlugin } from './indexer/plugins/framework/rails/index.js';
import { DjangoPlugin } from './indexer/plugins/framework/django/index.js';
import { ReactPlugin } from './indexer/plugins/framework/react/index.js';
import { TrpcPlugin } from './indexer/plugins/framework/trpc/index.js';
import { FastifyPlugin } from './indexer/plugins/framework/fastify/index.js';
import { HonoPlugin } from './indexer/plugins/framework/hono/index.js';
import { SocketIoPlugin } from './indexer/plugins/framework/socketio/index.js';
import { ZustandReduxPlugin } from './indexer/plugins/framework/zustand/index.js';
import { N8nPlugin } from './indexer/plugins/framework/n8n/index.js';
import { DataFetchingPlugin } from './indexer/plugins/framework/data-fetching/index.js';
import { ZodPlugin } from './indexer/plugins/framework/zod/index.js';
import { TestingPlugin } from './indexer/plugins/framework/testing/index.js';
import { IndexingPipeline } from './indexer/pipeline.js';
import { FileWatcher } from './indexer/watcher.js';
import { createAIProvider, BlobVectorStore, EmbeddingPipeline, InferenceCache, CachedInferenceService } from './ai/index.js';
import { SummarizationPipeline } from './ai/summarization-pipeline.js';
import http from 'node:http';

function registerDefaultPlugins(registry: PluginRegistry): void {
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
  registry.registerLanguagePlugin(new PythonLanguagePlugin());
  registry.registerLanguagePlugin(new JavaLanguagePlugin());
  registry.registerLanguagePlugin(new KotlinLanguagePlugin());
  registry.registerLanguagePlugin(new RubyLanguagePlugin());
  registry.registerLanguagePlugin(new GoLanguagePlugin());
  registry.registerLanguagePlugin(new PrismaLanguagePlugin());
  registry.registerLanguagePlugin(new GraphQLLanguagePlugin());
  registry.registerFrameworkPlugin(new LaravelPlugin());
  registry.registerFrameworkPlugin(new VueFrameworkPlugin());
  registry.registerFrameworkPlugin(new InertiaPlugin());
  registry.registerFrameworkPlugin(new NuxtPlugin());
  registry.registerFrameworkPlugin(new BladePlugin());
  registry.registerFrameworkPlugin(new NestJSPlugin());
  registry.registerFrameworkPlugin(new NextJSPlugin());
  registry.registerFrameworkPlugin(new ExpressPlugin());
  registry.registerFrameworkPlugin(new MongoosePlugin());
  registry.registerFrameworkPlugin(new SequelizePlugin());
  registry.registerFrameworkPlugin(new ReactNativePlugin());
  registry.registerFrameworkPlugin(new PrismaPlugin());
  registry.registerFrameworkPlugin(new GraphQLPlugin());
  registry.registerFrameworkPlugin(new TypeORMPlugin());
  registry.registerFrameworkPlugin(new DrizzlePlugin());
  registry.registerFrameworkPlugin(new DRFPlugin());
  registry.registerFrameworkPlugin(new PydanticPlugin());
  registry.registerFrameworkPlugin(new CeleryPlugin());
  registry.registerFrameworkPlugin(new FastAPIPlugin());
  registry.registerFrameworkPlugin(new FlaskPlugin());
  registry.registerFrameworkPlugin(new SQLAlchemyPlugin());
  registry.registerFrameworkPlugin(new DjangoPlugin());
  registry.registerFrameworkPlugin(new TrpcPlugin());
  registry.registerFrameworkPlugin(new FastifyPlugin());
  registry.registerFrameworkPlugin(new SocketIoPlugin());
  registry.registerFrameworkPlugin(new HonoPlugin());
  registry.registerFrameworkPlugin(new ZustandReduxPlugin());
  registry.registerFrameworkPlugin(new ReactPlugin());
  registry.registerFrameworkPlugin(new N8nPlugin());
  registry.registerFrameworkPlugin(new SpringPlugin());
  registry.registerFrameworkPlugin(new RailsPlugin());
  registry.registerFrameworkPlugin(new DataFetchingPlugin());
  registry.registerFrameworkPlugin(new ZodPlugin());
  registry.registerFrameworkPlugin(new TestingPlugin());
}

const program = new Command();

program
  .name('trace-mcp')
  .description('Framework-Aware Code Intelligence for Laravel/Vue/Inertia/Nuxt')
  .version('0.1.0');

program
  .command('serve')
  .description('Start MCP server (stdio transport)')
  .action(async () => {
    const configResult = await loadConfig(process.cwd());
    if (configResult.isErr()) {
      logger.error({ error: configResult.error }, 'Failed to load config');
      process.exit(1);
    }
    const config = configResult.value;

    const dbPath = path.resolve(process.cwd(), config.db.path);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const projectRoot = process.cwd();
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
    const watcher = new FileWatcher();

    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline = vectorStore && embeddingService
      ? new EmbeddingPipeline(store, embeddingService, vectorStore)
      : null;

    // Summarization pipeline (uses fast model + inference cache)
    const inferenceCache = config.ai?.enabled ? new InferenceCache(store.db) : null;
    const summarizationPipeline = config.ai?.enabled && config.ai.summarize_on_index !== false
      ? new SummarizationPipeline(
          store,
          new CachedInferenceService(aiProvider.fastInference(), inferenceCache!, config.ai.fast_model ?? 'fast'),
          projectRoot,
          {
            batchSize: config.ai.summarize_batch_size ?? 20,
            kinds: config.ai.summarize_kinds ?? ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'],
          },
        )
      : null;

    const runEmbeddings = () => {
      if (!embeddingPipeline) return;
      embeddingPipeline.indexUnembedded().catch((err) => {
        logger.error({ error: err }, 'Embedding indexing failed');
      });
    };

    const runSummarization = () => {
      if (!summarizationPipeline) return;
      summarizationPipeline.summarizeUnsummarized().catch((err) => {
        logger.error({ error: err }, 'Summarization failed');
      });
    };

    // Initial index runs in background so the server starts immediately
    // Summarization runs first (populates summaries), then embeddings (uses summaries for richer text)
    pipeline.indexAll().then(() => { runSummarization(); runEmbeddings(); }).catch((err) => {
      logger.error({ error: err }, 'Initial indexing failed');
    });

    await watcher.start(projectRoot, config, async (paths) => {
      await pipeline.indexFiles(paths);
      runSummarization();
      runEmbeddings();
    }, undefined, async (deleted) => {
      pipeline.deleteFiles(deleted);
    });

    const shutdown = async () => {
      await watcher.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const server = createServer(store, registry, config, projectRoot);
    const transport = new StdioServerTransport();

    logger.info('Starting trace-mcp MCP server...');
    await server.connect(transport);
  });

program
  .command('serve-http')
  .description('Start MCP server (HTTP/SSE transport)')
  .option('-p, --port <port>', 'Port to listen on', '3741')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    const configResult = await loadConfig(process.cwd());
    if (configResult.isErr()) {
      logger.error({ error: configResult.error }, 'Failed to load config');
      process.exit(1);
    }
    const config = configResult.value;

    const dbPath = path.resolve(process.cwd(), config.db.path);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const projectRoot = process.cwd();
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
    const watcher = new FileWatcher();

    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline = vectorStore && embeddingService
      ? new EmbeddingPipeline(store, embeddingService, vectorStore)
      : null;

    const inferenceCache2 = config.ai?.enabled ? new InferenceCache(store.db) : null;
    const summarizationPipeline2 = config.ai?.enabled && config.ai.summarize_on_index !== false
      ? new SummarizationPipeline(
          store,
          new CachedInferenceService(aiProvider.fastInference(), inferenceCache2!, config.ai.fast_model ?? 'fast'),
          projectRoot,
          {
            batchSize: config.ai.summarize_batch_size ?? 20,
            kinds: config.ai.summarize_kinds ?? ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'],
          },
        )
      : null;

    const runEmbeddings = () => {
      if (!embeddingPipeline) return;
      embeddingPipeline.indexUnembedded().catch((err) => {
        logger.error({ error: err }, 'Embedding indexing failed');
      });
    };

    const runSummarization2 = () => {
      if (!summarizationPipeline2) return;
      summarizationPipeline2.summarizeUnsummarized().catch((err) => {
        logger.error({ error: err }, 'Summarization failed');
      });
    };

    pipeline.indexAll().then(() => { runSummarization2(); runEmbeddings(); }).catch((err) => {
      logger.error({ error: err }, 'Initial indexing failed');
    });

    await watcher.start(projectRoot, config, async (paths) => {
      await pipeline.indexFiles(paths);
      runSummarization2();
      runEmbeddings();
    }, undefined, async (deleted) => {
      pipeline.deleteFiles(deleted);
    });

    const port = parseInt(opts.port, 10);
    const host = opts.host;

    // Simple per-IP rate limiter (token bucket: 60 requests/minute per IP)
    const RATE_WINDOW_MS = 60_000;
    const RATE_LIMIT = 60;
    const rateBuckets = new Map<string, { count: number; resetAt: number }>();

    function isRateLimited(ip: string): boolean {
      const now = Date.now();
      const bucket = rateBuckets.get(ip);
      if (!bucket || now > bucket.resetAt) {
        rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return false;
      }
      bucket.count++;
      return bucket.count > RATE_LIMIT;
    }

    // Periodically evict expired rate-limit buckets to prevent memory leak
    const rateBucketCleanup = setInterval(() => {
      const now = Date.now();
      for (const [ip, bucket] of rateBuckets) {
        if (now > bucket.resetAt) rateBuckets.delete(ip);
      }
    }, RATE_WINDOW_MS);
    rateBucketCleanup.unref(); // Don't block process exit

    // Max request body size (5 MB)
    const MAX_BODY_SIZE = 5 * 1024 * 1024;

    // Stateless HTTP transport: each request gets its own transport instance
    const httpServer = http.createServer(async (req, res) => {
      const clientIp = req.socket.remoteAddress ?? 'unknown';

      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      // Enforce max body size
      let bodySize = 0;
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          req.destroy();
        }
      });

      if (req.method === 'POST' && req.url === '/mcp') {
        const server = createServer(store, registry, config, projectRoot);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });
        res.on('close', () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'http' }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const shutdown = async () => {
      await watcher.stop();
      httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    httpServer.listen(port, host, () => {
      logger.info({ host, port, endpoint: `http://${host}:${port}/mcp` }, 'trace-mcp HTTP server started');
    });
  });

program
  .command('index')
  .description('Index a project directory')
  .argument('<dir>', 'Directory to index')
  .option('-f, --force', 'Force reindex all files')
  .action(async (dir: string, opts: { force?: boolean }) => {
    const resolvedDir = path.resolve(dir);
    if (!fs.existsSync(resolvedDir)) {
      logger.error({ dir: resolvedDir }, 'Directory does not exist');
      process.exit(1);
    }

    const configResult = await loadConfig(resolvedDir);
    if (configResult.isErr()) {
      logger.error({ error: configResult.error }, 'Failed to load config');
      process.exit(1);
    }
    const config = configResult.value;

    const dbPath = path.resolve(resolvedDir, config.db.path);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    logger.info({ dir: resolvedDir, dbPath, force: opts.force ?? false }, 'Indexing started');

    const pipeline = new IndexingPipeline(store, registry, config, resolvedDir);
    const result = await pipeline.indexAll(opts.force ?? false);
    logger.info(result, 'Indexing completed');

    db.close();
  });

program.parse();
