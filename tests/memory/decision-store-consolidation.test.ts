/**
 * Tests for DecisionStore.applyConsolidationVerdict.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore.applyConsolidationVerdict', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/consolidation-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidation-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function seed(title: string, content: string, tags?: string[]) {
    return store.addDecision({
      title,
      content,
      type: 'tech_choice',
      project_root: projectRoot,
      tags,
    });
  }

  it('keep_separate is a no-op and returns applied:false', () => {
    const a = seed('A', 'a body');
    const result = store.applyConsolidationVerdict({
      subject_id: a.id,
      verdict: { kind: 'keep_separate' },
    });
    expect(result.applied).toBe(false);
    expect(result.affected_ids).toEqual([]);
    expect(store.getDecision(a.id)?.valid_until).toBeNull();
  });

  it('merge_into_existing merges content, unions tags, invalidates subject', () => {
    const existing = seed('Existing', 'existing body', ['t1', 't2']);
    const subject = seed('Subject', 'subject body', ['t2', 't3']);

    const result = store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'merge_into_existing', existing_id: existing.id },
    });

    expect(result.applied).toBe(true);
    expect(result.affected_ids.sort()).toEqual([existing.id, subject.id].sort());

    const updated = store.getDecision(existing.id);
    expect(updated?.content).toContain('existing body');
    expect(updated?.content).toContain('[merged] subject body');
    expect(JSON.parse(updated?.tags ?? '[]')).toEqual(['t1', 't2', 't3']);

    const subjectAfter = store.getDecision(subject.id);
    expect(subjectAfter?.valid_until).not.toBeNull();
  });

  it('merge_into_existing uses merged_content override when provided', () => {
    const existing = seed('Existing', 'existing body');
    const subject = seed('Subject', 'subject body');

    store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'merge_into_existing', existing_id: existing.id },
      merged_content: 'manually-supplied final content',
    });

    expect(store.getDecision(existing.id)?.content).toBe('manually-supplied final content');
  });

  it('replace_existing invalidates the existing, leaves the subject untouched', () => {
    const existing = seed('Existing', 'old');
    const subject = seed('Subject', 'new refinement');

    const result = store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'replace_existing', existing_id: existing.id },
    });

    expect(result.applied).toBe(true);
    expect(result.affected_ids).toEqual([existing.id]);
    expect(store.getDecision(existing.id)?.valid_until).not.toBeNull();
    expect(store.getDecision(subject.id)?.valid_until).toBeNull();
  });

  it('invalidate_existing invalidates only the existing row', () => {
    const existing = seed('Existing', 'old');
    const subject = seed('Subject', 'new');

    const result = store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'invalidate_existing', existing_id: existing.id },
    });

    expect(result.applied).toBe(true);
    expect(result.affected_ids).toEqual([existing.id]);
    expect(store.getDecision(existing.id)?.valid_until).not.toBeNull();
    expect(store.getDecision(subject.id)?.valid_until).toBeNull();
  });

  it('refuses to act when the existing row is already invalidated', () => {
    const existing = seed('Existing', 'old');
    const subject = seed('Subject', 'new');
    store.invalidateDecision(existing.id);

    const result = store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'merge_into_existing', existing_id: existing.id },
    });

    expect(result.applied).toBe(false);
    expect(result.affected_ids).toEqual([]);
    expect(store.getDecision(subject.id)?.valid_until).toBeNull();
  });

  it('refuses to act when the subject row no longer exists', () => {
    const existing = seed('Existing', 'old');
    const result = store.applyConsolidationVerdict({
      subject_id: 99999,
      verdict: { kind: 'merge_into_existing', existing_id: existing.id },
    });
    expect(result.applied).toBe(false);
    expect(store.getDecision(existing.id)?.valid_until).toBeNull();
  });

  it('refuses to act when the existing row does not exist', () => {
    const subject = seed('Subject', 'new');
    const result = store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'merge_into_existing', existing_id: 99999 },
    });
    expect(result.applied).toBe(false);
    expect(store.getDecision(subject.id)?.valid_until).toBeNull();
  });

  it('merge updates the existing row updated_at timestamp', async () => {
    const existing = seed('Existing', 'a');
    const subject = seed('Subject', 'b');
    const before = store.getDecision(existing.id)!.updated_at;
    // Avoid same-ms write collision so updated_at differs deterministically.
    await new Promise((r) => setTimeout(r, 5));

    store.applyConsolidationVerdict({
      subject_id: subject.id,
      verdict: { kind: 'merge_into_existing', existing_id: existing.id },
    });

    const after = store.getDecision(existing.id)!.updated_at;
    expect(after).not.toBeNull();
    if (before !== null && after !== null) {
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });
});
