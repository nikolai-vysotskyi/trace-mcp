/**
 * Regression coverage for #218 — `saveProjectConfigJsonc` used to call
 * `modifyGlobalConfigJsonc(['projects', projectRoot], config)`, and
 * jsonc-parser's `modify()` REPLACES the whole object at that path. Since
 * `setupProject` always passes a fresh `{root, include, exclude}`, a
 * re-register (`init --force` / `add --force`) silently dropped any
 * caller-omitted, user-added keys in the per-project section — e.g. a
 * hand-edited `ignore` block. The fix merges onto the existing section before
 * writing so caller-supplied keys win but unrelated keys survive.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
let configJsonc: typeof import('../config-jsonc.js');
let GLOBAL_CONFIG_PATH: string;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-config-jsonc-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  configJsonc = await import('../config-jsonc.js');
  ({ GLOBAL_CONFIG_PATH } = await import('../global.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('saveProjectConfigJsonc — merge-before-write (#218)', () => {
  it('preserves a user-added ignore block across a re-register that omits it', () => {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      GLOBAL_CONFIG_PATH,
      JSON.stringify({
        projects: {
          '/fake/proj': {
            root: '.',
            include: ['old/**/*.ts'],
            exclude: ['old-dist/**'],
            ignore: { directories: ['custom'] },
          },
        },
      }),
      'utf-8',
    );

    configJsonc.saveProjectConfigJsonc('/fake/proj', {
      root: '.',
      include: ['src/**/*.ts'],
      exclude: ['dist/**'],
    });

    const written = parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    const section = written.projects['/fake/proj'];

    expect(section.root).toBe('.');
    expect(section.include).toEqual(['src/**/*.ts']);
    expect(section.exclude).toEqual(['dist/**']);
    expect(section.ignore.directories).toContain('custom');
  });

  it('does not fail when the projects section or file is missing yet', () => {
    expect(() =>
      configJsonc.saveProjectConfigJsonc('/fresh/proj', {
        root: '.',
        include: ['src/**/*.ts'],
        exclude: [],
      }),
    ).not.toThrow();

    const written = parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    expect(written.projects['/fresh/proj'].include).toEqual(['src/**/*.ts']);
  });
});
