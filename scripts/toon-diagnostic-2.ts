#!/usr/bin/env tsx
import { encode as toonEncode } from '@toon-format/toon';
import { encode as tokTok } from 'gpt-tokenizer';

const tok = (s: string) => tokTok(s).length;

function measure(payload: unknown): { jt: number; tt: number; delta: number; tableMode: boolean } {
  const json = JSON.stringify(payload);
  const toon = toonEncode(payload as object);
  const jt = tok(json);
  const tt = tok(toon);
  const delta = +(((jt - tt) / jt) * 100).toFixed(1);
  const tableMode = /\[\d+\]\{[^}]+\}:/.test(toon);
  return { jt, tt, delta, tableMode };
}

function sampleScalar(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Decision ${i + 1}`,
    type: ['arch', 'tech', 'pref'][i % 3],
    review: 'approved',
  }));
}
function sampleWithArray(n: number) {
  return sampleScalar(n).map((d) => ({ ...d, tags: ['perf', 'ser'] }));
}
function sampleNested(n: number) {
  return sampleScalar(n).map((d, i) => ({
    ...d,
    symbol: { id: `s${i}`, name: `n${i}`, kind: 'method' },
  }));
}

console.log('\nN  | scalar-only (table)         | with array tags             | with nested obj');
console.log(
  '   | json tt  toon tt  Δ%  table | json tt  toon tt  Δ%  table | json tt  toon tt  Δ%  table',
);
console.log('-'.repeat(108));
for (const n of [3, 5, 10, 20, 50, 100, 200]) {
  const a = measure({ items: sampleScalar(n) });
  const b = measure({ items: sampleWithArray(n) });
  const c = measure({ items: sampleNested(n) });
  const fmt = (m: ReturnType<typeof measure>) =>
    `${String(m.jt).padStart(5)}  ${String(m.tt).padStart(5)}  ${String(m.delta > 0 ? '+' + m.delta : m.delta).padStart(5)}  ${m.tableMode ? 'T' : 'L'}`;
  console.log(`${String(n).padStart(3)}| ${fmt(a)}          | ${fmt(b)}          | ${fmt(c)}`);
}
console.log('\nT = table-mode, L = list-mode. Positive Δ% = TOON saved tokens.');

// Same but vary FIELD count too (number of columns per row)
console.log('\nField-count effect (20 records, scalar-only, varying columns):');
console.log('cols | json tt  toon tt  Δ%  mode');
for (const cols of [2, 4, 6, 8, 12, 20]) {
  const recs = Array.from({ length: 20 }, (_, i) => {
    const r: Record<string, unknown> = {};
    for (let c = 0; c < cols; c++) r[`f${c}`] = `value${i}_${c}`;
    return r;
  });
  const m = measure({ items: recs });
  console.log(
    `${String(cols).padStart(4)} | ${String(m.jt).padStart(5)}  ${String(m.tt).padStart(5)}  ${String(m.delta > 0 ? '+' + m.delta : m.delta).padStart(5)}  ${m.tableMode ? 'T' : 'L'}`,
  );
}
