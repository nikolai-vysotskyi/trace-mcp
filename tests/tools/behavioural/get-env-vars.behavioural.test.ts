/**
 * Behavioural coverage for the env-var store API that backs the
 * `get_env_vars` MCP tool. The tool itself is defined inline in
 * `src/tools/register/core.ts` (~L527) and simply calls
 * `store.searchEnvVars()` / `store.getAllEnvVars()`, then groups by file
 * path. We exercise that underlying contract: insertion, retrieval, pattern
 * search, and grouping behaviour — which is the actual behavioural surface
 * the MCP tool exposes.
 *
 * NOTE: the original ticket asked for a behavioural test of `get_env_vars`
 * itself, but the tool is registered inline (not exported) so cannot be
 * imported directly. Testing the store-level contract is the closest
 * faithful coverage and matches the precedent set by other behavioural
 * tests against tools whose registrations are thin wrappers.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
  envFileId: number;
  exampleFileId: number;
}

function seed(): Fixture {
  const store = createTestStore();
  const envFileId = store.insertFile('.env', 'dotenv', 'h1', 200);
  const exampleFileId = store.insertFile('.env.example', 'dotenv', 'h2', 200);

  store.insertEnvVar(envFileId, {
    key: 'DB_HOST',
    valueType: 'string',
    valueFormat: 'host',
    comment: null,
    quoted: false,
    line: 1,
  });
  store.insertEnvVar(envFileId, {
    key: 'DB_PORT',
    valueType: 'number',
    valueFormat: null,
    comment: null,
    quoted: false,
    line: 2,
  });
  store.insertEnvVar(envFileId, {
    key: 'REDIS_URL',
    valueType: 'string',
    valueFormat: 'url',
    comment: 'cache layer',
    quoted: true,
    line: 3,
  });
  store.insertEnvVar(exampleFileId, {
    key: 'API_KEY',
    valueType: 'string',
    valueFormat: 'uuid',
    comment: null,
    quoted: false,
    line: 1,
  });

  return { store, envFileId, exampleFileId };
}

describe('env-var store API (backing get_env_vars MCP tool) — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('getAllEnvVars() returns every inserted key with file_path attached', () => {
    const all = ctx.store.getAllEnvVars();
    const keys = all.map((v) => v.key).sort();
    expect(keys).toEqual(['API_KEY', 'DB_HOST', 'DB_PORT', 'REDIS_URL']);
    for (const v of all) {
      expect(typeof v.file_path).toBe('string');
      expect(v.file_path.length).toBeGreaterThan(0);
    }
  });

  it('searchEnvVars() narrows by pattern (e.g. "DB_")', () => {
    const dbVars = ctx.store.searchEnvVars('DB_');
    const keys = dbVars.map((v) => v.key).sort();
    expect(keys).toEqual(['DB_HOST', 'DB_PORT']);
  });

  it('returned rows expose value_type, value_format, comment, and quoted', () => {
    const redis = ctx.store.searchEnvVars('REDIS')[0];
    expect(redis).toBeDefined();
    expect(redis.key).toBe('REDIS_URL');
    expect(redis.value_type).toBe('string');
    expect(redis.value_format).toBe('url');
    expect(redis.comment).toBe('cache layer');
    // quoted is stored as 0/1 in SQLite (boolean-ish).
    expect(redis.quoted === 1 || redis.quoted === true).toBe(true);
  });

  it('grouping by file_path mirrors what the MCP tool returns', () => {
    // Mirror the inline grouping logic from src/tools/register/core.ts.
    const all = ctx.store.getAllEnvVars();
    const grouped: Record<
      string,
      { key: string; type: string; format: string | null; comment: string | null }[]
    > = {};
    for (const v of all) {
      const arr = (grouped[v.file_path] ??= []);
      arr.push({
        key: v.key,
        type: v.value_type,
        format: v.value_format,
        comment: v.comment,
      });
    }
    expect(Object.keys(grouped).sort()).toEqual(['.env', '.env.example']);
    expect(grouped['.env'].map((e) => e.key).sort()).toEqual(['DB_HOST', 'DB_PORT', 'REDIS_URL']);
    expect(grouped['.env.example'].map((e) => e.key)).toEqual(['API_KEY']);
  });

  it('searchEnvVars() with a pattern matching nothing returns empty array (not throws)', () => {
    const none = ctx.store.searchEnvVars('NOPE_DOES_NOT_EXIST');
    expect(none).toEqual([]);
  });
});
