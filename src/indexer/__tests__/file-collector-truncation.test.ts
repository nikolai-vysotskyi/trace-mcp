/**
 * Regression coverage for TRA-1664 — when a project root holds more files
 * than `security.max_files`, the walk is cut to the cap and the truncation
 * must be visible to callers (not just one daemon-log line): the result
 * carries `truncated` + the pre-cap `found` count so the pipeline can stamp
 * it into IndexingResult / repo metadata / stats instead of reporting a
 * whole index.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { collectFiles } from '../file-collector.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'file-collector-truncation-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('collectFiles — max_files truncation (TRA-1664)', () => {
  it('flags truncation and reports the pre-cap count', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(src, `f${i}.ts`), `export const x${i} = ${i};\n`);
    }

    const config = TraceMcpConfigSchema.parse({ include: ['**/*.ts'], exclude: [] });
    const result = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 3,
    });

    expect(result.truncated).toBe(true);
    expect(result.found).toBe(5);
    expect(result.limit).toBe(3);
    expect(result.files).toHaveLength(3);
  });

  it('reports no truncation when the walk fits under the cap', async () => {
    const src = join(workDir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.ts'), 'export const a = 1;\n');

    const config = TraceMcpConfigSchema.parse({ include: ['**/*.ts'], exclude: [] });
    const result = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(result.truncated).toBe(false);
    expect(result.found).toBe(1);
    expect(result.files).toEqual(['src/a.ts']);
  });
});
