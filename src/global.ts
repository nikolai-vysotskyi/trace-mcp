/**
 * Global paths and helpers for ~/.trace-mcp/ directory structure.
 *
 * All trace-mcp state lives here:
 *   ~/.trace-mcp/.config.json          — global config
 *   ~/.trace-mcp/registry.json         — project registry
 *   ~/.trace-mcp/index/<name>-<hash>.db — per-project databases
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Root of all trace-mcp global state. */
export const TRACE_MCP_HOME = path.join(os.homedir(), '.trace-mcp');

/** Global config file (replaces per-project .trace-mcp.json). */
export const GLOBAL_CONFIG_PATH = path.join(TRACE_MCP_HOME, '.config.json');

/** Directory for per-project SQLite databases. */
export const INDEX_DIR = path.join(TRACE_MCP_HOME, 'index');

/** Global project registry. */
export const REGISTRY_PATH = path.join(TRACE_MCP_HOME, 'registry.json');

/** Topology database (cross-service graph). */
export const TOPOLOGY_DB_PATH = path.join(TRACE_MCP_HOME, 'topology.db');

/** Ensure ~/.trace-mcp/ and ~/.trace-mcp/index/ exist. */
export function ensureGlobalDirs(): void {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
}

/** Stable 12-char hex hash of an absolute path. */
export function projectHash(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

/** Sanitized project name from path basename. */
export function projectName(absolutePath: string): string {
  return path.basename(absolutePath).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Compute global DB path for a project root. */
export function getDbPath(projectRoot: string): string {
  const absRoot = path.resolve(projectRoot);
  return path.join(INDEX_DIR, `${projectName(absRoot)}-${projectHash(absRoot)}.db`);
}
