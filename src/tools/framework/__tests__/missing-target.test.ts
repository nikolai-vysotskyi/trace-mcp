/**
 * Missing-target errors must not be echoable (TRA-1633).
 *
 * Field evidence: agents called find_usages with no parameters, received
 * `"'provide symbol_id, fqn, or file_path' is not in the index"`, and then
 * passed that quoted string back verbatim as the next call's argument —
 * looping on NOT_FOUND and burning a full round-trip per iteration.
 *
 * Guard: a call with no target at all is a caller bug, so it must return
 * VALIDATION_ERROR (never NOT_FOUND), and the rendered message must not
 * contain a single quoted value-like string an agent could echo.
 */
import { describe, expect, it } from 'vitest';
import { formatToolError } from '../../../errors.js';
import { createTestStore } from '../../../../tests/test-utils.js';
import { findReferences } from '../references.js';
import { getTestsFor } from '../tests.js';

function renderedMessage(payload: { error: unknown }): string {
  const err = payload.error as { code: string; message: string };
  return `${err.code}: ${err.message}`;
}

describe('missing target is VALIDATION_ERROR, not echoable NOT_FOUND', () => {
  it('find_usages with no target returns VALIDATION_ERROR', () => {
    const store = createTestStore();
    const result = findReferences(store, {});
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('get_tests_for with no target returns VALIDATION_ERROR', () => {
    const store = createTestStore();
    const result = getTestsFor(store, {});
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rendered messages contain no quotable pseudo-value', () => {
    const store = createTestStore();
    for (const result of [findReferences(store, {}), getTestsFor(store, {})]) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        const text = renderedMessage(formatToolError(result.error) as { error: unknown });
        expect(text).not.toContain('NOT_FOUND');
        expect(text).not.toContain('is not in the index');
        // No single-quoted span that reads as one passable value.
        expect(text).not.toMatch(/'[^']*(symbol_id|fqn|file_path)[^']*'/);
      }
    }
  });
});
