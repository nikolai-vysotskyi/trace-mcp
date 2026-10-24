import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/db/store.js';
import { createTmpFixture, createTmpDir, removeTmpDir } from '../test-utils.js';

const repoRoot = path.resolve(__dirname, '../..');

describe('trace index-file include gate', () => {
  it('does not persist a file outside the project include on the local fallback', () => {
    const root = createTmpFixture({
      'src/allowed.ts': 'export const allowed = 1;\n',
      'src/i18n/en.json': '{"extra": 1}\n',
      '.trace.json': JSON.stringify({ include: ['src/**/*.ts'], exclude: [] }),
    });
    const dataDir = createTmpDir('trace-index-file-home-');
    try {
      const env = {
        ...process.env,
        TRACE_MCP_DATA_DIR: dataDir,
        TRACE_MCP_REPO_ROOT: root,
        TRACE_MCP_DAEMON_PORT: '1',
      };
      for (const file of ['src/i18n/en.json', 'src/allowed.ts']) {
        execFileSync(
          process.execPath,
          ['--import', 'tsx', 'src/cli.ts', 'index-file', path.join(root, file)],
          {
            cwd: repoRoot,
            env,
            timeout: 30_000,
            stdio: 'pipe',
          },
        );
      }

      const dbFiles = fs
        .readdirSync(path.join(dataDir, 'index'))
        .filter((name) => name.endsWith('.db'));
      expect(dbFiles).toHaveLength(1);
      const db = new Database(path.join(dataDir, 'index', dbFiles[0]), { readonly: true });
      try {
        expect(new Store(db).getAllFiles().map((f) => f.path)).toEqual(['src/allowed.ts']);
      } finally {
        db.close();
      }
    } finally {
      removeTmpDir(root);
      removeTmpDir(dataDir);
    }
  }, 120_000);
});
