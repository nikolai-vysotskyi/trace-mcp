/**
 * Tests for get_suggested_questions — the auto-generated review-question
 * surface that aggregates already-cached analysis signals.
 *
 * The contract:
 *   - shape stays stable (id/severity/question/reason/follow_up.tool)
 *   - severity sort puts high first
 *   - canned questions appear even on empty repos (so reviewers always
 *     get a starting checklist)
 *   - framework entry points without test partners surface concrete
 *     per-symbol questions
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getSuggestedQuestions } from '../../src/tools/quality/suggested-questions.js';

function fixture() {
  const db = initializeDatabase(':memory:');
  return { db, store: new Store(db) };
}

describe('getSuggestedQuestions — shape', () => {
  it('returns the documented top-level fields on an empty repo', () => {
    const { store } = fixture();
    const r = getSuggestedQuestions(store);
    expect(r.questions.length).toBeGreaterThan(0);
    expect(typeof r.total).toBe('number');
    expect(r.generated_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('every question has the documented contract fields', () => {
    const { store } = fixture();
    const r = getSuggestedQuestions(store);
    for (const q of r.questions) {
      expect(typeof q.id).toBe('string');
      expect(['high', 'medium', 'low']).toContain(q.severity);
      expect(typeof q.question).toBe('string');
      expect(typeof q.reason).toBe('string');
      expect(typeof q.follow_up.tool).toBe('string');
      expect(q.follow_up.tool.length).toBeGreaterThan(0);
    }
  });

  it('sorts questions with high severity first', () => {
    const { store } = fixture();
    const r = getSuggestedQuestions(store);
    const severityRank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < r.questions.length; i++) {
      const prev = severityRank[r.questions[i - 1].severity];
      const curr = severityRank[r.questions[i].severity];
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it('includes canned circular-import + ast-clone questions', () => {
    const { store } = fixture();
    const r = getSuggestedQuestions(store);
    const ids = r.questions.map((q) => q.id);
    expect(ids).toContain('circular_imports');
    expect(ids).toContain('ast_clone_cluster');
  });
});

describe('getSuggestedQuestions — framework entry points', () => {
  it('flags an untested @Service symbol with a per-symbol question', () => {
    const { store } = fixture();
    const fileId = store.insertFile('src/main/java/OrderService.java', 'java', 'h', 100);
    store.insertSymbol(fileId, {
      symbolId: 'src/main/java/OrderService.java::OrderService#class',
      name: 'OrderService',
      kind: 'class',
      fqn: 'OrderService',
      byteStart: 0,
      byteEnd: 100,
      metadata: { exported: 1, annotations: ['Service'] },
    });

    const r = getSuggestedQuestions(store);
    const perSymbol = r.questions.find((q) => q.id === 'untested_framework_entry_point');
    expect(perSymbol).toBeDefined();
    expect(perSymbol!.question).toContain('OrderService');
    expect(perSymbol!.severity).toBe('high');
    expect(perSymbol!.follow_up.tool).toBe('get_tests_for');
  });

  it('does NOT flag a framework entry point that has a sibling test file', () => {
    const { store } = fixture();
    const srcId = store.insertFile('src/orders.controller.ts', 'typescript', 'h', 100);
    store.insertSymbol(srcId, {
      symbolId: 'src/orders.controller.ts::OrdersController#class',
      name: 'OrdersController',
      kind: 'class',
      fqn: 'OrdersController',
      byteStart: 0,
      byteEnd: 100,
      metadata: { exported: 1, decorators: ['Controller'] },
    });
    // Sibling test file matching the *.test.* glob.
    store.insertFile('src/orders.controller.test.ts', 'typescript', 'h', 50);

    const r = getSuggestedQuestions(store);
    const perSymbol = r.questions.filter(
      (q) => q.id === 'untested_framework_entry_point' && q.question.includes('OrdersController'),
    );
    expect(perSymbol.length).toBe(0);
  });

  it('summarises remaining untested entry points after the first 3', () => {
    const { store } = fixture();
    for (let i = 0; i < 7; i++) {
      const fId = store.insertFile(`src/main/java/Svc${i}.java`, 'java', `h${i}`, 100);
      store.insertSymbol(fId, {
        symbolId: `src/main/java/Svc${i}.java::Svc${i}#class`,
        name: `Svc${i}`,
        kind: 'class',
        fqn: `Svc${i}`,
        byteStart: 0,
        byteEnd: 100,
        metadata: { exported: 1, annotations: ['Service'] },
      });
    }

    const r = getSuggestedQuestions(store);
    const perSymbolCount = r.questions.filter(
      (q) => q.id === 'untested_framework_entry_point',
    ).length;
    expect(perSymbolCount).toBe(3); // truncated
    const summary = r.questions.find((q) => q.id === 'untested_framework_entry_point_summary');
    expect(summary).toBeDefined();
    expect(summary!.question).toContain('4'); // 7 - 3 = 4 additional
  });
});

describe('getSuggestedQuestions — caps', () => {
  it('returns at most 12 questions (QUESTION_LIMIT)', () => {
    const { store } = fixture();
    for (let i = 0; i < 50; i++) {
      const fId = store.insertFile(`src/c${i}.ts`, 'typescript', `h${i}`, 100);
      store.insertSymbol(fId, {
        symbolId: `src/c${i}.ts::C${i}#class`,
        name: `C${i}`,
        kind: 'class',
        fqn: `C${i}`,
        byteStart: 0,
        byteEnd: 100,
        metadata: { exported: 1, decorators: ['Controller'] },
      });
    }
    const r = getSuggestedQuestions(store);
    expect(r.questions.length).toBeLessThanOrEqual(12);
  });
});
