#!/usr/bin/env node
// Prompt-cache continuity of Claude Code sessions, per API request (TRA-860).
//
//   node scripts/mirror-cache-continuity.mjs ~/.claude/projects
//
// A cached prefix is only re-billed if something *before* the cache breakpoint
// changed. So for each request we compare its cache_read against the full
// input of the previous request on the same conversation branch: a hit ratio
// near 1 means the whole prefix carried over, a low one means part of it was
// re-written at cache-write price. Turns whose previous request carried a
// mirror-rewritten tool result are reported separately -- that is the JetBrains
// "cache-busting penalty" hypothesis, stated as something measurable.
//
// Two things are easy to get wrong and both inflate the break count:
//   - one API request is logged as several records (one per content block);
//     dedupe by requestId.
//   - a transcript file interleaves parallel sub-agent branches; follow
//     parentUuid instead of file order, or unrelated branches get compared.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(root);

const MIRROR = /\[trace-mcp mirror\] (Read|Bash) output compressed [0-9]/;
const turns = [];
for (const f of files) {
  let raw;
  try {
    raw = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const byUuid = new Map();
  const recs = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (d.uuid) byUuid.set(d.uuid, d);
    recs.push(d);
  }
  const prefixOf = (d) => {
    const u = d.message?.usage;
    return (
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0)
    );
  };
  const seen = new Set();
  for (const d of recs) {
    if (d.type !== 'assistant') continue;
    const u = d.message?.usage;
    if (!u || typeof u.cache_read_input_tokens !== 'number') continue;
    // one API request can be logged as several records (one per content block)
    if (d.requestId) {
      if (seen.has(d.requestId)) continue;
      seen.add(d.requestId);
    }
    // nearest ancestor assistant turn that issued its own request
    let prev = null,
      mirror = false,
      hops = 0;
    let cur = byUuid.get(d.parentUuid);
    while (cur && hops++ < 200) {
      if (cur.type === 'user') {
        const c = cur.message?.content;
        const s = typeof c === 'string' ? c : JSON.stringify(c ?? '');
        if (MIRROR.test(s)) mirror = true;
      }
      if (
        cur.type === 'assistant' &&
        cur.message?.usage &&
        typeof cur.message.usage.cache_read_input_tokens === 'number' &&
        cur.requestId !== d.requestId
      ) {
        prev = cur;
        break;
      }
      cur = byUuid.get(cur.parentUuid);
    }
    turns.push({
      file: f,
      sidechain: !!d.isSidechain,
      prefix: prefixOf(d),
      read: u.cache_read_input_tokens || 0,
      write: u.cache_creation_input_tokens || 0,
      raw: u.input_tokens || 0,
      out: u.output_tokens || 0,
      prevPrefix: prev ? prefixOf(prev) : null,
      gapSec: prev ? (Date.parse(d.timestamp) - Date.parse(prev.timestamp)) / 1000 : null,
      afterMirror: mirror,
    });
  }
}
// --- report -----------------------------------------------------------------
// Below 5k tokens the prefix is mostly the system block and a hit ratio says
// little; those turns are excluded from the continuity numbers, not from the
// token-class shares.
const eligible = turns.filter((t) => t.prevPrefix > 5000);

function summarise(rows, label) {
  let breaks = 0,
    lost = 0,
    prefix = 0;
  for (const r of rows) {
    lost += Math.max(0, r.prevPrefix - r.read);
    prefix += r.prevPrefix;
    if (r.read / r.prevPrefix < 0.9) breaks++;
  }
  console.log(
    `${label.padEnd(13)} requests=${String(rows.length).padStart(7)}  ` +
      `prefix breaks=${breaks} (${((100 * breaks) / (rows.length || 1)).toFixed(2)}%)  ` +
      `prefix mass re-written=${((100 * lost) / (prefix || 1)).toFixed(2)}%`,
  );
}

const sum = (k) => turns.reduce((a, b) => a + b[k], 0);
const billed = sum('read') + sum('write') + sum('raw');
console.log(`sessions=${new Set(turns.map((t) => t.file)).size}  requests=${turns.length}`);
console.log(
  `token classes: cache_read ${((100 * sum('read')) / billed).toFixed(1)}%  ` +
    `cache_write ${((100 * sum('write')) / billed).toFixed(1)}%  ` +
    `uncached ${((100 * sum('raw')) / billed).toFixed(1)}%`,
);
summarise(
  eligible.filter((t) => !t.afterMirror),
  'no mirror',
);
summarise(
  eligible.filter((t) => t.afterMirror),
  'after mirror',
);
