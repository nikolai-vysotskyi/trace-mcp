/**
 * `trace-mcp add [dir]` command.
 * Registers a project: detects root, detects frameworks, creates DB, adds to registry.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { findProjectRoot } from '../project-root.js';
import { detectProject } from '../init/detector.js';
import { generateConfig } from '../init/config-generator.js';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { registerProject, getProject } from '../registry.js';
import { saveProjectConfig } from '../config.js';
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

    // 1. Detect project root
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(resolvedDir);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }

    const isInteractive = !opts.json;

    if (isInteractive) {
      p.intro('trace-mcp add');
      if (projectRoot !== resolvedDir) {
        p.note(`Detected project root: ${projectRoot}`, 'Root');
      }
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

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
