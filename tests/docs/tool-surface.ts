import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TRA-268: the numeric-claims guard derived its "how many tools do we ship"
 * number from `grep -lE "server\.tool\(" src/tools/register/*.ts` — a
 * non-recursive glob, so the nine tools registered under
 * `src/tools/register/navigation/` were invisible to it. The number it
 * produced (164) tracked the number the docs advertise (165) by coincidence,
 * not by construction: a batch of tools added in a subdirectory moves the
 * served surface without moving the guard, and a subdirectory refactor of
 * existing registrations drops the guard by nine and fails CI on docs that
 * were never wrong.
 *
 * This module is the single place both `readme-claims.test.ts` and
 * `preset-claims.test.ts` get the registered surface from.
 */

const REGISTER_DIR = fileURLToPath(new URL('../../src/tools/register', import.meta.url));

/** `server.tool('name', ...)` and the `_originalTool` meta-tool wrappers. */
const TOOL_NAME = /(?:server\.tool|_originalTool)\(\s*['"]([a-zA-Z0-9_]+)['"]/g;

function registerSources(): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (entry.name.endsWith('.ts')) out.push({ path: full, body: readFileSync(full, 'utf8') });
    }
  };
  walk(REGISTER_DIR);
  return out;
}

/** Byte ranges of every `if (has(...)) { ... }` block — the framework gates. */
function frameworkGateRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of body.matchAll(/if \(\s*has\(/g)) {
    const open = body.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) {
        ranges.push([open, i]);
        break;
      }
    }
  }
  return ranges;
}

/** Every tool name registered anywhere under src/tools/register (incl. subdirs). */
export function allToolNames(): string[] {
  const names = new Set<string>();
  for (const { body } of registerSources()) {
    for (const m of body.matchAll(TOOL_NAME)) names.add(m[1]);
  }
  return [...names];
}

/**
 * Tools registered only when a framework is detected (`if (has('vue', ...))`).
 * No single repo is ever served all of them, so they don't belong in the
 * number the docs advertise.
 */
export function frameworkGatedToolNames(): Set<string> {
  const gated = new Set<string>();
  for (const { body } of registerSources()) {
    const ranges = frameworkGateRanges(body);
    if (ranges.length === 0) continue;
    for (const m of body.matchAll(TOOL_NAME)) {
      if (ranges.some(([a, b]) => a <= m.index && m.index <= b)) gated.add(m[1]);
    }
  }
  return gated;
}

/**
 * The number the docs advertise: every registered tool a client gets on any
 * repo, framework-specific ones excluded. Deterministic — unlike a live
 * `tools/list`, which varies with the repo's detected frameworks and the
 * user's config (measured 150 / 165 / 172 across three environments).
 */
export function advertisedToolCount(): number {
  const gated = frameworkGatedToolNames();
  return allToolNames().filter((name) => !gated.has(name)).length;
}

/** `server.resource(...)` registrations, recursive for the same reason. */
export function resourceCount(): number {
  let total = 0;
  for (const { body } of registerSources()) {
    total += (body.match(/server\.resource\(/g) ?? []).length;
  }
  return total;
}
