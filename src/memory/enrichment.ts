/**
 * Decision Enrichment — injects relevant decisions into code intelligence results.
 *
 * This is the "code-aware memory" differentiator: when you ask "what breaks if I
 * change X?", you also see WHY X was written that way. No other tool does this.
 *
 * Used at the tool registration layer to enrich responses from get_change_impact,
 * plan_turn, get_session_resume, etc.
 */

import type { DecisionRow, DecisionStore } from './decision-store.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface CompactDecision {
  id: number;
  title: string;
  type: string;
  when: string;
  symbol?: string;
  file?: string;
}

// ════════════════════════════════════════════════════════════════════════
// COMPACT
// ════════════════════════════════════════════════════════════════════════

function compact(d: DecisionRow): CompactDecision {
  const entry: CompactDecision = { id: d.id, title: d.title, type: d.type, when: d.valid_from };
  if (d.symbol_id) entry.symbol = d.symbol_id;
  if (d.file_path) entry.file = d.file_path;
  return entry;
}

// ════════════════════════════════════════════════════════════════════════
// ENRICHERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Find decisions relevant to a change impact analysis.
 * Looks up by: target symbol, target file, affected files.
 */
export function decisionsForImpact(
  decisionStore: DecisionStore,
  projectRoot: string,
  target: { symbolId?: string; filePath?: string },
  affectedFiles?: string[],
  limit = 10,
): CompactDecision[] {
  const seen = new Set<number>();
  const results: CompactDecision[] = [];

  // 1. Decisions linked to the target symbol
  if (target.symbolId) {
    for (const d of decisionStore.getDecisionsForSymbol(target.symbolId)) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        results.push(compact(d));
      }
    }
  }

  // 2. Decisions linked to the target file
  if (target.filePath) {
    for (const d of decisionStore.getDecisionsForFile(target.filePath)) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        results.push(compact(d));
      }
    }
  }

  // 3. Decisions linked to affected files (top-5 most impactful)
  if (affectedFiles) {
    for (const file of affectedFiles.slice(0, 5)) {
      for (const d of decisionStore.getDecisionsForFile(file)) {
        if (!seen.has(d.id)) {
          seen.add(d.id);
          results.push(compact(d));
        }
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}

/**
 * Find decisions relevant to a task (for plan_turn).
 * Uses FTS5 search on the task description + decisions linked to target files.
 */
export function decisionsForTask(
  decisionStore: DecisionStore,
  projectRoot: string,
  taskDescription: string,
  targetFiles?: string[],
  limit = 5,
): CompactDecision[] {
  const seen = new Set<number>();
  const results: CompactDecision[] = [];

  // 1. FTS search on task description (top keywords)
  const keywords = extractKeywords(taskDescription);
  if (keywords) {
    try {
      const ftsResults = decisionStore.queryDecisions({
        project_root: projectRoot,
        search: keywords,
        limit: limit,
      });
      for (const d of ftsResults) {
        if (!seen.has(d.id)) {
          seen.add(d.id);
          results.push(compact(d));
        }
      }
    } catch {
      // FTS match syntax errors are non-fatal
    }
  }

  // 2. Decisions linked to target files
  if (targetFiles) {
    for (const file of targetFiles.slice(0, 3)) {
      for (const d of decisionStore.getDecisionsForFile(file)) {
        if (!seen.has(d.id)) {
          seen.add(d.id);
          results.push(compact(d));
        }
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}

/**
 * Get top active decisions for a project (for session resume).
 */
export function decisionsForResume(
  decisionStore: DecisionStore,
  projectRoot: string,
  limit = 5,
): CompactDecision[] {
  const decisions = decisionStore.queryDecisions({
    project_root: projectRoot,
    limit,
  });
  return decisions.map(compact);
}

/**
 * Extract FTS5-safe keywords from a natural language description.
 * Returns OR-joined terms for broad matching.
 */
function extractKeywords(text: string): string | null {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'shall',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'and',
    'but',
    'or',
    'not',
    'no',
    'so',
    'if',
    'when',
    'than',
    'that',
    'this',
    'these',
    'those',
    'it',
    'its',
    'i',
    'we',
    'you',
    'he',
    'she',
    'they',
    'them',
    'what',
    'which',
    'who',
    'how',
    'why',
    'where',
    'all',
    'each',
    'every',
    'add',
    'fix',
    'update',
    'change',
    'modify',
    'implement',
    'create',
    'make',
    'get',
    'set',
    'use',
    'new',
    'file',
    'code',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (words.length === 0) return null;

  // Take top-5 most significant words, join with OR for broad matching
  return words.slice(0, 5).join(' OR ');
}
