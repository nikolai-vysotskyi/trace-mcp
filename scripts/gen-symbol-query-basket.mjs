#!/usr/bin/env node
/**
 * TRA-985 review: the fifteen search terms in `bench-response-tokens.ts` are all
 * single lowercase subsystem words — the one query shape where a
 * `__module__:<filename>` pseudo-symbol wins the 10x FTS name weight. The real
 * recorded distribution (1,133 `search` calls in `~/.trace/analytics.db`) is
 * only 25% that shape: mean 1.69 words, 29% multi-word, mostly identifiers.
 *
 * Those real queries cannot be committed — they are symbol names from private
 * repositories — and cannot be replayed either, since they target codebases
 * this bench does not index. So this builds a second basket that is
 * treatment-independent by construction: real *symbol names* sampled from the
 * indexed corpus. Pseudo-symbols are named after files, never after symbols, so
 * a symbol-name query cannot be aimed at them.
 *
 * Deterministic: symbols ordered by symbol_id, every Nth taken. No seed, no
 * choice. Prints the basket for pasting into the harness.
 *
 *   node scripts/gen-symbol-query-basket.mjs <index.db> [count]
 */
import Database from 'better-sqlite3';

const [dbPath, countArg] = process.argv.slice(2);
if (!dbPath) {
  console.error('usage: gen-symbol-query-basket.mjs <index.db> [count]');
  process.exit(1);
}
const count = Number(countArg ?? 15);
const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(
    `SELECT name FROM symbols
      WHERE name NOT GLOB '__module__*' AND length(name) > 3 AND kind != 'namespace'
        AND name GLOB '[A-Za-z_]*' AND name NOT GLOB '*[^A-Za-z0-9_]*'
      ORDER BY symbol_id`,
  )
  .all();
const step = Math.floor(rows.length / count) || 1;
const picked = [];
for (let i = 0; picked.length < count && i * step < rows.length; i += 1) {
  const name = rows[i * step].name;
  if (!picked.includes(name)) picked.push(name);
}
console.log(JSON.stringify(picked, null, 2));
