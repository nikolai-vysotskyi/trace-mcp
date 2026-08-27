/**
 * Regression coverage for TRA-184 — a fresh project whose real code lives one
 * level deeper than the registered root (e.g. a repo checked out into a
 * subdirectory) got stuck indexing only a handful of files. collectFiles
 * gated its "rooted patterns matched nothing, retry with a deep prefix"
 * fallback on entries.length === 0 across ALL include patterns combined —
 * but a global pattern like "any markdown file" can match a stray top-level
 * file and make entries non-empty even though every directory-rooted
 * pattern (src, lib, ...) found nothing at the project root. That masked
 * the fallback and silently under-indexed the project.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { collectFiles } from '../file-collector.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'file-collector-nested-root-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('collectFiles — nested project root (TRA-184)', () => {
  it('falls back to a deep glob when a top-level README masks rooted patterns matching nothing', async () => {
    // A stray top-level markdown file matches the global `**/*.md` include
    // pattern immediately, while the real source lives nested under a
    // checked-out subdirectory the rooted `src/**` pattern never reaches.
    writeFileSync(join(workDir, 'README.md'), '# hello\n');
    const nestedSrc = join(workDir, 'checkout', 'src');
    mkdirSync(nestedSrc, { recursive: true });
    writeFileSync(join(nestedSrc, 'index.ts'), 'export const x = 1;\n');

    const config = TraceMcpConfigSchema.parse({
      include: ['src/**/*.ts', '**/*.md'],
      exclude: [],
    });

    const entries = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(entries).toEqual(expect.arrayContaining(['README.md', 'checkout/src/index.ts']));
  });
});
