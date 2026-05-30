import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, TraceMcpConfigSchema } from '../../src/config.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('config', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) removeTmpDir(tmpDir);
    delete process.env.TRACE_MCP_DB_PATH;
  });

  it('loads defaults when no config file exists', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    const result = await loadConfig(tmpDir);

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.root).toBe('.');
    expect(config.db.path).toBe('.trace-mcp/index.db');
    expect(config.include.length).toBeGreaterThan(0);
    expect(config.exclude.length).toBeGreaterThan(0);
    expect(config.plugins).toEqual([]);
  });

  it('default include globs index a FastAPI/SQLModel `app/` Python tree (regression)', async () => {
    // Regression: `app/**` previously omitted `.py`, so FastAPI/Flask/Django
    // projects that keep all code under `app/` indexed nothing but stray test
    // files. The default config must discover the whole Python source tree, and
    // must NOT descend into virtualenvs / caches.
    tmpDir = createTmpDir('trace-mcp-fastapi-');
    const files = [
      'app/main.py',
      'app/models/user.py',
      'app/routers/users.py',
      'app/services/user_service.py',
      'tests/test_users.py',
      // flat / root-package layout (no app/ wrapper)
      'routers/orders.py',
      'mypkg/core.py',
      // junk that must be excluded
      '.venv/lib/python3.12/site-packages/fastapi/__init__.py',
      'node_modules/foo/index.py',
      '__pycache__/cached.py',
    ];
    for (const f of files) {
      const abs = path.join(tmpDir, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x = 1\n');
    }

    const config = (await loadConfig(tmpDir))._unsafeUnwrap();
    const matched = await fg(config.include, {
      cwd: tmpDir,
      ignore: config.exclude,
      dot: false,
      onlyFiles: true,
    });

    // Every real source file is discovered, regardless of layout.
    expect(matched).toContain('app/main.py');
    expect(matched).toContain('app/models/user.py');
    expect(matched).toContain('app/routers/users.py');
    expect(matched).toContain('app/services/user_service.py');
    expect(matched).toContain('routers/orders.py');
    expect(matched).toContain('mypkg/core.py');
    expect(matched).toContain('tests/test_users.py');

    // Virtualenv / cache / vendored dependency trees are excluded.
    expect(matched.some((m) => m.includes('.venv/'))).toBe(false);
    expect(matched.some((m) => m.includes('site-packages/'))).toBe(false);
    expect(matched.some((m) => m.includes('node_modules/'))).toBe(false);
    expect(matched.some((m) => m.includes('__pycache__/'))).toBe(false);
  });

  it('loads .trace-mcp.json config file', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    const configFile = path.join(tmpDir, '.trace-mcp.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        root: './src',
        db: { path: 'custom/index.db' },
        include: ['src/**/*.ts'],
        exclude: ['dist/**'],
      }),
    );

    const result = await loadConfig(tmpDir);
    expect(result.isOk()).toBe(true);

    const config = result._unsafeUnwrap();
    expect(config.root).toBe('./src');
    expect(config.db.path).toBe('custom/index.db');
    expect(config.include).toEqual(['src/**/*.ts']);
  });

  it('env vars override file config', async () => {
    tmpDir = createTmpDir('trace-mcp-test-');
    const configFile = path.join(tmpDir, '.trace-mcp.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        db: { path: 'file-path.db' },
      }),
    );

    process.env.TRACE_MCP_DB_PATH = '/custom/env-path.db';

    const result = await loadConfig(tmpDir);
    expect(result.isOk()).toBe(true);

    const config = result._unsafeUnwrap();
    expect(config.db.path).toBe('/custom/env-path.db');
  });

  it('Zod validation rejects invalid config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      db: { path: 123 }, // path should be string
    });

    expect(result.success).toBe(false);
  });

  it('Zod validation accepts valid partial config', () => {
    const result = TraceMcpConfigSchema.safeParse({
      root: '/my/project',
      frameworks: {
        laravel: {
          artisan: { enabled: false },
          graceful_degradation: true,
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
