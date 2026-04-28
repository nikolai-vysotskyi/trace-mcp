/**
 * Discover Claude Code sessions on this machine.
 *
 * Claude Code stores per-project state under `~/.claude/projects/<encoded-path>/`
 * where the encoded path is the absolute project path with `/` replaced by `-`.
 * This module enumerates those directories, decodes them back to filesystem
 * paths, and reports which ones are still valid (the directory exists and
 * looks like a code project).
 *
 * Optionally registers discovered repos as subprojects in one shot — useful
 * for multi-repo workflows where you want trace-mcp to index every repo
 * Claude has touched recently.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { err, ok } from 'neverthrow';
import { type TraceMcpResult, validationError } from '../../errors.js';
import { logger } from '../../logger.js';
import { SubprojectManager } from '../../subproject/manager.js';
import type { TopologyStore } from '../../topology/topology-db.js';

export interface DiscoveredSession {
  /** Decoded absolute path of the project */
  projectPath: string;
  /** Whether the decoded path still exists on disk as a directory */
  exists: boolean;
  /** Number of session files (transcripts) recorded for the project */
  sessionFiles: number;
  /** Whether the project has a memory directory */
  hasMemory: boolean;
  /** Last modified time of the Claude project state directory (ms epoch) */
  lastActiveMs: number | null;
}

export interface DiscoverClaudeSessionsResult {
  scannedRoot: string;
  totalDirs: number;
  sessions: DiscoveredSession[];
  /** Populated only when add_as_subprojects=true */
  subprojectsAdded?: Array<{
    repo: string;
    name: string;
    services: number;
    endpoints: number;
  }>;
  subprojectsSkipped?: Array<{ repo: string; reason: string }>;
}

/**
 * Decode a Claude project directory name back to an absolute filesystem path.
 *
 * Claude encodes `/Users/nikolai/Foo` as `-Users-nikolai-Foo`. The leading
 * dash represents the root `/`. Dashes inside the original path also become
 * `-`, so the encoding is lossy: `/repos/my-repo` and `/repos/my/repo` map
 * to the same encoded string.
 *
 * We resolve the ambiguity by walking the filesystem segment-by-segment from
 * the root, at each step preferring the *longest* prefix of the remaining
 * tokens that names an existing directory entry. This recovers paths with
 * literal dashes when they exist on disk.
 *
 * If the filesystem walk reaches a dead end before consuming all tokens, we
 * fall back to the greedy `-`→`/` decoding so callers can still see the
 * candidate path (with `exists=false`).
 */
export function decodeClaudeProjectName(name: string): string | null {
  if (!name.startsWith('-')) return null;
  const tokens = name
    .slice(1)
    .split('-')
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '/';

  let current = '/';
  let i = 0;
  while (i < tokens.length) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      // Cannot read further — fall back to greedy decode of the remainder
      return current === '/'
        ? `/${tokens.slice(i).join('/')}`
        : path.join(current, tokens.slice(i).join('/'));
    }
    const entrySet = new Set(entries);

    // Try the longest match first: tokens[i..j] joined with '-'
    let matched = -1;
    for (let j = tokens.length; j > i; j--) {
      const candidate = tokens.slice(i, j).join('-');
      if (entrySet.has(candidate)) {
        matched = j;
        current = current === '/' ? `/${candidate}` : path.join(current, candidate);
        break;
      }
    }
    if (matched === -1) {
      // No match — give up walking; return greedy decode of the remainder
      return current === '/'
        ? `/${tokens.slice(i).join('/')}`
        : path.join(current, tokens.slice(i).join('/'));
    }
    i = matched;
  }
  return current;
}

function countSessionFiles(dir: string): number {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.filter(
      (e) => e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json')),
    ).length;
  } catch {
    return 0;
  }
}

function dirMtime(dir: string): number | null {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

export function discoverClaudeSessions(
  opts: {
    /** Override the scan root (defaults to ~/.claude/projects) */
    scanRoot?: string;
    /** If set, exclude paths under this prefix (typically the current project) */
    excludePrefix?: string;
    /** Drop entries whose decoded path no longer exists on disk */
    onlyExisting?: boolean;
    /** Maximum number of sessions to return (0 = unlimited) */
    limit?: number;
  } = {},
): TraceMcpResult<DiscoverClaudeSessionsResult> {
  const scanRoot = opts.scanRoot ?? path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(scanRoot)) {
    return err(validationError(`Claude projects root not found: ${scanRoot}`));
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch (e) {
    return err(validationError(`Failed to read ${scanRoot}: ${(e as Error).message}`));
  }

  const sessions: DiscoveredSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const decoded = decodeClaudeProjectName(entry.name);
    if (!decoded) continue;

    if (opts.excludePrefix && decoded === opts.excludePrefix) continue;

    let exists = false;
    try {
      exists = fs.statSync(decoded).isDirectory();
    } catch {
      exists = false;
    }
    if (opts.onlyExisting && !exists) continue;

    const projectStateDir = path.join(scanRoot, entry.name);
    sessions.push({
      projectPath: decoded,
      exists,
      sessionFiles: countSessionFiles(projectStateDir),
      hasMemory: fs.existsSync(path.join(projectStateDir, 'memory')),
      lastActiveMs: dirMtime(projectStateDir),
    });
  }

  // Most recently active first
  sessions.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0));

  const limited = opts.limit && opts.limit > 0 ? sessions.slice(0, opts.limit) : sessions;

  return ok({
    scannedRoot: scanRoot,
    totalDirs: entries.filter((e) => e.isDirectory()).length,
    sessions: limited,
  });
}

/**
 * Discover sessions and register each existing one as a subproject in one call.
 */
export function discoverAndRegisterSubprojects(
  topoStore: TopologyStore,
  opts: {
    scanRoot?: string;
    excludePrefix?: string;
    limit?: number;
  } = {},
): TraceMcpResult<DiscoverClaudeSessionsResult> {
  const discovered = discoverClaudeSessions({ ...opts, onlyExisting: true });
  if (discovered.isErr()) return discovered;

  const result = discovered.value;
  const added: NonNullable<DiscoverClaudeSessionsResult['subprojectsAdded']> = [];
  const skipped: NonNullable<DiscoverClaudeSessionsResult['subprojectsSkipped']> = [];

  const manager = new SubprojectManager(topoStore);
  for (const session of result.sessions) {
    try {
      const { services } = manager.autoDiscoverSubprojects(session.projectPath);
      const totalEndpoints = services.reduce((sum, s) => sum + s.endpoints, 0);
      added.push({
        repo: session.projectPath,
        name: path.basename(session.projectPath),
        services: services.length,
        endpoints: totalEndpoints,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      skipped.push({ repo: session.projectPath, reason: message });
      logger.warn({ err: e, repo: session.projectPath }, 'discoverAndRegisterSubprojects: skip');
    }
  }

  return ok({
    ...result,
    subprojectsAdded: added,
    subprojectsSkipped: skipped,
  });
}
