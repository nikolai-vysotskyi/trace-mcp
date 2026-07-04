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

describe('saveGlobalSettingsJsonc — deep-merge + comment-safe write (#221)', () => {
  const JSONC_FIXTURE = `{
  // Global trace-mcp settings
  "ai": {
    // provider comment
    "provider": "openai",
    "model": "gpt-4",
  },
  "logging": {
    "level": "info",
  },
  "customUserKey": "keep-me",
}
`;

  beforeEach(() => {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSONC_FIXTURE, 'utf-8');
  });

  it('leaves sibling nested keys intact when only one nested key is updated', () => {
    const result = configJsonc.saveGlobalSettingsJsonc({ ai: { provider: 'anthropic' } });

    expect(result.ai).toEqual({ provider: 'anthropic', model: 'gpt-4' });

    const written = parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    expect(written.ai.provider).toBe('anthropic');
    expect(written.ai.model).toBe('gpt-4'); // sibling nested key survives
    expect(written.logging.level).toBe('info'); // untouched sibling section survives
  });

  it('preserves comments in the existing JSONC file across the write', () => {
    configJsonc.saveGlobalSettingsJsonc({ ai: { provider: 'anthropic' } });

    const text = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
    expect(text).toContain('// Global trace-mcp settings');
    expect(text).toContain('// provider comment');
  });

  it('preserves top-level unknown/user-added keys', () => {
    const result = configJsonc.saveGlobalSettingsJsonc({ ai: { provider: 'anthropic' } });

    expect(result.customUserKey).toBe('keep-me');

    const written = parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    expect(written.customUserKey).toBe('keep-me');
  });

  it('removes a key when the payload sends an explicit null', () => {
    const result = configJsonc.saveGlobalSettingsJsonc({ ai: { model: null } });

    expect(result.ai.model).toBeUndefined();
    expect(result.ai.provider).toBe('openai'); // sibling survives removal

    const written = parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    expect(written.ai.model).toBeUndefined();
  });

  it('adds a brand-new top-level section without touching existing ones', () => {
    const result = configJsonc.saveGlobalSettingsJsonc({ runtime: { workers: 4 } });

    expect(result.runtime).toEqual({ workers: 4 });
    expect(result.ai).toEqual({ provider: 'openai', model: 'gpt-4' });
  });
});
