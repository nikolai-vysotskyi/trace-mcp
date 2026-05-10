/**
 * Additive Hermes-mining path used by `mineSessions`.
 *
 * Why a separate file:
 *   - `mineSessions` stays byte-identical for its legacy claude-code/claw-code
 *     path. The golden-file lockdown test in
 *     `tests/analytics/list-all-sessions.snapshot.test.ts` guarantees we
 *     didn't drift that behavior.
 *   - Hermes conversations are GLOBAL — sessions have no intrinsic
 *     project_path. We require the caller to name a `projectRoot` before we
 *     attribute any extracted decisions, rather than guessing. When no
 *     projectRoot is given, this helper is a no-op and the existing mining
 *     result is returned unchanged.
 */

import { logger } from '../logger.js';
import { getSessionProviderRegistry } from '../session/providers/registry.js';
import type { RawMessage, SessionHandle } from '../session/providers/types.js';
import { getCurrentBranch } from '../utils/git-branch.js';
import {
  type ConversationTurn,
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  classifyConfidence,
  extractDecisions,
} from './conversation-miner.js';
import type { DecisionInput, DecisionStore } from './decision-store.js';

export interface ProviderMineCounters {
  scanned: number;
  skipped: number;
  mined: number;
  extracted: number;
  errors: number;
}

export interface ProviderMineOpts {
  /** Required for provider-based mining — global sessions (Hermes) can't be
   *  attributed to a project without an explicit scope from the caller. */
  projectRoot?: string;
  force?: boolean;
  minConfidence?: number;
  /** Memoir confidence tier: rows ≥ this are auto-approved. */
  reviewThreshold?: number;
  /** Memoir confidence tier: rows below this are dropped entirely. */
  rejectThreshold?: number;
}

/** Provider ids we know how to mine additively. Keep this list narrow — each
 *  entry claims the provider is battle-tested on real data. */
const ADDITIVE_PROVIDER_IDS = new Set(['hermes', 'codex']);

/** Feed RawMessage stream from a SessionProvider into extractDecisions and
 *  persist the output. Mutates `counters` in place. */
export async function mineProviderSessions(
  decisionStore: DecisionStore,
  opts: ProviderMineOpts,
  counters: ProviderMineCounters,
): Promise<void> {
  // Hermes has no project_path. Without a caller-supplied scope, we'd have
  // to invent one or violate the decisions.project_root NOT NULL constraint
  // — both are worse than doing nothing.
  if (!opts.projectRoot) return;

  const registry = getSessionProviderRegistry();
  const providers = registry.all().filter((p) => ADDITIVE_PROVIDER_IDS.has(p.id));
  if (providers.length === 0) return;

  const reviewThreshold = opts.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const rejectThreshold = opts.rejectThreshold ?? opts.minConfidence ?? DEFAULT_REJECT_THRESHOLD;
  // Branch-aware capture: resolve once per call. Provider mining is scoped
  // to a single projectRoot, so a single lookup is enough.
  const capturedBranch = getCurrentBranch(opts.projectRoot);

  for (const provider of providers) {
    let handles: SessionHandle[];
    try {
      handles = await provider.discover({ projectRoot: opts.projectRoot });
    } catch (e) {
      logger.warn({ err: e, provider: provider.id }, 'provider discover failed');
      counters.errors++;
      continue;
    }

    for (const handle of handles) {
      counters.scanned++;
      const sessionKey = `${provider.id}:${handle.sessionId}`;

      if (!opts.force && decisionStore.isSessionMined(sessionKey)) {
        counters.skipped++;
        continue;
      }

      try {
        const turns: ConversationTurn[] = [];
        for await (const msg of provider.streamMessages(handle)) {
          turns.push(rawMessageToTurn(msg));
        }

        if (turns.length === 0) {
          decisionStore.markSessionMined(sessionKey, 0);
          counters.skipped++;
          continue;
        }

        // Memoir tiering — same auto/pending/drop split used for native sessions.
        const tiered = extractDecisions(turns)
          .map((d) => ({
            d,
            tier: classifyConfidence(d.confidence, reviewThreshold, rejectThreshold),
          }))
          .filter((x) => x.tier !== 'drop');

        if (tiered.length > 0) {
          const inputs: DecisionInput[] = tiered.map(({ d, tier }) => ({
            title: d.title,
            content: d.content,
            type: d.type,
            project_root: opts.projectRoot!,
            symbol_id: d.symbol_id,
            file_path: d.file_path,
            tags: [...(d.tags ?? []), `provider:${provider.id}`],
            valid_from: d.timestamp,
            session_id: sessionKey,
            source: 'mined' as const,
            confidence: d.confidence,
            git_branch: capturedBranch,
            review_status: tier === 'pending' ? 'pending' : null,
          }));

          decisionStore.addDecisions(inputs);
          counters.extracted += tiered.length;
        }

        decisionStore.markSessionMined(sessionKey, tiered.length);
        counters.mined++;
      } catch (e) {
        logger.warn({ err: e, session: sessionKey }, 'Failed to mine provider session');
        counters.errors++;
      }
    }
  }
}

/** Map a provider RawMessage into the ConversationTurn shape expected by
 *  extractDecisions. We keep the text verbatim (including tool-call bodies
 *  serialized inline) because that's what DECISION_PATTERNS regex against.
 *  extractDecisions only inspects `role === 'assistant'` turns, so `tool`/
 *  `system` messages are collapsed to `user` — they become ignored context
 *  without losing their text from nearby-file/symbol extraction windows. */
function rawMessageToTurn(msg: RawMessage): ConversationTurn {
  const parts: string[] = [msg.text];
  if (msg.toolName) {
    parts.push(`[tool:${msg.toolName}]`);
    if (msg.toolInput !== undefined) {
      parts.push(safeStringify(msg.toolInput));
    }
    if (msg.toolResult !== undefined) {
      parts.push(safeStringify(msg.toolResult));
    }
  }
  const role: ConversationTurn['role'] = msg.role === 'assistant' ? 'assistant' : 'user';
  return {
    role,
    text: parts.filter(Boolean).join('\n'),
    timestamp: msg.timestampMs ? new Date(msg.timestampMs).toISOString() : '',
    referenced_files: msg.referencedFiles ?? [],
    referenced_symbols: [],
  };
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}
