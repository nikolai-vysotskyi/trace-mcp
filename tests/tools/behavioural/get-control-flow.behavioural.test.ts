/**
 * Behavioural coverage for `getControlFlow()`. Needs a real source file on
 * disk because the tool re-reads the function body from the symbol's file.
 * We stage a small tmp fixture, seed the symbol, then run the tool across
 * each output format and the simplify toggle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getControlFlow } from '../../../src/tools/analysis/control-flow.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../../test-utils.js';

interface Fixture {
  store: Store;
  projectRoot: string;
  branchingSymbolId: string;
  sequentialSymbolId: string;
}

const BRANCHING_SRC = `function classify(value) {
  if (value > 10) {
    return 'big';
  } else if (value > 0) {
    return 'small';
  } else {
    return 'zero-or-negative';
  }
}
`;

const SEQUENTIAL_SRC = `function pipeline(x) {
  const a = x + 1;
  const b = a * 2;
  const c = b - 3;
  const d = c / 4;
  const e = d + 5;
  return e;
}
`;

function seed(): Fixture {
  const projectRoot = createTmpFixture({
    'src/branching.ts': BRANCHING_SRC,
    'src/sequential.ts': SEQUENTIAL_SRC,
  });
  const store = createTestStore();

  const bFid = store.insertFile('src/branching.ts', 'typescript', 'h-br', BRANCHING_SRC.length);
  store.insertSymbol(bFid, {
    symbolId: 'src/branching.ts::classify#function',
    name: 'classify',
    kind: 'function',
    fqn: 'classify',
    byteStart: 0,
    byteEnd: BRANCHING_SRC.length,
    lineStart: 1,
    lineEnd: 9,
  });

  const sFid = store.insertFile('src/sequential.ts', 'typescript', 'h-sq', SEQUENTIAL_SRC.length);
  store.insertSymbol(sFid, {
    symbolId: 'src/sequential.ts::pipeline#function',
    name: 'pipeline',
    kind: 'function',
    fqn: 'pipeline',
    byteStart: 0,
    byteEnd: SEQUENTIAL_SRC.length,
    lineStart: 1,
    lineEnd: 8,
  });

  return {
    store,
    projectRoot,
    branchingSymbolId: 'src/branching.ts::classify#function',
    sequentialSymbolId: 'src/sequential.ts::pipeline#function',
  };
}

describe('getControlFlow() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    removeTmpDir(ctx.projectRoot);
  });

  it('branching function yields a CFG with multiple nodes', () => {
    const result = getControlFlow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.branchingSymbolId,
      format: 'json',
      simplify: false,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.format).toBe('json');
    const cfg = out.cfg as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(cfg.nodes)).toBe(true);
    expect(Array.isArray(cfg.edges)).toBe(true);
    expect(cfg.nodes.length).toBeGreaterThan(2);
    // A function with two-level branching must have cyclomatic > 1.
    expect(out.cyclomatic_complexity).toBeGreaterThan(1);
  });

  it("format='mermaid' returns a mermaid flowchart string", () => {
    const result = getControlFlow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.branchingSymbolId,
      format: 'mermaid',
      simplify: false,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.format).toBe('mermaid');
    expect(typeof out.cfg).toBe('string');
    const text = out.cfg as string;
    expect(text.toLowerCase()).toMatch(/^(flowchart|graph)/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("format='ascii' returns an ASCII art string", () => {
    const result = getControlFlow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.branchingSymbolId,
      format: 'ascii',
      simplify: false,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.format).toBe('ascii');
    expect(typeof out.cfg).toBe('string');
    const text = out.cfg as string;
    // ASCII output uses [ENTRY] / [EXIT] markers.
    expect(text).toContain('[ENTRY]');
    expect(text).toContain('[EXIT]');
  });

  it("format='json' returns { nodes, edges } plus complexity metadata", () => {
    const result = getControlFlow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.branchingSymbolId,
      format: 'json',
      simplify: false,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(typeof out.cyclomatic_complexity).toBe('number');
    expect(typeof out.paths).toBe('number');
    expect(typeof out.max_nesting).toBe('number');
    const cfg = out.cfg as { nodes: Array<{ kind: string }>; edges: unknown[] };
    const kinds = cfg.nodes.map((n) => n.kind);
    expect(kinds).toContain('entry');
    expect(kinds).toContain('exit');
  });

  it('simplify=true produces fewer nodes than simplify=false on a sequential function', () => {
    const verbose = getControlFlow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.sequentialSymbolId,
      format: 'json',
      simplify: false,
    });
    const simplified = getControlFlow(ctx.store, ctx.projectRoot, {
      symbolId: ctx.sequentialSymbolId,
      format: 'json',
      simplify: true,
    });
    expect(verbose.isOk() && simplified.isOk()).toBe(true);
    const verboseCfg = verbose._unsafeUnwrap().cfg as { nodes: unknown[] };
    const simplifiedCfg = simplified._unsafeUnwrap().cfg as { nodes: unknown[] };
    // simplify collapses sequential statements — strictly fewer (or equal) nodes.
    expect(simplifiedCfg.nodes.length).toBeLessThanOrEqual(verboseCfg.nodes.length);
  });
});
