/**
 * `trace-mcp remove [dir]` command.
 * Unregisters a project: removes from registry, deletes DB, removes config.
 * For multi-root projects, can also exclude a single child.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { findProjectRoot } from '../project-root.js';
import { getProject, unregisterProject, findParentProject } from '../registry.js';
import { removeProjectConfig } from '../config.js';
import { TOPOLOGY_DB_PATH } from '../global.js';
import { TopologyStore } from '../topology/topology-db.js';

export const removeCommand = new Command('remove')
  .description('Unregister a project and delete its index')
  .argument('[dir]', 'Project directory (default: current directory)', '.')
  .option('--force', 'Remove without confirmation')
  .option('--keep-db', 'Keep the database file (only unregister)')
  .option('--json', 'Output results as JSON')
  .action(async (dir: string, opts: { force?: boolean; keepDb?: boolean; json?: boolean }) => {
    const resolvedDir = path.resolve(dir);
    const isInteractive = !opts.json;

    // Try to find project root
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(resolvedDir);
    } catch {
      projectRoot = resolvedDir;
    }

    // Check if this dir is a child of a multi-root project
    const parentEntry = findParentProject(projectRoot);
    if (parentEntry) {
      await handleRemoveFromMultiRoot(projectRoot, parentEntry, opts);
      return;
    }

    // Check if registered
    const entry = getProject(projectRoot);
    if (!entry) {
      if (opts.json) {
        console.log(JSON.stringify({ status: 'not_registered', dir: projectRoot }));
      } else {
        if (isInteractive) p.intro('trace-mcp remove');
        p.log.warn(`Project not registered: ${projectRoot}`);
        p.log.info('Use `trace-mcp list` to see registered projects.');
      }
      return;
    }

    if (isInteractive) {
      p.intro('trace-mcp remove');

      const lines: string[] = [];
      lines.push(`Project: ${entry.name}`);
      lines.push(`Root: ${entry.root}`);
      lines.push(`DB: ${shortPath(entry.dbPath)}`);
      if (entry.type === 'multi-root' && entry.children) {
        lines.push(`Children: ${entry.children.map((c) => path.basename(c)).join(', ')}`);
      }
      p.note(lines.join('\n'), 'Project to remove');
    }

    // Confirm
    if (!opts.force && isInteractive) {
      const confirm = await p.confirm({
        message:
          entry.type === 'multi-root'
            ? `Remove multi-root project "${entry.name}" and its unified index?`
            : `Remove project "${entry.name}" and delete its index?`,
        initialValue: false,
      });
      if (p.isCancel(confirm) || !confirm) {
        p.cancel('Cancelled.');
        return;
      }
    }

    // Delete DB file
    let dbDeleted = false;
    if (!opts.keepDb && fs.existsSync(entry.dbPath)) {
      fs.unlinkSync(entry.dbPath);
      dbDeleted = true;
    }

    // Clean topology data (subprojects, services, endpoints, etc.)
    const topoCleaned = cleanTopology(entry.root);

    // Remove config
    removeProjectConfig(entry.root);

    // Unregister
    unregisterProject(entry.root);

    // Report
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            status: 'removed',
            project: entry.name,
            root: entry.root,
            dbDeleted,
            topologyCleaned: topoCleaned.subprojects > 0 || topoCleaned.services > 0,
          },
          null,
          2,
        ),
      );
    } else {
      const lines: string[] = [];
      lines.push(`Project: ${entry.name}`);
      if (dbDeleted) {
        lines.push(`Database deleted: ${shortPath(entry.dbPath)}`);
      } else if (opts.keepDb) {
        lines.push(`Database kept: ${shortPath(entry.dbPath)}`);
      }
      if (topoCleaned.subprojects > 0 || topoCleaned.services > 0) {
        lines.push(
          `Topology cleaned: ${topoCleaned.services} service(s), ${topoCleaned.subprojects} subproject(s)`,
        );
      }
      lines.push('Config removed');
      p.note(lines.join('\n'), 'Removed');
      p.outro('Project unregistered.');
    }
  });

interface ParentEntry {
  name: string;
  root: string;
  dbPath: string;
  type?: string;
  children?: string[];
}

async function handleRemoveFromMultiRoot(
  childRoot: string,
  parent: ParentEntry,
  opts: { force?: boolean; keepDb?: boolean; json?: boolean },
): Promise<void> {
  const isInteractive = !opts.json;

  if (isInteractive) {
    p.intro('trace-mcp remove (from multi-root)');
    p.note(
      `This project is part of multi-root index: ${parent.name}\n` +
        `Parent root: ${parent.root}\n` +
        `Child to exclude: ${path.basename(childRoot)}`,
      'Multi-root',
    );
  }

  if (!opts.force && isInteractive) {
    const confirm = await p.confirm({
      message: `Exclude "${path.basename(childRoot)}" from multi-root "${parent.name}"? (The parent index will be re-registered without this child.)`,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Cancelled.');
      return;
    }
  }

  // Get current children, remove this one
  const currentChildren = parent.children ?? [];
  const newChildren = currentChildren.filter((c) => path.resolve(c) !== path.resolve(childRoot));

  if (newChildren.length === 0) {
    // No children left — remove the entire multi-root
    if (!opts.keepDb && fs.existsSync(parent.dbPath)) {
      fs.unlinkSync(parent.dbPath);
    }
    cleanTopology(parent.root);
    removeProjectConfig(parent.root);
    unregisterProject(parent.root);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            status: 'removed_multi_root',
            reason: 'no children remaining',
            parent: parent.name,
          },
          null,
          2,
        ),
      );
    } else {
      p.note('No children remaining — entire multi-root project removed.', 'Removed');
      p.outro('Multi-root project unregistered.');
    }
    return;
  }

  if (newChildren.length === 1) {
    // Only one child left — convert to single project
    const remainingChild = newChildren[0];

    // Remove multi-root
    if (!opts.keepDb && fs.existsSync(parent.dbPath)) {
      fs.unlinkSync(parent.dbPath);
    }
    cleanTopology(parent.root);
    removeProjectConfig(parent.root);
    unregisterProject(parent.root);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            status: 'excluded_from_multi_root',
            excluded: path.basename(childRoot),
            remaining: path.basename(remainingChild),
            hint: `Run \`trace-mcp add ${remainingChild}\` to re-register the remaining project individually.`,
          },
          null,
          2,
        ),
      );
    } else {
      p.note(
        `Excluded: ${path.basename(childRoot)}\n` +
          `Only one child remaining: ${path.basename(remainingChild)}\n` +
          `Multi-root removed. Run \`trace-mcp add ${remainingChild}\` to re-register individually.`,
        'Converted',
      );
      p.outro('Child excluded from multi-root.');
    }
    return;
  }

  // Multiple children remain — need to re-register the multi-root without this child.
  // We remove the old registration and tell the user to re-add.
  // (Re-registering inline would duplicate too much logic from add.ts)
  if (!opts.keepDb && fs.existsSync(parent.dbPath)) {
    fs.unlinkSync(parent.dbPath);
  }
  cleanTopology(parent.root);
  removeProjectConfig(parent.root);
  unregisterProject(parent.root);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          status: 'excluded_from_multi_root',
          excluded: path.basename(childRoot),
          remaining: newChildren.map((c) => path.basename(c)),
          hint: `Run \`trace-mcp add ${parent.root}\` to re-register with ${newChildren.length} children.`,
        },
        null,
        2,
      ),
    );
  } else {
    p.note(
      `Excluded: ${path.basename(childRoot)}\n` +
        `Remaining children: ${newChildren.map((c) => path.basename(c)).join(', ')}\n` +
        `Run \`trace-mcp add ${parent.root}\` to re-register the multi-root.`,
      'Excluded',
    );
    p.outro('Child excluded. Re-add the parent to rebuild the index.');
  }
}

function cleanTopology(repoRoot: string): { subprojects: number; services: number } {
  try {
    if (!fs.existsSync(TOPOLOGY_DB_PATH)) return { subprojects: 0, services: 0 };
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const result = topoStore.removeByRepoRoot(repoRoot);
    topoStore.close();
    return result;
  } catch {
    return { subprojects: 0, services: 0 };
  }
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
