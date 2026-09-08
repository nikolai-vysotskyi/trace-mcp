/**
 * Live Multica workspace telemetry audit for tool presets (TRA-1194).
 *
 * Mines session logs from ~/.trace/sessions/ created by Multica agent tasks
 * and measures empirical coverage against each tool preset defined in
 * src/tools/project/presets.ts.
 *
 * Complements scripts/preset-coverage.ts (which reads ~/.trace/savings.json)
 * by scoping specifically to Multica agent runs post-rollout (2026-09-02+).
 *
 * Run: pnpm exec tsx scripts/multica-audit.ts [pathToSessionsDir]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer';
import { z } from 'zod';
import { UNGATED_META_TOOLS } from '../src/server/tool-filter.js';
import { TOOL_PRESETS } from '../src/tools/project/presets.js';
import { captureAllTools } from '../src/tools/register/__tests__/_capture-tools.js';

function resolveSessionsDir(): string {
  if (process.argv[2]) return process.argv[2];
  const candidates = [
    '/Users/nikolai/.trace/sessions',
    join(homedir(), '.trace', 'sessions'),
    join(process.env.HOME ?? '', '.trace', 'sessions'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return join(homedir(), '.trace', 'sessions');
}

const sessionsDir = resolveSessionsDir();
const files = existsSync(sessionsDir)
  ? readdirSync(sessionsDir).filter((f) => f.endsWith('.json') && !f.includes('-'))
  : [];

let preRolloutSessions = 0;
let preRolloutCalls = 0;
let postRolloutSessions = 0;
let postRolloutCalls = 0;
const toolCounts: Record<string, number> = {};

const ROLLOUT_CUTOFF = '2026-09-02T17:10:00Z';

for (const file of files) {
  try {
    const raw = readFileSync(join(sessionsDir, file), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (!s.project_root || !s.project_root.includes('multica_workspaces')) continue;
      const calls = (s.total_calls as number) || 0;
      if (s.started_at < ROLLOUT_CUTOFF) {
        preRolloutSessions++;
        preRolloutCalls += calls;
      } else {
        postRolloutSessions++;
        postRolloutCalls += calls;
        if (s.top_tools) {
          for (const [tool, count] of Object.entries(s.top_tools)) {
            toolCounts[tool] = (toolCounts[tool] || 0) + (count as number);
          }
        }
      }
    }
  } catch {}
}

const allTools = captureAllTools();

function surface(members: readonly string[] | 'all'): { tools: number; tokens: number } {
  const allowed = members === 'all' ? null : new Set([...members, ...UNGATED_META_TOOLS]);
  const payload = allTools
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(z.object(t.schemaShape)),
    }));
  return { tools: payload.length, tokens: encode(JSON.stringify(payload)).length };
}

const fullSurface = surface('all');

console.log('========================================================================');
console.log('   MULTICA WORKSPACE LIVE TELEMETRY AUDIT: ROLE PRESETS (TRA-1223)      ');
console.log('========================================================================\n');
console.log(`Directory: ${sessionsDir}`);
console.log(
  `Pre-rollout Multica sessions (< ${ROLLOUT_CUTOFF.slice(0, 10)}): ` +
    `${preRolloutSessions} sessions / ${preRolloutCalls} calls`,
);
console.log(
  `Post-rollout Multica sessions (>= ${ROLLOUT_CUTOFF.slice(0, 10)}): ` +
    `${postRolloutSessions} sessions / ${postRolloutCalls} calls\n`,
);

console.log(
  [
    'preset',
    'tools',
    'tokens',
    'saving vs full',
    'coverage',
    'missing calls',
    'top missing tools',
  ].join('\t'),
);

for (const [name, members] of Object.entries(TOOL_PRESETS)) {
  const { tools, tokens } = surface(members);
  const tokenSaving = (((fullSurface.tokens - tokens) / fullSurface.tokens) * 100).toFixed(1);

  if (members === 'all') {
    console.log([name.padEnd(12), tools, tokens, '0.0%', '100.0%', 0, '—'].join('\t'));
    continue;
  }

  const allowed = new Set([...members, ...UNGATED_META_TOOLS]);
  let covered = 0;
  const missing: [string, number][] = [];

  for (const [t, count] of Object.entries(toolCounts)) {
    if (allowed.has(t)) {
      covered += count;
    } else {
      missing.push([t, count]);
    }
  }

  missing.sort((a, b) => b[1] - a[1]);
  const coveragePct =
    postRolloutCalls > 0 ? ((100 * covered) / postRolloutCalls).toFixed(1) : '0.0';
  const topMissing = missing
    .slice(0, 3)
    .map(([t, c]) => `${t}(${c})`)
    .join(' ');

  console.log(
    [
      name.padEnd(12),
      tools,
      tokens,
      `-${tokenSaving}%`,
      `${coveragePct}%`,
      postRolloutCalls - covered,
      topMissing || '—',
    ].join('\t'),
  );
}

console.log('\n------------------------------------------------------------------------');
console.log('   TOP TOOL CALL DISTRIBUTION (Post-Rollout N = ' + postRolloutCalls + ' calls)');
console.log('------------------------------------------------------------------------\n');
const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
for (const [tool, count] of sorted.slice(0, 15)) {
  const pct = ((count / postRolloutCalls) * 100).toFixed(1);
  console.log(`  ${tool.padEnd(25)} ${String(count).padStart(5)} calls (${pct.padStart(4)}%)`);
}

console.log('\n========================================================================');
