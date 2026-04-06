/**
 * `trace-mcp upgrade` command.
 * Updates hooks, runs DB migrations, force-reindexes, refreshes CLAUDE.md.
 * Operates on all registered projects by default, or a specific one if [dir] is given.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { detectProject, detectGuardHook } from '../init/detector.js';
import { updateClaudeMd } from '../init/claude-md.js';
import { installGuardHook, installWorktreeHook, isHookOutdated } from '../init/hooks.js';
import { loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from '../indexer/plugins/integration/all.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { logger } from '../logger.js';
import { listProjects, updateLastIndexed } from '../registry.js';
import { getDbPath, ensureGlobalDirs } from '../global.js';
import type { InitStepResult } from '../init/types.js';

export const upgradeCommand = new Command('upgrade')
  .description('Upgrade trace-mcp: run DB migrations, reindex with latest plugins, update hooks and CLAUDE.md')
  .argument('[dir]', 'Project directory (omit to upgrade all registered projects)')
  .option('--skip-hooks', 'Do not update guard hooks')
  .option('--skip-reindex', 'Do not trigger reindex')
  .option('--skip-claude-md', 'Do not update CLAUDE.md block')
  .option('--dry-run', 'Show what would be done without writing files')
  .option('--json', 'Output results as JSON')
  .action(async (dir: string | undefined, opts: {
    skipHooks?: boolean;
    skipReindex?: boolean;
    skipClaudeMd?: boolean;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    // Determine which projects to upgrade
    const projectRoots: string[] = [];

    if (dir) {
      projectRoots.push(path.resolve(dir));
    } else {
      const projects = listProjects();
      if (projects.length === 0) {
        console.error('No registered projects. Run `trace-mcp add` first, or specify a directory.');
        process.exit(1);
      }
      for (const p of projects) {
        if (fs.existsSync(p.root)) {
          projectRoots.push(p.root);
        } else {
          logger.warn({ root: p.root }, 'Skipping stale project (directory not found)');
        }
      }
    }

    const allSteps: Array<{ projectRoot: string; steps: InitStepResult[] }> = [];

    for (const projectRoot of projectRoots) {
      const steps: InitStepResult[] = [];

      // Load config for this project
      const configResult = await loadConfig(projectRoot);
      if (configResult.isErr()) {
        logger.error({ error: configResult.error, project: projectRoot }, 'Failed to load config');
        steps.push({ target: projectRoot, action: 'skipped', detail: 'Config load failed' });
        allSteps.push({ projectRoot, steps });
        continue;
      }
      const config = configResult.value;

      // Resolve DB path
      const dbPath = getDbPath(projectRoot);
      ensureGlobalDirs();

      if (!opts.dryRun) {
        try {
          // Run migrations
          const db = initializeDatabase(dbPath);
          const store = new Store(db);

          const versionRow = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
          const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
          steps.push({
            target: dbPath, action: 'updated',
            detail: `Schema v${currentVersion}`,
          });

          // Force reindex
          if (!opts.skipReindex) {
            const registry = new PluginRegistry();
            for (const p of createAllLanguagePlugins()) registry.registerLanguagePlugin(p);
            for (const p of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(p);

            const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
            const result = await pipeline.indexAll(true);
            steps.push({
              target: projectRoot, action: 'updated',
              detail: `Reindexed: ${result.indexed} files, ${result.skipped} skipped, ${result.errors} errors`,
            });
            updateLastIndexed(projectRoot);
          }

          db.close();
        } catch (err) {
          logger.error({ error: (err as Error).message, project: projectRoot }, 'Upgrade failed');
          steps.push({ target: projectRoot, action: 'skipped', detail: `Upgrade failed: ${(err as Error).message}` });
        }
      } else {
        steps.push({ target: dbPath, action: 'skipped', detail: 'Would run migrations' });
        if (!opts.skipReindex) {
          steps.push({ target: projectRoot, action: 'skipped', detail: 'Would force reindex' });
        }
      }

      allSteps.push({ projectRoot, steps });
    }

    // Global: update guard hook if outdated
    if (!opts.skipHooks) {
      const { hasGuardHook, guardHookVersion } = detectGuardHook();
      if (hasGuardHook && isHookOutdated(guardHookVersion)) {
        const hookResult = installGuardHook({ dryRun: opts.dryRun });
        // Attach to first project's steps or create global section
        if (allSteps.length > 0) {
          allSteps[0].steps.push(hookResult);
        }
      }
      // Always ensure worktree hooks are installed (new in this version)
      const worktreeResults = installWorktreeHook({ dryRun: opts.dryRun });
      if (allSteps.length > 0) {
        allSteps[0].steps.push(...worktreeResults);
      }
    }

    // Global: refresh CLAUDE.md
    if (!opts.skipClaudeMd) {
      const mdResult = updateClaudeMd(process.cwd(), { dryRun: opts.dryRun, scope: 'global' });
      if (allSteps.length > 0) {
        allSteps[0].steps.push(mdResult);
      }
    }

    // Report
    const header = opts.dryRun ? 'trace-mcp upgrade (dry run)' : 'trace-mcp upgrade';
    if (opts.json) {
      console.log(JSON.stringify(allSteps, null, 2));
    } else {
      console.log(header);
      for (const { projectRoot, steps } of allSteps) {
        console.log(`\n  Project: ${path.basename(projectRoot)} (${projectRoot})`);
        for (const step of steps) {
          console.log(`    ${step.action}: ${step.detail ?? step.target}`);
        }
      }
      console.log();
    }
  });
