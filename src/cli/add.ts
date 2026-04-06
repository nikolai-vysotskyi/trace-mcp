/**
 * `trace-mcp add [dir]` command.
 * Registers a project: detects root, detects frameworks, creates DB, adds to registry.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { findProjectRoot, discoverChildProjects } from '../project-root.js';
import { detectProject } from '../init/detector.js';
import { generateConfig } from '../init/config-generator.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { registerProject, getProject, unregisterProject, listProjects, findParentProject } from '../registry.js';
import { saveProjectConfig, removeProjectConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';

export const addCommand = new Command('add')
  .description('Register a project for indexing: detect root, create DB, add to registry')
  .argument('[dir]', 'Project directory (default: current directory)', '.')
  .option('--force', 'Re-register even if already registered')
  .option('--json', 'Output results as JSON')
  .action(async (dir: string, opts: { force?: boolean; json?: boolean }) => {
    const resolvedDir = path.resolve(dir);
    if (!fs.existsSync(resolvedDir)) {
      console.error(`Directory does not exist: ${resolvedDir}`);
      process.exit(1);
    }

    // 1. Detect project root (or discover child projects)
    let projectRoot: string | undefined;
    try {
      projectRoot = findProjectRoot(resolvedDir);
    } catch {
      // No root markers — try multi-root discovery
      const children = discoverChildProjects(resolvedDir);
      if (children.length > 0) {
        await handleMultiRoot(resolvedDir, children, opts);
        return;
      }
      console.error(
        `Could not find project root from ${resolvedDir}, ` +
        `and no child projects discovered in subdirectories.`,
      );
      process.exit(1);
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

    // 3. Detect project (frameworks, languages, etc.)
    const detection = detectProject(projectRoot);

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

    // 4. Generate config for this project
    const config = generateConfig(detection);
    const configForSave = {
      root: config.root,
      include: config.include,
      exclude: config.exclude,
    };

    // 5. Ensure global dirs
    ensureGlobalDirs();

    // 6. Save per-project config in global config file
    saveProjectConfig(projectRoot, configForSave);

    // 7. Create DB at global location
    const dbPath = getDbPath(projectRoot);

    // Migrate old local DB if exists and global doesn't
    const oldDbPath = path.join(projectRoot, '.trace-mcp', 'index.db');
    let migrated = false;
    if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
      fs.copyFileSync(oldDbPath, dbPath);
      migrated = true;
    }

    // Initialize (creates if new, runs migrations if migrated)
    const db = initializeDatabase(dbPath);
    db.close();

    // 8. Register in registry
    const entry = registerProject(projectRoot);

    // 9. Report
    if (opts.json) {
      console.log(JSON.stringify({
        status: existing ? 're-registered' : 'registered',
        project: entry,
        migrated,
        detection: {
          languages: detection.languages,
          frameworks: detection.frameworks.map((f) => f.name),
        },
      }, null, 2));
    } else {
      const lines: string[] = [];
      lines.push(`Project: ${entry.name}`);
      lines.push(`Root: ${projectRoot}`);
      lines.push(`DB: ${shortPath(dbPath)}`);
      if (migrated) {
        lines.push(`Migrated existing index from .trace-mcp/index.db`);
      }
      p.note(lines.join('\n'), existing ? 'Re-registered' : 'Registered');
      p.outro('Project registered. It will be indexed when trace-mcp serve starts.');
    }
  });

async function handleMultiRoot(
  parentDir: string,
  childRoots: string[],
  opts: { force?: boolean; json?: boolean },
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

  // Report
  if (opts.json) {
    console.log(JSON.stringify({
      status: existing ? 're-registered' : 'registered',
      type: 'multi-root',
      project: entry,
      children: childRoots.map((r) => path.basename(r)),
      cleaned,
    }, null, 2));
  } else {
    const lines: string[] = [];
    lines.push(`Project: ${entry.name} (multi-root)`);
    lines.push(`Root: ${parentDir}`);
    lines.push(`DB: ${shortPath(dbPath)}`);
    lines.push(`Children: ${childRoots.map((r) => path.basename(r)).join(', ')}`);
    p.note(lines.join('\n'), existing ? 'Re-registered' : 'Registered');
    p.outro('Multi-root project registered. It will be indexed when trace-mcp serve starts.');
  }
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
