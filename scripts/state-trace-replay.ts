#!/usr/bin/env tsx
/**
 * Runs the SKILL.state trace-replay benchmark over local Claude Code session logs.
 *
 *   pnpm bench:state-replay [--limit 40] [--window 2] [--out docs/_data/state_replay_bench.json]
 *
 * Reads only token counts and tool names out of the logs; no transcript text is
 * written to the output file.
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  loadSession,
  median,
  replaySession,
  type ReplayResult,
} from '../src/eval/state-trace-replay.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const limit = Number(arg('limit', '40'));
const window = Number(arg('window', '2'));
const out = arg('out', '');
const root = arg('sessions', join(homedir(), '.claude', 'projects'));

const logs: string[] = [];
for (const dir of readdirSync(root)) {
  const full = join(root, dir);
  if (!statSync(full).isDirectory()) continue;
  for (const file of readdirSync(full)) {
    if (file.endsWith('.jsonl')) logs.push(join(full, file));
  }
}
// Biggest transcripts first: those are the long multi-step tasks the state
// engine is supposed to help with.
logs.sort((a, b) => statSync(b).size - statSync(a).size);

const results: ReplayResult[] = [];
for (const path of logs) {
  if (results.length >= limit) break;
  if (statSync(path).size > 200 * 1024 * 1024) continue;
  let session;
  try {
    session = loadSession(path, basename(path, '.jsonl'));
  } catch {
    continue;
  }
  if (!session) continue;
  results.push(replaySession(session, window));
}

if (results.length === 0) {
  console.error(`No usable sessions found under ${root}`);
  process.exit(1);
}

console.log(`sessions=${results.length} window=${window}\n`);
console.log('turns  state_tok  react_total  state_total  raw%   billed%');
for (const r of results) {
  console.log(
    `${String(r.turns).padStart(5)}  ${String(r.stateTokens).padStart(9)}  ` +
      `${String(r.reactTotalTokens).padStart(11)}  ${String(r.stateTotalTokens).padStart(11)}  ` +
      `${String(r.savingsPercent).padStart(5)}  ${String(r.billedSavingsPercent).padStart(7)}`,
  );
}

const summary = {
  generated_at: new Date().toISOString().slice(0, 10),
  sessions: results.length,
  window_size: window,
  median_turns: median(results.map((r) => r.turns)),
  median_state_tokens: median(results.map((r) => r.stateTokens)),
  median_raw_savings_percent: median(results.map((r) => r.savingsPercent)),
  median_billed_savings_percent: median(results.map((r) => r.billedSavingsPercent)),
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);

if (out) {
  // Session ids identify a local machine's transcripts; publish the shape only.
  const anonymized = results.map(({ sessionId: _drop, ...rest }) => rest);
  writeFileSync(out, `${JSON.stringify({ ...summary, results: anonymized }, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
}
