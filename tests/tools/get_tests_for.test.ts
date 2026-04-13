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

  describe('graph-based test_covers edges', () => {
    it('finds tests via file-level test_covers edge when querying by symbol', () => {
      // Source file + symbol
      const srcFileId = store.insertFile('src/services/OrderService.ts', 'typescript', 'h1', 100);
      store.insertSymbol(srcFileId, {
        symbolId: 'src/services/OrderService.ts::OrderService#class',
        name: 'OrderService',
        kind: 'class',
        byteStart: 0,
        byteEnd: 100,
      });

      // Test file (no name-matching to source — purely graph-based)
      const testFileId = store.insertFile('tests/integration/orders.test.ts', 'typescript', 'h2', 50);

      // Create test_covers edge: test file node → source file node
      const testFileNodeId = store.getNodeId('file', testFileId)!;
      const srcFileNodeId = store.getNodeId('file', srcFileId)!;
      expect(testFileNodeId).toBeDefined();
      expect(srcFileNodeId).toBeDefined();

      store.insertEdge(testFileNodeId, srcFileNodeId, 'test_covers', true, { test_file: 'tests/integration/orders.test.ts' });

      const result = getTestsFor(store, { symbolId: 'src/services/OrderService.ts::OrderService#class' });
      expect(result.isOk()).toBe(true);
      const { tests } = result._unsafeUnwrap();

      expect(tests.length).toBe(1);
      expect(tests[0].test_file).toBe('tests/integration/orders.test.ts');
      expect(tests[0].edge_type).toBe('test_covers');
    });

    it('finds tests via symbol-level test_covers edge', () => {
      // Source file + symbol
      const srcFileId = store.insertFile('src/utils/calc.ts', 'typescript', 'h1', 100);
      const symId = store.insertSymbol(srcFileId, {
        symbolId: 'src/utils/calc.ts::add#function',
        name: 'add',
        kind: 'function',
        byteStart: 0,
        byteEnd: 50,
      });

      // Test file
      const testFileId = store.insertFile('tests/math-helpers.test.ts', 'typescript', 'h2', 50);

      // Create test_covers edge: test file node → symbol node
      const testFileNodeId = store.getNodeId('file', testFileId)!;
      const symNodeId = store.getNodeId('symbol', symId)!;
      expect(testFileNodeId).toBeDefined();
      expect(symNodeId).toBeDefined();

      store.insertEdge(testFileNodeId, symNodeId, 'test_covers', true, { test_file: 'tests/math-helpers.test.ts' });

      const result = getTestsFor(store, { symbolId: 'src/utils/calc.ts::add#function' });
      expect(result.isOk()).toBe(true);
      const { tests } = result._unsafeUnwrap();

      expect(tests.length).toBe(1);
      expect(tests[0].test_file).toBe('tests/math-helpers.test.ts');
      expect(tests[0].edge_type).toBe('test_covers');
    });

    it('deduplicates when both file-level and heuristic match same test', () => {
      // Source file + symbol
      const srcFileId = store.insertFile('src/auth.ts', 'typescript', 'h1', 100);
      store.insertSymbol(srcFileId, {
        symbolId: 'sym:login',
        name: 'login',
        kind: 'function',
        byteStart: 0,
        byteEnd: 50,
      });

      // Test file that ALSO matches heuristic (auth → auth.test.ts)
      const testFileId = store.insertFile('tests/auth.test.ts', 'typescript', 'h2', 50);

      // Create test_covers edge too
      const testFileNodeId = store.getNodeId('file', testFileId)!;
      const srcFileNodeId = store.getNodeId('file', srcFileId)!;
      store.insertEdge(testFileNodeId, srcFileNodeId, 'test_covers', true, { test_file: 'tests/auth.test.ts' });

      const result = getTestsFor(store, { symbolId: 'sym:login' });
      expect(result.isOk()).toBe(true);
      const { tests } = result._unsafeUnwrap();

      // Should appear only once, as test_covers (graph wins over heuristic)
      expect(tests.length).toBe(1);
      expect(tests[0].edge_type).toBe('test_covers');
    });

    it('finds tests via file-level edge when querying by file_path', () => {
      const srcFileId = store.insertFile('src/config.ts', 'typescript', 'h1', 100);
      // Test file with non-matching name
      const testFileId = store.insertFile('tests/e2e/configuration.test.ts', 'typescript', 'h2', 50);

      const testFileNodeId = store.getNodeId('file', testFileId)!;
      const srcFileNodeId = store.getNodeId('file', srcFileId)!;
      store.insertEdge(testFileNodeId, srcFileNodeId, 'test_covers', true, { test_file: 'tests/e2e/configuration.test.ts' });

      const result = getTestsFor(store, { filePath: 'src/config.ts' });
      expect(result.isOk()).toBe(true);
      const { tests } = result._unsafeUnwrap();

      expect(tests.length).toBe(1);
      expect(tests[0].test_file).toBe('tests/e2e/configuration.test.ts');
      expect(tests[0].edge_type).toBe('test_covers');
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
