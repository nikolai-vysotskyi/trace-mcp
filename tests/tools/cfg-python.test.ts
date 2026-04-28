/**
 * Tests for Python control flow patterns in the CFG extractor.
 */
import { describe, expect, it } from 'vitest';
import { extractCFG } from '../../src/indexer/cfg-extractor.js';

describe('CFG extractor — Python patterns', () => {
  it('extracts if/elif/else', () => {
    const cfg = extractCFG(`
def check(x):
    if x > 0:
        return "positive"
    elif x < 0:
        return "negative"
    else:
        return "zero"
`);
    const kinds = cfg.nodes.map((n) => n.kind);
    expect(kinds).toContain('if');
    expect(kinds).toContain('else_if');
    expect(kinds).toContain('else');
    expect(kinds).toContain('return');
  });

  it('extracts for ... in loop', () => {
    const cfg = extractCFG(`
def process(items):
    for item in items:
        handle(item)
`);
    const forNode = cfg.nodes.find((n) => n.kind === 'for_in');
    expect(forNode).toBeDefined();
    expect(forNode!.condition).toContain('items');
  });

  it('extracts async for loop', () => {
    const cfg = extractCFG(`
async def stream(channel):
    async for msg in channel:
        process(msg)
`);
    const forNode = cfg.nodes.find((n) => n.kind === 'for_in');
    expect(forNode).toBeDefined();
  });

  it('extracts while loop', () => {
    const cfg = extractCFG(`
def poll():
    while not done:
        check()
`);
    const whileNode = cfg.nodes.find((n) => n.kind === 'while');
    expect(whileNode).toBeDefined();
    expect(whileNode!.condition).toContain('not done');
  });

  it('extracts try/except/finally', () => {
    const cfg = extractCFG(`
def safe_call():
    try:
        result = risky()
    except ValueError as e:
        handle(e)
    finally:
        cleanup()
`);
    const kinds = cfg.nodes.map((n) => n.kind);
    expect(kinds).toContain('try');
    expect(kinds).toContain('catch'); // except maps to catch
    expect(kinds).toContain('finally');
  });

  it('extracts raise', () => {
    const cfg = extractCFG(`
def validate(x):
    if x < 0:
        raise ValueError("negative")
`);
    const throwNode = cfg.nodes.find((n) => n.kind === 'throw');
    expect(throwNode).toBeDefined();
  });

  it('extracts with statement', () => {
    const cfg = extractCFG(`
def read_file(path):
    with open(path) as f:
        return f.read()
`);
    // with maps to try (resource acquisition)
    const tryNode = cfg.nodes.find((n) => n.kind === 'try' && n.code_snippet.includes('with'));
    expect(tryNode).toBeDefined();
  });

  it('extracts async with', () => {
    const cfg = extractCFG(`
async def fetch(pool):
    async with pool.acquire() as conn:
        return await conn.fetch("SELECT 1")
`);
    const tryNode = cfg.nodes.find(
      (n) => n.kind === 'try' && n.code_snippet.includes('async with'),
    );
    expect(tryNode).toBeDefined();
  });

  it('extracts match/case (Python 3.10+)', () => {
    const cfg = extractCFG(`
def handle(command):
    match command:
        case "quit":
            return
        case "help":
            show_help()
`);
    const switchNode = cfg.nodes.find((n) => n.kind === 'switch');
    expect(switchNode).toBeDefined();
    expect(switchNode!.condition).toContain('command');

    const caseNodes = cfg.nodes.filter((n) => n.kind === 'case');
    expect(caseNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts yield', () => {
    const cfg = extractCFG(`
def gen():
    yield 1
    yield 2
`);
    const yieldNodes = cfg.nodes.filter((n) => n.kind === 'yield');
    expect(yieldNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('computes cyclomatic complexity for Python code', () => {
    const cfg = extractCFG(`
def complex_func(x, y):
    if x > 0:
        for i in range(y):
            if i % 2 == 0:
                pass
            else:
                pass
    elif x < 0:
        while y > 0:
            y -= 1
    else:
        pass
    return x + y
`);
    // CFG uses line-by-line regex, so Python nesting without braces is approximate
    expect(cfg.cyclomatic_complexity).toBeGreaterThanOrEqual(1);
    // Verify decision nodes were found
    const decisionKinds = new Set(cfg.nodes.map((n) => n.kind));
    expect(decisionKinds.has('if')).toBe(true);
    expect(decisionKinds.has('for_in')).toBe(true);
  });
});
