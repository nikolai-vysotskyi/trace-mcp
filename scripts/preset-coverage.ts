/**
 * What each preset costs, and what it can still answer (TRA-1162).
 *
 * `preset-surface-budget.test.ts` caps the cost half — the serialized
 * `tools/list` a session pays for. Nothing measured the other half: of the tool
 * calls agents actually make, how many land inside the preset. A preset that is
 * cheap because it dropped the tools its role uses has not saved anything; it
 * has moved the cost to a `load_tools` round-trip nobody counted.
 *
 * Coverage is weighted by real recorded call volume from `~/.trace/savings.json`
 * — one machine, mixed roles, never an average user. It cannot say "the `perf`
 * preset misses what a perf agent needs", because the store does not record
 * which preset a call ran under (that is the gap TRA-1162 closes on the
 * telemetry side). It can say which tools a preset cannot reach at all, and how
 * busy those tools are, which is enough to find a preset missing a navigation
 * basic.
 *
 * Run: npx tsx scripts/preset-coverage.ts [pathToSavingsJson]
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer';
import { z } from 'zod';
import { UNGATED_META_TOOLS } from '../src/server/tool-filter.js';
import { ALWAYS_LOAD_TOOLS, TOOL_PRESETS } from '../src/tools/project/presets.js';
import { captureAllTools } from '../src/tools/register/__tests__/_capture-tools.js';

function resolveStorePath(): string {
  if (process.argv[2]) return process.argv[2];
  const candidates = [
    join(homedir(), '.trace', 'savings.json'),
    join(process.env.HOME ?? '', '.trace', 'savings.json'),
    '/Users/nikolai/.trace/savings.json',
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return join(homedir(), '.trace', 'savings.json');
}

const storePath = resolveStorePath();
const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
  per_tool: Record<string, number | { calls: number }>;
  sessions: number;
  first_session: string;
  last_session: string;
};
const calls = new Map<string, number>(
  Object.entries(store.per_tool).map(([tool, v]) => [tool, typeof v === 'number' ? v : v.calls]),
);
const totalCalls = [...calls.values()].reduce((a, b) => a + b, 0);

const allTools = captureAllTools();

/** The wire payload a client receives for `preset`, and what it costs. */
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

console.log(
  `store: ${storePath}\n` +
    `${totalCalls} calls / ${calls.size} tools / ${store.sessions} sessions, ` +
    `${store.first_session.slice(0, 10)}..${store.last_session.slice(0, 10)}\n`,
);
console.log(
  ['preset', 'tools', 'tokens', 'covered', 'uncovered calls', 'always-load gaps'].join('\t'),
);

for (const [name, members] of Object.entries(TOOL_PRESETS)) {
  const { tools, tokens } = surface(members);
  const reachable = members === 'all' ? null : new Set<string>([...members, ...UNGATED_META_TOOLS]);
  const covered = reachable
    ? [...calls].filter(([t]) => reachable.has(t)).reduce((a, [, c]) => a + c, 0)
    : totalCalls;
  const gaps = reachable
    ? [...ALWAYS_LOAD_TOOLS]
        .filter((t) => !reachable.has(t))
        .sort((a, b) => (calls.get(b) ?? 0) - (calls.get(a) ?? 0))
    : [];
  console.log(
    [
      name,
      tools,
      tokens,
      `${((100 * covered) / totalCalls).toFixed(1)}%`,
      totalCalls - covered,
      gaps.map((t) => `${t}(${calls.get(t) ?? 0})`).join(' ') || '—',
    ].join('\t'),
  );
}
