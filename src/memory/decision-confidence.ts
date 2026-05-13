/**
 * Confidence scoring for live agent-written decisions.
 *
 * Used by the `remember_decision` MCP tool to map a DecisionInput-shaped
 * payload to a `confidence` in [0,1]. The score routes the row through the
 * existing memoir review queue:
 *   confidence >= review_threshold  -> auto-approved (visible by default)
 *   reject_threshold <= confidence  -> pending (review queue)
 *   confidence <  reject_threshold  -> dropped (not persisted)
 *
 * Heuristic is intentionally conservative: BASE=0.40 plus modest signal
 * weights means a decision with no code reference sits at 0.40 and gets
 * dropped under the default reject_threshold (0.45). Adding a symbol_id
 * or file_path is the cheapest way to push above the floor.
 */
import type { DecisionInput } from './decision-store.js';

const BASE = 0.4;
const W_CODE_REF = 0.2; // symbol_id or file_path present
const W_LENGTH = 0.15; // content length >= 200 chars
const W_TAGS = 0.1; // tags array non-empty
const W_TYPE = 0.1; // high-signal type (architecture_decision | bug_root_cause)
const W_SERVICE = 0.05; // service_name populated

const HIGH_SIGNAL_TYPES = new Set<string>(['architecture_decision', 'bug_root_cause']);

export function computeConfidence(
  input: Pick<
    DecisionInput,
    'title' | 'content' | 'type' | 'symbol_id' | 'file_path' | 'tags' | 'service_name'
  >,
): number {
  let c = BASE;
  if (input.symbol_id || input.file_path) c += W_CODE_REF;
  if ((input.content?.length ?? 0) >= 200) c += W_LENGTH;
  if ((input.tags?.length ?? 0) > 0) c += W_TAGS;
  if (HIGH_SIGNAL_TYPES.has(input.type)) c += W_TYPE;
  if (input.service_name) c += W_SERVICE;
  return Math.max(0, Math.min(1, c));
}
