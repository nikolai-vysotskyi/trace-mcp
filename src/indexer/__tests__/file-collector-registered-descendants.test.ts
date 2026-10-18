import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trace-registered-descendants-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', join(home, 'data'));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

describe('collectFiles with overlapping registered roots (TRA-2522)', () => {
  it('keeps unregistered nested repos, excludes registered children, then restores them on removal', async () => {
    const root = join(home, 'general');
    const child = join(root, 'thewed');
    const unregistered = join(root, 'fair-front');
    for (const dir of [child, unregistered]) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1;\n');
    }

    const { registerProject, unregisterProject } = await import('../../registry.js');
    const { collectFiles } = await import('../file-collector.js');
    const { TraceMcpConfigSchema } = await import('../../config.js');
    const config = TraceMcpConfigSchema.parse({ include: ['**/*.ts'], exclude: [] });
    const files = async () =>
      (
        await collectFiles({
          config,
          rootPath: root,
          workspaces: [],
          traceignore: undefined,
          maxFiles: 100,
        })
      ).files.sort();

    registerProject(root);
    registerProject(child);
    expect(await files()).toEqual(['fair-front/src/index.ts']);

    unregisterProject(child);
    expect(await files()).toEqual(['fair-front/src/index.ts', 'thewed/src/index.ts']);
  });
});
