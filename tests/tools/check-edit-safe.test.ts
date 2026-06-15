/**
 * check_edit_safe — edit-safety preflight verdict.
 *
 * Verifies the fused verdict:
 *   - a low-complexity, test-covered symbol with no external consumers → safe_to_edit
 *   - an exported symbol consumed by many files → signature_impact (blockers populated)
 *   - an exported, untested symbol with no consumers → untested
 *   - a high-complexity, untested symbol → complexity_risk
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { checkEditSafe } from '../../src/tools/quality/check-edit-safe.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

const CONSUMER_COUNT = 30;

describe('check_edit_safe', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-edit-safe-');

    // (1) Safe target: exported, simple, covered by a test, no external consumers.
    writeFixtureFile(
      tmpDir,
      'src/safe.ts',
      'export function safe(x: number): number {\n  return x + 1;\n}\n',
    );
    writeFixtureFile(
      tmpDir,
      'src/safe.test.ts',
      "import { safe } from './safe.js';\ndescribe('safe', () => {\n  it('adds one', () => {\n    expect(safe(1)).toBe(2);\n  });\n});\n",
    );

    // (2) High-impact target: exported, consumed by many files (signature contract).
    writeFixtureFile(
      tmpDir,
      'src/hub.ts',
      'export function hub(x: number): number {\n  return x;\n}\n',
    );
    for (let i = 0; i < CONSUMER_COUNT; i++) {
      writeFixtureFile(
        tmpDir,
        `src/consumer${i}.ts`,
        `import { hub } from './hub.js';\nexport function use${i}(): number {\n  return hub(${i});\n}\n`,
      );
    }

    // (3) Untested target: exported, no consumers, no test, low complexity.
    writeFixtureFile(
      tmpDir,
      'src/lonely.ts',
      'export function lonely(x: number): number {\n  return x * 2;\n}\n',
    );

    // (4) Complexity target: high cyclomatic complexity, no tests, no consumers.
    const branches = Array.from({ length: 20 }, (_, i) => `  if (x === ${i}) return ${i};`).join(
      '\n',
    );
    writeFixtureFile(
      tmpDir,
      'src/tangled.ts',
      `export function tangled(x: number): number {\n${branches}\n  return -1;\n}\n`,
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = {
      root: tmpDir,
      include: ['src/**/*.ts'],
      exclude: ['node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);

    // Seed a test_covers edge for src/safe.ts deterministically. The indexer's
    // test_covers resolver depends on the oxc path resolver mapping `./safe.js`
    // → `./safe.ts`, which is unreliable for fixtures written to a bare tmp dir
    // (no tsconfig). We assert check_edit_safe's coverage tier, not the
    // resolver's path heuristics, so we attach the edge directly.
    const safeFile = store.getFile('src/safe.ts');
    const testFile = store.getFile('src/safe.test.ts');
    expect(safeFile).toBeDefined();
    expect(testFile).toBeDefined();
    const safeNode = store.getNodeId('file', safeFile!.id);
    const testNode = store.getNodeId('file', testFile!.id);
    expect(safeNode).toBeDefined();
    expect(testNode).toBeDefined();
    store.insertEdge(testNode!, safeNode!, 'test_covers', true, {
      test_file: 'src/safe.test.ts',
    });
  });

  it('returns safe_to_edit for a simple, covered symbol with no external consumers', () => {
    const res = checkEditSafe(store, { symbolId: 'src/safe.ts::safe#function' });
    expect(res.isOk()).toBe(true);
    const out = res._unsafeUnwrap();

    expect(out.verdict).toBe('safe_to_edit');
    expect(out.blockers).toHaveLength(0);
    expect(out.signals.target_has_tests).toBe(true);
    expect(out.signals.breaking_consumers).toBe(0);
    expect(out.recommended_action).toMatch(/low edit risk/i);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });

  it('returns signature_impact for an exported symbol with many cross-file consumers', () => {
    const res = checkEditSafe(store, { symbolId: 'src/hub.ts::hub#function' });
    expect(res.isOk()).toBe(true);
    const out = res._unsafeUnwrap();

    expect(out.verdict).toBe('signature_impact');
    expect(out.blockers.length).toBeGreaterThan(0);
    // The dominant blocker must be the signature/contract one, ranked first.
    expect(out.blockers[0].signal).toBe('signature_impact');
    expect(out.blockers[0].severity).toBe('high');
    // breaking_consumers counts the enumerated non-test consumer files (capped);
    // dependent_files carries the exact downstream count.
    expect(out.signals.breaking_consumers).toBeGreaterThan(0);
    expect(out.signals.dependent_files).toBeGreaterThanOrEqual(CONSUMER_COUNT);
    expect(out.recommended_action).toMatch(/preserve|contract|signature/i);
  });

  it('returns untested for an exported symbol with no coverage and no consumers', () => {
    const res = checkEditSafe(store, { symbolId: 'src/lonely.ts::lonely#function' });
    expect(res.isOk()).toBe(true);
    const out = res._unsafeUnwrap();

    expect(out.verdict).toBe('untested');
    expect(out.signals.target_has_tests).toBe(false);
    expect(out.signals.breaking_consumers).toBe(0);
    expect(out.blockers.some((b) => b.signal === 'untested')).toBe(true);
    expect(out.recommended_action).toMatch(/test|coverage/i);
  });

  it('returns complexity_risk for a high-complexity, untested symbol', () => {
    const res = checkEditSafe(store, { symbolId: 'src/tangled.ts::tangled#function' });
    expect(res.isOk()).toBe(true);
    const out = res._unsafeUnwrap();

    expect(out.verdict).toBe('complexity_risk');
    expect(out.signals.target_complexity).toBeGreaterThanOrEqual(15);
    expect(out.blockers[0].signal).toBe('complexity_risk');
    // Both complexity and missing-coverage blockers should be reported.
    expect(out.blockers.some((b) => b.signal === 'untested')).toBe(true);
  });

  it('errors when neither file_path nor symbol_id is provided', () => {
    const res = checkEditSafe(store, {});
    expect(res.isErr()).toBe(true);
  });

  it('cleanup', () => {
    removeTmpDir(tmpDir);
    expect(true).toBe(true);
  });
});
