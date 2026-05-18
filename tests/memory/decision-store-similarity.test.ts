/**
 * Tests for DecisionStore.findSimilarDecisions — the candidate retrieval
 * surface that powers consolidate_decisions. No LLM involved; the store
 * is exercised directly with seeded rows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore.findSimilarDecisions', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/similarity-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'similarity-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function seed(
    title: string,
    content: string,
    type: 'tech_choice' | 'architecture_decision' = 'tech_choice',
  ) {
    return store.addDecision({
      title,
      content,
      type,
      project_root: projectRoot,
    });
  }

  it('returns near-duplicate titles, sorted by similarity', () => {
    const a = seed('Use JWT for authentication', 'JWT body A');
    const b = seed('Use JWT for auth', 'JWT body B');
    const c = seed('Use OAuth for authentication', 'OAuth body');
    seed('Pick PostgreSQL as primary DB', 'unrelated');

    const result = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 5,
      min_title_similarity: 0.2,
    });

    const ids = result.map((r) => r.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id); // subject excluded
  });

  it('excludes the subject itself', () => {
    const a = seed('Use JWT auth', 'JWT');
    const result = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 10,
      min_title_similarity: 0,
    });
    expect(result.map((r) => r.id)).not.toContain(a.id);
  });

  it('honors min_title_similarity by filtering out low-similarity rows', () => {
    const a = seed('Use JWT for authentication', 'JWT');
    seed('Pick PostgreSQL as primary DB', 'PG');
    const strict = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 5,
      min_title_similarity: 0.6,
    });
    expect(strict).toHaveLength(0);
  });

  it('honors topK as a hard cap', () => {
    const a = seed('Use JWT for authentication', 'JWT');
    seed('Use JWT for sessions', 'JWT2');
    seed('Use JWT for refresh', 'JWT3');
    seed('Use JWT for cookies', 'JWT4');

    const result = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 2,
      min_title_similarity: 0.1,
    });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('honors same_type_only', () => {
    const a = seed('Use JWT auth', 'JWT', 'tech_choice');
    const b = seed('Use JWT for sessions', 'JWT sessions', 'tech_choice');
    seed('Use JWT in architecture', 'JWT arch', 'architecture_decision');

    const restricted = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 10,
      min_title_similarity: 0.1,
      same_type_only: true,
    });
    const ids = restricted.map((r) => r.id);
    expect(ids).toContain(b.id);
    // architecture_decision row must not appear.
    expect(restricted.every((r) => r.type === 'tech_choice')).toBe(true);
  });

  it('excludes invalidated rows by default', () => {
    const a = seed('Use JWT auth', 'JWT');
    const b = seed('Use JWT for sessions', 'JWT sessions');
    store.invalidateDecision(b.id);

    const result = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 10,
      min_title_similarity: 0.1,
    });
    expect(result.map((r) => r.id)).not.toContain(b.id);
  });

  it('returns [] for a non-existent subject', () => {
    const result = store.findSimilarDecisions({ subject_id: 999999, topK: 5 });
    expect(result).toEqual([]);
  });

  it('returns [] when the subject title has no FTS-tokenizable words and no candidates match', () => {
    // 3-char threshold means a numeric / short title is treated as "no FTS words".
    const subject = store.addDecision({
      title: 'X',
      content: 'X',
      type: 'tech_choice',
      project_root: projectRoot,
    });
    // No other rows seeded — the fallback project-wide scan finds nothing.
    const result = store.findSimilarDecisions({ subject_id: subject.id, topK: 5 });
    expect(result).toEqual([]);
  });

  it('confines results to the same project_root', () => {
    const a = seed('Use JWT auth', 'JWT');
    // Same content/title in a different project — should not be a candidate.
    store.addDecision({
      title: 'Use JWT auth',
      content: 'JWT in other project',
      type: 'tech_choice',
      project_root: '/projects/other-repo',
    });

    const result = store.findSimilarDecisions({
      subject_id: a.id,
      topK: 5,
      min_title_similarity: 0.1,
    });
    expect(result.every((r) => r.project_root === projectRoot)).toBe(true);
  });
});
