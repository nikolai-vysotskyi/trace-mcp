#!/usr/bin/env node
/**
 * TRA-1049: what a tool's response actually costs *in the field*, from the
 * calls that really happened, rather than from a basket someone assembled.
 *
 * `scripts/bench-response-tokens.ts` prices a tool by calling it with arguments
 * a harness chose. That is the only option for most tools — no arguments are
 * recorded anywhere. But `~/.trace/analytics.db` does keep `output_size_chars`
 * for every mined tool call, and for a tool whose cost is decided by its
 * argument (`find_usages` returns one reference or three hundred) the recorded
 * distribution is the better estimator of a per-call cost, and the only check
 * on whether the harness basket resembles real use at all.
 *
 * Chars are converted to o200k tokens by the tool's own measured chars->token
 * ratio from `docs/perf/response-tokens.json`, so the two sides are comparable.
 *
 *   node scripts/field-response-distribution.mjs find_usages
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const tool = process.argv[2];
if (!tool) {
  console.error('usage: field-response-distribution.mjs <tool_name>');
  process.exit(1);
}

const bench = JSON.parse(readFileSync(join(REPO, 'docs/perf/response-tokens.json'), 'utf8'));
const row = bench.rows.find((r) => r.tool === tool);
if (!row) throw new Error(`${tool} is not in docs/perf/response-tokens.json — measure it first`);
const tokensPerChar = row.real / row.chars;

const db = new Database(join(homedir(), '.trace/analytics.db'), { readonly: true });
const rows = db
  .prepare(
    `SELECT output_size_chars AS chars, timestamp FROM tool_calls
       WHERE tool_short_name = ? AND is_error = 0 AND output_size_chars > 0
       ORDER BY chars`,
  )
  .all(tool);
if (rows.length === 0) throw new Error(`no recorded ${tool} calls in analytics.db`);

const toks = rows.map((r) => Math.round(r.chars * tokensPerChar));
const at = (p) => toks[Math.min(toks.length - 1, Math.floor(p * toks.length))];
const dates = rows.map((r) => r.timestamp).sort();

console.log(
  JSON.stringify(
    {
      tool,
      source: '~/.trace/analytics.db, one machine (maintainer)',
      calls: toks.length,
      first_call: dates[0],
      last_call: dates[dates.length - 1],
      tokens_per_char: Number(tokensPerChar.toFixed(4)),
      tokens_per_char_from: `docs/perf/response-tokens.json (${row.chars} chars / ${row.real} o200k)`,
      o200k: {
        min: toks[0],
        p25: at(0.25),
        median: at(0.5),
        p75: at(0.75),
        p90: at(0.9),
        max: toks[toks.length - 1],
        mean: Math.round(toks.reduce((a, b) => a + b, 0) / toks.length),
      },
    },
    null,
    2,
  ),
);
