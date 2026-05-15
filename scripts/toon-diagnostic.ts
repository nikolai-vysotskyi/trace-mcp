#!/usr/bin/env tsx
import { encode as toonEncode } from '@toon-format/toon';
import { encode as tokTok } from 'gpt-tokenizer';

const tok = (s: string) => tokTok(s).length;

function dump(label: string, payload: unknown) {
  const json = JSON.stringify(payload);
  const toon = toonEncode(payload as object);
  const jt = tok(json);
  const tt = tok(toon);
  const delta = (((jt - tt) / jt) * 100).toFixed(1);
  const sign = jt > tt ? '+' : '';
  console.log('\n' + '='.repeat(78));
  console.log(`${label}`);
  console.log(
    `  json ${jt} tok / ${json.length} B    toon ${tt} tok / ${toon.length} B   savings ${sign}${delta}%`,
  );
  console.log('-'.repeat(78));
  console.log('JSON (first 600 chars):');
  console.log(json.slice(0, 600));
  console.log('-'.repeat(78));
  console.log('TOON (first 800 chars):');
  console.log(toon.slice(0, 800));
}

// ── Winner shape: query_decisions — flat homogeneous records ────────────────
const winnerPayload = {
  decisions: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    title: `Decision ${i + 1}`,
    type: ['architecture_decision', 'tech_choice', 'preference'][i % 3],
    content: 'Switched to TOON for tabular outputs.',
    tags: ['perf', 'serialization'],
    created_at: '2026-05-14T10:00:00Z',
    review_status: 'approved',
  })),
  total_results: 8,
};

// ── Loser shape: find_usages — heterogeneous refs with nested objects ───────
const loserPayload = {
  references: Array.from({ length: 6 }, (_, i) => ({
    file: `src/tools/${['register', 'navigation', 'analysis', 'memory', 'git', 'quality'][i]}/some-file.ts`,
    line: 100 + i * 7,
    kind: ['call', 'import', 'render', 'dispatch'][i % 4],
    context: `someFunction(arg${i}, otherArg${i})`,
    symbol: {
      id: `src/tools/foo.ts::Foo#method${i}`,
      name: `method${i}`,
      kind: 'method',
      signature: `method${i}(x: number, y: string): Promise<void>`,
      fqn: `Foo.method${i}`,
    },
    score: 0.123456789 + i * 0.01,
  })),
  total: 6,
  ambiguous_filtered: 0,
};

// ── Loser shape: search_text — string-heavy with array context ──────────────
const stringHeavyPayload = {
  matches: Array.from({ length: 8 }, (_, i) => ({
    file: `src/tools/register/navigation.ts`,
    language: 'typescript',
    line: 200 + i * 15,
    column: 7,
    match: 'output_format',
    context: [
      `  ${198 + i * 15}: const fmt = output_format === 'markdown' ? 'json' : output_format;`,
      `  ${199 + i * 15}: const text = encodeResponse(payload, fmt);`,
      `> ${200 + i * 15}:       output_format: OutputFormatSchema,`,
      `  ${201 + i * 15}: }, async (args) => {`,
    ],
  })),
  total_matches: 8,
  files_searched: 653,
  files_matched: 1,
};

// ── Same string-heavy but grouped by_file ───────────────────────────────────
const groupedPayload = {
  files: [
    {
      file: 'src/tools/register/navigation.ts',
      language: 'typescript',
      hits: stringHeavyPayload.matches.map((m) => ({
        line: m.line,
        column: m.column,
        match: m.match,
        context: m.context,
      })),
    },
  ],
  total_matches: 8,
  files_searched: 653,
  files_matched: 1,
};

// ── Tiny payload — overhead dominates ───────────────────────────────────────
const tinyPayload = {
  primary: [{ symbol_id: 'foo', file: 'a.ts', source: 'const x = 1;' }],
  imports: [],
  token_usage: { used: 12, budget: 1000 },
};

dump('WINNER  query_decisions-like (8 homogeneous flat records)', winnerPayload);
dump('LOSER   find_usages-like (6 refs with nested symbol{} block)', loserPayload);
dump('LOSER   search_text flat (8 matches with context[] array)', stringHeavyPayload);
dump('FIX     search_text by_file (same data, grouped)', groupedPayload);
dump('TINY    get_context_bundle small payload', tinyPayload);
