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
import { listAllSessions } from '../analytics/log-parser.js';
import { logger } from '../logger.js';
import { mineProviderSessions } from './conversation-miner-providers.js';
import type { DecisionInput, DecisionStore, DecisionType } from './decision-store.js';

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
// DECISION EXTRACTION PATTERNS
// ════════════════════════════════════════════════════════════════════════

interface DecisionPattern {
  /** Regex to match against assistant text */
  pattern: RegExp;
  type: DecisionType;
  /** Confidence multiplier for this pattern */
  confidence: number;
  /** Function to extract title from the match */
  titleExtractor: (match: RegExpMatchArray, context: string) => string;
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

function truncateTitle(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 77)}...`;
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
        // Deduplicate by title similarity
        const titleKey = title.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(titleKey)) continue;
        seen.add(titleKey);

        // Extract surrounding context (±200 chars around match)
        const start = Math.max(0, match.index - 200);
        const end = Math.min(turn.text.length, match.index + match[0].length + 200);
        const content = turn.text.slice(start, end).trim();

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

  // Filter low-confidence and deduplicate
  return decisions.filter((d) => d.confidence >= 0.5);
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
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Mine all Claude Code / Claw Code sessions for decisions.
 * Skips already-mined sessions. Stores results in the decision store.
 */
export async function mineSessions(
  decisionStore: DecisionStore,
  opts: {
    /** Only mine sessions for this project (default: all) */
    projectRoot?: string;
    /** Re-mine already processed sessions */
    force?: boolean;
    /** Minimum confidence threshold (default: 0.6) */
    minConfidence?: number;
  } = {},
): Promise<MineResult> {
  const start = Date.now();
  const sessions = listAllSessions();
  const minConfidence = opts.minConfidence ?? 0.6;

  let scanned = 0;
  let skipped = 0;
  let mined = 0;
  let extracted = 0;
  let errors = 0;

  for (const session of sessions) {
    scanned++;

    // Filter by project if specified
    if (opts.projectRoot && session.projectPath !== opts.projectRoot) {
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

      const decisions = extractDecisions(turns).filter((d) => d.confidence >= minConfidence);

      if (decisions.length > 0) {
        const inputs: DecisionInput[] = decisions.map((d) => ({
          title: d.title,
          content: d.content,
          type: d.type,
          project_root: session.projectPath,
          symbol_id: d.symbol_id,
          file_path: d.file_path,
          tags: d.tags,
          valid_from: d.timestamp,
          session_id: path.basename(session.filePath, '.jsonl'),
          source: 'mined' as const,
          confidence: d.confidence,
        }));

        decisionStore.addDecisions(inputs);
        extracted += decisions.length;
      }

      decisionStore.markSessionMined(session.filePath, decisions.length);
      mined++;
    } catch (e) {
      logger.warn({ error: e, file: session.filePath }, 'Failed to mine session for decisions');
      errors++;
    }
  }

  const _providerCounters = { scanned, skipped, mined, extracted, errors };
  await mineProviderSessions(
    decisionStore,
    { projectRoot: opts.projectRoot, force: opts.force, minConfidence: opts.minConfidence },
    _providerCounters,
  );
  scanned = _providerCounters.scanned;
  skipped = _providerCounters.skipped;
  mined = _providerCounters.mined;
  extracted = _providerCounters.extracted;
  errors = _providerCounters.errors;

  return {
    sessions_scanned: scanned,
    sessions_skipped: skipped,
    sessions_mined: mined,
    decisions_extracted: extracted,
    errors,
    duration_ms: Date.now() - start,
  };
}
