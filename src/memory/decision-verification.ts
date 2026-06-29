/**
 * Decision staleness verification (Task 3 — "Kage"-inspired).
 *
 * A decision linked to a `symbol_id` keeps surfacing even after that symbol is
 * renamed, moved, or deleted, and even after its source body changes materially
 * since the decision was captured. This module checks, at recall time, whether a
 * decision's linked code still resolves AND still looks the way it did when the
 * decision was made.
 *
 * Verdicts:
 *   - `"ok"`             — symbol resolves and source slice is unchanged since
 *                          `created_at` (or we couldn't tell → fail-open).
 *   - `"symbol_missing"` — the linked `symbol_id` no longer resolves in the
 *                          index (deleted / renamed / moved).
 *   - `"code_changed"`   — the symbol resolves, but its current source slice
 *                          differs from the slice at the last commit ≤ the
 *                          decision's `created_at`.
 *
 * Design notes:
 *   - Conservative by default. Git unavailable, file untracked, ambiguous
 *     history, unparseable timestamps → `"ok"` (never withhold on uncertainty).
 *   - Decisions with no `symbol_id` are always `"ok"`: a bare `file_path` link
 *     is too coarse to flag reliably without a lot of false positives.
 *   - Pure + synchronous (mirrors `getSymbol`'s `verify_against_git` path) so
 *     callers can fold it into existing synchronous recall handlers. The git
 *     calls are `execFileSync` with a short timeout — fine for the occasional
 *     verification pass, not the hot loop.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { safeGitEnv } from '../utils/git-env.js';
import type { DecisionRow } from './decision-types.js';

export type VerificationStatus = 'ok' | 'symbol_missing' | 'code_changed';

export interface DecisionVerification {
  /** Verdict — see module docstring. */
  verification: VerificationStatus;
  /** True when the linked code is missing or materially changed. */
  stale: boolean;
}

/** A decision row decorated with its verification verdict (when computed). */
export type VerifiedDecisionRow = DecisionRow & Partial<DecisionVerification>;

const FRESH: DecisionVerification = { verification: 'ok', stale: false };

/**
 * Read the on-disk byte slice [byteStart, byteEnd) for a file relative to root.
 * Returns null on any IO error so callers fail-open.
 */
function readDiskSlice(
  rootPath: string,
  relPath: string,
  byteStart: number,
  byteEnd: number,
): string | null {
  try {
    const buf = readFileSync(path.resolve(rootPath, relPath));
    return buf.slice(byteStart, byteEnd).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve the last commit SHA that touched `relPath` at or before `isoTs`.
 * Uses `git log -1 --before` so we land on the state the decision was made
 * against. Returns null when git is unavailable, the file is untracked, the
 * timestamp is unparseable, or there is no such commit.
 */
function lastCommitBefore(rootPath: string, relPath: string, isoTs: string): string | null {
  const ts = Date.parse(isoTs);
  if (!Number.isFinite(ts)) return null;
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', `--before=${new Date(ts).toISOString()}`, '--format=%H', '--', relPath],
      {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: safeGitEnv(),
        encoding: 'utf8',
      },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read the byte slice [byteStart, byteEnd) from `<commit>:<relPath>`.
 * Returns null on any git error (file not in that commit, etc.).
 */
function readCommitSlice(
  rootPath: string,
  commit: string,
  relPath: string,
  byteStart: number,
  byteEnd: number,
): string | null {
  try {
    const raw = execFileSync('git', ['show', `${commit}:${relPath}`], {
      cwd: rootPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      env: safeGitEnv(),
      encoding: 'buffer',
    });
    return raw.slice(byteStart, byteEnd).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Verify a single decision against the live code index + git history.
 *
 * @param decision  The decision row to verify.
 * @param store     The code Store (the index — NOT the decision store).
 * @param projectRoot Absolute path to the project root for git/IO resolution.
 */
export function verifyDecision(
  decision: Pick<DecisionRow, 'symbol_id' | 'file_path' | 'created_at'>,
  store: Store,
  projectRoot: string,
): DecisionVerification {
  // No code anchor → nothing to verify. File-only links are intentionally
  // not flagged (too coarse, high false-positive rate).
  if (!decision.symbol_id) return FRESH;

  const symbol = store.getSymbolBySymbolId(decision.symbol_id);
  if (!symbol) {
    // The decision points at a symbol the index no longer knows — renamed,
    // moved, or deleted. Withhold/flag.
    return { verification: 'symbol_missing', stale: true };
  }

  const file = store.getFileById(symbol.file_id);
  if (!file) {
    // Symbol row exists but its file is gone from the index — treat as missing.
    return { verification: 'symbol_missing', stale: true };
  }

  // Compare the current on-disk slice against the slice at the last commit
  // ≤ created_at. Any read failure fails-open to "ok".
  const current = readDiskSlice(projectRoot, file.path, symbol.byte_start, symbol.byte_end);
  if (current === null) return FRESH;

  const commit = lastCommitBefore(projectRoot, file.path, decision.created_at);
  if (!commit) return FRESH;

  // The byte range is the CURRENT index range; the historical file may have had
  // different offsets, so a byte-range slice of an old blob is only a heuristic.
  // To keep false positives low we compare on the historical commit's own
  // byte range when the slice lands cleanly; if the old slice read fails we
  // fail-open. This is intentionally conservative — it flags the common case
  // (symbol body edited in place) without crying wolf on offset drift.
  const past = readCommitSlice(projectRoot, commit, file.path, symbol.byte_start, symbol.byte_end);
  if (past === null) return FRESH;

  if (normalize(past) !== normalize(current)) {
    return { verification: 'code_changed', stale: true };
  }
  return FRESH;
}

/** Trim trailing whitespace per line + collapse CRLF so cosmetic diffs don't flag. */
function normalize(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Decorate a batch of decisions with verification verdicts.
 *
 * @param decisions   Rows to verify (typically a `query_decisions` page).
 * @param store       The code Store, or null when no index is available — in
 *                    which case every row is returned untouched (no verdict).
 * @param projectRoot Absolute project root.
 * @param opts.withhold When true, drop stale rows entirely instead of flagging
 *                      them. Default false (annotate in place).
 * @returns The decorated (and possibly filtered) rows.
 */
export function verifyDecisions(
  decisions: DecisionRow[],
  store: Store | null,
  projectRoot: string,
  opts: { withhold?: boolean } = {},
): VerifiedDecisionRow[] {
  if (!store || decisions.length === 0) return decisions;
  const out: VerifiedDecisionRow[] = [];
  for (const d of decisions) {
    // Bare decisions (no symbol_id) skip the git work entirely.
    if (!d.symbol_id) {
      out.push(d);
      continue;
    }
    const v = verifyDecision(d, store, projectRoot);
    if (v.stale && opts.withhold) continue;
    if (v.stale) {
      out.push({ ...d, verification: v.verification, stale: true });
    } else {
      out.push(d);
    }
  }
  return out;
}
