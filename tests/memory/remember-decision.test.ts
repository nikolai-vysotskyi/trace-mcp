/**
 * Integration test for the `remember_decision` MCP tool wiring.
 *
 * The tool registration lives in `src/tools/register/memory.ts` and is
 * tightly coupled to `McpServer`. Rather than spin up a full MCP server,
 * this test exercises the same code path by re-using its public helpers
 * (`computeConfidence` + `classifyConfidence`) and verifies the visible
 * contract: a high-confidence input ends up in the active graph with
 * `source = 'auto'`, a mid-confidence input enters the review queue, and
 * a low-confidence input is rejected without a row.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_REVIEW_THRESHOLD,
  classifyConfidence,
} from '../../src/memory/conversation-miner.js';
import { computeConfidence } from '../../src/memory/decision-confidence.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

function persistViaRememberFlow(
  store: DecisionStore,
  projectRoot: string,
  input: {
    title: string;
    content: string;
    type: 'architecture_decision' | 'preference' | 'bug_root_cause' | 'tradeoff';
    symbol_id?: string;
    file_path?: string;
    tags?: string[];
    service_name?: string;
  },
): { id: number | null; review_status: string; confidence: number } {
  const confidence = computeConfidence(input);
  const tier = classifyConfidence(confidence, DEFAULT_REVIEW_THRESHOLD, DEFAULT_REJECT_THRESHOLD);
  if (tier === 'drop') {
    return { id: null, review_status: 'rejected', confidence };
  }
  const reviewStatus: 'pending' | null = tier === 'pending' ? 'pending' : null;
  const row = store.addDecision({
    title: input.title,
    content: input.content,
    type: input.type,
    project_root: projectRoot,
    symbol_id: input.symbol_id,
    file_path: input.file_path,
    tags: input.tags,
    service_name: input.service_name,
    source: 'auto',
    confidence,
    review_status: reviewStatus,
  });
  return { id: row.id, review_status: reviewStatus ?? 'approved', confidence };
}

describe('remember_decision flow', () => {
  let dbPath: string;
  let store: DecisionStore;
  const projectRoot = '/tmp/fake-remember-project';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-remember-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('high-confidence input is auto-approved and source is auto', () => {
    const res = persistViaRememberFlow(store, projectRoot, {
      title: 'Switch to ESM',
      content:
        'After investigating compatibility with our dependencies we decided to migrate ' +
        'all internal modules to native ESM, dropping CJS interop shims that were causing ' +
        'cold-start regressions in the daemon.',
      type: 'architecture_decision',
      symbol_id: 'src/server/server.ts::createServer#function',
      file_path: 'src/server/server.ts',
      tags: ['build', 'esm'],
      service_name: 'daemon',
    });
    expect(res.id).not.toBeNull();
    expect(res.review_status).toBe('approved');
    expect(res.confidence).toBeGreaterThanOrEqual(DEFAULT_REVIEW_THRESHOLD);

    const row = store.getDecision(res.id!);
    expect(row).toBeDefined();
    expect(row!.source).toBe('auto');
    expect(row!.review_status).toBeNull();

    // Visible from default query_decisions (review_status NULL = active).
    const rows = store.queryDecisions({ project_root: projectRoot });
    expect(rows.find((r) => r.id === res.id)).toBeDefined();
  });

  it('mid-confidence input enters the review queue', () => {
    // No tags, no service, short content, low-signal type — but a code ref
    // lifts it into [reject_threshold, review_threshold).
    const res = persistViaRememberFlow(store, projectRoot, {
      title: 'Use snake_case for env vars',
      content: 'a short rationale of around sixty characters or so here..',
      type: 'preference',
      symbol_id: 'src/foo.ts::bar#function',
    });
    expect(res.review_status).toBe('pending');
    expect(res.id).not.toBeNull();
    expect(res.confidence).toBeGreaterThanOrEqual(DEFAULT_REJECT_THRESHOLD);
    expect(res.confidence).toBeLessThan(DEFAULT_REVIEW_THRESHOLD);

    // Default query hides pending rows; include_pending surfaces them.
    const defaultRows = store.queryDecisions({ project_root: projectRoot });
    expect(defaultRows.find((r) => r.id === res.id)).toBeUndefined();
    const pendingRows = store.queryDecisions({
      project_root: projectRoot,
      include_pending: true,
    });
    expect(pendingRows.find((r) => r.id === res.id)).toBeDefined();
  });

  it('low-confidence input is rejected without persisting a row', () => {
    const before = store.getStats().total;
    const res = persistViaRememberFlow(store, projectRoot, {
      title: 'tiny',
      content: 'too short to matter, no signals',
      type: 'preference',
    });
    expect(res.id).toBeNull();
    expect(res.review_status).toBe('rejected');
    expect(res.confidence).toBeLessThan(DEFAULT_REJECT_THRESHOLD);

    const after = store.getStats().total;
    expect(after).toBe(before);
  });

  it('writes from this flow are tagged source=auto (not manual)', () => {
    const res = persistViaRememberFlow(store, projectRoot, {
      title: 'Pin go-cache version',
      content:
        'go-cache had a known leak prior to 2.5.0 — we pin >=2.5.0 across services. ' +
        'Captured during the post-mortem of the May incident. Symbols affected include ' +
        'CacheManager and downstream invalidation hooks.',
      type: 'bug_root_cause',
      file_path: 'src/cache/manager.ts',
      tags: ['cache', 'incident'],
    });
    expect(res.id).not.toBeNull();
    const row = store.getDecision(res.id!);
    expect(row!.source).toBe('auto');
  });
});
