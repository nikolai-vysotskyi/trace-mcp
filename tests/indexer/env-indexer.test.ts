/**
 * Regression: EnvIndexer was passing config.exclude straight to fast-glob, and the
 * default exclude contains `**\/.env` / `**\/.env.*` to keep env files out of the
 * code index. That list must NOT hide env files from EnvIndexer itself, which only
 * records keys + inferred types/formats (never values) — the "anonymization" path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { EnvIndexer } from '../../src/indexer/env-indexer.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const DEFAULT_LIKE_EXCLUDE = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/.env',
  '**/.env.*',
];

function makeConfig(overrides: Partial<TraceMcpConfig> = {}): TraceMcpConfig {
  return {
    root: '.',
    include: [],
    exclude: DEFAULT_LIKE_EXCLUDE,
    db: { path: ':memory:' },
    plugins: [],
    ...overrides,
  } as TraceMcpConfig;
}

describe('EnvIndexer', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) {
      removeTmpDir(tmp);
      tmp = null;
    }
  });

  it('indexes root + per-service .env files despite default exclude patterns', async () => {
    tmp = createTmpFixture({
      '.env': [
        '# Root database',
        'DB_HOST=localhost',
        'DB_PORT=5432',
        'API_URL=https://api.example.com',
      ].join('\n'),
      'services/api/.env': ['SERVICE_NAME=api', 'JWT_SECRET="s3cr3t"'].join('\n'),
      'services/web/.env.production': [
        'PUBLIC_URL=https://web.example.com',
        'FEATURE_FLAG=true',
      ].join('\n'),
    });

    const store = createTestStore();
    const indexer = new EnvIndexer(store, makeConfig(), tmp);

    await indexer.indexEnvFiles(false);

    const rows = store.getAllEnvVars();
    const keysByFile = new Map<string, string[]>();
    for (const row of rows) {
      const list = keysByFile.get(row.file_path) ?? [];
      list.push(row.key);
      keysByFile.set(row.file_path, list);
    }

    expect([...keysByFile.keys()].sort()).toEqual([
      '.env',
      'services/api/.env',
      'services/web/.env.production',
    ]);
    expect(keysByFile.get('.env')).toEqual(['DB_HOST', 'DB_PORT', 'API_URL']);
    expect(keysByFile.get('services/api/.env')).toEqual(['SERVICE_NAME', 'JWT_SECRET']);
    expect(keysByFile.get('services/web/.env.production')).toEqual(['PUBLIC_URL', 'FEATURE_FLAG']);
  });

  it('stores only keys + inferred types/formats (no raw values leak to DB)', async () => {
    tmp = createTmpFixture({
      '.env': [
        'DB_HOST=localhost',
        'DB_PORT=5432',
        'DB_URL=postgres://user:pass@host:5432/db',
        'ENABLED=true',
        'JWT_SECRET="super-secret-should-not-leak"',
      ].join('\n'),
    });

    const store = createTestStore();
    const indexer = new EnvIndexer(store, makeConfig(), tmp);
    await indexer.indexEnvFiles(false);

    const rows = store.getAllEnvVars();
    expect(rows.map((r) => r.key)).toEqual([
      'DB_HOST',
      'DB_PORT',
      'DB_URL',
      'ENABLED',
      'JWT_SECRET',
    ]);

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.DB_PORT.value_type).toBe('number');
    expect(byKey.ENABLED.value_type).toBe('boolean');
    expect(byKey.DB_URL.value_format).toBe('url');
    expect(byKey.JWT_SECRET.quoted).toBe(1);

    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        expect(value).not.toContain('localhost');
        expect(value).not.toContain('5432');
        expect(value).not.toContain('postgres://');
        expect(value).not.toContain('super-secret-should-not-leak');
      }
    }
  });

  it('still honors directory excludes (e.g. node_modules/**)', async () => {
    tmp = createTmpFixture({
      '.env': 'APP=real\n',
      'node_modules/some-pkg/.env': 'LEAKED=should-not-be-indexed\n',
    });

    const store = createTestStore();
    const indexer = new EnvIndexer(store, makeConfig(), tmp);
    await indexer.indexEnvFiles(false);

    const files = [...new Set(store.getAllEnvVars().map((r) => r.file_path))];
    expect(files).toEqual(['.env']);
    expect(store.getAllEnvVars().map((r) => r.key)).toEqual(['APP']);
  });

  it('re-indexes updated files on second pass (force=false, content changed)', async () => {
    tmp = createTmpFixture({ '.env': 'A=1\n' });
    const store = createTestStore();
    const indexer = new EnvIndexer(store, makeConfig(), tmp);

    await indexer.indexEnvFiles(false);
    expect(store.getAllEnvVars().map((r) => r.key)).toEqual(['A']);

    fs.writeFileSync(path.join(tmp, '.env'), 'A=1\nB=2\n', 'utf-8');
    await indexer.indexEnvFiles(false);

    expect(
      store
        .getAllEnvVars()
        .map((r) => r.key)
        .sort(),
    ).toEqual(['A', 'B']);
  });
});
