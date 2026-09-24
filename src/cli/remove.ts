/**
 * `trace-mcp remove [dir]` command.
 * Unregisters a project: removes from registry, deletes DB, removes config.
 * For multi-root projects, can also exclude a single child.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { Command } from 'commander';
import { removeProjectConfig } from '../config.js';
import { hasLiveHolderOrUnknown, releaseDbHolder } from '../db-holders.js';
import { TOPOLOGY_DB_PATH } from '../global.js';
import { findProjectRoot } from '../project-root.js';
import { findParentProject, getProject, listProjects, unregisterProject } from '../registry.js';
import { TopologyStore } from '../topology/topology-db.js';
import { deleteDbFamily } from '../utils/db-family.js';

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

    // Delete DB file + its whole family (WAL/SHM/journal, snapshot, holders).
    // TRA-1887 (GH#1371 edge 2): dbPath is not private to this row — a
    // same-remote clone can share the canonical checkout's dbPath (TRA-38
    // sibling sharing in registerProject). Unlinking it here would delete the
    // canonical index out from under a live project. Mirror
    // removeProjectArtifacts: keep the DB while another registry entry points
    // at it or a live holder claims it; per-root topology/config rows are
    // still cleaned up below regardless.
    const db = guardedDeleteDb(entry.dbPath, entry.root, opts.keepDb);
    const dbDeleted = db.dbDeleted;
    const dbKept = db.dbKept;
    const dbSharedReason = db.reason;

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
            dbKept,
            dbShared: dbSharedReason !== null,
            ...(dbSharedReason ? { dbSharedReason } : {}),
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
      } else if (dbSharedReason) {
        lines.push(`Database kept (shared with another project): ${shortPath(entry.dbPath)}`);
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
    const db = guardedDeleteDb(parent.dbPath, parent.root, opts.keepDb);
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
            dbDeleted: db.dbDeleted,
            dbKept: db.dbKept,
            dbShared: db.reason !== null,
            ...(db.reason ? { dbSharedReason: db.reason } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      p.note(
        'No children remaining — entire multi-root project removed.' +
          (db.reason ? '\nDatabase kept (shared with another project).' : ''),
        'Removed',
      );
      p.outro('Multi-root project unregistered.');
    }
    return;
  }

  if (newChildren.length === 1) {
    // Only one child left — convert to single project
    const remainingChild = newChildren[0];

    // Remove multi-root
    const db = guardedDeleteDb(parent.dbPath, parent.root, opts.keepDb);
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
            dbDeleted: db.dbDeleted,
            dbKept: db.dbKept,
            dbShared: db.reason !== null,
            ...(db.reason ? { dbSharedReason: db.reason } : {}),
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
          `Multi-root removed. Run \`trace-mcp add ${remainingChild}\` to re-register individually.` +
          (db.reason ? '\nDatabase kept (shared with another project).' : ''),
        'Converted',
      );
      p.outro('Child excluded from multi-root.');
    }
    return;
  }

  // Multiple children remain — need to re-register the multi-root without this child.
  // We remove the old registration and tell the user to re-add.
  // (Re-registering inline would duplicate too much logic from add.ts)
  const db = guardedDeleteDb(parent.dbPath, parent.root, opts.keepDb);
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
          dbDeleted: db.dbDeleted,
          dbKept: db.dbKept,
          dbShared: db.reason !== null,
          ...(db.reason ? { dbSharedReason: db.reason } : {}),
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
        `Run \`trace-mcp add ${parent.root}\` to re-register the multi-root.` +
        (db.reason ? '\nDatabase kept (shared with another project).' : ''),
      'Excluded',
    );
    p.outro('Child excluded. Re-add the parent to rebuild the index.');
  }
}

/**
 * TRA-1887 (GH#1371 edge 2): dbPath is not private to its registry row.
 * Returns the reason the DB must be kept, or null when it is safe to delete.
 * Mirrors the guards in removeProjectArtifacts (sibling entry + live holder).
 */
function dbKeepReason(dbPath: string, selfRoot: string): 'sibling' | 'holder' | null {
  const absSelf = path.resolve(selfRoot);
  let siblingShares = false;
  try {
    siblingShares = listProjects().some(
      (e) => path.resolve(e.root) !== absSelf && e.dbPath === dbPath,
    );
  } catch {
    // Fail toward keeping: an unreadable registry must not cost someone else's index.
    return 'sibling';
  }
  if (siblingShares) return 'sibling';
  if (hasLiveHolderOrUnknown(dbPath, selfRoot)) return 'holder';
  return null;
}

/**
 * Guarded whole-family delete for the remove command. Returns the honest
 * kept/deleted outcome so callers can report it without re-deriving.
 */
function guardedDeleteDb(
  dbPath: string,
  selfRoot: string,
  keepDb?: boolean,
): { dbDeleted: boolean; dbKept: boolean; reason: 'sibling' | 'holder' | null } {
  if (keepDb) {
    return { dbDeleted: false, dbKept: fs.existsSync(dbPath), reason: null };
  }
  if (!fs.existsSync(dbPath)) {
    return { dbDeleted: false, dbKept: false, reason: null };
  }
  const reason = dbKeepReason(dbPath, selfRoot);
  if (reason) {
    try {
      releaseDbHolder(dbPath, selfRoot);
    } catch {
      /* best effort — a leftover marker is reaped by the next scan */
    }
    return { dbDeleted: false, dbKept: true, reason };
  }
  const { deleted } = deleteDbFamily(dbPath);
  return { dbDeleted: deleted.includes(dbPath), dbKept: false, reason: null };
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
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
