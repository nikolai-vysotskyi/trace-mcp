/**
 * Apply / rollback for `get_startup_context_audit`'s `recommendations[]`
 * (TRA-769 — the second half of TRA-759: measure, suggest, apply, watch).
 *
 * Every kind this applies is configuration the user could change themselves:
 * an `mcpServers` entry in a client config file, a skill directory under
 * `~/.claude/skills`, a duplicated line inside their own project instruction
 * file. Nothing here patches a client binary, intercepts traffic, or rewords
 * text — the same boundary `startup-text.ts` draws for `textCompression`.
 *
 * Two rules make this safe to run unattended:
 *  - `dryRun` defaults to true at the tool layer; nothing is written unless
 *    the caller explicitly asks. Every handler still computes and returns
 *    what it WOULD do, so a dry run is a real preview, not a guess.
 *  - Every write is preceded by capturing enough to undo it byte-for-byte —
 *    the original file content, or the original path a moved directory came
 *    from — into one manifest per `applyStartupRecommendations` call, and that
 *    manifest is flushed to disk before the write it covers, not after the
 *    batch. `rollbackStartupRecommendations` replays it in reverse.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeHome, STARTUP_BACKUPS_DIR } from '../shared/paths.js';
import { findSharedLines } from './startup-context.js';

const CHARS_PER_TOKEN = 4;

/**
 * `target` and `backup_id` arrive from a tool call, so they are input, not
 * trusted names: a single `..` segment turns `path.join(dir, name)` into a
 * write anywhere on the machine. Everything this module joins onto a directory
 * must be one plain path segment, and this is the only place that decides it.
 */
function isPathSegment(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..' &&
    !path.isAbsolute(name)
  );
}

/** Instruction files the audit can name — mirrors the pairing in startup-context.ts. */
const INSTRUCTION_BASENAMES = ['CLAUDE.md', 'AGENTS.md'];
/** Context lines around a hunk in the emitted diff — matches startup-text.ts. */
const DIFF_CONTEXT = 2;

export type RecommendationKind = 'unusedMcpServer' | 'unusedSkill' | 'duplicateInstructions';

export interface ApplyRequest {
  kind: RecommendationKind;
  /** The `target` field from the matching `Recommendation` in the audit payload. */
  target: string;
}

export type ApplyStatus = 'applied' | 'wouldApply' | 'skipped';

export interface ApplyOutcome {
  kind: RecommendationKind;
  target: string;
  status: ApplyStatus;
  /** Why nothing changed, when status is 'skipped'. */
  reason?: string;
  filesTouched?: string[];
  /** Deletion-only unified diff — only set for duplicateInstructions. */
  diff?: string;
  tokensRemoved?: number;
}

type ManifestEntry =
  | { type: 'file'; path: string; existed: boolean; content: string | null }
  | { type: 'move'; from: string; to: string };

interface BackupManifest {
  id: string;
  createdAt: string;
  entries: ManifestEntry[];
}

/**
 * Records one undo entry AND flushes the manifest to disk before the write it
 * describes happens. An in-memory array flushed at the end of the call would
 * leave a killed run with changed files and no manifest to roll them back.
 */
type Recorder = (entry: ManifestEntry) => void;

export interface ApplyOptions {
  projectRoot?: string;
  /** No writes happen when true (default at the tool layer). Every outcome is still computed. */
  dryRun: boolean;
}

export interface ApplyResult {
  dryRun: boolean;
  /** Set only when at least one request actually wrote something (dryRun: false). */
  backupId: string | null;
  outcomes: ApplyOutcome[];
}

export interface RollbackResult {
  backupId: string;
  restored: string[];
  errors: string[];
}

// --- unusedMcpServer ---

function mcpConfigCandidates(projectRoot?: string): string[] {
  return [
    path.join(claudeHome(), 'settings.json'),
    // Legacy single-file form (src/shared/paths.ts's CLAUDE_USER_MCP_PATH is a
    // module-load-time const, which would not follow a HOME override taken by
    // a test or a long-lived process — computed fresh here instead).
    path.join(os.homedir(), '.claude.json'),
    ...(projectRoot ? [path.join(projectRoot, '.mcp.json')] : []),
  ];
}

function applyUnusedMcpServer(target: string, opts: ApplyOptions, record: Recorder): ApplyOutcome {
  const touched: string[] = [];
  for (const file of mcpConfigCandidates(opts.projectRoot)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // Not our job to fix a config file that doesn't even parse.
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    // Object.hasOwn, not `in`: "constructor" and "toString" are `in` every
    // object, and would make this rewrite a config that has no such server.
    if (typeof servers !== 'object' || servers === null || !Object.hasOwn(servers, target)) {
      continue;
    }

    touched.push(file);
    if (opts.dryRun) continue;
    record({ type: 'file', path: file, existed: true, content: raw });
    delete (servers as Record<string, unknown>)[target];
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }

  if (touched.length === 0) {
    return {
      kind: 'unusedMcpServer',
      target,
      status: 'skipped',
      reason: `No "${target}" entry under mcpServers in ${mcpConfigCandidates(opts.projectRoot).join(', ')} — already removed, or configured somewhere this tool does not scan.`,
    };
  }
  return {
    kind: 'unusedMcpServer',
    target,
    status: opts.dryRun ? 'wouldApply' : 'applied',
    filesTouched: touched,
  };
}

// --- unusedSkill ---

function skillCandidates(target: string, projectRoot?: string): string[] {
  return [
    path.join(claudeHome(), 'skills', target),
    ...(projectRoot ? [path.join(projectRoot, '.claude', 'skills', target)] : []),
  ];
}

/**
 * Holding directory a disabled skill moves into: a real sibling of `skills/`,
 * so the move stays on one filesystem AND the holding directory itself is not
 * inside `skills/`, where every skill scanner — Claude Code's and our own
 * `scanInstalledSkills` — would list it as an installed skill named
 * `.trace-mcp-disabled`.
 */
function disabledSkillPath(skillPath: string): string {
  const skillsDir = path.dirname(skillPath);
  return path.join(path.dirname(skillsDir), '.trace-mcp-disabled-skills', path.basename(skillPath));
}

function applyUnusedSkill(target: string, opts: ApplyOptions, record: Recorder): ApplyOutcome {
  if (target.includes(':')) {
    return {
      kind: 'unusedSkill',
      target,
      status: 'skipped',
      reason:
        'Plugin-provided skill — disabling it would disable the whole plugin, which one unused skill is not evidence for. Turn the plugin off yourself if that is what you want.',
    };
  }
  if (!isPathSegment(target)) {
    return {
      kind: 'unusedSkill',
      target,
      status: 'skipped',
      reason: `"${target}" is not a skill name — a skill is one directory name under skills/, never a path. Nothing was moved.`,
    };
  }

  let src: string | null = null;
  for (const candidate of skillCandidates(target, opts.projectRoot)) {
    try {
      fs.lstatSync(candidate); // lstat, not stat — a symlinked skill must not resolve through its target.
      src = candidate;
      break;
    } catch {
      /* not here */
    }
  }
  if (!src) {
    return {
      kind: 'unusedSkill',
      target,
      status: 'skipped',
      reason: `No "${target}" directory under ~/.claude/skills or the project's .claude/skills — already removed, or not a filesystem-backed skill.`,
    };
  }

  const dest = disabledSkillPath(src);
  if (opts.dryRun) {
    return { kind: 'unusedSkill', target, status: 'wouldApply', filesTouched: [src] };
  }
  if (fs.existsSync(dest)) {
    return {
      kind: 'unusedSkill',
      target,
      status: 'skipped',
      reason: `${dest} already exists — a previous disable of this skill was never rolled back. Resolve that first.`,
    };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Recorded before the rename: rollback already no-ops on a move that never
  // landed, so an entry ahead of its write is safe and a missing one is not.
  record({ type: 'move', from: src, to: dest });
  fs.renameSync(src, dest);
  return { kind: 'unusedSkill', target, status: 'applied', filesTouched: [src] };
}

// --- duplicateInstructions ---

/** Deletion-only unified diff — same shape as startup-text.ts's, kept local to avoid reaching into its private helper. */
function unifiedDiff(filePath: string, lines: string[], removed: Set<number>): string {
  const indices = [...removed].sort((a, b) => a - b);
  const hunks: Array<[number, number]> = [];
  for (const i of indices) {
    const last = hunks[hunks.length - 1];
    if (last && i - last[1] <= DIFF_CONTEXT * 2 + 1) last[1] = i;
    else hunks.push([i, i]);
  }
  const out = [`--- ${filePath}`, `+++ ${filePath} (proposed)`];
  for (const [from, to] of hunks) {
    const start = Math.max(0, from - DIFF_CONTEXT);
    const end = Math.min(lines.length - 1, to + DIFF_CONTEXT);
    const kept = lines.slice(start, end + 1).filter((_, k) => !removed.has(start + k)).length;
    out.push(`@@ -${start + 1},${end - start + 1} +${start + 1},${kept} @@`);
    for (let i = start; i <= end; i++) out.push(`${removed.has(i) ? '-' : ' '}${lines[i]}`);
  }
  return out.join('\n');
}

function applyDuplicateInstructions(
  target: string,
  record: Recorder,
  dryRun: boolean,
): ApplyOutcome {
  // The audit only ever names a PROJECT instruction file, paired against its
  // global namesake. Given the global file itself, findSharedLines would
  // compare it with itself, call every substantial line a duplicate, and empty
  // the user's global instructions — so the applier enforces that contract
  // rather than trusting the caller to have come from the audit.
  const resolvedTarget = path.resolve(target);
  const homePrefix = path.resolve(claudeHome()) + path.sep;
  if (
    !INSTRUCTION_BASENAMES.includes(path.basename(resolvedTarget)) ||
    resolvedTarget.startsWith(homePrefix)
  ) {
    return {
      kind: 'duplicateInstructions',
      target,
      status: 'skipped',
      reason: `Target must be a project ${INSTRUCTION_BASENAMES.join(' or ')} outside ${claudeHome()} — the global file is the copy this keeps, never the one it edits.`,
    };
  }

  const globalFile = path.join(claudeHome(), path.basename(resolvedTarget));
  if (!fs.existsSync(target) || !fs.existsSync(globalFile)) {
    return {
      kind: 'duplicateInstructions',
      target,
      status: 'skipped',
      reason: `${target} or its global counterpart ${globalFile} no longer exists — re-run the audit.`,
    };
  }

  const shared = findSharedLines(globalFile, target);
  if (shared.length === 0) {
    return {
      kind: 'duplicateInstructions',
      target,
      status: 'skipped',
      reason: 'No duplicate lines found on re-check — the files changed since the audit ran.',
    };
  }

  const raw = fs.readFileSync(target, 'utf8');
  const lines = raw.split('\n');
  const removed = new Set(shared.map((s) => s.index));
  const tokensRemoved = Math.round(
    shared.reduce((n, s) => n + s.text.length + 1, 0) / CHARS_PER_TOKEN,
  );
  const diff = unifiedDiff(target, lines, removed);

  if (dryRun) {
    return {
      kind: 'duplicateInstructions',
      target,
      status: 'wouldApply',
      filesTouched: [target],
      diff,
      tokensRemoved,
    };
  }

  record({ type: 'file', path: target, existed: true, content: raw });
  const newContent = lines.filter((_, i) => !removed.has(i)).join('\n');
  fs.writeFileSync(target, newContent, 'utf8');
  return {
    kind: 'duplicateInstructions',
    target,
    status: 'applied',
    filesTouched: [target],
    diff,
    tokensRemoved,
  };
}

// --- Entry points ---

function backupId(): string {
  // Not a security token, but Semgrep blocks Math.random() repo-wide and a
  // collision here would let one bundle overwrite another's manifest.
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

export function applyStartupRecommendations(
  requests: ApplyRequest[],
  opts: ApplyOptions,
): ApplyResult {
  const manifest: BackupManifest = {
    id: backupId(),
    createdAt: new Date().toISOString(),
    entries: [],
  };
  const dir = path.join(STARTUP_BACKUPS_DIR, manifest.id);
  const record: Recorder = (entry) => {
    manifest.entries.push(entry);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  };

  const outcomes = requests.map((req) => {
    switch (req.kind) {
      case 'unusedMcpServer':
        return applyUnusedMcpServer(req.target, opts, record);
      case 'unusedSkill':
        return applyUnusedSkill(req.target, opts, record);
      case 'duplicateInstructions':
        return applyDuplicateInstructions(req.target, record, opts.dryRun);
    }
  });

  // A dry run never calls `record`, so no directory was created for it either.
  if (opts.dryRun || manifest.entries.length === 0) {
    return { dryRun: opts.dryRun, backupId: null, outcomes };
  }
  return { dryRun: false, backupId: manifest.id, outcomes };
}

function loadManifest(id: string): BackupManifest {
  const raw = fs.readFileSync(path.join(STARTUP_BACKUPS_DIR, id, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as BackupManifest;
}

function latestBackupId(): string | null {
  if (!fs.existsSync(STARTUP_BACKUPS_DIR)) return null;
  const ids = fs
    .readdirSync(STARTUP_BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return ids.length ? ids[ids.length - 1] : null;
}

/** Undoes one `applyStartupRecommendations` call, byte-for-byte, in one action. Defaults to the most recent backup. */
export function rollbackStartupRecommendations(id?: string): RollbackResult {
  const targetId = id ?? latestBackupId();
  if (!targetId) {
    return { backupId: '', restored: [], errors: ['No backups found — nothing to roll back.'] };
  }
  if (!isPathSegment(targetId)) {
    // A manifest read from outside STARTUP_BACKUPS_DIR is a list of files this
    // would overwrite or delete on someone else's say-so.
    return {
      backupId: targetId,
      restored: [],
      errors: [
        `"${targetId}" is not a backup id — a backup id is one directory name, never a path.`,
      ],
    };
  }

  let manifest: BackupManifest;
  try {
    manifest = loadManifest(targetId);
  } catch (e) {
    return {
      backupId: targetId,
      restored: [],
      errors: [
        `Could not read backup "${targetId}": ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }

  const restored: string[] = [];
  const errors: string[] = [];
  // Reverse order: undo the most recently applied change first.
  for (const entry of [...manifest.entries].reverse()) {
    try {
      if (entry.type === 'file') {
        if (entry.existed) {
          fs.writeFileSync(entry.path, entry.content ?? '', 'utf8');
        } else if (fs.existsSync(entry.path)) {
          fs.rmSync(entry.path);
        }
        restored.push(entry.path);
      } else {
        if (fs.existsSync(entry.to) && !fs.existsSync(entry.from)) {
          fs.renameSync(entry.to, entry.from);
        }
        restored.push(entry.from);
      }
    } catch (e) {
      errors.push(
        `Failed to restore ${entry.type === 'file' ? entry.path : entry.from}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { backupId: targetId, restored, errors };
}
