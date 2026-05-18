/**
 * Project Memo Generator — LLM-synthesised L3 orientation digest.
 *
 * A project memo is a 250-400 word Markdown document that captures the
 * project's architectural personality: dominant tech choices, conventions,
 * in-flight refactors, named subsystems. It complements:
 *
 *   L1 — raw decisions       (DecisionStore)
 *   L2 — thematic clusters   (decision-clusterer.ts)
 *   L3 — synthesised memo    (THIS MODULE)
 *
 * Unlike a flat list of decisions, the memo is a NARRATIVE — what a senior
 * engineer would say in a 30-second "what is this project about" pitch.
 *
 * Privacy
 * ───────
 * The LLM input is a sanitised projection of decisions / clusters:
 *   - cluster.title + cluster.summary
 *   - decision.title + decision.content (first 120 chars)
 * Full decision bodies are never sent.
 *
 * Robustness
 * ──────────
 * - Hard length cap: target tokens × 2 (chars/4 heuristic). Truncates at a
 *   sentence boundary rather than mid-sentence.
 * - Generic boilerplate detector: rejects memos that share zero specific
 *   terms with the input clusters/decisions — caller decides what to do.
 * - Never throws on a bad LLM response — returns { memo_md: '' } on failure.
 */

import { logger } from '../logger.js';
import type { InferenceService } from '../ai/interfaces.js';
import type { ClusterRow, DecisionRow } from './decision-store.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface MemoInput {
  /** Pre-filtered/scoped decisions — caller picks active rows + ordering. */
  decisions: DecisionRow[];
  /** Top clusters for the same scope (largest by decision_count). */
  clusters: ClusterRow[];
  /** Human-readable project name (e.g. `path.basename(projectRoot)`). */
  project_name: string;
  /** Optional subproject name when the memo scopes to a service. */
  service_name?: string;
}

export interface GenerateMemoOpts {
  provider: InferenceService;
  /** Model identifier — recorded on the memo row for provenance. */
  model: string;
  /** Soft target length. Hard cap at 2× this value via sentence-boundary truncation. */
  targetTokens?: number;
  /** Forwarded to the inference call so the recall budget can abort us. */
  abortSignal?: AbortSignal;
}

// ════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_TARGET_TOKENS = 350;

/** chars/4 ≈ tokens heuristic, matches the rest of the memory subsystem. */
const CHARS_PER_TOKEN = 4;

/** Cap per content preview line in the prompt — keeps the input prompt bounded. */
const DECISION_CONTENT_PREVIEW_CHARS = 120;

/** Hard caps on per-section input size sent to the LLM. */
const PROMPT_LIMITS = {
  clusters: 8,
  architecture: 8,
  tech_choices: 8,
  conventions: 5,
  discoveries: 5,
} as const;

const SYSTEM_PROMPT_TEMPLATE = `You are writing a 250-400 word project orientation memo for a new engineer joining this codebase. Write in plain markdown with these sections in order: Architecture, Tech stack, Conventions, In progress.

Rules:
- Each section is 2-4 short sentences. Be specific, not generic.
- Reference actual decisions and topics from the input below. Do NOT invent facts.
- Skip obvious filler ("this project uses Git", "we write tests"). Surface the non-obvious.
- Use present tense, declarative voice. No marketing.
- Output ONLY the markdown memo. No preamble, no commentary.`;

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Generate a project memo from the input scope via the configured LLM.
 *
 * Returns `{ memo_md: '', estimated_tokens: 0 }` — never throws — on:
 *   - inference call failing
 *   - LLM returning empty / whitespace-only output
 *   - output failing the boilerplate guard (no specific terms from input)
 *
 * On success the returned `memo_md` is normalised (trimmed, capped at 2×
 * target tokens via sentence-boundary truncation) and `estimated_tokens`
 * carries the chars/4 estimate.
 */
export async function generateProjectMemo(
  input: MemoInput,
  opts: GenerateMemoOpts,
): Promise<{ memo_md: string; estimated_tokens: number }> {
  const targetTokens = Math.max(100, Math.min(opts.targetTokens ?? DEFAULT_TARGET_TOKENS, 2000));
  const hardCapChars = targetTokens * 2 * CHARS_PER_TOKEN;

  const prompt = buildPrompt(input);
  // Token budget for the response — overshoot so we have headroom for the
  // sentence-boundary truncate to land cleanly. The actual cap is enforced
  // post-generation via `truncateAtSentence`.
  const maxTokens = Math.ceil(targetTokens * 1.6);

  let response: string;
  try {
    response = await opts.provider.generate(prompt, {
      maxTokens,
      temperature: 0.2,
      signal: opts.abortSignal,
    });
  } catch (err) {
    logger.warn(
      { project: input.project_name, err: (err as Error)?.message ?? String(err) },
      'project-memo: provider.generate failed — returning empty memo',
    );
    return { memo_md: '', estimated_tokens: 0 };
  }

  const cleaned = stripCodeFences(response).trim();
  if (!cleaned) {
    logger.debug?.({ project: input.project_name }, 'project-memo: empty response');
    return { memo_md: '', estimated_tokens: 0 };
  }

  // Guard against generic boilerplate — if the model invented a memo that
  // shares NO specific terms with the input topics/decisions, drop it.
  if (!hasSpecificTerms(cleaned, input)) {
    logger.warn(
      { project: input.project_name },
      'project-memo: rejected — output lacks any project-specific terms',
    );
    return { memo_md: '', estimated_tokens: 0 };
  }

  const truncated = truncateAtSentence(cleaned, hardCapChars);
  const estimated_tokens = Math.ceil(truncated.length / CHARS_PER_TOKEN);
  return { memo_md: truncated, estimated_tokens };
}

// ════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ════════════════════════════════════════════════════════════════════════

/**
 * Assemble the LLM prompt from the input scope. Public for tests so the
 * structured shape can be asserted without invoking the LLM.
 */
export function buildPrompt(input: MemoInput): string {
  const lines: string[] = [SYSTEM_PROMPT_TEMPLATE, ''];
  lines.push(`Project: ${input.project_name}`);
  if (input.service_name) lines.push(`Service: ${input.service_name}`);
  lines.push('');

  // Topics — the clusters provide topical scaffolding.
  lines.push('Topics:');
  if (input.clusters.length === 0) {
    lines.push('- (no clusters yet)');
  } else {
    for (const c of input.clusters.slice(0, PROMPT_LIMITS.clusters)) {
      lines.push(`- ${c.title}: ${trimOneLine(c.summary, 200)}`);
    }
  }
  lines.push('');

  const arch = input.decisions.filter((d) => d.type === 'architecture_decision');
  const tech = input.decisions.filter((d) => d.type === 'tech_choice');
  const conv = input.decisions.filter((d) => d.type === 'convention');
  // For "In progress": discoveries/tradeoffs/bug roots by recency.
  const recentDiscoveries = input.decisions
    .filter((d) => d.type === 'discovery' || d.type === 'tradeoff' || d.type === 'bug_root_cause')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  lines.push('Architecture decisions:');
  if (arch.length === 0) {
    lines.push('- (none captured)');
  } else {
    for (const d of arch.slice(0, PROMPT_LIMITS.architecture)) {
      lines.push(`- ${d.title}: ${trimOneLine(d.content, DECISION_CONTENT_PREVIEW_CHARS)}`);
    }
  }
  lines.push('');

  lines.push('Tech choices:');
  if (tech.length === 0) {
    lines.push('- (none captured)');
  } else {
    for (const d of tech.slice(0, PROMPT_LIMITS.tech_choices)) {
      lines.push(`- ${d.title}: ${trimOneLine(d.content, DECISION_CONTENT_PREVIEW_CHARS)}`);
    }
  }
  lines.push('');

  lines.push('Conventions:');
  if (conv.length === 0) {
    lines.push('- (none captured)');
  } else {
    for (const d of conv.slice(0, PROMPT_LIMITS.conventions)) {
      lines.push(`- ${d.title}: ${trimOneLine(d.content, DECISION_CONTENT_PREVIEW_CHARS)}`);
    }
  }
  lines.push('');

  lines.push('Recent discoveries & tradeoffs:');
  if (recentDiscoveries.length === 0) {
    lines.push('- (none captured)');
  } else {
    for (const d of recentDiscoveries.slice(0, PROMPT_LIMITS.discoveries)) {
      lines.push(`- ${d.title}`);
    }
  }
  lines.push('');
  lines.push('Memo:');

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function trimOneLine(s: string, max: number): string {
  const firstLine = (s ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/**
 * Strip wrapping markdown code fences ("```markdown\n...\n```"). Some models
 * wrap the memo in a fence when asked for markdown output — flatten it so
 * the memo renders cleanly when embedded into prose.
 */
export function stripCodeFences(s: string): string {
  if (!s) return '';
  const fenced = /^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```$/.exec(s.trim());
  return fenced ? fenced[1].trim() : s;
}

/**
 * Truncate `s` to at most `maxChars`, breaking on the last sentence
 * boundary (period, question mark, exclamation mark, or markdown heading)
 * inside the window. Falls back to hard slice when no boundary exists.
 */
export function truncateAtSentence(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const window = s.slice(0, maxChars);
  // Prefer the last sentence-terminating punctuation followed by whitespace
  // or end-of-string. Markdown headings also count as boundaries.
  const sentenceEnd = window.search(/[.!?](?=\s|$)(?!\S)/g);
  // Use the LAST match — `String.search` only gives the first; find the last
  // index by scanning.
  let lastBoundary = -1;
  const re = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) lastBoundary = m.index;
  if (lastBoundary !== -1 && lastBoundary >= Math.floor(maxChars * 0.5)) {
    return window.slice(0, lastBoundary + 1).trim();
  }
  // Fallback: last newline before the cap.
  const lastNewline = window.lastIndexOf('\n');
  if (lastNewline !== -1 && lastNewline >= Math.floor(maxChars * 0.5)) {
    return window.slice(0, lastNewline).trim();
  }
  // Last resort: hard slice, but trim a trailing partial word.
  const hard = window.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(' ');
  return (lastSpace > 0 ? hard.slice(0, lastSpace) : hard).trim();
  // Note: sentenceEnd kept above for the linter to see the original heuristic.
  void sentenceEnd;
}

/**
 * Boilerplate guard: a real memo should mention at least one topical term
 * from the input — cluster title words, decision titles, or tags. We split
 * each topical source into "specific" tokens (length >=4, alphabetic, NOT
 * in a stoplist of generic words) and check the memo against that set.
 *
 * Returns true when the memo shares at least one specific term, false when
 * it's pure generic prose ("this project uses TypeScript and unit tests…").
 */
export function hasSpecificTerms(memo: string, input: MemoInput): boolean {
  const memoTokens = tokenize(memo);
  if (memoTokens.size === 0) return false;
  const specific = collectSpecificTerms(input);
  if (specific.size === 0) {
    // No input terms means we can't enforce specificity. Don't reject —
    // a memo for a brand-new project legitimately has nothing to anchor on.
    return true;
  }
  for (const t of specific) {
    if (memoTokens.has(t)) return true;
  }
  return false;
}

function collectSpecificTerms(input: MemoInput): Set<string> {
  const out = new Set<string>();
  for (const c of input.clusters) {
    for (const t of tokenize(c.title)) out.add(t);
    if (c.tags) {
      try {
        const tags = JSON.parse(c.tags);
        if (Array.isArray(tags)) {
          for (const tag of tags) {
            if (typeof tag === 'string') for (const t of tokenize(tag)) out.add(t);
          }
        }
      } catch {
        /* malformed tag JSON — ignore */
      }
    }
  }
  for (const d of input.decisions) {
    for (const t of tokenize(d.title)) out.add(t);
  }
  return out;
}

/**
 * Cheap tokenizer: split on non-word, lowercase, drop tokens shorter than
 * 4 chars and a small stoplist of generic words. Match against a memo
 * tokenised the same way — so "Auth" in cluster matches "authentication"
 * by prefix? No — we keep it exact for now to avoid false positives.
 */
const STOPLIST = new Set<string>([
  'this',
  'that',
  'with',
  'from',
  'into',
  'over',
  'when',
  'where',
  'they',
  'them',
  'their',
  'have',
  'will',
  'been',
  'were',
  'each',
  'some',
  'most',
  'such',
  'than',
  'then',
  'also',
  'about',
  'project',
  'projects',
  'system',
  'systems',
  'general',
  'generic',
  'using',
  'used',
  'good',
  'best',
  'work',
  'works',
  'tests',
  'test',
  'code',
  'codebase',
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  if (!s) return out;
  const lower = s.toLowerCase();
  const re = /[a-z][a-z0-9_-]{3,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const tok = m[0];
    if (STOPLIST.has(tok)) continue;
    out.add(tok);
  }
  return out;
}
