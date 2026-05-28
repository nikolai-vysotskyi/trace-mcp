/**
 * Conversation Miner — extracts architectural decisions, tech choices,
 * bug root causes, and preferences from Claude Code / Claw Code JSONL session logs.
 *
 * Uses pattern-based extraction (no LLM calls) to identify decision-like
 * content in assistant messages. Links decisions to code files/symbols
 * mentioned in the same conversation turn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InferenceService } from '../ai/interfaces.js';
import { listAllSessions } from '../analytics/log-parser.js';
import { logger } from '../logger.js';
import { detectGitWorktree } from '../project-root.js';
import { getCurrentBranch } from '../utils/git-branch.js';
import { computeConfidence } from './decision-confidence.js';
import { mineProviderSessions } from './conversation-miner-providers.js';
import type { DecisionInput, DecisionStore, DecisionType } from './decision-store.js';
import { type LlmExtractedDecision, extractDecisionsWithLlm } from './llm-extractor.js';
import {
  type ConversationTurn,
  type ExtractedDecision,
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  classifyConfidence,
  extractDecisions,
  isInternalProtocolPayload,
  stripPrivacyTags,
} from './conversation-miner-types.js';
import { isContentNonEnglish, sanitizeTitle } from './title-extractor.js';

// Re-export the shared surface so external callers keep importing from
// `./conversation-miner.js` — the public API stays unchanged after the
// types/leaf-utility extraction.
export type { ConversationTurn, ExtractedDecision } from './conversation-miner-types.js';
export {
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  classifyConfidence,
  extractDecisions,
  isInternalProtocolPayload,
  stripPrivacyTags,
} from './conversation-miner-types.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface MineResult {
  sessions_scanned: number;
  sessions_skipped: number;
  sessions_mined: number;
  decisions_extracted: number;
  errors: number;
  duration_ms: number;
  /** Extraction strategy actually used (may differ from requested when AI
   *  provider is unavailable and we fell back to regex). Omitted on the
   *  default regex path so existing callers / snapshots stay byte-identical. */
  strategy?: MineStrategy;
  /** Number of sessions that went through the LLM pass (post cost guard). */
  llm_sessions?: number;
  /** Number of decisions contributed by the LLM pass. */
  llm_decisions_extracted?: number;
}

/** Decision-extraction strategy used by `mineSessions`. See the strategy
 *  parameter docs on `mineSessions` for the per-mode semantics. */
export type MineStrategy = 'regex' | 'llm' | 'hybrid';

/** Subset of `LlmConfig` we forward into the extractor. Keeps the public
 *  surface narrow and lets callers override knobs without re-reading config. */
export interface LlmMiningKnobs {
  maxTokensPerSession: number;
  minSessionLength: number;
  maxSessions: number;
}

/** What `mineSessions` needs from an AI layer to enable LLM extraction.
 *  Kept narrow so tests can pass a fake without standing up a full AIProvider. */
export interface LlmMiningContext {
  inference: InferenceService;
  model: string;
}

// `ConversationTurn`, `ExtractedDecision`, threshold constants, and the
// `classifyConfidence` / `extractDecisions` extractors now live in
// `conversation-miner-types.ts` so helper modules (providers, llm-extractor)
// can import them without closing a cycle back through this file.

// ════════════════════════════════════════════════════════════════════════
// CONVERSATION PARSING
// ════════════════════════════════════════════════════════════════════════

/**
 * Options for incremental session-file reads. When omitted, behaves like a
 * full read from byte 0 — preserving the legacy single-pass contract.
 */
export interface ParseConversationOpts {
  /** Byte offset to start reading from (default 0). */
  startOffset?: number;
}

export interface ParseConversationResult {
  turns: ConversationTurn[];
  /** File size at read time (= next-pass startOffset). */
  endOffset: number;
  /** File mtime in ms at read time. */
  modifiedMs: number;
  /**
   * True when `startOffset` landed mid-line and the partial first line was
   * dropped. Cursor accounting still uses the full file size; callers only
   * lose the partial bytes between the cursor and the first newline.
   */
  warningTruncated?: boolean;
}

export function parseConversationTurns(
  filePath: string,
  opts: ParseConversationOpts = {},
): ParseConversationResult {
  const startOffset = Math.max(0, opts.startOffset ?? 0);
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const modifiedMs = stat.mtimeMs;

  if (startOffset >= size) {
    return { turns: [], endOffset: size, modifiedMs };
  }

  // Read only the appended portion. For session files (usually <50MB) we
  // accept reading the whole tail in one shot — sessions are JSONL, so a
  // streaming reader buys little over the simpler slice.
  //
  // When startOffset > 0 we also peek the single byte immediately before
  // startOffset. If it is a newline the chunk starts cleanly at a record
  // boundary and we keep it verbatim; otherwise the cursor landed inside
  // a record and we drop everything up to (and including) the first
  // newline in the chunk.
  const peekPrevByte = startOffset > 0;
  const fd = fs.openSync(filePath, 'r');
  let chunk: Buffer;
  let prevByteIsNewline = false;
  try {
    if (peekPrevByte) {
      const peek = Buffer.alloc(1);
      fs.readSync(fd, peek, 0, 1, startOffset - 1);
      prevByteIsNewline = peek[0] === 0x0a; // '\n'
    }
    const length = size - startOffset;
    chunk = Buffer.alloc(length);
    fs.readSync(fd, chunk, 0, length, startOffset);
  } finally {
    fs.closeSync(fd);
  }

  let content = chunk.toString('utf-8');
  let warningTruncated = false;
  if (startOffset > 0 && !prevByteIsNewline) {
    const nl = content.indexOf('\n');
    if (nl === -1) {
      // No newline in the tail at all — nothing to parse but the cursor still
      // advances so we don't re-read the same bytes next time.
      return { turns: [], endOffset: size, modifiedMs, warningTruncated: true };
    }
    // Drop the partial first line and flag the truncation.
    content = content.slice(nl + 1);
    warningTruncated = true;
  }

  const lines = content.split('\n').filter((l) => l.trim());
  const turns: ConversationTurn[] = [];

  for (const line of lines) {
    let record: {
      type?: string;
      timestamp?: string;
      message?: ConversationMessage;
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = record.timestamp || '';

    // Claude Code format
    if (record.type === 'assistant' || record.type === 'user') {
      const msg = record.message;
      if (!msg) continue;
      const turn = extractTurnContent(msg, record.type, timestamp);
      if (turn && turn.text.length > 20) turns.push(turn);
    }

    // Claw Code format
    if (record.type === 'message') {
      const msg = record.message;
      if (!msg) continue;
      const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : null;
      if (!role) continue;
      const turn = extractTurnContent(msg, role, timestamp);
      if (turn && turn.text.length > 20) turns.push(turn);
    }
  }

  return { turns, endOffset: size, modifiedMs, ...(warningTruncated ? { warningTruncated } : {}) };
}

interface ConversationContentItem {
  type?: string;
  text?: string;
  input?: unknown;
  name?: string;
}

interface ConversationMessage {
  role?: string;
  content?: string | ConversationContentItem[];
}

// `stripPrivacyTags` and `isInternalProtocolPayload` live in
// `conversation-miner-types.ts` (re-exported above).

function extractTurnContent(
  msg: ConversationMessage,
  role: 'user' | 'assistant',
  timestamp: string,
): ConversationTurn | null {
  const textParts: string[] = [];
  const referencedFiles: string[] = [];
  const referencedSymbols: string[] = [];

  const content = msg.content;
  if (typeof content === 'string') {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') {
        textParts.push(item);
      } else if (typeof item === 'object' && item !== null) {
        if (item.type === 'text' && typeof item.text === 'string') {
          textParts.push(item.text);
        }
        // Extract file references from tool use
        if (item.type === 'tool_use' && item.input) {
          const input = item.input as Record<string, unknown>;
          if (typeof input.file_path === 'string') referencedFiles.push(input.file_path);
          if (typeof input.path === 'string') referencedFiles.push(input.path);
          if (typeof input.symbol_id === 'string') referencedSymbols.push(input.symbol_id);
        }
      }
    }
  }

  const rawText = textParts.join('\n');
  // Privacy filter: drop messages that are entirely auto-generated protocol
  // payloads (system reminders, task notifications), then strip any remaining
  // private/persisted-output blocks from the user-visible content.
  if (isInternalProtocolPayload(rawText)) return null;
  const text = stripPrivacyTags(rawText).trim();
  if (!text) return null;

  return {
    role,
    text,
    timestamp,
    referenced_files: referencedFiles,
    referenced_symbols: referencedSymbols,
  };
}

// `extractDecisions`, `DECISION_PATTERNS`, `CONTEXT_BOOSTERS`, `inferTags`,
// and `TAG_PATTERNS` now live in `conversation-miner-types.ts`.

// ════════════════════════════════════════════════════════════════════════
// WORKTREE ADOPTION
// ════════════════════════════════════════════════════════════════════════

/**
 * Resolve a session's recorded project path to its **canonical** project root.
 *
 * If the recorded path is a linked git worktree, the canonical root is the
 * parent worktree (where the primary `.git` directory lives). Otherwise the
 * recorded path is returned unchanged.
 *
 * Why
 * ───
 * Claude Code stores `cwd` per session in `~/.claude/projects/<encoded-cwd>/`.
 * When a developer runs Claude inside `repo/.git/worktrees/feat-x`, every
 * decision mined from that session lands under the worktree's project_root.
 * Once the worktree is removed (post-merge), those decisions become orphans
 * — invisible to `query_decisions { project_root: '<repo>' }` — even though
 * the merged code now lives in the parent.
 *
 * claude-mem v12.2.0 ("Worktree Adoption") solved this with the same idea:
 * collapse worktree decisions under the parent at mining time, so memory
 * follows the code through a merge.
 *
 * Failure modes
 * ─────────────
 * `detectGitWorktree` returns null when the directory no longer exists, when
 * the `.git` entry is unreadable, or when the dir is not a git repo at all.
 * In every "can't tell" case we fall back to the original path — adoption is
 * opportunistic, never destructive. Decisions filed before this fix stay where
 * they are; manual reattribution is a follow-up CLI concern.
 *
 * Cache
 * ─────
 * Worktree detection touches the filesystem. Callers pass a `Map` so we
 * don't re-stat the same path for every session in a long mining run.
 */
export function adoptWorktreeRoot(rawProjectPath: string, cache: Map<string, string>): string {
  const cached = cache.get(rawProjectPath);
  if (cached !== undefined) return cached;

  let resolved = rawProjectPath;
  try {
    const wt = detectGitWorktree(rawProjectPath);
    if (wt && wt.mainRoot && wt.mainRoot !== rawProjectPath) {
      resolved = wt.mainRoot;
      logger.debug?.(
        { from: rawProjectPath, to: resolved },
        'mineSessions: adopted worktree decisions to parent project',
      );
    }
  } catch {
    /* defensive — never block mining on a worktree detection failure */
  }

  cache.set(rawProjectPath, resolved);
  return resolved;
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Mine all Claude Code / Claw Code sessions for decisions.
 * Skips already-mined sessions. Stores results in the decision store.
 *
 * Extraction strategy
 * ───────────────────
 *   - `'regex'`   (default) — pattern-based, free, fast, ~20-40% recall.
 *   - `'llm'`     — LLM-only. Requires an AI provider; costs tokens; higher recall.
 *                   When no provider is available, falls back to regex with a warning.
 *   - `'hybrid'`  — runs regex first; when an AI provider is available, also runs
 *                   the LLM pass and merges results (dedup by normalized title;
 *                   keep the higher-confidence row).
 *
 * The LLM pass is bounded by `llm.maxSessions` (cost guard). LLM-extracted
 * decisions are scored by `computeConfidence` and the LLM's own confidence;
 * the routing through the auto/pending/drop tier uses the higher of the two.
 */
export async function mineSessions(
  decisionStore: DecisionStore,
  opts: {
    /** Only mine sessions for this project (default: all) */
    projectRoot?: string;
    /** Re-mine already processed sessions */
    force?: boolean;
    /** Minimum confidence threshold (default: 0.6).
     *  Kept for back-compat callers; review/reject thresholds take precedence
     *  when supplied. When only minConfidence is passed, it's used as the
     *  reject floor — i.e. legacy "drop everything below this" semantics. */
    minConfidence?: number;
    /** Memoir confidence tier: rows ≥ this are auto-approved (review_status=NULL). */
    reviewThreshold?: number;
    /** Memoir confidence tier: rows below this are dropped entirely. */
    rejectThreshold?: number;
    /** Decision extraction strategy. Defaults to `'regex'` for back-compat. */
    strategy?: MineStrategy;
    /** AI context required for `'llm'` / `'hybrid'` strategies. */
    llmContext?: LlmMiningContext;
    /** Tunables for the LLM pass (token budget, min length, cost cap). */
    llmKnobs?: Partial<LlmMiningKnobs>;
    /** Inherits the recall timeout so LLM calls never pin the agent turn. */
    signal?: AbortSignal;
    /**
     * Use byte-offset cursor for incremental session mining. When false,
     * falls back to legacy binary (mined/unmined) semantics. Defaults to
     * `true` — caller (MCP tool) typically threads the value from
     * `memory.mining.incrementalCursor` in config.
     */
    incrementalCursor?: boolean;
  } = {},
): Promise<MineResult> {
  const start = Date.now();
  const sessions = listAllSessions();
  // Legacy `minConfidence` falls back to the default reject floor so behaviour
  // is unchanged for callers that don't opt into the tiered review queue.
  const reviewThreshold = opts.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const rejectThreshold = opts.rejectThreshold ?? opts.minConfidence ?? DEFAULT_REJECT_THRESHOLD;

  // ── Strategy resolution ─────────────────────────────────────────────
  // `'regex'` is the default for back-compat. `'llm'` / `'hybrid'` require
  // an AI provider — when one isn't configured we emit a warning and fall
  // back to regex so the call still does something useful.
  const requestedStrategy: MineStrategy = opts.strategy ?? 'regex';
  let effectiveStrategy: MineStrategy = requestedStrategy;
  const llmAvailable = !!opts.llmContext;
  if ((requestedStrategy === 'llm' || requestedStrategy === 'hybrid') && !llmAvailable) {
    logger.warn(
      { requestedStrategy, fallback: 'regex' },
      'mineSessions: LLM strategy requested but no AI inference context provided — falling back to regex',
    );
    effectiveStrategy = 'regex';
  }
  const knobs: LlmMiningKnobs = {
    maxTokensPerSession: opts.llmKnobs?.maxTokensPerSession ?? 8000,
    minSessionLength: opts.llmKnobs?.minSessionLength ?? 500,
    maxSessions: opts.llmKnobs?.maxSessions ?? 50,
  };
  let llmSessionsRemaining = effectiveStrategy === 'regex' ? 0 : knobs.maxSessions;
  let llmSessionsUsed = 0;
  let llmDecisionsExtracted = 0;
  const worktreeCache = new Map<string, string>();
  // Branch-aware capture: resolve current branch per canonical project root, once.
  // Mining can span thousands of sessions across many projects; the cache keeps
  // it to one `git rev-parse` per project.
  const branchCache = new Map<string, string | null>();
  const branchFor = (projectPath: string): string | null => {
    if (branchCache.has(projectPath)) return branchCache.get(projectPath) ?? null;
    const b = getCurrentBranch(projectPath);
    branchCache.set(projectPath, b);
    return b;
  };

  // Optionally adopt the filter target itself, in case the user passed a
  // worktree path: we want their `--project /repo/wt-x` to also pick up
  // sessions whose recorded cwd is `/repo/wt-x` AND those whose cwd is the
  // parent `/repo` (after adoption they share the same canonical root).
  const filterRoot = opts.projectRoot
    ? adoptWorktreeRoot(opts.projectRoot, worktreeCache)
    : undefined;

  let scanned = 0;
  let skipped = 0;
  let mined = 0;
  let extracted = 0;
  let errors = 0;

  for (const session of sessions) {
    scanned++;

    const canonicalProjectPath = adoptWorktreeRoot(session.projectPath, worktreeCache);

    // Filter by project if specified
    if (filterRoot && canonicalProjectPath !== filterRoot) {
      skipped++;
      continue;
    }

    // Resolve the next-read cursor for this session.
    //  - `incrementalCursor: false` falls back to legacy binary semantics —
    //    once mined, never re-mined unless `force=true`.
    //  - `incrementalCursor: true` (default): consult the byte-offset cursor.
    //    Unchanged files are skipped without parsing; grown files resume from
    //    the recorded offset; shrunk files restart from 0.
    //  - `force=true` always reads from 0 but still UPDATES the cursor row
    //    afterwards.
    const incrementalEnabled = opts.incrementalCursor !== false;
    let readStartOffset = 0;
    let cursorReason: 'unmined' | 'restart_shrunk' | 'incremental' | 'forced' = 'unmined';
    if (!incrementalEnabled) {
      if (!opts.force && decisionStore.isSessionMined(session.filePath)) {
        skipped++;
        continue;
      }
    } else {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(session.filePath);
      } catch {
        // File disappeared between listing and stat — treat as skip.
        skipped++;
        continue;
      }
      if (opts.force) {
        cursorReason = 'forced';
        readStartOffset = 0;
      } else {
        const cursor = decisionStore.getSessionCursor(session.filePath, stat.size, stat.mtimeMs);
        if (cursor === null) {
          // File unchanged since last pass — skip without parsing.
          skipped++;
          continue;
        }
        cursorReason = cursor.reason;
        readStartOffset = cursor.cursor;
        if (cursor.reason === 'incremental' && cursor.cursor > 0) {
          logger.debug(
            { file: session.filePath, cursor: cursor.cursor, size: stat.size },
            'mineSessions: incremental mining resuming from cursor',
          );
        }
      }
    }

    try {
      const parseResult = incrementalEnabled
        ? parseConversationTurns(session.filePath, { startOffset: readStartOffset })
        : parseConversationTurns(session.filePath);
      const turns = parseResult.turns;
      if (turns.length === 0) {
        if (incrementalEnabled) {
          decisionStore.updateSessionCursor({
            sessionPath: session.filePath,
            cursor: parseResult.endOffset,
            size: parseResult.endOffset,
            modifiedMs: parseResult.modifiedMs,
            decisionsFound: 0,
          });
        } else {
          decisionStore.markSessionMined(session.filePath, 0);
        }
        skipped++;
        continue;
      }
      // Suppress unused-variable lint in legacy path: cursorReason is
      // primarily for debug logging, but referenced here so the symbol
      // doesn't trip noUnusedLocals when incrementalEnabled is false.
      void cursorReason;

      // Strategy-driven extraction:
      //  - regex: legacy pattern-based; current behaviour.
      //  - llm:   skip regex entirely, use LLM only.
      //  - hybrid: run both; merge by normalized-title dedup keeping the
      //           higher-confidence row.
      const sessionId = path.basename(session.filePath, '.jsonl');
      let regexDecisions: ExtractedDecision[] =
        effectiveStrategy === 'llm' ? [] : extractDecisions(turns);

      let llmDecisions: ExtractedDecision[] = [];
      if (
        (effectiveStrategy === 'llm' || effectiveStrategy === 'hybrid') &&
        opts.llmContext &&
        llmSessionsRemaining > 0
      ) {
        llmSessionsRemaining--;
        llmSessionsUsed++;
        const llmRaw = await extractDecisionsWithLlm(turns, {
          provider: opts.llmContext.inference,
          model: opts.llmContext.model,
          maxTokens: knobs.maxTokensPerSession,
          minSessionLength: knobs.minSessionLength,
          sessionId,
          signal: opts.signal,
          cache: {
            get: (sid, sha, model) => decisionStore.getCachedLlmExtraction(sid, sha, model),
            put: (sid, sha, model, json) =>
              decisionStore.putCachedLlmExtraction(sid, sha, model, json),
          },
        });
        llmDecisions = adaptLlmDecisions(llmRaw, turns);
        llmDecisionsExtracted += llmDecisions.length;
      }

      const combined = mergeRegexAndLlm(regexDecisions, llmDecisions);

      // Memoir tiering: drop rows below the reject floor; everything else
      // becomes either auto-approved (review_status = NULL) or queued for
      // human review (review_status = 'pending').
      const tiered = combined
        .map((d) => ({
          d,
          tier: classifyConfidence(d.confidence, reviewThreshold, rejectThreshold),
        }))
        .filter((x) => x.tier !== 'drop');

      if (tiered.length > 0) {
        const capturedBranch = branchFor(canonicalProjectPath);
        const inputs: DecisionInput[] = tiered.map(({ d, tier }) => ({
          title: d.title,
          content: d.content,
          type: d.type,
          // Adopted to the parent worktree if `session.projectPath` is a
          // linked worktree, so post-merge memory still queries cleanly.
          project_root: canonicalProjectPath,
          symbol_id: d.symbol_id,
          file_path: d.file_path,
          tags: d.tags,
          valid_from: d.timestamp,
          session_id: sessionId,
          source: 'mined' as const,
          confidence: d.confidence,
          git_branch: capturedBranch,
          review_status: tier === 'pending' ? 'pending' : null,
        }));

        decisionStore.addDecisions(inputs);
        extracted += tiered.length;
      }

      if (incrementalEnabled) {
        decisionStore.updateSessionCursor({
          sessionPath: session.filePath,
          cursor: parseResult.endOffset,
          size: parseResult.endOffset,
          modifiedMs: parseResult.modifiedMs,
          decisionsFound: tiered.length,
        });
      } else {
        decisionStore.markSessionMined(session.filePath, tiered.length);
      }
      mined++;
    } catch (e) {
      logger.warn({ error: e, file: session.filePath }, 'Failed to mine session for decisions');
      errors++;
    }
  }

  const _providerCounters = { scanned, skipped, mined, extracted, errors };
  await mineProviderSessions(
    decisionStore,
    {
      // Forward the canonical (worktree-adopted) root so provider mining
      // also files decisions under the parent project.
      projectRoot: filterRoot ?? opts.projectRoot,
      force: opts.force,
      minConfidence: opts.minConfidence,
      reviewThreshold,
      rejectThreshold,
      // Single switch for both paths: callers toggle incremental on/off once.
      incrementalCursor: opts.incrementalCursor,
    },
    _providerCounters,
  );
  scanned = _providerCounters.scanned;
  skipped = _providerCounters.skipped;
  mined = _providerCounters.mined;
  extracted = _providerCounters.extracted;
  errors = _providerCounters.errors;

  const result: MineResult = {
    sessions_scanned: scanned,
    sessions_skipped: skipped,
    sessions_mined: mined,
    decisions_extracted: extracted,
    errors,
    duration_ms: Date.now() - start,
  };
  // Annotate the new fields only when the caller opted into a non-default
  // strategy. Keeps the byte-for-byte JSON unchanged for legacy regex callers
  // and snapshot tests under `tests/analytics`.
  if (requestedStrategy !== 'regex') {
    result.strategy = effectiveStrategy;
    result.llm_sessions = llmSessionsUsed;
    result.llm_decisions_extracted = llmDecisionsExtracted;
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// LLM ↔ REGEX MERGE HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Adapt the raw `LlmExtractedDecision[]` (no provenance, no nearby-file
 * context) into the `ExtractedDecision` shape used by the rest of the
 * pipeline. Files/symbols referenced anywhere in the session become weak
 * provenance hints — first-match wins, same as the regex path.
 *
 * Confidence is `max(computeConfidence, llm.confidence)`. The LLM's own
 * confidence is informative but not authoritative; the heuristic floor
 * (code_ref present, content length, type signal, tags) keeps the routing
 * symmetric with `remember_decision`.
 */
function adaptLlmDecisions(
  raw: LlmExtractedDecision[],
  turns: ConversationTurn[],
): ExtractedDecision[] {
  if (raw.length === 0) return [];
  const allFiles = new Set<string>();
  const allSymbols = new Set<string>();
  for (const t of turns) {
    for (const f of t.referenced_files) allFiles.add(f);
    for (const s of t.referenced_symbols) allSymbols.add(s);
  }
  const fileHint = allFiles.size > 0 ? [...allFiles][0] : undefined;
  const symbolHint = allSymbols.size > 0 ? [...allSymbols][0] : undefined;
  const timestamp = turns.length > 0 ? turns[turns.length - 1].timestamp : '';

  const out: ExtractedDecision[] = [];
  for (const d of raw) {
    // English-only gate also applies to LLM-extracted decisions — even when
    // a remote model returns fluent foreign-language prose, it must not
    // land in the active knowledge graph.
    const cleanTitle = sanitizeTitle(d.title);
    if (cleanTitle === null) continue;
    if (isContentNonEnglish(d.content)) continue;
    const heuristic = computeConfidence({
      title: cleanTitle,
      content: d.content,
      type: d.type,
      symbol_id: symbolHint,
      file_path: fileHint,
      tags: d.tags,
    });
    out.push({
      title: cleanTitle,
      content: d.content,
      type: d.type,
      // Take the higher of the LLM's self-estimate and the heuristic — LLM
      // overconfidence is real, but so is heuristic blindness to nuance.
      confidence: Math.max(heuristic, d.confidence),
      file_path: fileHint,
      symbol_id: symbolHint,
      tags: d.tags ?? [],
      timestamp: timestamp || new Date().toISOString(),
    });
  }
  return out;
}

/**
 * Merge regex and LLM extractions, deduplicating by normalized title
 * (lowercase, whitespace-collapsed). On collision, keep the higher-confidence
 * entry. Used by the hybrid strategy.
 */
export function mergeRegexAndLlm(
  regex: ExtractedDecision[],
  llm: ExtractedDecision[],
): ExtractedDecision[] {
  const byKey = new Map<string, ExtractedDecision>();
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const d of regex) byKey.set(normalize(d.title), d);
  for (const d of llm) {
    const k = normalize(d.title);
    const existing = byKey.get(k);
    if (!existing || d.confidence > existing.confidence) {
      byKey.set(k, d);
    }
  }
  return [...byKey.values()];
}
