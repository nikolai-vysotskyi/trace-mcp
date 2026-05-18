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
import { isContentNonEnglish, sanitizeTitle } from './title-extractor.js';

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

interface ExtractedDecision {
  title: string;
  content: string;
  type: DecisionType;
  confidence: number;
  file_path?: string;
  symbol_id?: string;
  tags: string[];
  timestamp: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  /** Files referenced in tool calls during this turn */
  referenced_files: string[];
  /** Symbol names mentioned in tool calls */
  referenced_symbols: string[];
}

// ════════════════════════════════════════════════════════════════════════
// CONFIDENCE TIERS — memoir-style auto / review / reject split
// ════════════════════════════════════════════════════════════════════════

/**
 * Default review-tier thresholds (overridable via `decisions.review_threshold`
 * and `decisions.reject_threshold` in trace-mcp config).
 *
 *   confidence ≥ REVIEW_THRESHOLD → auto-approved (review_status = NULL)
 *   confidence ≥ REJECT_THRESHOLD → 'pending' (queued for human review)
 *   otherwise                     → dropped entirely (current behaviour)
 *
 * Pre-feature behaviour kept any decision that cleared `minConfidence`
 * (default 0.6) and dropped the rest. The new tier system splits that
 * "kept" bucket so borderline rows surface in the review queue instead
 * of silently entering the active knowledge graph.
 */
export const DEFAULT_REVIEW_THRESHOLD = 0.75;
export const DEFAULT_REJECT_THRESHOLD = 0.45;

/**
 * Classify a confidence score against the configured thresholds.
 * Returns `'drop'` to skip the row entirely (caller does nothing),
 * `'pending'` to insert with `review_status = 'pending'`, or
 * `'auto'` to insert with `review_status = NULL` (visible by default).
 */
export function classifyConfidence(
  confidence: number,
  reviewThreshold = DEFAULT_REVIEW_THRESHOLD,
  rejectThreshold = DEFAULT_REJECT_THRESHOLD,
): 'auto' | 'pending' | 'drop' {
  if (confidence >= reviewThreshold) return 'auto';
  if (confidence >= rejectThreshold) return 'pending';
  return 'drop';
}

// ════════════════════════════════════════════════════════════════════════
// DECISION EXTRACTION PATTERNS
// ════════════════════════════════════════════════════════════════════════

interface DecisionPattern {
  /** Regex to match against assistant text */
  pattern: RegExp;
  type: DecisionType;
  /** Confidence multiplier for this pattern */
  confidence: number;
  /**
   * Function to extract title from the match. Returns `null` when the
   * candidate must be rejected (non-English, unbalanced, empty) — callers
   * skip the decision entirely rather than substitute a worse title.
   */
  titleExtractor: (match: RegExpMatchArray, context: string) => string | null;
}

const DECISION_PATTERNS: DecisionPattern[] = [
  // Architecture decisions: "decided to", "we'll use", "going with", "chose X over Y"
  {
    pattern:
      /(?:decided|choose|chose|going with|we(?:'ll| will) use|opting for|switching to|migrating to)\s+(.{10,120}?)(?:\.|$|\n)/gi,
    type: 'architecture_decision',
    confidence: 0.85,
    titleExtractor: (m) => truncateTitle(m[1].trim()),
  },
  // Tech choices: "using X because", "X instead of Y", "picked X for"
  {
    pattern:
      /(?:using|picked|selected|adopted)\s+(\S+(?:\s+\S+){0,4})\s+(?:because|since|for|due to|as it)\s+(.{10,120}?)(?:\.|$|\n)/gi,
    type: 'tech_choice',
    confidence: 0.8,
    titleExtractor: (m) => truncateTitle(`Use ${m[1].trim()}: ${m[2].trim()}`),
  },
  // "X instead of Y" / "X over Y"
  {
    pattern: /(\S+(?:\s+\S+){0,3})\s+(?:instead of|over|rather than)\s+(\S+(?:\s+\S+){0,3})\b/gi,
    type: 'tech_choice',
    confidence: 0.75,
    titleExtractor: (m) => truncateTitle(`${m[1].trim()} over ${m[2].trim()}`),
  },
  // Bug root causes: "the bug was", "root cause", "the issue was", "caused by"
  {
    pattern:
      /(?:the (?:bug|issue|problem|error) (?:was|is)|root cause|caused by|the fix (?:was|is))\s+(.{10,150}?)(?:\.|$|\n)/gi,
    type: 'bug_root_cause',
    confidence: 0.85,
    titleExtractor: (m) => truncateTitle(m[1].trim()),
  },
  // Preferences: "prefer", "always use", "never use", "should always", "convention is"
  {
    pattern:
      /(?:(?:I |we |you should )prefer|always (?:use|do)|never (?:use|do)|convention is|standard is)\s+(.{10,120}?)(?:\.|$|\n)/gi,
    type: 'preference',
    confidence: 0.7,
    titleExtractor: (m) => truncateTitle(m[1].trim()),
  },
  // Tradeoffs: "tradeoff", "trade-off", "downside is", "the cost of"
  {
    pattern: /(?:trade-?off|downside (?:is|was)|the cost of|drawback)\s+(.{10,150}?)(?:\.|$|\n)/gi,
    type: 'tradeoff',
    confidence: 0.75,
    titleExtractor: (m) => truncateTitle(m[1].trim()),
  },
  // Discoveries: "discovered that", "found out that", "turns out", "TIL"
  {
    pattern:
      /(?:discovered that|found out (?:that)?|turns out|TIL|it appears that|realized that)\s+(.{10,150}?)(?:\.|$|\n)/gi,
    type: 'discovery',
    confidence: 0.8,
    titleExtractor: (m) => truncateTitle(m[1].trim()),
  },
  // Conventions: "from now on", "going forward", "the rule is", "naming convention"
  {
    pattern:
      /(?:from now on|going forward|the rule is|naming convention|our convention)\s+(.{10,120}?)(?:\.|$|\n)/gi,
    type: 'convention',
    confidence: 0.8,
    titleExtractor: (m) => truncateTitle(m[1].trim()),
  },
];

/** Patterns that indicate a decision context (boost confidence when present nearby) */
const CONTEXT_BOOSTERS = [
  /\bbecause\b/i,
  /\breason(?:ing)?\b/i,
  /\bwhy\b/i,
  /\bpros?\s+(?:and|&)\s+cons?\b/i,
  /\balternative/i,
  /\barchitecture\b/i,
  /\bdesign decision\b/i,
];

/**
 * Sentence-aware, language-filtered, bracket-balanced title sanitizer.
 * Returns `null` to signal that the candidate must be dropped — caller
 * skips the decision entirely rather than persist a worse title.
 */
function truncateTitle(s: string): string | null {
  return sanitizeTitle(s);
}

// ════════════════════════════════════════════════════════════════════════
// CONVERSATION PARSING
// ════════════════════════════════════════════════════════════════════════

function parseConversationTurns(filePath: string): ConversationTurn[] {
  const content = fs.readFileSync(filePath, 'utf-8');
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

  return turns;
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

// ════════════════════════════════════════════════════════════════════════
// PRIVACY FILTERING — strip non-user content before persisting to memory
// ════════════════════════════════════════════════════════════════════════

/**
 * Block-tags whose content should be redacted before mining.
 *
 * - `<private>…</private>` — user-curated "do not remember this" markers
 * - `<persisted-output>…</persisted-output>` — Claude Code's offline tool-output
 *   capture, often hundreds of KB of file contents we don't want to mine
 * - `<system-reminder>…</system-reminder>` — runtime nudges (e.g. "TodoWrite
 *   has not been used"), not user-authored content
 * - `<ide_selection>…</ide_selection>` — IDE selection echo, can contain
 *   sensitive code we shouldn't surface back across sessions
 * - `<task-notification>…</task-notification>` — autonomous protocol payloads
 *   emitted by Claude Code on background `Agent` completion (claude-mem v12.4.2
 *   found 471 of these polluting one local DB)
 * - `<local-command-stdout>…</local-command-stdout>` — captured shell output
 *   (e.g. `!pwd`), may contain secrets
 *
 * `<command-message>` and `<command-name>` are kept — those wrap real user
 * slash-commands and are part of the conversation.
 *
 * Tempered greedy body (`[\s\S]*?`) prevents one tag from spanning across
 * unrelated text. 256 KiB size guard short-circuits the regex on hostile
 * payloads to avoid pathological backtracking.
 */
const PRIVACY_BLOCK_TAGS = [
  'private',
  'persisted-output',
  'system-reminder',
  'ide_selection',
  'task-notification',
  'local-command-stdout',
] as const;

const PRIVACY_TAG_REGEX = new RegExp(
  `<(${PRIVACY_BLOCK_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'gi',
);

const PRIVACY_REGEX_BUDGET = 256 * 1024;

export function stripPrivacyTags(text: string): string {
  if (!text) return text;
  if (text.length > PRIVACY_REGEX_BUDGET) {
    // Don't run the regex on hostile input; nuke any opening privacy tag
    // through to end-of-string as a conservative fallback. We'd rather
    // drop the message than spend seconds backtracking.
    return text.replace(
      new RegExp(`<(${PRIVACY_BLOCK_TAGS.join('|')})\\b[^>]*>[\\s\\S]*$`, 'i'),
      '',
    );
  }
  return text.replace(PRIVACY_TAG_REGEX, '');
}

/**
 * Detect messages whose visible content is *only* an internal protocol
 * payload — e.g. autonomous `<task-notification>` blocks or stale system
 * reminders. After stripping privacy tags, what's left is whitespace.
 *
 * Mining these as user prompts pollutes the decision graph (claude-mem
 * v12.4.2: 471 ghost rows in one local DB). Returning `true` tells the
 * caller to skip the turn entirely.
 */
export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  return stripPrivacyTags(text).trim().length === 0;
}

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

// ════════════════════════════════════════════════════════════════════════
// DECISION EXTRACTION
// ════════════════════════════════════════════════════════════════════════

export function extractDecisions(turns: ConversationTurn[]): ExtractedDecision[] {
  const decisions: ExtractedDecision[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== 'assistant') continue;

    // Build context window: previous user message + current assistant message
    const contextText =
      i > 0 && turns[i - 1].role === 'user' ? `${turns[i - 1].text}\n---\n${turn.text}` : turn.text;

    // Check for context boosters
    const boosterCount = CONTEXT_BOOSTERS.filter((p) => p.test(contextText)).length;
    const boosterMultiplier = 1 + boosterCount * 0.05;

    // Collect file/symbol references from nearby turns
    const nearbyFiles = new Set<string>();
    const nearbySymbols = new Set<string>();
    for (let j = Math.max(0, i - 1); j <= Math.min(turns.length - 1, i + 1); j++) {
      for (const f of turns[j].referenced_files) nearbyFiles.add(f);
      for (const s of turns[j].referenced_symbols) nearbySymbols.add(s);
    }

    for (const pattern of DECISION_PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.pattern.exec(turn.text)) !== null) {
        const title = pattern.titleExtractor(match, contextText);
        // Title-sanitizer rejects non-English / unbalanced / empty fragments
        // by returning null. Skip these candidates entirely — falling back
        // to a worse title would just pollute the decision graph.
        if (title === null) continue;
        // Deduplicate by title similarity
        const titleKey = title.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(titleKey)) continue;
        seen.add(titleKey);

        // Extract surrounding context (±200 chars around match)
        const start = Math.max(0, match.index - 200);
        const end = Math.min(turn.text.length, match.index + match[0].length + 200);
        const content = turn.text.slice(start, end).trim();

        // English-only rule applies to the long content field too — drop
        // candidates whose surrounding context is predominantly non-English
        // even if the title slice itself happened to land in Latin chars.
        if (isContentNonEnglish(content)) continue;

        const confidence = Math.min(pattern.confidence * boosterMultiplier, 0.99);

        // Infer tags from content
        const tags = inferTags(content);

        decisions.push({
          title,
          content,
          type: pattern.type,
          confidence,
          file_path: nearbyFiles.size > 0 ? [...nearbyFiles][0] : undefined,
          symbol_id: nearbySymbols.size > 0 ? [...nearbySymbols][0] : undefined,
          tags,
          timestamp: turn.timestamp || new Date().toISOString(),
        });
      }
    }
  }

  // Keep everything above the hard reject floor; the caller (mineSessions /
  // mineProviderSessions) applies the auto/pending split via classifyConfidence.
  // 0.4 = a touch below DEFAULT_REJECT_THRESHOLD so users can lower their
  // reject_threshold without re-running extraction.
  return decisions.filter((d) => d.confidence >= 0.4);
}

const TAG_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bauth(?:entication|orization)?\b/i, tag: 'auth' },
  { pattern: /\bdatabase|db|sql|postgres|mysql|sqlite|mongo/i, tag: 'database' },
  { pattern: /\bapi\b|endpoint|route|REST|GraphQL/i, tag: 'api' },
  { pattern: /\btest(?:ing|s)?\b|jest|vitest|mocha/i, tag: 'testing' },
  { pattern: /\bperformance|optimization|cache|latency/i, tag: 'performance' },
  { pattern: /\bsecurity|vulnerability|CVE|OWASP/i, tag: 'security' },
  { pattern: /\bdeploy|CI|CD|pipeline|docker|k8s/i, tag: 'devops' },
  { pattern: /\btype(?:script)?|typing|generic/i, tag: 'typescript' },
  { pattern: /\brefactor|clean.?up|tech.?debt/i, tag: 'refactoring' },
  { pattern: /\bmigrat(?:e|ion)/i, tag: 'migration' },
];

function inferTags(content: string): string[] {
  const tags: string[] = [];
  for (const { pattern, tag } of TAG_PATTERNS) {
    if (pattern.test(content)) tags.push(tag);
  }
  return tags;
}

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

    // Skip already mined (unless force)
    if (!opts.force && decisionStore.isSessionMined(session.filePath)) {
      skipped++;
      continue;
    }

    try {
      const turns = parseConversationTurns(session.filePath);
      if (turns.length === 0) {
        decisionStore.markSessionMined(session.filePath, 0);
        skipped++;
        continue;
      }

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

      decisionStore.markSessionMined(session.filePath, tiered.length);
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
