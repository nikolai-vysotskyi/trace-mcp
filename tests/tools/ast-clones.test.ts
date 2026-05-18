import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { detectAstClones } from '../../src/tools/analysis/ast-clones.js';
import { createTestStore } from '../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-ast-clones-test-${process.pid}`);

function writeAndIndex(
  store: Store,
  relPath: string,
  content: string,
  language: string,
  symbols: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>,
): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  const fileId = store.insertFile(relPath, language, `hash-${relPath}`, content.length);

  // Compute byte offsets for each symbol based on line ranges
  const lines = content.split('\n');
  const lineByteOffsets: number[] = [0];
  let acc = 0;
  for (const l of lines) {
    acc += l.length + 1; // +1 for \n
    lineByteOffsets.push(acc);
  }

  for (const sym of symbols) {
    const byteStart = lineByteOffsets[sym.lineStart - 1] ?? 0;
    const byteEnd = lineByteOffsets[sym.lineEnd] ?? content.length;
    store.insertSymbol(fileId, {
      symbolId: `${relPath}::${sym.name}#${sym.kind}`,
      name: sym.name,
      kind: sym.kind as any,
      byteStart,
      byteEnd,
      lineStart: sym.lineStart,
      lineEnd: sym.lineEnd,
      signature: `function ${sym.name}()`,
    });
  }
}

describe('AST Type-2 Clone Detection', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  test('detects structurally identical functions with renamed vars', async () => {
    // Two functions doing the same thing with different names and literal values.
    // The Type-2 normalizer strips identifiers and literals, so they should match.
    const contentA = `
function sumUsers(items) {
  let total = 0;
  for (const x of items) {
    if (x.age > 18) {
      total = total + x.score;
    }
  }
  return total;
}
`.trimStart();

    const contentB = `
function aggregateProducts(list) {
  let accumulator = 100;
  for (const entry of list) {
    if (entry.price > 50) {
      accumulator = accumulator + entry.revenue;
    }
  }
  return accumulator;
}
`.trimStart();

    writeAndIndex(store, 'src/a.ts', contentA, 'typescript', [
      { name: 'sumUsers', kind: 'function', lineStart: 1, lineEnd: 10 },
    ]);
    writeAndIndex(store, 'src/b.ts', contentB, 'typescript', [
      { name: 'aggregateProducts', kind: 'function', lineStart: 1, lineEnd: 10 },
    ]);

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 5, min_nodes: 10 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups.length).toBeGreaterThanOrEqual(1);
    const group = data.groups[0];
    expect(group.size).toBe(2);
    const names = group.symbols.map((s) => s.name).sort();
    expect(names).toEqual(['aggregateProducts', 'sumUsers']);
  });

  test('does NOT flag structurally different functions', async () => {
    const contentA = `
function computeA(x) {
  return x + 1;
}
`.trimStart();

    const contentB = `
function computeB(x) {
  for (let i = 0; i < x; i++) {
    console.log(i);
  }
}
`.trimStart();

    writeAndIndex(store, 'src/a.ts', contentA, 'typescript', [
      { name: 'computeA', kind: 'function', lineStart: 1, lineEnd: 3 },
    ]);
    writeAndIndex(store, 'src/b.ts', contentB, 'typescript', [
      { name: 'computeB', kind: 'function', lineStart: 1, lineEnd: 5 },
    ]);

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 3, min_nodes: 5 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups.length).toBe(0);
  });

  test('skips trivial functions below min_nodes threshold', async () => {
    const content = `
function get1() { return 1; }
function get2() { return 1; }
`.trimStart();

    writeAndIndex(store, 'src/trivial.ts', content, 'typescript', [
      { name: 'get1', kind: 'function', lineStart: 1, lineEnd: 1 },
      { name: 'get2', kind: 'function', lineStart: 2, lineEnd: 2 },
    ]);

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 1, min_nodes: 100 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().groups.length).toBe(0);
  });

  test('detects 3+ identical clones in one group', async () => {
    const body = (name: string, a: string, b: string) =>
      `
function ${name}(input) {
  const ${a} = input.split(',');
  const ${b} = [];
  for (const item of ${a}) {
    if (item.length > 0) {
      ${b}.push(item.trim());
    }
  }
  return ${b};
}
`.trimStart();

    writeAndIndex(store, 'src/x.ts', body('splitTokens', 'parts', 'result'), 'typescript', [
      { name: 'splitTokens', kind: 'function', lineStart: 1, lineEnd: 10 },
    ]);
    writeAndIndex(store, 'src/y.ts', body('parseFields', 'chunks', 'output'), 'typescript', [
      { name: 'parseFields', kind: 'function', lineStart: 1, lineEnd: 10 },
    ]);
    writeAndIndex(store, 'src/z.ts', body('tokenize', 'segments', 'cleaned'), 'typescript', [
      { name: 'tokenize', kind: 'function', lineStart: 1, lineEnd: 10 },
    ]);

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 5, min_nodes: 10 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups.length).toBeGreaterThanOrEqual(1);
    expect(data.groups[0].size).toBe(3);
  });

  test('works across Python files', async () => {
    const contentA = `
def process_users(items):
    total = 0
    for x in items:
        if x.age > 18:
            total = total + x.score
    return total
`.trimStart();

    const contentB = `
def aggregate_products(list):
    acc = 100
    for entry in list:
        if entry.price > 50:
            acc = acc + entry.revenue
    return acc
`.trimStart();

    writeAndIndex(store, 'src/a.py', contentA, 'python', [
      { name: 'process_users', kind: 'function', lineStart: 1, lineEnd: 7 },
    ]);
    writeAndIndex(store, 'src/b.py', contentB, 'python', [
      { name: 'aggregate_products', kind: 'function', lineStart: 1, lineEnd: 7 },
    ]);

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 3, min_nodes: 10 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups.length).toBeGreaterThanOrEqual(1);
  });

  test('respects file_pattern filter', async () => {
    const body = `
function doWork(x) {
  let r = 0;
  for (const v of x) {
    if (v > 0) r += v;
  }
  return r;
}
`.trimStart();

    writeAndIndex(store, 'src/app/a.ts', body, 'typescript', [
      { name: 'doWork', kind: 'function', lineStart: 1, lineEnd: 8 },
    ]);
    writeAndIndex(store, 'tests/b.ts', body, 'typescript', [
      { name: 'doWork', kind: 'function', lineStart: 1, lineEnd: 8 },
    ]);

    const result = await detectAstClones(store, TEST_DIR, {
      min_loc: 5,
      min_nodes: 10,
      file_pattern: 'src/app',
    });
    expect(result.isOk()).toBe(true);
    // Only 1 symbol matches the pattern → no clone group possible
    expect(result._unsafeUnwrap().groups.length).toBe(0);
  });

  test('returns empty when no symbols meet criteria', async () => {
    const result = await detectAstClones(store, TEST_DIR, { min_loc: 10, min_nodes: 50 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups).toHaveLength(0);
    expect(data.symbols_scanned).toBe(0);
  });

  test('.tsx file with 5 unrelated components produces no clone groups', async () => {
    // Regression: previously ast-clones re-parsed .tsx files with the plain
    // `typescript` grammar, which mis-parses JSX and collapses unrelated
    // components into the same ancestor node → bogus hash collisions.
    const content = `
import { useState } from 'react';

export function UserCard({ user }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <h2>{user.name}</h2>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      {open && <p>{user.bio}</p>}
    </div>
  );
}

export function ProductList({ products }) {
  const [filter, setFilter] = useState('');
  return (
    <ul>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      {products.filter((p) => p.name.includes(filter)).map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  );
}

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <section>
      <span>Count: {count}</span>
      <button onClick={() => setCount(count + 1)}>++</button>
      <button onClick={() => setCount(count - 1)}>--</button>
    </section>
  );
}

export function LoginForm({ onSubmit }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ email, password }); }}>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Sign in</button>
    </form>
  );
}

export function Notification({ message, kind }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <aside data-kind={kind}>
      <p>{message}</p>
      <button onClick={() => setVisible(false)}>Dismiss</button>
    </aside>
  );
}
`.trimStart();

    const lines = content.split('\n');
    function findRange(name: string): { start: number; end: number } {
      const startIdx = lines.findIndex((l) => l.includes(`function ${name}`));
      let depth = 0;
      let started = false;
      for (let i = startIdx; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') {
            depth--;
            if (started && depth === 0) {
              return { start: startIdx + 1, end: i + 1 };
            }
          }
        }
      }
      return { start: startIdx + 1, end: lines.length };
    }

    const names = ['UserCard', 'ProductList', 'Counter', 'LoginForm', 'Notification'];
    writeAndIndex(
      store,
      'src/Widgets.tsx',
      content,
      'typescript',
      names.map((n) => {
        const r = findRange(n);
        return { name: n, kind: 'function', lineStart: r.start, lineEnd: r.end };
      }),
    );

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 3, min_nodes: 10 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups).toHaveLength(0);
  });

  test('.tsx file with 2 structural twins produces 1 group of 2', async () => {
    // Both components share identical structure (function -> return JSX with
    // ul > items.map -> li > span + strong). With the correct tsx grammar
    // they hash the same; with the buggy plain-typescript grammar the JSX
    // either fails to parse or collapses, so the regression test is also a
    // positive check that the tsx grammar is now wired up.
    const block = (compName: string, label: string) => [
      `export function ${compName}({ items }) {`,
      `  return (`,
      `    <ul className="${label}">`,
      `      {items.map((it) => (`,
      `        <li key={it.id}>`,
      `          <span>{it.title}</span>`,
      `          <strong>{it.value}</strong>`,
      `        </li>`,
      `      ))}`,
      `    </ul>`,
      `  );`,
      `}`,
    ];

    const alpha = block('AlphaList', 'alpha');
    const beta = block('BetaList', 'beta');
    const blank = [''];
    const lines = [...alpha, ...blank, ...beta];
    const content = lines.join('\n') + '\n';

    const alphaStart = 1;
    const alphaEnd = alpha.length;
    const betaStart = alpha.length + blank.length + 1;
    const betaEnd = alpha.length + blank.length + beta.length;

    writeAndIndex(store, 'src/Twins.tsx', content, 'typescript', [
      { name: 'AlphaList', kind: 'function', lineStart: alphaStart, lineEnd: alphaEnd },
      { name: 'BetaList', kind: 'function', lineStart: betaStart, lineEnd: betaEnd },
    ]);

    const result = await detectAstClones(store, TEST_DIR, { min_loc: 3, min_nodes: 10 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].size).toBe(2);
    const names = data.groups[0].symbols.map((s) => s.name).sort();
    expect(names).toEqual(['AlphaList', 'BetaList']);
  });
});
