/**
 * Wake-Up Context — assembles a compact context payload (~300 tokens) that
 * gives an AI agent immediate orientation at session start.
 *
 * Layers:
 *   L0: Project identity (name, frameworks, key stats)
 *   L1: Active decisions (top-N most recent, code-linked)
 *   L2: Session context (hot files, dead ends from recent sessions)
 *
 * Inspired by MemPalace's layered memory stack, but code-aware:
 * decisions are linked to symbols/files, not just text.
 */

import * as path from 'node:path';
import type { DecisionRow, DecisionStore } from './decision-store.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface WakeUpContext {
  /** L0: Project identity */
  project: {
    name: string;
    root: string;
  };
  /** L1: Active decisions (most recent, code-linked) */
  decisions: {
    total_active: number;
    recent: Array<{
      id: number;
      title: string;
      type: string;
      /** Linked symbol (if any) */
      symbol?: string;
      /** Linked file (if any) */
      file?: string;
      /** When this decision was made */
      when: string;
    }>;
  };
  /** L2: Session memory stats */
  memory: {
    total_decisions: number;
    sessions_mined: number;
    sessions_indexed: number;
    by_type: Record<string, number>;
  };
  /** Approximate token count */
  estimated_tokens: number;
}

// ════════════════════════════════════════════════════════════════════════
// ASSEMBLY
// ════════════════════════════════════════════════════════════════════════

function compactDecision(d: DecisionRow): WakeUpContext['decisions']['recent'][0] {
  const entry: WakeUpContext['decisions']['recent'][0] = {
    id: d.id,
    title: d.title,
    type: d.type,
    when: d.valid_from,
  };
  if (d.symbol_id) entry.symbol = d.symbol_id;
  if (d.file_path) entry.file = d.file_path;
  return entry;
}

/**
 * Assemble wake-up context for a project.
 * Returns ~300 tokens of critical orientation data.
 */
export function assembleWakeUp(
  decisionStore: DecisionStore,
  projectRoot: string,
  opts: {
    maxDecisions?: number;
  } = {},
): WakeUpContext {
  const maxDecisions = opts.maxDecisions ?? 10;

  // L1: Recent active decisions
  const recentDecisions = decisionStore.queryDecisions({
    project_root: projectRoot,
    limit: maxDecisions,
  });

  const activeCount = decisionStore.getStats(projectRoot).active;

  // L2: Memory stats
  const stats = decisionStore.getStats(projectRoot);
  const minedCount = decisionStore.getMinedSessionCount();
  const indexedSessions = decisionStore.getIndexedSessionIds(projectRoot);

  const result: WakeUpContext = {
    project: {
      name: path.basename(projectRoot),
      root: projectRoot,
    },
    decisions: {
      total_active: activeCount,
      recent: recentDecisions.map(compactDecision),
    },
    memory: {
      total_decisions: stats.total,
      sessions_mined: minedCount,
      sessions_indexed: indexedSessions.length,
      by_type: stats.by_type,
    },
    estimated_tokens: 0,
  };

  // Rough token estimation (1 token ≈ 4 chars of JSON)
  const jsonSize = JSON.stringify(result).length;
  result.estimated_tokens = Math.ceil(jsonSize / 4);

  return result;
}
