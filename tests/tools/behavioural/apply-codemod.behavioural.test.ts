/**
 * Behavioural coverage for `applyCodemod()` (the `apply_codemod` MCP tool).
 *
 * All tests use dry_run=true — no source files are mutated.
 *   - pattern + replacement: returns matches[] keyed by file with replacement preview
 *   - file_pattern filter: only files matching glob participate
 *   - multiline flag: enables cross-line regex matching
 *   - filter_content: narrows scope to files containing the substring
 *   - dry_run preserves file mtimes (asserted before/after)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyCodemod } from '../../../src/tools/refactoring/refactor.js';
import { createTmpFixture, removeTmpDir } from '../../test-utils.js';

function snapshotMtimes(tmpDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of fs.readdirSync(tmpDir, { recursive: true }) as string[]) {
    const full = path.join(tmpDir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) out[full] = stat.mtimeMs;
    } catch {
      // ignore
    }
  }
  return out;
}

describe('applyCodemod() — behavioural contract (dry_run path)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('pattern + replacement: returns matches with per-file replacement preview', async () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'const x = foo();\nconst y = foo();\n',
      'src/b.ts': 'const z = foo();\n',
    });

    const result = await applyCodemod(tmpDir, '\\bfoo\\b', 'bar', 'src/**/*.ts', {
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.tool).toBe('apply_codemod');
    expect(result.dry_run).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.total_replacements).toBeGreaterThan(0);
    expect(result.total_files).toBe(2);
    // Replacement preview contains "bar"
    expect(result.matches.some((m) => m.replaced.includes('bar'))).toBe(true);
    // files_modified must be empty in dry-run
    expect(result.files_modified).toEqual([]);
  });

  it('file_pattern filter: only files matching the glob are processed', async () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'const x = needle;\n',
      'lib/b.ts': 'const y = needle;\n',
      'docs/c.md': 'needle in docs\n',
    });

    const result = await applyCodemod(tmpDir, '\\bneedle\\b', 'haystack', 'src/**/*.ts', {
      dryRun: true,
    });

    expect(result.success).toBe(true);
    // Only src/a.ts matched, not lib/b.ts or docs/c.md
    expect(result.total_files).toBe(1);
    expect(result.matches.every((m) => m.file === 'src/a.ts')).toBe(true);
  });

  it('multiline flag enables cross-line regex matches', async () => {
    tmpDir = createTmpFixture({
      'src/multi.ts': 'function foo() {\n  doStuff();\n}\n',
    });

    // Pattern spans across newlines — only multiline mode should match.
    const result = await applyCodemod(
      tmpDir,
      'function foo\\(\\) \\{\\s+doStuff\\(\\);',
      'function bar() {\n  newStuff();',
      'src/**/*.ts',
      { dryRun: true, multiline: true },
    );

    expect(result.success).toBe(true);
    expect(result.total_replacements).toBeGreaterThan(0);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('filter_content narrows scope to files containing the substring', async () => {
    tmpDir = createTmpFixture({
      'src/has.ts': 'const x = TARGET; // contains MARKER\n',
      'src/skip.ts': 'const y = TARGET; // no marker\n',
    });

    const result = await applyCodemod(tmpDir, '\\bTARGET\\b', 'REPLACED', 'src/**/*.ts', {
      dryRun: true,
      filterContent: 'MARKER',
    });

    expect(result.success).toBe(true);
    // Only the file containing the MARKER string was processed
    expect(result.total_files).toBe(1);
    expect(result.matches.every((m) => m.file === 'src/has.ts')).toBe(true);
  });

  it('dry_run does NOT modify files on disk (mtime check)', async () => {
    tmpDir = createTmpFixture({
      'src/a.ts': 'const x = original;\n',
      'src/b.ts': 'const y = original;\n',
    });

    const before = snapshotMtimes(tmpDir);
    await new Promise((r) => setTimeout(r, 5));

    const result = await applyCodemod(tmpDir, '\\boriginal\\b', 'replacement', 'src/**/*.ts', {
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.total_replacements).toBeGreaterThan(0);
    expect(result.files_modified).toEqual([]);

    const after = snapshotMtimes(tmpDir);
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
    // Content should still contain "original", not "replacement"
    expect(fs.readFileSync(path.join(tmpDir, 'src/a.ts'), 'utf-8')).toContain('original');
    expect(fs.readFileSync(path.join(tmpDir, 'src/a.ts'), 'utf-8')).not.toContain('replacement');
  });
});
