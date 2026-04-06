/**
 * Consultation markers — bridge between trace-mcp server and guard hook.
 *
 * When a trace-mcp tool accesses a file (get_outline, get_symbol, etc.),
 * a marker is written to /tmp/trace-mcp-consulted-{projectHash}/{fileHash}.
 * The PreToolUse guard hook checks these markers: if a file has been
 * "consulted" via trace-mcp, Read is allowed immediately without denial.
 *
 * Markers are ephemeral (tmpdir) and scoped per project.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { projectHash } from '../global.js';

function fileHash(filePath: string): string {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

function markerDir(projectRoot: string): string {
  return path.join(os.tmpdir(), `trace-mcp-consulted-${projectHash(path.resolve(projectRoot))}`);
}

/** Write a consultation marker for a file. Non-blocking, best-effort. */
export function markConsulted(projectRoot: string, relPath: string): void {
  try {
    const dir = markerDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileHash(relPath)), '', { flag: 'w' });
  } catch { /* best-effort — never block tool execution */ }
}

/** Extract file paths from tool params that indicate file consultation. */
export function extractConsultedFiles(toolName: string, params: Record<string, unknown>): string[] {
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
      if (sid && sid.includes('::')) {
        files.push(sid.split('::')[0]);
      }
      break;
    }

    case 'get_context_bundle': {
      const sid = params.symbol_id as string | undefined;
      if (sid && sid.includes('::')) files.push(sid.split('::')[0]);
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

/** Return the marker directory path (for documentation / guard hook alignment). */
export function getMarkerDir(projectRoot: string): string {
  return markerDir(projectRoot);
}
