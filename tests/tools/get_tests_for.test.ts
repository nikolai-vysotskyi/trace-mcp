/**
 * Tests for get_tests_for tool.
 * Uses in-memory store to verify heuristic path matching and edge-based resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getTestsFor } from '../../src/tools/framework/tests.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

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

      const result = getTestsFor(store, {
        symbolId: 'src/services/UserService.ts::UserService#class',
      });
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
      const testFileId = store.insertFile(
        'tests/integration/orders.test.ts',
        'typescript',
        'h2',
        50,
      );

      // Create test_covers edge: test file node → source file node
      const testFileNodeId = store.getNodeId('file', testFileId)!;
      const srcFileNodeId = store.getNodeId('file', srcFileId)!;
      expect(testFileNodeId).toBeDefined();
      expect(srcFileNodeId).toBeDefined();

      store.insertEdge(testFileNodeId, srcFileNodeId, 'test_covers', true, {
        test_file: 'tests/integration/orders.test.ts',
      });

      const result = getTestsFor(store, {
        symbolId: 'src/services/OrderService.ts::OrderService#class',
      });
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

      store.insertEdge(testFileNodeId, symNodeId, 'test_covers', true, {
        test_file: 'tests/math-helpers.test.ts',
      });

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
      store.insertEdge(testFileNodeId, srcFileNodeId, 'test_covers', true, {
        test_file: 'tests/auth.test.ts',
      });

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
      const testFileId = store.insertFile(
        'tests/e2e/configuration.test.ts',
        'typescript',
        'h2',
        50,
      );

      const testFileNodeId = store.getNodeId('file', testFileId)!;
      const srcFileNodeId = store.getNodeId('file', srcFileId)!;
      store.insertEdge(testFileNodeId, srcFileNodeId, 'test_covers', true, {
        test_file: 'tests/e2e/configuration.test.ts',
      });

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

  describe('symbol-level narrowing', () => {
    let projectRoot: string;

    afterEach(() => {
      if (projectRoot) removeTmpDir(projectRoot);
    });

    function seedSymbolWithReachers(
      targetName: string,
      reacherFiles: string[],
      callerFiles: string[],
    ): { targetSymbolId: string; targetFileId: number } {
      const srcFileId = store.insertFile('src/db/store.ts', 'typescript', 'h1', 200);
      const targetSymbolId = `src/db/store.ts::Store#${targetName}`;
      const targetSymId = store.insertSymbol(srcFileId, {
        symbolId: targetSymbolId,
        name: targetName,
        kind: 'method',
        byteStart: 0,
        byteEnd: 100,
      });
      const targetNodeId = store.getNodeId('symbol', targetSymId)!;
      const srcFileNodeId = store.getNodeId('file', srcFileId)!;

      // Each `reacherFile` imports the source file (file-level edge) but does
      // NOT call the symbol. This is the "common store method" scenario.
      for (const rf of reacherFiles) {
        const fid = store.insertFile(rf, 'typescript', `h-${rf}`, 50);
        const fnid = store.getNodeId('file', fid)!;
        store.insertEdge(fnid, srcFileNodeId, 'imports', true, {});
      }

      // Each `callerFile` imports AND has a symbol that directly calls the target.
      for (const cf of callerFiles) {
        const fid = store.insertFile(cf, 'typescript', `h-${cf}`, 50);
        const fnid = store.getNodeId('file', fid)!;
        store.insertEdge(fnid, srcFileNodeId, 'imports', true, {});

        const callerSymId = store.insertSymbol(fid, {
          symbolId: `${cf}::caller#function`,
          name: 'callerFn',
          kind: 'function',
          byteStart: 0,
          byteEnd: 40,
        });
        const callerNodeId = store.getNodeId('symbol', callerSymId)!;
        store.insertEdge(callerNodeId, targetNodeId, 'calls', true, {}, false, 'ast_resolved');
      }

      return { targetSymbolId, targetFileId: srcFileId };
    }

    it('narrows file-level reachers to only those that mention the symbol', () => {
      // 5 importers, only 1 actually calls. Disk-content scan distinguishes them.
      const reachers = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts'];
      const callers = ['tests/store-method.test.ts'];
      const { targetSymbolId } = seedSymbolWithReachers('getSymbolById', reachers, callers);

      // Fixture on disk: only the caller test body mentions getSymbolById.
      const fixture: Record<string, string> = {
        'tests/store-method.test.ts': [
          "import { Store } from '../src/db/store';",
          "describe('Store', () => {",
          "  it('returns the symbol', () => {",
          '    store.getSymbolById(1);',
          '  });',
          '});',
        ].join('\n'),
      };
      for (const r of reachers) {
        fixture[r] = "import { Store } from '../src/db/store';\n// unrelated test\n";
      }
      projectRoot = createTmpFixture(fixture);

      const result = getTestsFor(store, {
        symbolId: targetSymbolId,
        projectRoot,
      });
      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.symbol_filtered).toBe(true);
      expect(value.fell_back_to_file_level).toBeUndefined();
      expect(value.tests).toHaveLength(1);
      expect(value.tests[0].test_file).toBe('tests/store-method.test.ts');
      expect(value.tests[0].confidence).toBe('direct_invocation');
    });

    it('returns empty (filtered) for a symbol with zero test signal', () => {
      const { targetSymbolId } = seedSymbolWithReachers('rarelyUsedMethod', [], []);
      projectRoot = createTmpFixture({
        // Single non-test file just to keep tmpdir non-empty
        'src/db/store.ts': 'export class Store { rarelyUsedMethod() {} }\n',
      });

      const result = getTestsFor(store, { symbolId: targetSymbolId, projectRoot });
      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.tests).toHaveLength(0);
    });

    it('falls back to file-level when no symbol-level hit is found', () => {
      // Reacher imports the source file but body never mentions the symbol —
      // and there is no direct graph edge. Default threshold should yield 0,
      // triggering the file-level fallback.
      const { targetSymbolId } = seedSymbolWithReachers(
        'getSymbolById',
        ['tests/incidental.test.ts'],
        [],
      );
      projectRoot = createTmpFixture({
        'tests/incidental.test.ts':
          "import { Store } from '../src/db/store';\n// no mention of the method\n",
      });

      const result = getTestsFor(store, { symbolId: targetSymbolId, projectRoot });
      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.fell_back_to_file_level).toBe(true);
      // file-level fallback returns the importer (matched via heuristic_path?
      // no — but test_covers? no — only importer in file-level mode is the
      // graph `test_covers` edge OR heuristic. Heuristic on 'store.ts' will
      // not match 'incidental.test.ts', so file-level result is also 0.
      expect(value.tests).toHaveLength(0);
    });

    it('file_path-only call skips symbol narrowing (pure file-level mode)', () => {
      const srcFileId = store.insertFile('src/utils.ts', 'typescript', 'h1', 100);
      store.insertFile('tests/utils.test.ts', 'typescript', 'h2', 50);

      const result = getTestsFor(store, { filePath: 'src/utils.ts' });
      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.symbol_filtered).toBeUndefined();
      expect(value.tests).toHaveLength(1);
      expect(value.tests[0].confidence).toBeUndefined();
      expect(value.tests[0].edge_type).toBe('heuristic_path');
      // Sanity: srcFileId is used (silence unused warnings via assertion)
      expect(srcFileId).toBeGreaterThan(0);
    });

    it('min_confidence=text_match includes incidental mentions', () => {
      const { targetSymbolId } = seedSymbolWithReachers('getSymbolById', [], []);

      // Add a heuristic-named test that mentions the symbol only as a
      // string literal — no import, no call.
      store.insertFile('tests/store.test.ts', 'typescript', 'h-text', 50);
      projectRoot = createTmpFixture({
        'tests/store.test.ts': [
          "describe('docs', () => {",
          "  it('mentions getSymbolById in a string', () => {",
          "    expect('getSymbolById').toBeTruthy();",
          '  });',
          '});',
        ].join('\n'),
      });

      const strict = getTestsFor(store, { symbolId: targetSymbolId, projectRoot });
      expect(strict.isOk()).toBe(true);
      // text_match is below the default import_and_call threshold -> fallback
      expect(strict._unsafeUnwrap().fell_back_to_file_level).toBe(true);

      const lenient = getTestsFor(store, {
        symbolId: targetSymbolId,
        projectRoot,
        minConfidence: 'text_match',
      });
      expect(lenient.isOk()).toBe(true);
      const value = lenient._unsafeUnwrap();
      expect(value.symbol_filtered).toBe(true);
      expect(value.fell_back_to_file_level).toBeUndefined();
      expect(value.tests).toHaveLength(1);
      expect(value.tests[0].confidence).toBe('text_match');
      expect(value.tests[0].test_file).toBe('tests/store.test.ts');
    });
  });
});
