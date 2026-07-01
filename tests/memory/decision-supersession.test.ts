import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('auto-supersession (Task 11)', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/supersede';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('invalidates the prior active decision on the same symbol_id + type when supersede is set', () => {
    const old = store.addDecision({
      title: 'Use bcrypt for hashing',
      content: 'bcrypt cost 12',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/auth.ts::hash#function',
    });
    const fresh = store.addDecision(
      {
        title: 'Use argon2 for hashing',
        content: 'switched to argon2id',
        type: 'tech_choice',
        project_root: projectRoot,
        symbol_id: 'src/auth.ts::hash#function',
      },
      { supersede: true },
    );

    const oldRow = store.getDecision(old.id);
    const freshRow = store.getDecision(fresh.id);
    expect(oldRow?.valid_until).not.toBeNull(); // invalidated
    expect(freshRow?.valid_until).toBeNull(); // still active

    const active = store.queryDecisions({ project_root: projectRoot });
    expect(active.map((d) => d.id)).toEqual([fresh.id]);
  });

  it('supersedes by file_path + type when neither row carries a symbol_id', () => {
    const old = store.addDecision({
      title: 'Config in YAML',
      content: 'use config.yaml',
      type: 'convention',
      project_root: projectRoot,
      file_path: 'src/config.ts',
    });
    const fresh = store.addDecision(
      {
        title: 'Config in TOML',
        content: 'moved to config.toml',
        type: 'convention',
        project_root: projectRoot,
        file_path: 'src/config.ts',
      },
      { supersede: true },
    );

    expect(store.getDecision(old.id)?.valid_until).not.toBeNull();
    expect(store.getDecision(fresh.id)?.valid_until).toBeNull();
  });

  it('does NOT supersede when types differ (conservative)', () => {
    const a = store.addDecision({
      title: 'X',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/a.ts::f#function',
    });
    const b = store.addDecision(
      {
        title: 'Y',
        content: 'c',
        type: 'architecture_decision',
        project_root: projectRoot,
        symbol_id: 'src/a.ts::f#function',
      },
      { supersede: true },
    );
    expect(store.getDecision(a.id)?.valid_until).toBeNull(); // untouched
    expect(store.getDecision(b.id)?.valid_until).toBeNull();
  });

  it('does NOT supersede a decision on a different symbol', () => {
    const a = store.addDecision({
      title: 'X',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/a.ts::f#function',
    });
    store.addDecision(
      {
        title: 'Y',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        symbol_id: 'src/a.ts::g#function',
      },
      { supersede: true },
    );
    expect(store.getDecision(a.id)?.valid_until).toBeNull(); // untouched
  });

  it('does NOT supersede a row with a bare anchor when the new row has a symbol_id (no shared state key)', () => {
    // Old row has only a file_path; new row has a symbol_id. The state key for
    // a symbol-anchored row is the symbol, so it must not collide with a
    // file-only row even when the file matches.
    const old = store.addDecision({
      title: 'file-level note',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      file_path: 'src/a.ts',
    });
    store.addDecision(
      {
        title: 'symbol-level note',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        symbol_id: 'src/a.ts::f#function',
        file_path: 'src/a.ts',
      },
      { supersede: true },
    );
    expect(store.getDecision(old.id)?.valid_until).toBeNull(); // untouched
  });

  it('is a no-op without the supersede flag (back-compat)', () => {
    const old = store.addDecision({
      title: 'A',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/a.ts::f#function',
    });
    store.addDecision({
      title: 'B',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/a.ts::f#function',
    });
    expect(store.getDecision(old.id)?.valid_until).toBeNull(); // both active
    expect(store.queryDecisions({ project_root: projectRoot })).toHaveLength(2);
  });

  it('does NOT supersede across different projects', () => {
    const a = store.addDecision({
      title: 'X',
      content: 'c',
      type: 'tech_choice',
      project_root: '/projects/other',
      symbol_id: 'src/a.ts::f#function',
    });
    store.addDecision(
      {
        title: 'Y',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
        symbol_id: 'src/a.ts::f#function',
      },
      { supersede: true },
    );
    expect(store.getDecision(a.id)?.valid_until).toBeNull(); // untouched
  });

  it('reports superseded ids via addDecisionWithSupersession', () => {
    const old = store.addDecision({
      title: 'old',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/a.ts::f#function',
    });
    const { decision, superseded } = store.addDecisionWithSupersession({
      title: 'new',
      content: 'c',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/a.ts::f#function',
    });
    expect(superseded).toEqual([old.id]);
    expect(store.getDecision(decision.id)?.valid_until).toBeNull();
  });

  // ── Adversarial false-positive guards ──────────────────────────────────
  //
  // Wrongly invalidating a decision is a data-loss bug (the row is dropped
  // from the active surface, and only recoverable by inspecting
  // valid_until/history). These two scenarios are the highest-risk shape of
  // Task 11: an `architecture_decision` must never supersede a
  // `bug_root_cause` recorded on the SAME symbol, and near-identical title
  // TEXT across two DIFFERENT symbols must never trigger supersession —
  // `findSupersedable` keys purely on (project_root, type, anchor), so title
  // similarity plays no role at all, by design.

  it('does NOT let an architecture_decision supersede a bug_root_cause on the same symbol', () => {
    const rootCause = store.addDecision({
      title: 'Root cause: race condition in cache invalidation',
      content: 'Two writers raced on the same key without a lock.',
      type: 'bug_root_cause',
      project_root: projectRoot,
      symbol_id: 'src/cache.ts::invalidate#function',
    });
    store.addDecision(
      {
        title: 'Adopt write-through caching architecture',
        content: 'Switched the cache layer to write-through.',
        type: 'architecture_decision',
        project_root: projectRoot,
        symbol_id: 'src/cache.ts::invalidate#function',
      },
      { supersede: true },
    );
    // The bug_root_cause must survive untouched — different type, no shared
    // state key, even though it anchors the exact same symbol.
    expect(store.getDecision(rootCause.id)?.valid_until).toBeNull();
    const active = store.queryDecisions({ project_root: projectRoot });
    expect(active.map((d) => d.id)).toContain(rootCause.id);
  });

  it('does NOT supersede across different symbols that share near-identical title text', () => {
    // Adversarial: titles are almost word-for-word identical (a naive
    // title-similarity heuristic would flag these as "the same decision
    // restated"), but the symbol_id differs. The state key is the anchor,
    // never the title — so no supersession should occur.
    const a = store.addDecision({
      title: 'Use bcrypt for password hashing',
      content: 'bcrypt cost 12',
      type: 'tech_choice',
      project_root: projectRoot,
      symbol_id: 'src/auth.ts::hashPassword#function',
    });
    store.addDecision(
      {
        title: 'Use bcrypt for password hashing',
        content: 'bcrypt cost 12, applied to the admin login path too',
        type: 'tech_choice',
        project_root: projectRoot,
        symbol_id: 'src/admin-auth.ts::hashAdminPassword#function',
      },
      { supersede: true },
    );
    expect(store.getDecision(a.id)?.valid_until).toBeNull(); // untouched
    const active = store.queryDecisions({ project_root: projectRoot });
    expect(active).toHaveLength(2); // both stayed active
  });
});
