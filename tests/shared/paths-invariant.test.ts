import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Invariant: every path that touches `~/.trace-mcp` or a foreign IDE home
 * (Claude / Codex / Cursor / Windsurf / Hermes / Continue / Junie / Factory /
 * Amp) MUST be defined in `src/shared/paths.ts` (or its back-compat seed
 * `src/global.ts`).
 *
 * Why
 * ───
 * Hardcoded path literals drift across the codebase. claude-mem hit this
 * (PR #2237 / #2238) when `homedir() + '.claude-mem'` repeated in 24 places
 * — relocating the data dir required hunting every literal. We don't want
 * the same maintenance burden, so the test fails the build whenever a
 * fresh literal appears outside the centralised module.
 *
 * Grandfathered files
 * ───────────────────
 * Existing call sites are listed in `GRANDFATHERED` below — they still
 * contain the literal but are tracked so we don't accidentally regress.
 * Removing a file from this set means the literal must be migrated to
 * `src/shared/paths.ts`. Adding a new file requires reviewer approval.
 */

const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');

/** Files where the literal is the source of truth and MUST stay. */
const ALLOWED: ReadonlySet<string> = new Set([
  // The accessor module itself.
  'shared/paths.ts',
  // The override-resolution / TRACE_MCP_HOME computation lives here.
  'global.ts',
]);

/** Files that pre-existed this invariant. New literals here are still
 *  blocked — only the listed lines are excused.
 *
 *  Pruning this set is the migration roadmap: each removal means the
 *  file now imports from shared/paths.ts instead. */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  'analytics/log-parser.ts',
  'cli/install-app.ts',
  'config.ts',
  'init/conflict-detector.ts',
  'init/detector.ts',
  'init/hermes-hooks.ts',
  'init/hooks.ts',
  'init/launcher.ts',
  'init/mcp-client.ts',
  'init/tweakcc.ts',
  'logger.ts',
  'project-root.ts',
  'project-setup.ts',
  'session/providers/hermes.ts',
  'session/providers/types.ts',
  'tools/advanced/claude-sessions.ts',
  'tools/advanced/subproject-clone.ts',
  'utils/traceignore.ts',
]);

const FORBIDDEN_LITERALS = [
  // trace-mcp's own data dir — must come from TRACE_MCP_HOME / paths.ts
  /['"`]\.trace-mcp['"`]/,
  // foreign IDE homes — must come from named constants in paths.ts
  /\bos\.homedir\(\)[^'"`]*['"`]\.claude['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.codex['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.cursor['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.windsurf['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.hermes['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.continue['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.junie['"`]/,
  /\bos\.homedir\(\)[^'"`]*['"`]\.factory['"`]/,
];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith('.ts')) yield full;
  }
}

function relFromSrc(p: string): string {
  return path.relative(SRC_ROOT, p).replace(/\\/g, '/');
}

describe('paths invariant', () => {
  it('has no fresh hardcoded path literals outside src/shared/paths.ts', () => {
    const offenders: Array<{ file: string; pattern: string; line: number; text: string }> = [];

    for (const filePath of walk(SRC_ROOT)) {
      const rel = relFromSrc(filePath);
      if (ALLOWED.has(rel) || GRANDFATHERED.has(rel)) continue;

      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((text, idx) => {
        for (const pattern of FORBIDDEN_LITERALS) {
          if (pattern.test(text)) {
            offenders.push({
              file: rel,
              pattern: String(pattern),
              line: idx + 1,
              text: text.trim().slice(0, 140),
            });
          }
        }
      });
    }

    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line} matches ${o.pattern}\n    > ${o.text}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} fresh hardcoded path literal(s).\n` +
          `Use the named accessor from src/shared/paths.ts instead.\n` +
          `Or, if you can't migrate now, add the file to GRANDFATHERED in ` +
          `tests/shared/paths-invariant.test.ts.\n\n${formatted}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('all GRANDFATHERED files actually exist on disk', () => {
    // Catches stale entries when files are renamed/deleted — those should be
    // pruned from the list, not silently kept around.
    const missing: string[] = [];
    for (const rel of GRANDFATHERED) {
      const full = path.join(SRC_ROOT, rel);
      if (!fs.existsSync(full)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  it('all ALLOWED files actually exist on disk', () => {
    const missing: string[] = [];
    for (const rel of ALLOWED) {
      const full = path.join(SRC_ROOT, rel);
      if (!fs.existsSync(full)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});
