/**
 * Tests for get_tests_for tool.
 * Uses in-memory store to verify heuristic path matching and edge-based resolution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { getTestsFor } from '../../src/tools/framework/tests.js';
import { createTestStore } from '../test-utils.js';

describe('get_tests_for', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns NOT_FOUND when no target specified', () => {
    const result = getTestsFor(store, {});
    expect(result.isErr()).toBe(true);
  });

  it('returns NOT_FOUND for unknown symbol_id', () => {
    const result = getTestsFor(store, { symbolId: 'nonexistent' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns NOT_FOUND for unknown file', () => {
    const result = getTestsFor(store, { filePath: 'src/missing.ts' });
    expect(result.isErr()).toBe(true);
  });

  describe('heuristic path matching', () => {
    it('finds test.ts file matching source file base name', () => {
      const srcFileId = store.insertFile('src/services/UserService.ts', 'typescript', 'h1', 100);
      store.insertSymbol(srcFileId, {
        symbolId: 'src/services/UserService.ts::UserService#class',
        name: 'UserService',
        kind: 'class',
        byteStart: 0,
        byteEnd: 100,
      });

      // Test file with matching name
      store.insertFile('tests/services/UserService.test.ts', 'typescript', 'h2', 50);
      // Unrelated test
      store.insertFile('tests/services/OrderService.test.ts', 'typescript', 'h3', 50);

      const result = getTestsFor(store, { symbolId: 'src/services/UserService.ts::UserService#class' });
      expect(result.isOk()).toBe(true);
      const { tests } = result._unsafeUnwrap();

      expect(tests.length).toBe(1);
      expect(tests[0].test_file).toBe('tests/services/UserService.test.ts');
      expect(tests[0].edge_type).toBe('heuristic_path');
    });

    it('matches kebab-case test files for PascalCase sources', () => {
      const srcFileId = store.insertFile('src/UserService.ts', 'typescript', 'h1', 100);
      store.insertSymbol(srcFileId, {
        symbolId: 'sym:UserService',
        name: 'UserService',
        kind: 'class',
        byteStart: 0,
        byteEnd: 100,
      });

      store.insertFile('tests/user-service.test.ts', 'typescript', 'h2', 50);

      const result = getTestsFor(store, { symbolId: 'sym:UserService' });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().tests).toHaveLength(1);
    });

    it('finds test by file_path option', () => {
      store.insertFile('src/utils.ts', 'typescript', 'h1', 100);
      store.insertFile('tests/utils.test.ts', 'typescript', 'h2', 50);

      const result = getTestsFor(store, { filePath: 'src/utils.ts' });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().tests).toHaveLength(1);
      expect(result._unsafeUnwrap().target.file).toBe('src/utils.ts');
    });

    it('matches spec files and __tests__ directories', () => {
      const fileId = store.insertFile('src/auth.ts', 'typescript', 'h1', 100);
      store.insertSymbol(fileId, {
        symbolId: 'sym:auth',
        name: 'auth',
        kind: 'function',
        byteStart: 0,
        byteEnd: 50,
      });

      store.insertFile('src/__tests__/auth.spec.ts', 'typescript', 'h2', 50);

      const result = getTestsFor(store, { symbolId: 'sym:auth' });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().tests).toHaveLength(1);
    });

    it('returns empty when no matching tests exist', () => {
      const fileId = store.insertFile('src/lonely.ts', 'typescript', 'h1', 100);
      store.insertSymbol(fileId, {
        symbolId: 'sym:lonely',
        name: 'lonely',
        kind: 'function',
        byteStart: 0,
        byteEnd: 50,
      });

      store.insertFile('tests/other.test.ts', 'typescript', 'h2', 50);

      const result = getTestsFor(store, { symbolId: 'sym:lonely' });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().tests).toHaveLength(0);
    });
  });

  describe('PHP test matching', () => {
    it('matches Test.php files', () => {
      store.insertFile('app/Models/User.php', 'php', 'h1', 100);
      store.insertFile('tests/Unit/UserTest.php', 'php', 'h2', 50);

      const result = getTestsFor(store, { filePath: 'app/Models/User.php' });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().tests).toHaveLength(1);
    });
  });

  describe('Python test matching', () => {
    it('matches test_*.py files', () => {
      store.insertFile('myapp/models.py', 'python', 'h1', 100);
      store.insertFile('tests/test_models.py', 'python', 'h2', 50);

      const result = getTestsFor(store, { filePath: 'myapp/models.py' });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().tests).toHaveLength(1);
    });
  });
});
