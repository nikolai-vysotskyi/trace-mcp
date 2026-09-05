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
import os from 'node:os';
import path from 'node:path';
import { projectHash, STATUS_DIR } from '../global.js';
import { ensureTmpDirSync, writeTmpFileSync } from '../utils/safe-fs.js';

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex');
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
      // symbol_id format: "src/foo.ts::SymbolName#kind"
      const sid = (params.symbol_id ?? params.fqn) as string | undefined;
      if (sid?.includes('::')) {
        files.push(sid.split('::')[0]);
      }
      break;
    }

    case 'get_context_bundle': {
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
      break;
  }

  return files;
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
    markConsulted(projectRoot, f);
  }
}
