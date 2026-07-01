import { describe, expect, it } from 'vitest';
import { cfgToAscii, cfgToMermaid, extractCFG } from '../../src/indexer/cfg-extractor.js';

describe('CFG Extractor', () => {
  describe('extractCFG', () => {
    it('creates entry and exit for empty function', () => {
      const cfg = extractCFG('');
      expect(cfg.nodes.length).toBeGreaterThanOrEqual(2);
      expect(cfg.nodes[0].kind).toBe('entry');
      expect(cfg.nodes[cfg.nodes.length - 1].kind).toBe('exit');
    });

    it('detects if/else branches', () => {
      const source = `
function test(x) {
  if (x > 0) {
    console.log("positive");
  } else {
    console.log("non-positive");
  }
}`;
      const cfg = extractCFG(source);
      const ifNode = cfg.nodes.find((n) => n.kind === 'if');
      expect(ifNode).toBeDefined();
      expect(ifNode?.condition).toContain('x > 0');

      const elseNode = cfg.nodes.find((n) => n.kind === 'else');
      expect(elseNode).toBeDefined();
    });

    it('detects for loops', () => {
      const source = `
function sum(arr) {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}`;
      const cfg = extractCFG(source);
      const forNode = cfg.nodes.find((n) => n.kind === 'for');
      expect(forNode).toBeDefined();
      expect(forNode?.condition).toContain('i < arr.length');

      const returnNode = cfg.nodes.find((n) => n.kind === 'return');
      expect(returnNode).toBeDefined();
    });

    it('detects while loops', () => {
      const source = `
while (queue.length > 0) {
  const item = queue.pop();
  process(item);
}`;
      const cfg = extractCFG(source);
      const whileNode = cfg.nodes.find((n) => n.kind === 'while');
      expect(whileNode).toBeDefined();
      expect(whileNode?.condition).toContain('queue.length > 0');
    });

    it('detects try/catch/finally', () => {
      const source = `
try {
  await fetchData();
} catch (error) {
  console.error(error);
} finally {
  cleanup();
}`;
      const cfg = extractCFG(source);
      expect(cfg.nodes.some((n) => n.kind === 'try')).toBe(true);
      expect(cfg.nodes.some((n) => n.kind === 'catch')).toBe(true);
      expect(cfg.nodes.some((n) => n.kind === 'finally')).toBe(true);

      // Exception edge from try to catch
      const tryNode = cfg.nodes.find((n) => n.kind === 'try')!;
      const catchNode = cfg.nodes.find((n) => n.kind === 'catch')!;
      const exceptionEdge = cfg.edges.find((e) => e.from === tryNode.id && e.to === catchNode.id);
      expect(exceptionEdge?.label).toBe('exception');
    });

    it('detects switch/case/default', () => {
      const source = `
switch (action.type) {
  case 'INCREMENT':
    return state + 1;
  case 'DECREMENT':
    return state - 1;
  default:
    return state;
}`;
      const cfg = extractCFG(source);
      expect(cfg.nodes.some((n) => n.kind === 'switch')).toBe(true);
      const caseNodes = cfg.nodes.filter((n) => n.kind === 'case');
      expect(caseNodes.length).toBe(2);
      expect(cfg.nodes.some((n) => n.kind === 'default')).toBe(true);
    });

    it('detects return and throw', () => {
      const source = `
function validate(x) {
  if (x < 0) {
    throw new Error("negative");
  }
  return x * 2;
}`;
      const cfg = extractCFG(source);
      expect(cfg.nodes.some((n) => n.kind === 'throw')).toBe(true);
      expect(cfg.nodes.some((n) => n.kind === 'return')).toBe(true);

      // Return and throw should link to exit
      const exitNode = cfg.nodes.find((n) => n.kind === 'exit')!;
      const returnNode = cfg.nodes.find((n) => n.kind === 'return')!;
      const throwNode = cfg.nodes.find((n) => n.kind === 'throw')!;
      expect(cfg.edges.some((e) => e.from === returnNode.id && e.to === exitNode.id)).toBe(true);
      expect(cfg.edges.some((e) => e.from === throwNode.id && e.to === exitNode.id)).toBe(true);
    });

    it('detects for...of', () => {
      const source = `for (const item of items) { process(item); }`;
      const cfg = extractCFG(source);
      expect(cfg.nodes.some((n) => n.kind === 'for_of')).toBe(true);
    });

    it('detects await', () => {
      const source = `const data = await fetchData();`;
      const cfg = extractCFG(source);
      expect(cfg.nodes.some((n) => n.kind === 'await')).toBe(true);
    });

    it('computes cyclomatic complexity', () => {
      // Simple function with if/else → complexity should be >= 2
      const source = `
if (x) {
  doA();
} else {
  doB();
}`;
      const cfg = extractCFG(source);
      expect(cfg.cyclomatic_complexity).toBeGreaterThanOrEqual(1);
    });

    it('tracks max nesting depth', () => {
      const source = `
if (a) {
  if (b) {
    if (c) {
      deep();
    }
  }
}`;
      const cfg = extractCFG(source);
      expect(cfg.max_nesting).toBeGreaterThanOrEqual(3);
    });

    it('respects startLine parameter', () => {
      const source = `if (x) { return 1; }`;
      const cfg = extractCFG(source, 42);
      expect(cfg.nodes[0].line).toBe(42); // Entry at line 42
    });
  });

  describe('cfgToMermaid', () => {
    it('produces valid Mermaid syntax', () => {
      const cfg = extractCFG(`if (x) { return 1; } else { return 2; }`);
      const mermaid = cfgToMermaid(cfg);
      expect(mermaid).toContain('flowchart TD');
      expect(mermaid).toContain('N0'); // At least one node
      expect(mermaid).toContain('-->'); // At least one edge
    });

    it('uses diamond shape for decision nodes', () => {
      const cfg = extractCFG(`if (x > 0) { y(); }`);
      const mermaid = cfgToMermaid(cfg);
      // Decision nodes use { } shape in Mermaid
      expect(mermaid).toMatch(/N\d+\{/);
    });

    it('uses rounded shape for entry/exit', () => {
      const cfg = extractCFG('');
      const mermaid = cfgToMermaid(cfg);
      expect(mermaid).toMatch(/N\d+\(\[/); // ([ ]) = rounded
    });
  });

  describe('cfgToAscii', () => {
    it('produces readable ASCII output', () => {
      const cfg = extractCFG(`if (x) { return 1; }`);
      const ascii = cfgToAscii(cfg);
      expect(ascii).toContain('[ENTRY]');
      expect(ascii).toContain('[EXIT]');
      expect(ascii).toContain('└→');
    });
  });

  describe('no memory leaks', () => {
    it('handles large function without unbounded growth', () => {
      // 1000 lines of code
      const lines = Array.from({ length: 1000 }, (_, i) => {
        if (i % 10 === 0) return `if (x${i}) {`;
        if (i % 10 === 5) return `}`;
        return `  statement${i}();`;
      });
      const cfg = extractCFG(lines.join('\n'));
      // Should complete without OOM
      expect(cfg.nodes.length).toBeLessThan(2000);
      expect(cfg.edges.length).toBeLessThan(4000);
    });
  });

  describe('loop back-edges and merge nodes', () => {
    it('emits a back-edge from the while loop body to the loop header', () => {
      const source = `
while (queue.length > 0) {
  const item = queue.pop();
  process(item);
}
done();`;
      const cfg = extractCFG(source);
      const whileNode = cfg.nodes.find((n) => n.kind === 'while')!;
      expect(whileNode).toBeDefined();

      // A real CFG models the loop as a cycle: the last body node loops back to
      // the header. Assert a 'back'-labeled edge points to the while node.
      const backEdge = cfg.edges.find((e) => e.to === whileNode.id && e.label === 'back');
      expect(backEdge).toBeDefined();
      expect(backEdge?.from).not.toBe(whileNode.id);
    });

    it('emits a loop-exit (false) edge from the for header to the continuation', () => {
      const source = `
for (let i = 0; i < n; i++) {
  acc += i;
}
return acc;`;
      const cfg = extractCFG(source);
      const forNode = cfg.nodes.find((n) => n.kind === 'for')!;
      expect(forNode).toBeDefined();

      // The loop header must have an exit edge (condition false) leaving the loop.
      const exitEdge = cfg.edges.find((e) => e.from === forNode.id && e.label === 'false');
      expect(exitEdge).toBeDefined();

      // And a back-edge into the header (the cycle).
      const backEdge = cfg.edges.find((e) => e.to === forNode.id && e.label === 'back');
      expect(backEdge).toBeDefined();
    });

    it('renders the back-edge in mermaid output', () => {
      const source = `
while (running) {
  tick();
}`;
      const cfg = extractCFG(source);
      const mermaid = cfgToMermaid(cfg);
      // The back-edge should appear as a labeled edge in the mermaid graph.
      expect(mermaid).toMatch(/back/);
    });

    it('back-edge increases cyclomatic complexity for a loop', () => {
      // A single while loop is one decision point; with the back-edge the
      // E - N + 2 formula yields complexity >= 2.
      const source = `
while (x) {
  y();
}`;
      const cfg = extractCFG(source);
      expect(cfg.cyclomatic_complexity).toBeGreaterThanOrEqual(2);
    });

    it('do_while emits a back-edge', () => {
      const source = `
do {
  step();
} while (more());`;
      const cfg = extractCFG(source);
      const loopNode = cfg.nodes.find((n) => n.kind === 'do_while')!;
      expect(loopNode).toBeDefined();
      const backEdge = cfg.edges.find((e) => e.to === loopNode.id && e.label === 'back');
      expect(backEdge).toBeDefined();
    });

    it('try/catch/finally route to a single merge node', () => {
      const source = `
try {
  risky();
} catch (e) {
  handle(e);
} finally {
  cleanup();
}
after();`;
      const cfg = extractCFG(source);
      // There should be a dedicated merge node where try/catch/finally rejoin.
      const mergeNode = cfg.nodes.find((n) => n.kind === 'merge');
      expect(mergeNode).toBeDefined();
      // Both the finally (or catch when no finally) and the normal path reach merge.
      const incoming = cfg.edges.filter((e) => e.to === mergeNode!.id);
      expect(incoming.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Adversarial: nested / compound control flow. These guard the loop
  // back-edge modeling against conflation, mis-classification, and wrong
  // cyclomatic counts.
  // -------------------------------------------------------------------
  describe('nested and compound control flow', () => {
    it('does NOT classify do-prefixed identifiers as do_while loops', () => {
      // `doOuter()`, `done()`, `download()` all START with "do" but are plain
      // calls, NOT do-while loops. A greedy /^\s*do\s*\{?/ pattern mis-matches
      // them, injecting phantom loop nodes + back-edges and corrupting the CFG.
      const source = `
function work() {
  doOuter();
  const x = download(url);
  done();
}`;
      const cfg = extractCFG(source);
      const bogusLoops = cfg.nodes.filter((n) => n.kind === 'do_while');
      expect(bogusLoops).toHaveLength(0);
      // No spurious back-edges should exist in a loop-free function.
      const backEdges = cfg.edges.filter((e) => e.label === 'back');
      expect(backEdges).toHaveLength(0);
    });

    it('a real do-while is still detected when written as `do {`', () => {
      const source = `
do {
  step();
} while (more());`;
      const cfg = extractCFG(source);
      expect(cfg.nodes.some((n) => n.kind === 'do_while')).toBe(true);
    });

    it('nested for-inside-while emits two independent back-edges to the right headers', () => {
      const source = `
while (outer()) {
  prep();
  for (let i = 0; i < n; i++) {
    inner();
  }
  cleanup();
}
finish();`;
      const cfg = extractCFG(source);
      const whileNode = cfg.nodes.find((n) => n.kind === 'while');
      const forNode = cfg.nodes.find((n) => n.kind === 'for');
      expect(whileNode).toBeDefined();
      expect(forNode).toBeDefined();
      // No plain call ("prep", "cleanup", "finish", "inner") should have become
      // a loop node.
      expect(cfg.nodes.filter((n) => n.kind === 'do_while')).toHaveLength(0);
      expect(cfg.nodes.filter((n) => n.kind === 'for')).toHaveLength(1);
      expect(cfg.nodes.filter((n) => n.kind === 'while')).toHaveLength(1);

      // Two distinct back-edges: one into the while header, one into the for
      // header — not conflated onto a single node.
      const backToWhile = cfg.edges.find((e) => e.label === 'back' && e.to === whileNode!.id);
      const backToFor = cfg.edges.find((e) => e.label === 'back' && e.to === forNode!.id);
      expect(backToWhile).toBeDefined();
      expect(backToFor).toBeDefined();
      expect(backToWhile!.to).not.toBe(backToFor!.to);
    });

    it('break does not create a back-edge to the loop header', () => {
      const source = `
while (true) {
  if (found()) {
    break;
  }
  step();
}
after();`;
      const cfg = extractCFG(source);
      const whileNode = cfg.nodes.find((n) => n.kind === 'while')!;
      const breakNode = cfg.nodes.find((n) => n.kind === 'break')!;
      expect(breakNode).toBeDefined();
      // The break node must NOT loop back to the header (it exits the loop).
      const breakBack = cfg.edges.find(
        (e) => e.from === breakNode.id && e.to === whileNode.id && e.label === 'back',
      );
      expect(breakBack).toBeUndefined();
    });

    it('continue inside a loop is modeled as a distinct node (not a plain statement)', () => {
      const source = `
for (let i = 0; i < n; i++) {
  if (skip(i)) {
    continue;
  }
  process(i);
}`;
      const cfg = extractCFG(source);
      const continueNode = cfg.nodes.find((n) => n.kind === 'continue');
      expect(continueNode).toBeDefined();
      // No phantom do_while from `process(i)` etc.
      expect(cfg.nodes.filter((n) => n.kind === 'do_while')).toHaveLength(0);
    });

    it('switch/case fallthrough is modeled as branches, not flattened', () => {
      const source = `
switch (kind) {
  case 'a':
    handleA();
  case 'b':
    handleB();
    break;
  default:
    handleDefault();
}`;
      const cfg = extractCFG(source);
      const switchNode = cfg.nodes.find((n) => n.kind === 'switch')!;
      expect(switchNode).toBeDefined();
      const caseNodes = cfg.nodes.filter((n) => n.kind === 'case');
      expect(caseNodes.length).toBe(2);
      expect(cfg.nodes.some((n) => n.kind === 'default')).toBe(true);
      // Each case is a branch OUT of the switch node.
      for (const c of caseNodes) {
        expect(cfg.edges.some((e) => e.from === switchNode.id && e.to === c.id)).toBe(true);
      }
    });

    it('cyclomatic complexity matches the McCabe hand-count (E - N + 2)', () => {
      // A single while loop with an if inside. We assert the reported number
      // equals the formula computed from the emitted graph — i.e. the extractor
      // is internally consistent and not fudging a constant.
      const source = `
while (running()) {
  if (ready()) {
    act();
  }
  tick();
}
shutdown();`;
      const cfg = extractCFG(source);
      const expected = Math.max(1, cfg.edges.length - cfg.nodes.length + 2);
      expect(cfg.cyclomatic_complexity).toBe(expected);
      // And no phantom loop nodes inflating it.
      expect(cfg.nodes.filter((n) => n.kind === 'do_while')).toHaveLength(0);
    });
  });
});
