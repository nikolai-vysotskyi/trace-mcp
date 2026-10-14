/**
 * Consultation markers — bridge between trace-mcp server and guard hook.
 *
 * When a trace-mcp tool accesses a file (get_outline, get_symbol, etc.),
 * a marker is written to trace-mcp-consulted-{projectHash}/{fileHash}.
 * The PreToolUse guard hook checks these markers: if a file has been
 * "consulted" via trace-mcp, Read is allowed immediately without denial.
 *
 * Markers are scoped per project and written to two directories: STATUS_DIR
 * under the state home (primary — the only path the hook and the server agree
 * on, see TRA-869) and `$TMPDIR` (for hooks installed before that fix).
 *
 * ponytail: drop the $TMPDIR half once no supported release reads it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectHash, STATUS_DIR } from '../global.js';
import { normalizeToProjectRelative } from '../utils/security.js';
import { ensureTmpDirSync, writeTmpFileSync } from '../utils/safe-fs.js';
import { isDangerousProjectRoot } from '../dangerous-root.js';
import { findProjectRoot, detectGitWorktree } from '../project-root.js';
import { resolveRegisteredAncestor, resolveFileInRegisteredProjects } from '../registry.js';

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex');
}

/**
 * Canonical marker key for a consulted file (TRA-1737).
 *
 * The server used to hash the raw `params.path` string while the guard hook
 * hashes its own normalized spelling — `./x` vs `x`, an absolute path vs a
 * relative one, or a path carrying the project dir-name prefix (agent CWD is
 * the parent, e.g. `thewed-laravel/nova/...` under session root `thewed/`)
 * produced different hashes for the same file, so a successful get_outline
 * never unlocked the follow-up Read. Both sides now canonicalize with this
 * rule (the hook mirrors it in `canonical_marker_key`): fold to
 * project-relative, strip `./` segments, collapse a leading
 * `<basename(projectRoot)>/` segment.
 */
export function canonicalMarkerKey(filePath: string, projectRoot: string): string {
  const normalized = normalizeToProjectRelative(filePath, projectRoot);
  let rel = normalized.split('\\').join('/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  const base = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '';
  if (base && rel.startsWith(`${base}/`)) rel = rel.slice(base.length + 1);
  return rel || normalized;
}

function markerDirs(projectRoot: string): string[] {
  const name = `trace-mcp-consulted-${projectHash(path.resolve(projectRoot))}`;
  return [path.join(STATUS_DIR, name), path.join(os.tmpdir(), name)];
}

// Per-process dedup: markers are existence-only (empty files) and the guard
// hook just checks presence, so re-marking a file already marked this process
// is a pure no-op syscall. On a busy session this fires thousands of times
// (get_symbol/get_outline/...), so skip the mkdir+write when nothing changes.
const _ensuredDirs = new Set<string>();
const _writtenMarkers = new Set<string>();

/** Write a consultation marker for a file. Non-blocking, best-effort. */
function markConsulted(projectRoot: string, relPath: string): void {
  const name = fileHash(relPath);
  for (const dir of markerDirs(projectRoot)) {
    try {
      const markerPath = path.join(dir, name);
      if (_writtenMarkers.has(markerPath)) continue; // already marked this process
      if (!_ensuredDirs.has(dir)) {
        if (!ensureTmpDirSync(dir)) continue; // squatted or unwritable — skip markers
        _ensuredDirs.add(dir);
      }
      writeTmpFileSync(markerPath, '');
      // ponytail: bound the dedup set — clearing only costs one repeat write.
      if (_writtenMarkers.size >= 50_000) _writtenMarkers.clear();
      _writtenMarkers.add(markerPath);
    } catch {
      /* best-effort — never block tool execution */
    }
  }
}

/** Test-only: clear the per-process dedup caches so tests that wipe the marker
 *  directory between cases re-create it. No production caller. */
export function __resetConsultationMarkersForTests(): void {
  _ensuredDirs.clear();
  _writtenMarkers.clear();
}

/** Extract file paths from tool params that indicate file consultation. */
function extractConsultedFiles(toolName: string, params: Record<string, unknown>): string[] {
  const files: string[] = [];

  switch (toolName) {
    case 'get_outline':
    case 'get_complexity_report':
    case 'get_control_flow':
    case 'get_dataflow':
      if (typeof params.path === 'string') files.push(params.path);
      if (typeof params.file_path === 'string') files.push(params.file_path);
      break;

    case 'get_symbol':
    case 'get_call_graph':
    case 'get_change_impact':
    case 'find_usages':
    case 'get_tests_for':
    case 'get_type_hierarchy': {
      if (typeof params.path === 'string') files.push(params.path);
      if (typeof params.file_path === 'string') files.push(params.file_path);
      // symbol_id format: "src/foo.ts::SymbolName#kind"
      const sid = (params.symbol_id ?? params.fqn) as string | undefined;
      if (sid?.includes('::')) {
        files.push(sid.split('::')[0]);
      }
      break;
    }

    case 'get_context_bundle': {
      if (typeof params.path === 'string') files.push(params.path);
      if (typeof params.file_path === 'string') files.push(params.file_path);
      const sid = params.symbol_id as string | undefined;
      if (sid?.includes('::')) files.push(sid.split('::')[0]);
      const sids = params.symbol_ids as string[] | undefined;
      if (Array.isArray(sids)) {
        for (const s of sids) {
          if (s.includes('::')) files.push(s.split('::')[0]);
        }
      }
      break;
    }

    case 'register_edit':
      if (typeof params.file_path === 'string') files.push(params.file_path);
      if (typeof params.path === 'string') files.push(params.path);
      break;
  }

  return files;
}

export interface ConsultationTarget {
  projectRoot: string;
  relKey: string;
}

/**
 * Resolve all project roots where a consultation marker should be recorded for `filePath`.
 *
 * In a standard setup, this is just `sessionProjectRoot`.
 *
 * When the server runs from a root session (`/` or desktop client spawn), or when the
 * file belongs to a registered project, child package, or git worktree whose sentinel
 * will be checked by a client/guard running in a different cwd, we record markers for
 * all candidate roots so follow-up Reads are never blocked due to session root mismatch.
 */
export function resolveConsultationTargets(
  filePath: string,
  sessionProjectRoot?: string,
): ConsultationTarget[] {
  const targets: ConsultationTarget[] = [];
  const visited = new Set<string>();

  const addTarget = (root: string, relOrAbsPath: string) => {
    try {
      const normRoot = path.resolve(root);
      const key = canonicalMarkerKey(relOrAbsPath, normRoot);
      const dedupKey = `${normRoot}::${key}`;
      if (visited.has(dedupKey)) return;
      visited.add(dedupKey);
      targets.push({ projectRoot: normRoot, relKey: key });
    } catch {
      /* ignore invalid path combinations */
    }
  };

  // 1. Session root (if provided)
  if (sessionProjectRoot) {
    addTarget(sessionProjectRoot, filePath);
  }

  // 2. Resolve absolute file path if possible
  let absPath: string | null = null;
  if (path.isAbsolute(filePath)) {
    absPath = path.resolve(filePath);
  } else if (
    sessionProjectRoot &&
    sessionProjectRoot !== '/' &&
    isDangerousProjectRoot(sessionProjectRoot) === null
  ) {
    absPath = path.resolve(sessionProjectRoot, filePath);
  } else {
    // Root or dangerous session: resolve candidate file in registered projects
    try {
      const resolved = resolveFileInRegisteredProjects(filePath, sessionProjectRoot);
      if (resolved) {
        absPath = resolved.absPath;
        addTarget(resolved.projectRoot, resolved.relPath);
      }
    } catch {
      /* best-effort */
    }
  }

  if (!absPath) return targets;

  // 3. Registered ancestor and multi-root children
  try {
    const anc = resolveRegisteredAncestor(absPath);
    if (anc) {
      addTarget(anc.root, absPath);
      if (anc.type === 'multi-root' && anc.children) {
        for (const child of anc.children) {
          const normChild = path.resolve(child);
          if (absPath === normChild || absPath.startsWith(normChild + path.sep)) {
            addTarget(normChild, absPath);
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }

  // 4. Git repository root and worktree main checkout
  try {
    const gitRoot = findProjectRoot(absPath);
    if (gitRoot && isDangerousProjectRoot(gitRoot) === null) {
      addTarget(gitRoot, absPath);
      const wt = detectGitWorktree(gitRoot);
      if (wt?.mainRoot && isDangerousProjectRoot(wt.mainRoot) === null) {
        addTarget(wt.mainRoot, absPath);
      }
    }
  } catch {
    /* best-effort */
  }

  // 5. Intermediate directories with active or recent sentinels or trace configs
  try {
    let cursor = path.dirname(absPath);
    let depth = 0;
    while (cursor && cursor !== path.dirname(cursor) && depth < 10) {
      if (isDangerousProjectRoot(cursor) !== null) break;
      const h = projectHash(cursor);
      const hasSentinel =
        fs.existsSync(path.join(STATUS_DIR, `trace-mcp-alive-${h}`)) ||
        fs.existsSync(path.join(os.tmpdir(), `trace-mcp-alive-${h}`)) ||
        fs.existsSync(path.join(STATUS_DIR, `trace-mcp-status-${h}.json`)) ||
        fs.existsSync(path.join(os.tmpdir(), `trace-mcp-status-${h}.json`)) ||
        fs.existsSync(path.join(cursor, '.trace.json')) ||
        fs.existsSync(path.join(cursor, '.trace-mcp.json'));
      if (hasSentinel) {
        addTarget(cursor, absPath);
      }
      cursor = path.dirname(cursor);
      depth++;
    }
  } catch {
    /* best-effort */
  }

  return targets;
}

/**
 * Mark all files referenced by a tool call as consulted.
 * Called from tool gate after successful tool execution.
 */
export function markToolConsultation(
  projectRoot: string,
  toolName: string,
  params: Record<string, unknown>,
): void {
  const files = extractConsultedFiles(toolName, params);
  for (const f of files) {
    const targets = resolveConsultationTargets(f, projectRoot);
    for (const { projectRoot: root, relKey } of targets) {
      markConsulted(root, relKey);
    }
  }
}
