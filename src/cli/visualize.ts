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
  .description('Generate an interactive dependency graph and open it in the browser')
  .argument('[scope]', `what to visualize

  Scope can be:
    project            whole project graph
    src/server.ts      single file and its dependencies
    src/indexer/        all files under a directory`, 'project')
  .option('-l, --layout <type>', `graph layout algorithm

  Layouts:
    force          physics-based force-directed (best for exploration)
    hierarchical   top-down layered DAG (best for dependency chains)
    radial         concentric circles from the scope center`, 'force')
  .option('-c, --color-by <mode>', `node coloring strategy

  Modes:
    community        color by detected module community
    language         color by programming language
    framework_role   color by framework role (controller, model, etc.)`, 'community')
  .option('-d, --depth <n>', 'max dependency hops from scope', '2')
  .option('-g, --granularity <mode>', `node granularity

  Modes:
    file     each node = one file (default)
    symbol   each node = function/class/method`, 'file')
  .option('-k, --symbol-kinds <kinds>', 'comma-separated symbol kinds when granularity=symbol (e.g. function,class,method)')
  .option('--hide-isolated', 'hide nodes with no edges')
  .option('--max-files <n>', 'max seed files for file-level graph (default: 10000)')
  .option('--max-nodes <n>', 'max viz nodes for symbol-level graph (default: 100000)')
  .option('-o, --output <path>', 'write HTML to this path instead of a temp file')
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

    // Open topology store for federation support (best-effort)
    let topoStore: InstanceType<typeof TopologyStore> | undefined;
    try {
      if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    } catch { /* federation is optional */ }

    const result = visualizeGraph(store, {
      scope,
      layout: opts.layout,
      colorBy: opts.colorBy,
      depth: parseInt(opts.depth, 10),
      output: outputPath,
      granularity: opts.granularity,
      symbolKinds: opts.symbolKinds ? opts.symbolKinds.split(',') : undefined,
      hideIsolated: opts.hideIsolated ?? false,
      maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined,
      maxNodes: opts.maxNodes ? parseInt(opts.maxNodes, 10) : undefined,
      topoStore,
      projectRoot,
    });

    topoStore?.close();
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
