/**
 * `trace-mcp add [dir]` command.
 * Registers a project: detects root, detects frameworks, creates DB, adds to registry.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { findProjectRoot, discoverChildProjects, hasRootMarkers } from '../project-root.js';
import { detectProject } from '../init/detector.js';
import { generateConfig } from '../init/config-generator.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { registerProject, getProject, unregisterProject, listProjects, findParentProject, updateLastIndexed } from '../registry.js';
import { saveProjectConfig, removeProjectConfig, loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { setupProject } from '../project-setup.js';
import { Store } from '../db/store.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from '../indexer/plugins/integration/all.js';
import { IndexingPipeline } from '../indexer/pipeline.js';

async function runIndexing(
  projectRoot: string,
  opts: { json?: boolean },
): Promise<{ indexed: number; skipped: number; errors: number; durationMs: number } | null> {
  const configResult = await loadConfig(projectRoot);
  if (configResult.isErr()) {
    if (!opts.json) {
      p.log.warn(`Could not load config for indexing: ${configResult.error}`);
    }
    return null;
  }

  const dbPath = getDbPath(projectRoot);
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = new PluginRegistry();
  for (const lp of createAllLanguagePlugins()) registry.registerLanguagePlugin(lp);
  for (const fp of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(fp);

  const pipeline = new IndexingPipeline(store, registry, configResult.value, projectRoot);
  try {
    const result = await pipeline.indexAll(true);
    updateLastIndexed(projectRoot);
    return { indexed: result.indexed, skipped: result.skipped, errors: result.errors, durationMs: result.durationMs };
  } catch (err) {
    if (!opts.json) {
      p.log.warn(`Indexing failed: ${(err as Error).message}`);
    }
    return null;
  } finally {
    db.close();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const addCommand = new Command('add')
  .description('Register a project for indexing: detect root, create DB, add to registry')
  .argument('[dir]', 'Project directory (default: current directory)', '.')
  .option('--force', 'Re-register even if already registered')
  .option('--no-index', 'Skip indexing after registration')
  .option('--json', 'Output results as JSON')
  .action(async (dir: string, opts: { force?: boolean; index?: boolean; json?: boolean }) => {
    const resolvedDir = path.resolve(dir);
    if (!fs.existsSync(resolvedDir)) {
      console.error(`Directory does not exist: ${resolvedDir}`);
      process.exit(1);
    }

    // 1. Detect project root (or discover child projects)
    //    Priority: current dir > already-registered parent > multi-root discovery
    let projectRoot: string | undefined;
    if (hasRootMarkers(resolvedDir)) {
      // Current directory has root markers — use it directly, don't walk up
      projectRoot = resolvedDir;
    } else {
      // No markers in current dir — check if a parent is already registered
      try {
        const parentRoot = findProjectRoot(resolvedDir);
        const parentEntry = getProject(parentRoot);
        if (parentEntry) {
          // Parent is already registered — use it
          projectRoot = parentRoot;
        }
      } catch {
        // No root markers found anywhere up the tree
      }

      if (!projectRoot) {
        // Try multi-root discovery in subdirectories
        const children = discoverChildProjects(resolvedDir);
        if (children.length > 0) {
          await handleMultiRoot(resolvedDir, children, opts);
          return;
        }
        console.error(
          `Could not find project root from ${resolvedDir}. ` +
          `No root markers (package.json, .git, composer.json, etc.) found in this directory, ` +
          `and no child projects discovered in subdirectories.`,
        );
        process.exit(1);
      }
    }

    const isInteractive = !opts.json;

    if (isInteractive) {
      p.intro('trace-mcp add');
      if (projectRoot !== resolvedDir) {
        p.note(`Detected project root: ${projectRoot}`, 'Root');
      }
    }

    // Guard: warn if this project is already part of a multi-root
    const parentEntry = findParentProject(projectRoot);
    if (parentEntry && !opts.force) {
      if (opts.json) {
        console.log(JSON.stringify({ status: 'child_of_multi_root', parent: parentEntry }));
      } else {
        p.note(
          `This project is already part of multi-root index: ${parentEntry.name}\n` +
          `Root: ${parentEntry.root}`,
          'Multi-root',
        );
        p.outro('Use --force to register it separately.');
      }
      return;
    }

    // 2. Check if already registered
    const existing = getProject(projectRoot);
    if (existing && !opts.force) {
      if (opts.json) {
        console.log(JSON.stringify({ status: 'already_registered', project: existing }));
      } else {
        p.note(`Already registered: ${existing.name}\nDB: ${shortPath(existing.dbPath)}`, 'Existing');
        p.outro('Use --force to re-register.');
      }
      return;
    }

    // 3–8. Standard project setup: detect → config → DB → register
    const { entry, detection, dbPath, migrated } = setupProject(projectRoot, {
      force: opts.force,
      migrateOldDb: true,
    });

    if (isInteractive) {
      const detectedLines: string[] = [];
      if (detection.languages.length > 0) {
        detectedLines.push(`Languages: ${detection.languages.join(', ')}`);
      }
      if (detection.frameworks.length > 0) {
        detectedLines.push(`Frameworks: ${detection.frameworks.map((f) => f.version ? `${f.name} ${f.version}` : f.name).join(', ')}`);
      }
      if (detection.packageManagers.length > 0) {
        detectedLines.push(`Package managers: ${detection.packageManagers.map((pm) => pm.type).join(', ')}`);
      }
      if (detectedLines.length > 0) {
        p.note(detectedLines.join('\n'), 'Detected');
      }
    }

    // 9. Index immediately (unless --no-index)
    let indexResult: Awaited<ReturnType<typeof runIndexing>> = null;
    if (opts.index !== false) {
      if (isInteractive) {
        const spin = p.spinner();
        spin.start('Indexing project...');
        indexResult = await runIndexing(projectRoot, opts);
        if (indexResult) {
          spin.stop(`Indexed ${indexResult.indexed} files in ${formatDuration(indexResult.durationMs)}`);
        } else {
          spin.stop('Indexing skipped');
        }
      } else {
        indexResult = await runIndexing(projectRoot, opts);
      }
    }

    // 10. Report
    if (opts.json) {
      console.log(JSON.stringify({
        status: existing ? 're-registered' : 'registered',
        project: entry,
        migrated,
        detection: {
          languages: detection.languages,
          frameworks: detection.frameworks.map((f) => f.name),
        },
        indexing: indexResult ?? undefined,
      }, null, 2));
    } else {
      const lines: string[] = [];
      lines.push(`Project: ${entry.name}`);
      lines.push(`Root: ${projectRoot}`);
      lines.push(`DB: ${shortPath(dbPath)}`);
      if (migrated) {
        lines.push(`Migrated existing index from .trace-mcp/index.db`);
      }
      if (indexResult) {
        lines.push(`Indexed: ${indexResult.indexed} files (${indexResult.skipped} skipped, ${indexResult.errors} errors)`);
        lines.push(`Duration: ${formatDuration(indexResult.durationMs)}`);
      }
      p.note(lines.join('\n'), existing ? 'Re-registered' : 'Registered');
      if (indexResult) {
        p.outro('Project registered and indexed.');
      } else {
        p.outro('Project registered. Run `trace-mcp index` to index it.');
      }
    }
  });

async function handleMultiRoot(
  parentDir: string,
  childRoots: string[],
  opts: { force?: boolean; index?: boolean; json?: boolean },
): Promise<void> {
  const isInteractive = !opts.json;

  if (isInteractive) {
    p.intro('trace-mcp add (multi-root)');
    p.note(
      `No project root markers in ${parentDir}\n` +
      `Discovered ${childRoots.length} child project(s):\n` +
      childRoots.map((r) => `  ${path.basename(r)}`).join('\n'),
      'Multi-root',
    );
  }

  // Check if already registered as multi-root
  const existing = getProject(parentDir);
  if (existing && !opts.force) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'already_registered', project: existing }));
    } else {
      p.note(`Already registered as multi-root: ${existing.name}`, 'Existing');
      p.outro('Use --force to re-register.');
    }
    return;
  }

  // Detect and merge configs from all children
  const mergedInclude: string[] = [];
  const mergedExclude: string[] = [];
  const allLanguages = new Set<string>();
  const allFrameworks = new Set<string>();

  for (const childRoot of childRoots) {
    const relPath = path.relative(parentDir, childRoot).replace(/\\/g, '/');
    const detection = detectProject(childRoot);
    const config = generateConfig(detection);

    // Prefix patterns with child relative path
    for (const pattern of config.include) {
      mergedInclude.push(`${relPath}/${pattern}`);
    }
    for (const pattern of config.exclude) {
      mergedExclude.push(`${relPath}/${pattern}`);
    }

    for (const lang of detection.languages) allLanguages.add(lang);
    for (const fw of detection.frameworks) allFrameworks.add(fw.name);
  }

  if (isInteractive) {
    const detectedLines: string[] = [];
    if (allLanguages.size > 0) {
      detectedLines.push(`Languages: ${[...allLanguages].join(', ')}`);
    }
    if (allFrameworks.size > 0) {
      detectedLines.push(`Frameworks: ${[...allFrameworks].join(', ')}`);
    }
    if (detectedLines.length > 0) {
      p.note(detectedLines.join('\n'), 'Detected (all children)');
    }
  }

  // Cleanup: remove individually registered children
  const allProjects = listProjects();
  const cleaned: string[] = [];
  for (const proj of allProjects) {
    if (proj.root.startsWith(parentDir + path.sep) || proj.root.startsWith(parentDir + '/')) {
      // Delete child's DB file
      if (fs.existsSync(proj.dbPath)) {
        fs.unlinkSync(proj.dbPath);
      }
      unregisterProject(proj.root);
      removeProjectConfig(proj.root);
      cleaned.push(path.basename(proj.root));
    }
  }

  if (isInteractive && cleaned.length > 0) {
    p.note(`Removed individual indexes: ${cleaned.join(', ')}`, 'Cleanup');
  }

  // Save unified config
  ensureGlobalDirs();
  const configForSave = {
    root: '.',
    include: mergedInclude,
    exclude: mergedExclude,
    children: childRoots,
  };
  saveProjectConfig(parentDir, configForSave);

  // Create unified DB
  const dbPath = getDbPath(parentDir);
  const db = initializeDatabase(dbPath);
  db.close();

  // Register as multi-root
  const entry = registerProject(parentDir, {
    type: 'multi-root',
    children: childRoots,
  });

  // Index immediately (unless --no-index)
  let indexResult: Awaited<ReturnType<typeof runIndexing>> = null;
  if (opts.index !== false) {
    if (isInteractive) {
      const spin = p.spinner();
      spin.start('Indexing multi-root project...');
      indexResult = await runIndexing(parentDir, opts);
      if (indexResult) {
        spin.stop(`Indexed ${indexResult.indexed} files in ${formatDuration(indexResult.durationMs)}`);
      } else {
        spin.stop('Indexing skipped');
      }
    } else {
      indexResult = await runIndexing(parentDir, opts);
    }
  }

  // Report
  if (opts.json) {
    console.log(JSON.stringify({
      status: existing ? 're-registered' : 'registered',
      type: 'multi-root',
      project: entry,
      children: childRoots.map((r) => path.basename(r)),
      cleaned,
      indexing: indexResult ?? undefined,
    }, null, 2));
  } else {
    const lines: string[] = [];
    lines.push(`Project: ${entry.name} (multi-root)`);
    lines.push(`Root: ${parentDir}`);
    lines.push(`DB: ${shortPath(dbPath)}`);
    lines.push(`Children: ${childRoots.map((r) => path.basename(r)).join(', ')}`);
    if (indexResult) {
      lines.push(`Indexed: ${indexResult.indexed} files (${indexResult.skipped} skipped, ${indexResult.errors} errors)`);
      lines.push(`Duration: ${formatDuration(indexResult.durationMs)}`);
    }
    p.note(lines.join('\n'), existing ? 'Re-registered' : 'Registered');
    if (indexResult) {
      p.outro('Multi-root project registered and indexed.');
    } else {
      p.outro('Multi-root project registered. Run `trace-mcp index` to index it.');
    }
  }
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
