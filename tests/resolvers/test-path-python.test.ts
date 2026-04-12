/**
 * Tests for TEST_PATH_RE matching Python test files.
 * Verifies that the test_covers edge resolver correctly identifies Python test files.
 */
import { describe, it, expect } from 'vitest';

// Re-create the regex from tests.ts to test it in isolation
const TEST_PATH_RE = /\.(test|spec)\.[jt]sx?$|__tests__\/|(?:^|[/\\])test_[^/\\]+\.py$|(?:^|[/\\])[^/\\]+_test\.py$|conftest\.py$/;

describe('TEST_PATH_RE — Python file matching', () => {
  // Python test files that SHOULD match
  it('matches test_*.py files', () => {
    expect(TEST_PATH_RE.test('test_users.py')).toBe(true);
    expect(TEST_PATH_RE.test('tests/test_models.py')).toBe(true);
    expect(TEST_PATH_RE.test('tests/unit/test_services.py')).toBe(true);
    expect(TEST_PATH_RE.test('test_integration.py')).toBe(true);
  });

  it('matches *_test.py files', () => {
    expect(TEST_PATH_RE.test('users_test.py')).toBe(true);
    expect(TEST_PATH_RE.test('tests/models_test.py')).toBe(true);
    expect(TEST_PATH_RE.test('app/services_test.py')).toBe(true);
  });

  it('matches conftest.py', () => {
    expect(TEST_PATH_RE.test('conftest.py')).toBe(true);
    expect(TEST_PATH_RE.test('tests/conftest.py')).toBe(true);
    expect(TEST_PATH_RE.test('tests/unit/conftest.py')).toBe(true);
  });

  // JS/TS test files that should still match
  it('still matches JS/TS test files', () => {
    expect(TEST_PATH_RE.test('users.test.ts')).toBe(true);
    expect(TEST_PATH_RE.test('users.spec.js')).toBe(true);
    expect(TEST_PATH_RE.test('__tests__/users.ts')).toBe(true);
    expect(TEST_PATH_RE.test('src/utils.test.tsx')).toBe(true);
  });

  // Files that should NOT match
  it('does not match regular Python files', () => {
    expect(TEST_PATH_RE.test('models.py')).toBe(false);
    expect(TEST_PATH_RE.test('app/views.py')).toBe(false);
    expect(TEST_PATH_RE.test('utils/helpers.py')).toBe(false);
  });

  it('does not match files with "test" in the middle', () => {
    expect(TEST_PATH_RE.test('testutils.py')).toBe(false);
    expect(TEST_PATH_RE.test('app/testing.py')).toBe(false);
  });
});
