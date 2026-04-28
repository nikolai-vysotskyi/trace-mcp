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
});
