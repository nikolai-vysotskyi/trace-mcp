/**
 * Behavioural coverage for `getSuggestedQuestions()` in
 * `src/tools/quality/suggested-questions.ts` (the implementation behind the
 * `get_suggested_questions` MCP tool). Aggregates already-cached analysis
 * signals into a ranked list of review questions. Each question carries an
 * id, severity, follow-up tool, and a human-readable reason.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getSuggestedQuestions } from '../../../src/tools/quality/suggested-questions.js';
import { createTestStore } from '../../test-utils.js';

/**
 * Seed the store with: one framework-tagged class with NO test partner,
 * a test file (so the "untested_symbols" question fires), and enough
 * exported symbols to trigger the "dead_export_audit" branch.
 */
function seedWithSignals(store: Store): void {
  // Framework entry point with no test partner — generates "untested_framework_entry_point".
  const ctrlFile = store.insertFile('src/auth/Controller.ts', 'typescript', 'h-ctrl', 400);
  store.insertSymbol(ctrlFile, {
    symbolId: 'src/auth/Controller.ts::AuthController#class',
    name: 'AuthController',
    kind: 'class',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 20,
    signature: 'class AuthController',
    metadata: {
      frameworkRole: 'controller',
      decorators: ['Controller'],
      exported: 1,
    },
  });

  // A real test file so "untested_symbols" question fires.
  store.insertFile('tests/something.test.ts', 'typescript', 'h-test', 100);

  // 60+ exported symbols → triggers "dead_export_audit" branch (>50 threshold).
  const utilsFile = store.insertFile('src/utils/helpers.ts', 'typescript', 'h-utils', 2000);
  for (let i = 0; i < 60; i++) {
    store.insertSymbol(utilsFile, {
      symbolId: `src/utils/helpers.ts::helper${i}#function`,
      name: `helper${i}`,
      kind: 'function',
      byteStart: i * 30,
      byteEnd: i * 30 + 30,
      lineStart: i + 1,
      lineEnd: i + 2,
      signature: `function helper${i}()`,
      metadata: { exported: 1 },
    });
  }
}

describe('getSuggestedQuestions() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('envelope shape: { questions, total, generated_at }', () => {
    const result = getSuggestedQuestions(store);
    expect(Array.isArray(result.questions)).toBe(true);
    expect(typeof result.total).toBe('number');
    expect(typeof result.generated_at).toBe('string');
  });

  it('generated_at is a valid ISO timestamp', () => {
    const result = getSuggestedQuestions(store);
    // Date.parse returns NaN for invalid input.
    expect(Number.isNaN(Date.parse(result.generated_at))).toBe(false);
    // ISO format always carries a "T".
    expect(result.generated_at).toMatch(/T/);
  });

  it('each question has id/severity/question/reason/follow_up.tool', () => {
    seedWithSignals(store);
    const result = getSuggestedQuestions(store);

    expect(result.questions.length).toBeGreaterThan(0);
    for (const q of result.questions) {
      expect(typeof q.id).toBe('string');
      expect(['high', 'medium', 'low']).toContain(q.severity);
      expect(typeof q.question).toBe('string');
      expect(q.question.length).toBeGreaterThan(0);
      expect(typeof q.reason).toBe('string');
      expect(typeof q.follow_up).toBe('object');
      expect(typeof q.follow_up.tool).toBe('string');
    }
  });

  it('empty index still emits the canned circular/ast-clone questions (never empty list)', () => {
    // No seeding — exercises the "no framework rows, no exports, no tests" path.
    const result = getSuggestedQuestions(store);
    // The canned circular_imports + ast_clone_cluster questions are unconditional.
    const ids = result.questions.map((q) => q.id);
    expect(ids).toContain('circular_imports');
    expect(ids).toContain('ast_clone_cluster');
  });

  it('questions are sorted by severity (high before medium before low)', () => {
    seedWithSignals(store);
    const result = getSuggestedQuestions(store);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < result.questions.length; i++) {
      expect(rank[result.questions[i].severity]).toBeGreaterThanOrEqual(
        rank[result.questions[i - 1].severity],
      );
    }
  });

  it('untested framework entry point triggers a high-severity question linked to get_tests_for', () => {
    seedWithSignals(store);
    const result = getSuggestedQuestions(store);

    const entry = result.questions.find((q) => q.id === 'untested_framework_entry_point');
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe('high');
    expect(entry!.follow_up.tool).toBe('get_tests_for');
  });
});
