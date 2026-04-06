/**
 * `trace-mcp bundles` command.
 * Manage pre-indexed bundles for popular libraries.
 */

import { Command } from 'commander';
import { exportBundle, listBundles, removeBundle, ensureBundlesDir } from '../bundles.js';
import { getDbPath, ensureGlobalDirs } from '../global.js';
import { getProject } from '../registry.js';
import { findProjectRoot } from '../project-root.js';

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

export const bundlesCommand = new Command('bundles')
  .description('Manage pre-indexed bundles for dependency libraries');

bundlesCommand
  .command('list')
  .description('List installed bundles')
  .action(() => {
    ensureBundlesDir();
    const bundles = listBundles();
    if (bundles.length === 0) {
      console.log('No bundles installed.');
      console.log('Create one with: trace-mcp bundles export --package <name> --version <ver>');
      return;
    }
    console.log('Installed bundles:\n');
    for (const b of bundles) {
      const sizeKB = Math.round(b.size_bytes / 1024);
      console.log(`  ${b.package}@${b.version}`);
      console.log(`    Symbols: ${b.symbols} | Edges: ${b.edges} | Size: ${sizeKB}KB`);
      console.log(`    Created: ${b.created_at}`);
      console.log();
    }
  });

bundlesCommand
  .command('export')
  .description('Export current project index as a bundle')
  .requiredOption('--package <name>', 'Package name (e.g. "react")')
  .requiredOption('--version <ver>', 'Package version (e.g. "19.1.0")')
  .action((opts: { package: string; version: string }) => {
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(process.cwd());
    } catch {
      projectRoot = process.cwd();
    }

    ensureGlobalDirs();
    const dbPath = resolveDbPath(projectRoot);
    const entry = exportBundle(dbPath, opts.package, opts.version);
    const sizeKB = Math.round(entry.size_bytes / 1024);
    console.log(`Bundle exported: ${opts.package}@${opts.version}`);
    console.log(`  Symbols: ${entry.symbols} | Edges: ${entry.edges} | Size: ${sizeKB}KB`);
    console.log(`  SHA256: ${entry.sha256}`);
  });

bundlesCommand
  .command('remove')
  .description('Remove an installed bundle')
  .requiredOption('--package <name>', 'Package name')
  .option('--version <ver>', 'Specific version (omit to remove all versions)')
  .action((opts: { package: string; version?: string }) => {
    const count = removeBundle(opts.package, opts.version);
    if (count === 0) {
      console.log(`No bundles found for ${opts.package}${opts.version ? `@${opts.version}` : ''}`);
    } else {
      console.log(`Removed ${count} bundle(s) for ${opts.package}`);
    }
  });
