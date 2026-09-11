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
import Database from 'better-sqlite3';
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

function resolveAnalyticsDb(): string | null {
  const candidates = [
    join(homedir(), '.trace', 'analytics.db'),
    join(homedir(), '.trace-mcp', 'analytics.db'),
    '/Users/nikolai/.trace/analytics.db',
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
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
      if (!s.project_root || !s.project_root.includes('multica')) continue;
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
console.log('   MULTICA WORKSPACE LIVE TELEMETRY AUDIT: ROLE PRESETS (TRA-1366)      ');
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

const dbPath = resolveAnalyticsDb();
if (dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const dbRows = db
      .prepare(
        `SELECT tc.tool_short_name, count(*) as cnt
         FROM tool_calls tc
         JOIN sessions s ON tc.session_id = s.id
         WHERE s.project_path LIKE ?
           AND s.started_at >= ?
           AND tc.tool_server = ?
         GROUP BY tc.tool_short_name
         ORDER BY cnt DESC`,
      )
      .all('%multica%', ROLLOUT_CUTOFF, 'trace-mcp') as { tool_short_name: string; cnt: number }[];

    const sessionStats = db
      .prepare(
        `SELECT count(distinct s.id) as sessions, count(tc.id) as total_calls
         FROM sessions s
         LEFT JOIN tool_calls tc ON tc.session_id = s.id
         WHERE s.project_path LIKE ?
           AND s.started_at >= ?`,
      )
      .get('%multica%', ROLLOUT_CUTOFF) as { sessions: number; total_calls: number };

    const tracemcpCalls = dbRows.reduce((a, b) => a + b.cnt, 0);

    console.log('\n------------------------------------------------------------------------');
    console.log(`   ANALYTICS DB MULTICA TELEMETRY (${dbPath})`);
    console.log('------------------------------------------------------------------------\n');
    console.log(
      `Multica Sessions: ${sessionStats.sessions} | Total System Tool Calls: ${sessionStats.total_calls} | trace-mcp Calls: ${tracemcpCalls}\n`,
    );
    console.log(
      ['preset', 'tools', 'tokens', 'saving vs full', 'empirical DB coverage'].join('\t'),
    );

    for (const [name, members] of Object.entries(TOOL_PRESETS)) {
      const { tools, tokens } = surface(members);
      const tokenSaving = (((fullSurface.tokens - tokens) / fullSurface.tokens) * 100).toFixed(1);
      if (members === 'all') {
        console.log([name.padEnd(12), tools, tokens, '0.0%', '100.0%'].join('\t'));
        continue;
      }
      const allowed = new Set([...members, ...UNGATED_META_TOOLS]);
      let covered = 0;
      for (const r of dbRows) {
        if (allowed.has(r.tool_short_name)) covered += r.cnt;
      }
      const pct = tracemcpCalls > 0 ? ((100 * covered) / tracemcpCalls).toFixed(1) : '0.0';
      console.log([name.padEnd(12), tools, tokens, `-${tokenSaving}%`, `${pct}%`].join('\t'));
    }

    console.log('\nTop trace-mcp Tools in Analytics DB:');
    for (const r of dbRows.slice(0, 10)) {
      const pct = ((r.cnt / tracemcpCalls) * 100).toFixed(1);
      console.log(
        `  ${r.tool_short_name.padEnd(25)} ${String(r.cnt).padStart(5)} calls (${pct.padStart(4)}%)`,
      );
    }

    const ROLE_PRESET_MAP: Record<string, string> = {
      'Implementation Engineer': 'dev',
      'Lead Engineer': 'dev',
      'Performance Agent': 'perf',
      'Design/UX Agent': 'design',
      'Web Design Agent': 'design',
      'Growth & Outreach Agent': 'minimal',
      'SEO Agent': 'minimal',
      'Security Agent': 'security',
      'TraceMCP Research Analyst': 'minimal',
      'Code Reviewer': 'review',
      'Reviewer B': 'review',
      'Reviewer C': 'review',
      'Ops Sweeper': 'minimal',
    };

    const cachePath = join(import.meta.dirname, '..', 'ops', 'preset-issue-roles.json');
    const issueRoles: Record<string, string> = existsSync(cachePath)
      ? JSON.parse(readFileSync(cachePath, 'utf8'))
      : {};

    const roleRows = db
      .prepare(
        `SELECT s.project_path, tc.tool_short_name, count(*) as cnt
         FROM tool_calls tc
         JOIN sessions s ON tc.session_id = s.id
         WHERE s.project_path LIKE ?
           AND s.started_at >= ?
           AND tc.tool_server = ?
         GROUP BY s.project_path, tc.tool_short_name`,
      )
      .all('%multica%', ROLLOUT_CUTOFF, 'trace-mcp') as {
      project_path: string;
      tool_short_name: string;
      cnt: number;
    }[];

    const roleCalls: Record<string, Record<string, number>> = {};
    for (const r of roleRows) {
      const m = r.project_path.match(/tra-(\d+)/i);
      const issueKey = m ? `TRA-${m[1]}` : null;
      const role =
        issueKey && issueRoles[issueKey] ? issueRoles[issueKey] : 'Unmapped / Direct Task';
      roleCalls[role] = roleCalls[role] || {};
      roleCalls[role][r.tool_short_name] = (roleCalls[role][r.tool_short_name] || 0) + r.cnt;
    }

    console.log('\n------------------------------------------------------------------------');
    console.log('   PER-ROLE DIRECT RESOLUTION AUDIT (Role Presets vs Real Usage, TRA-1366)');
    console.log('------------------------------------------------------------------------\n');

    let totalMappedCalls = 0;
    let totalDirectCalls = 0;

    for (const [role, tools] of Object.entries(roleCalls)) {
      if (role === 'Unmapped / Direct Task') continue;
      const presetName = ROLE_PRESET_MAP[role] || 'minimal';
      const members = TOOL_PRESETS[presetName];
      const allowed =
        members === 'all' ? null : new Set([...(members as string[]), ...UNGATED_META_TOOLS]);
      const total = Object.values(tools).reduce((a, b) => a + b, 0);
      let direct = 0;
      const missing: [string, number][] = [];
      for (const [tool, count] of Object.entries(tools)) {
        if (!allowed || allowed.has(tool)) {
          direct += count;
        } else {
          missing.push([tool, count]);
        }
      }
      totalMappedCalls += total;
      totalDirectCalls += direct;
      const pct = ((direct / total) * 100).toFixed(1);
      const missingStr =
        missing.length > 0
          ? `missing: ${missing.map(([t, c]) => `${t}(${c})`).join(' ')}`
          : '✓ 100% covered';
      console.log(
        `${role.padEnd(26)} [${presetName.padEnd(8)}] ${String(total).padStart(4)} calls -> ${pct.padStart(5)}% direct (${missingStr})`,
      );
    }

    console.log('\n------------------------------------------------------------------------');
    console.log(
      `Workspace Fleet Total: ${totalDirectCalls} / ${totalMappedCalls} calls directly resolved (${((100 * totalDirectCalls) / totalMappedCalls).toFixed(1)}%)`,
    );
    console.log('------------------------------------------------------------------------');
  } catch (err) {
    console.warn(`Could not read analytics DB: ${(err as Error).message}`);
  }
}

console.log('\n========================================================================');
