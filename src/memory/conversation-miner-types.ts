/**
 * Conversation-miner shared surface — types + leaf utilities used by the
 * main miner (`conversation-miner.ts`) and its helpers
 * (`conversation-miner-providers.ts`, `llm-extractor.ts`).
 *
 * Extracted from `conversation-miner.ts` to break import cycles: the helpers
 * needed values like `extractDecisions`, `classifyConfidence`,
 * `stripPrivacyTags` while conversation-miner.ts needed the helpers back —
 * producing two circular import edges. Hoisting the shared surface to this
 * leaf module is the smallest fix that keeps `mineSessions` byte-identical
 * and preserves the public API (`conversation-miner.ts` re-exports
 * everything below for back-compat).
 *
 * This module is value-bearing (not types-only): the legacy utilities here
 * are pure functions / constants with no cross-module value dependencies of
 * their own beyond `./title-extractor.ts`, which is itself a leaf.
 */

import type { DecisionType } from './decision-types.js';
import { isContentNonEnglish, sanitizeTitle } from './title-extractor.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  /** Files referenced in tool calls during this turn */
  referenced_files: string[];
  /** Symbol names mentioned in tool calls */
  referenced_symbols: string[];
}

export interface ExtractedDecision {
  title: string;
  content: string;
  type: DecisionType;
  confidence: number;
  file_path?: string;
  symbol_id?: string;
  tags: string[];
  timestamp: string;
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
// PRIVACY FILTERING
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
 *   emitted by Claude Code on background `Agent` completion
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
 * Mining these as user prompts pollutes the decision graph. Returning `true`
 * tells the caller to skip the turn entirely.
 */
export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  return stripPrivacyTags(text).trim().length === 0;
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

/**
 * Sentence-aware, language-filtered, bracket-balanced title sanitizer.
 * Returns `null` to signal that the candidate must be dropped — caller
 * skips the decision entirely rather than persist a worse title.
 */
function truncateTitle(s: string): string | null {
  return sanitizeTitle(s);
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
