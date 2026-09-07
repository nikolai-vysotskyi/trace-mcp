/**
 * TRA-1100 — the cheap structural gate promised in the TRA-1090 postmortem
 * (docs/perf/pr-context-loss-classes.md). The behavioural suite for
 * `get_context_bundle` proved a single symbol's body reaches the caller;
 * this asserts it at fixture scale, on the field a consumer actually has to
 * check (`detail`), so a regression that degrades *some* symbols under a
 * generous budget — not just "everything" — still fails CI. It is
 * deliberately independent of `bench-pr-quality.ts`, which needs model calls
 * this gate does not: no index database found does not block it.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/db/store.js';
import { getContextBundle } from '../../src/tools/navigation/context-bundle.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

/** Deterministic fixture, budget generous enough that nothing should be truncated. */
const TOKEN_BUDGET = 20_000;
/** Every symbol below is expected to arrive with a body, not just a pointer. */
const MIN_BODY_COVERAGE = 1.0;

function src(name: string, body: string): string {
  return `export function ${name}() {\n  ${body}\n}\n`;
}

function seed(): { store: Store; rootPath: string; primaryId: string } {
  const rootPath = createTmpFixture({
    'src/primary.ts':
      `import { dep0 } from "./dep0";\nimport { dep1 } from "./dep1";\nimport { dep2 } from "./dep2";\n` +
      `${src('primary', 'return dep0() + dep1() + dep2();')}`,
    'src/dep0.ts': src('dep0', 'return 0;'),
    'src/dep1.ts': src('dep1', 'return 1;'),
    'src/dep2.ts': src('dep2', 'return 2;'),
    'src/callerA.ts': `import { primary } from "./primary";\n${src('callerA', 'primary();')}`,
    'src/callerB.ts': `import { primary } from "./primary";\n${src('callerB', 'primary();')}`,
  });

  const store = createTestStore();
  const insert = (rel: string, name: string, source: string) => {
    const file = store.insertFile(rel, 'typescript', `h-${name}`, source.length);
    const internalId = store.insertSymbol(file, {
      symbolId: `${rel}::${name}#function`,
      name,
      kind: 'function',
      fqn: name,
      byteStart: 0,
      byteEnd: source.length,
      lineStart: 1,
      lineEnd: source.split('\n').length,
      signature: `function ${name}()`,
    });
    return store.getNodeId('symbol', internalId)!;
  };

  const primaryNid = insert(
    'src/primary.ts',
    'primary',
    `import { dep0 } from "./dep0";\nimport { dep1 } from "./dep1";\nimport { dep2 } from "./dep2";\n${src('primary', 'return dep0() + dep1() + dep2();')}`,
  );
  const dep0Nid = insert('src/dep0.ts', 'dep0', src('dep0', 'return 0;'));
  const dep1Nid = insert('src/dep1.ts', 'dep1', src('dep1', 'return 1;'));
  const dep2Nid = insert('src/dep2.ts', 'dep2', src('dep2', 'return 2;'));
  const callerANid = insert(
    'src/callerA.ts',
    'callerA',
    `import { primary } from "./primary";\n${src('callerA', 'primary();')}`,
  );
  const callerBNid = insert(
    'src/callerB.ts',
    'callerB',
    `import { primary } from "./primary";\n${src('callerB', 'primary();')}`,
  );

  store.insertEdge(primaryNid, dep0Nid, 'esm_imports', true, undefined, false, 'ast_resolved');
  store.insertEdge(primaryNid, dep1Nid, 'esm_imports', true, undefined, false, 'ast_resolved');
  store.insertEdge(primaryNid, dep2Nid, 'esm_imports', true, undefined, false, 'ast_resolved');
  store.insertEdge(callerANid, primaryNid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(callerBNid, primaryNid, 'calls', true, undefined, false, 'ast_resolved');

  return { store, rootPath, primaryId: 'src/primary.ts::primary#function' };
}

describe('get_context_bundle — body coverage gate (TRA-1100)', () => {
  it('every symbol in a generously-budgeted bundle carries a body, not just a pointer', () => {
    const { store, rootPath, primaryId } = seed();
    try {
      const result = getContextBundle(store, rootPath, {
        symbolIds: [primaryId],
        includeCallers: true,
        tokenBudget: TOKEN_BUDGET,
        outputFormat: 'markdown',
      });
      expect(result.isOk()).toBe(true);
      const bundle = result._unsafeUnwrap();

      const items = [...bundle.primary, ...bundle.dependencies, ...bundle.callers];
      expect(items.length).toBeGreaterThan(0); // the fixture itself must not silently shrink

      const withBody = items.filter((i) => i.detail === 'full');
      const coverage = withBody.length / items.length;

      const offenders = items
        .filter((i) => i.detail !== 'full')
        .map((i) => `${i.symbol_id} (${i.detail})`);

      expect(
        coverage,
        `Body coverage ${(coverage * 100).toFixed(1)}% fell below the ${MIN_BODY_COVERAGE * 100}% ` +
          `gate under a ${TOKEN_BUDGET}-token budget that comfortably fits every symbol here. ` +
          `This is the class of regression TRA-1090 shipped silently for three months: symbols ` +
          `still get listed, but their bodies never reach the caller. Offenders:\n` +
          offenders.join('\n'),
      ).toBeGreaterThanOrEqual(MIN_BODY_COVERAGE);

      // The bundle content must actually contain the source text the metadata claims.
      expect(bundle.content ?? '').toContain('return dep0() + dep1() + dep2();');
    } finally {
      removeTmpDir(rootPath);
    }
  });
});
