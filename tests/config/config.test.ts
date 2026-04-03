import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, TraceMcpConfigSchema } from '../../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('config', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
    delete process.env.TRACE_MCP_DB_PATH;
  });

  it('loads defaults when no config file exists', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-test-'));
    const result = await loadConfig(tmpDir);

    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.root).toBe('.');
    expect(config.db.path).toBe('.trace-mcp/index.db');
    expect(config.include.length).toBeGreaterThan(0);
    expect(config.exclude.length).toBeGreaterThan(0);
    expect(config.plugins).toEqual([]);
  });

  it('loads .trace-mcp.json config file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-test-'));
    const configFile = path.join(tmpDir, '.trace-mcp.json');
    fs.writeFileSync(configFile, JSON.stringify({
      root: './src',
      db: { path: 'custom/index.db' },
      include: ['src/**/*.ts'],
      exclude: ['dist/**'],
    }));

    const result = await loadConfig(tmpDir);
    expect(result.isOk()).toBe(true);

    const config = result._unsafeUnwrap();
    expect(config.root).toBe('./src');
    expect(config.db.path).toBe('custom/index.db');
    expect(config.include).toEqual(['src/**/*.ts']);
  });

  it('env vars override file config', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-test-'));
    const configFile = path.join(tmpDir, '.trace-mcp.json');
    fs.writeFileSync(configFile, JSON.stringify({
      db: { path: 'file-path.db' },
    }));

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
