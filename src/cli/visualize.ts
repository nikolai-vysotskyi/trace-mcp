/**
 * CLI: trace-mcp visualize — open an interactive dependency graph in the browser.
 *
 * Usage:
 *   trace-mcp visualize [scope]              # scope: file/dir/project (default: project)
 *   trace-mcp visualize src/server.ts
 *   trace-mcp visualize src/
 *   trace-mcp visualize --layout hierarchical --color-by framework_role
 *   trace-mcp visualize --output /tmp/graph.html --no-open
 *
 *   trace-mcp visualize federation           # federation topology
 *   trace-mcp visualize federation --layout radial
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { getDbPath, ensureGlobalDirs, TOPOLOGY_DB_PATH } from '../global.js';
import { findProjectRoot } from '../project-root.js';
import { getProject } from '../registry.js';
import { TopologyStore } from '../topology/topology-db.js';
import { visualizeGraph } from '../tools/analysis/visualize.js';
import { visualizeFederationTopology } from '../tools/analysis/visualize-federation.js';

function openInBrowser(filePath: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') execSync(`open "${filePath}"`);
    else if (platform === 'win32') execSync(`start "" "${filePath}"`);
    else execSync(`xdg-open "${filePath}"`);
  } catch {
    // ignore — user can open manually
  }
}

export const visualizeCommand = new Command('visualize')
  .alias('viz')
  .description('Open an interactive dependency graph in the browser')
  .argument('[scope]', 'file path, directory, or "project" (default: project)', 'project')
  .option('-l, --layout <type>', 'graph layout: force | hierarchical | radial', 'force')
  .option('-c, --color-by <mode>', 'coloring: community | language | framework_role', 'community')
  .option('-d, --depth <n>', 'max hops from scope', '2')
  .option('-o, --output <path>', 'output HTML file path')
  .option('--no-open', 'write HTML but do not open the browser')
  .option('--dir <dir>', 'project directory (default: cwd)')
  .action((scope: string, opts) => {
    const projectDir = opts.dir ? path.resolve(opts.dir) : process.cwd();
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(projectDir);
    } catch {
      projectRoot = projectDir;
    }

    const dbPath = (() => {
      const entry = getProject(projectRoot);
      return entry ? entry.dbPath : getDbPath(projectRoot);
    })();

    if (!fs.existsSync(dbPath)) {
      console.error(`No index found for ${projectRoot}`);
      console.error(`Run: trace-mcp index ${projectRoot}`);
      process.exit(1);
    }

    const outputPath = opts.output ?? path.join(os.tmpdir(), 'trace-mcp-graph.html');

    const db = initializeDatabase(dbPath);
    const store = new Store(db);

    const result = visualizeGraph(store, {
      scope,
      layout: opts.layout,
      colorBy: opts.colorBy,
      depth: parseInt(opts.depth, 10),
      output: outputPath,
    });

    db.close();

    if (result.isErr()) {
      console.error('Error:', result.error.message);
      process.exit(1);
    }

    console.log(`Graph: ${result.value.nodes} nodes, ${result.value.edges} edges, ${result.value.communities} communities`);
    console.log(`Output: ${result.value.outputPath}`);

    if (opts.open !== false) {
      openInBrowser(result.value.outputPath);
    }
  });

// ── visualize federation ──────────────────────────────────────────────

visualizeCommand
  .command('federation')
  .alias('fed')
  .description('Open federation topology graph in the browser')
  .option('-l, --layout <type>', 'graph layout: force | hierarchical | radial', 'force')
  .option('-o, --output <path>', 'output HTML file path')
  .option('--no-open', 'write HTML but do not open the browser')
  .action((opts) => {
    ensureGlobalDirs();
    const outputPath = opts.output ?? path.join(os.tmpdir(), 'trace-mcp-federation.html');
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);

    const result = visualizeFederationTopology(topoStore, {
      layout: opts.layout,
      output: outputPath,
    });

    topoStore.close();

    if (result.isErr()) {
      console.error('Error:', result.error.message);
      process.exit(1);
    }

    console.log(`Federation: ${result.value.services} services, ${result.value.edges} edges`);
    console.log(`Output: ${result.value.outputPath}`);

    if (opts.open !== false) {
      openInBrowser(result.value.outputPath);
    }
  });
