import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore stale pruning (TRA-595)', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-prune-test-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects and prunes decisions, chunks, clusters, and memos for deleted project roots', () => {
    const liveDir = path.join(tmpDir, 'live-proj');
    const deadDir = path.join(tmpDir, 'dead-proj');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(deadDir, { recursive: true });

    // Seed live data
    store.addDecision({
      title: 'Live decision',
      content: 'Live decision content',
      type: 'architecture',
      project_root: liveDir,
    });
    store.addSessionChunks([
      {
        session_id: 'live-sess',
        project_root: liveDir,
        chunk_index: 0,
        content: 'Live chunk content',
        role: 'user',
        timestamp: Date.now(),
      },
    ]);

    // Seed dead data
    const deadDec = store.addDecision({
      title: 'Dead decision',
      content: 'Dead decision content',
      type: 'tech_choice',
      project_root: deadDir,
    });
    store.addSessionChunks([
      {
        session_id: 'dead-sess',
        project_root: deadDir,
        chunk_index: 0,
        content: 'Dead chunk content',
        role: 'user',
        timestamp: Date.now(),
      },
    ]);
    store.createCluster({
      title: 'Dead cluster',
      summary: 'Dead cluster summary',
      project_root: deadDir,
      decision_ids: [deadDec.id],
    });
    store.saveProjectMemo({
      project_root: deadDir,
      memo_md: 'Dead memo content and learnings',
      decisions_at_generation: 1,
      clusters_at_generation: 1,
      estimated_tokens: 100,
    });
    store.upsertSchedulerState({
      project_root: deadDir,
      last_mine_at: Date.now(),
      last_cluster_at: null,
      last_memo_at: null,
      last_tune_at: null,
      last_tune_event_count: null,
      consecutive_failures: 0,
    });

    // Seed mined sessions
    const deadSessionPath = path.join(deadDir, 'session.jsonl');
    fs.writeFileSync(deadSessionPath, '{"type":"message"}\n');
    store.updateSessionCursor({
      sessionPath: deadSessionPath,
      cursor: 10,
      size: 20,
      modifiedMs: Date.now(),
      decisionsFound: 1,
    });

    // Initial check: all folders exist
    expect(store.findStaleRoots()).toHaveLength(0);
    const initialStale = store.findStale();
    expect(initialStale.decisionsCount).toBe(0);

    // Delete deadDir
    fs.rmSync(deadDir, { recursive: true, force: true });

    // Stale detection
    const stale = store.findStale();
    expect(stale.staleRoots).toEqual([deadDir]);
    expect(stale.decisionsCount).toBe(1);
    expect(stale.chunksCount).toBe(1);
    expect(stale.clustersCount).toBe(1);
    expect(stale.memosCount).toBe(1);
    expect(stale.schedulerStatesCount).toBe(1);
    expect(stale.staleMinedSessionsCount).toBe(1);
    expect(stale.staleDecisions.map((d) => d.title)).toEqual(['Dead decision']);

    // Prune stale entries
    const pruneRes = store.pruneStale({ includeMinedSessions: true });
    expect(pruneRes.staleRoots).toEqual([deadDir]);
    expect(pruneRes.decisions).toBe(1);
    expect(pruneRes.chunks).toBe(1);
    expect(pruneRes.clusters).toBe(1);
    expect(pruneRes.memos).toBe(1);
    expect(pruneRes.schedulerStates).toBe(1);
    expect(pruneRes.minedSessions).toBe(1);

    // Verify dead data is gone and live data is intact
    expect(store.queryDecisions({ project_root: deadDir })).toHaveLength(0);
    const liveDecisions = store.queryDecisions({ project_root: liveDir });
    expect(liveDecisions).toHaveLength(1);
    expect(liveDecisions[0].title).toBe('Live decision');

    // FTS search on dead decision returns nothing
    const searchRes = store.queryDecisions({ project_root: deadDir, search: 'Dead' });
    expect(searchRes).toHaveLength(0);
  });

  it('is a no-op when decision store has no stale project roots', () => {
    const liveDir = path.join(tmpDir, 'live-proj');
    fs.mkdirSync(liveDir, { recursive: true });

    store.addDecision({
      title: 'Live decision',
      content: 'Live decision content',
      type: 'architecture',
      project_root: liveDir,
    });

    const res = store.pruneStale();
    expect(res.staleRoots).toEqual([]);
    expect(res.decisions).toBe(0);
    expect(res.chunks).toBe(0);
    expect(res.clusters).toBe(0);
    expect(res.memos).toBe(0);
    expect(res.schedulerStates).toBe(0);
  });
});
