import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectWorkspaces } from '../../src/indexer/monorepo.js';
import { createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

let tmpDir: string;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe('detectWorkspaces', () => {
  beforeEach(() => {
    tmpDir = createTmpDir('trace-mcp-mono-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('returns empty array when no workspace config exists', () => {
    const result = detectWorkspaces(tmpDir);
    expect(result).toEqual([]);
  });

  it('detects pnpm workspaces from pnpm-workspace.yaml', () => {
    writeFixtureFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - "packages/*"\n`);
    writeJson(path.join(tmpDir, 'packages/ui/package.json'), { name: '@mono/ui' });
    writeJson(path.join(tmpDir, 'packages/core/package.json'), { name: '@mono/core' });

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(2);

    const names = result.map((w) => w.name).sort();
    expect(names).toEqual(['@mono/core', '@mono/ui']);

    const paths = result.map((w) => w.path).sort();
    expect(paths).toEqual(['packages/core', 'packages/ui']);
  });

  it('detects npm/yarn workspaces from package.json (array form)', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'my-monorepo',
      workspaces: ['packages/*'],
    });
    writeJson(path.join(tmpDir, 'packages/app/package.json'), { name: '@mono/app' });
    writeJson(path.join(tmpDir, 'packages/lib/package.json'), { name: '@mono/lib' });

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.name).sort()).toEqual(['@mono/app', '@mono/lib']);
  });

  it('detects npm/yarn workspaces from package.json (object form)', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'my-monorepo',
      workspaces: { packages: ['apps/*'] },
    });
    writeJson(path.join(tmpDir, 'apps/web/package.json'), { name: '@mono/web' });

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('@mono/web');
    expect(result[0]!.path).toBe('apps/web');
  });

  it('detects composer path repositories', () => {
    writeJson(path.join(tmpDir, 'composer.json'), {
      name: 'my/monorepo',
      repositories: [
        { type: 'path', url: 'packages/*' },
      ],
    });
    writeJson(path.join(tmpDir, 'packages/auth/composer.json'), { name: 'my/auth' });
    writeJson(path.join(tmpDir, 'packages/billing/composer.json'), { name: 'my/billing' });

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.name).sort()).toEqual(['my/auth', 'my/billing']);
  });

  it('uses directory name when package.json has no name', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      workspaces: ['packages/*'],
    });
    writeJson(path.join(tmpDir, 'packages/unnamed/package.json'), {});

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('packages/unnamed');
  });

  it('skips directories without package.json or composer.json', () => {
    writeJson(path.join(tmpDir, 'package.json'), {
      workspaces: ['packages/*'],
    });
    // Create directory without package.json
    fs.mkdirSync(path.join(tmpDir, 'packages/empty'), { recursive: true });
    writeJson(path.join(tmpDir, 'packages/valid/package.json'), { name: '@mono/valid' });

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('@mono/valid');
  });

  it('pnpm takes priority over npm workspaces', () => {
    // Both exist, but pnpm should win
    writeFixtureFile(tmpDir, 'pnpm-workspace.yaml', `packages:\n  - "apps/*"\n`);
    writeJson(path.join(tmpDir, 'package.json'), {
      workspaces: ['packages/*'],
    });
    writeJson(path.join(tmpDir, 'apps/web/package.json'), { name: '@pnpm/web' });
    writeJson(path.join(tmpDir, 'packages/lib/package.json'), { name: '@npm/lib' });

    const result = detectWorkspaces(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('@pnpm/web');
  });
});
