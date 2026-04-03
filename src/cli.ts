#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeDatabase } from './db/schema.js';
import { Store } from './db/store.js';
import { PluginRegistry } from './plugin-api/registry.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { PhpLanguagePlugin } from './indexer/plugins/language/php.js';
import { TypeScriptLanguagePlugin } from './indexer/plugins/language/typescript.js';
import { VueLanguagePlugin } from './indexer/plugins/language/vue.js';
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
import { IndexingPipeline } from './indexer/pipeline.js';
import { FileWatcher } from './indexer/watcher.js';

function registerDefaultPlugins(registry: PluginRegistry): void {
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
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

    // Initial index runs in background so the server starts immediately
    pipeline.indexAll().catch((err) => {
      logger.error({ error: err }, 'Initial indexing failed');
    });

    await watcher.start(projectRoot, config, async (paths) => {
      await pipeline.indexFiles(paths);
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
