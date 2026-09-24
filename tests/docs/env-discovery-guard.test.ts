import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Env-discovery guard (TRA-1883).
 *
 * `get_env_vars` is the only safe env path: it returns keys plus inferred
 * types/formats, never values. Agents that cannot find it fall back to unsafe
 * hacks — `python -c "import os; print(os.environ)"`, the
 * `before = dict(os.environ)` import-diff, `print(module.__file__)` for file
 * discovery, or a direct `.env` read that leaks secrets into model context.
 *
 * This guard fails when `docs/**`, `skills/**` or `examples/**` teach any of
 * those shapes. Deliberately scoped to prose: `src/` product code (the
 * `get_env_vars` implementation, env-classifier, redaction) and real tests
 * legitimately touch the environment and are not scanned.
 *
 * Why vitest and not Semgrep: the Semgrep scan is a code merge gate whose
 * scope (`.semgrepignore`) excludes `docs/` — Markdown prose is not an
 * actionable Semgrep surface. The `tests/docs/*` vitest guards already run in
 * CI test shards, so this file is the closest applicable gate.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SKILL = join(REPO_ROOT, 'skills/trace-mcp/SKILL.md');

/** Executable-looking shapes, not mere mentions of an identifier. */
const FORBIDDEN = [
  /print\s*\(.*os\.environ|os\.environ.*print\s*\(/, // python env dump
  /dict\s*\(\s*os\.environ/, // before=dict(os.environ) import-diff
  /print\s*\(.*__file__/, // print(module.__file__) discovery
  /console\.log\s*\(.*process\.env|process\.env.*console\.log\s*\(/, // node env dump
  /\bcat\s+\.env\b/, // direct `cat .env` for discovery
];

/**
 * A line that explicitly prohibits the shape is instruction, not
 * encouragement — e.g. the FORBIDDEN box in SKILL.md ("never ...").
 * Deliberately narrow: generic words like `instead`, `don't`, `do not`, or a
 * mere mention of `get_env_vars` must NOT suppress a hit, otherwise genuine
 * violations sharing the line are silently skipped.
 */
const PROHIBITION = /\b(?:never|forbidden|prohibit(?:ed)?|do not use)\b/i;

function proseFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.mdx?$|\.txt$/.test(entry.name)) out.push(full);
    }
  };
  for (const dir of ['docs', 'skills', 'examples']) walk(join(REPO_ROOT, dir));
  for (const root of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
    const full = join(REPO_ROOT, root);
    if (existsSync(full)) out.push(full);
  }
  return out;
}

function violationsFor(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (PROHIBITION.test(line)) return;
    if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

describe('env-discovery guard (TRA-1883)', () => {
  it('routes env discovery through get_env_vars in the skill decision matrix', () => {
    const skill = readFileSync(SKILL, 'utf8');
    expect(skill, 'skills/trace-mcp/SKILL.md must name get_env_vars').toContain('get_env_vars');
    expect(skill, 'skills/trace-mcp/SKILL.md must carry the FORBIDDEN env box').toMatch(
      /FORBIDDEN.*env/i,
    );
  });

  it('no docs/skills/examples prose teaches env dumps or __file__ discovery', () => {
    const bad: string[] = [];
    for (const file of proseFiles()) {
      for (const hit of violationsFor(file)) bad.push(`${relative(REPO_ROOT, file)} — ${hit}`);
    }
    expect(bad, `unsafe env-discovery shapes in prose:\n${bad.join('\n')}`).toEqual([]);
  });
});
