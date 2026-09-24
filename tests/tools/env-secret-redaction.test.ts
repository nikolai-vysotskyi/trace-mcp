/**
 * TRA-1889 regression: secret values in indexed .env files must never leak
 * through searchText, packContext (source section), or scanNonCodeFiles.
 *
 * All sentinel values below are fake — no live secrets anywhere in this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import type { PluginRegistry } from '../../src/plugin-api/registry.js';
import { searchText } from '../../src/tools/navigation/search-text.js';
import { packContext } from '../../src/tools/refactoring/pack-context.js';
import { scanNonCodeFiles } from '../../src/tools/refactoring/non-code-scanner.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

// Fake sentinels — structurally realistic, never real credentials.
const SENTINEL_VALUE = 'sk-fake-sentinel-9f8e7d6c5b4a-tra1889';
const SENTINEL_DB_URL = 'postgres://fakesentinel:tra1889pw@db.internal:5432/appdb';

describe('env secret redaction (TRA-1889)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('env-redact-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  describe('searchText', () => {
    let store: Store;

    beforeEach(() => {
      store = createTestStore();
      fs.writeFileSync(
        path.join(tmpDir, '.env'),
        [
          '# fake fixture, not a real secret',
          `API_KEY=${SENTINEL_VALUE}`,
          `DATABASE_URL=${SENTINEL_DB_URL}`,
          '',
        ].join('\n'),
      );
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const app = 1;\n');
      store.insertFile('.env', 'env', 'h-env', 200);
      store.insertFile('app.ts', 'typescript', 'h-ts', 50);
    });

    it('never returns a .env secret value for a value query', () => {
      const result = searchText(store, tmpDir, { query: SENTINEL_VALUE });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.matches).toHaveLength(0);
      expect(JSON.stringify(data)).not.toContain(SENTINEL_VALUE);
    });

    it('never leaks values via context lines either', () => {
      const result = searchText(store, tmpDir, {
        query: 'API_KEY',
        contextLines: 5,
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const blob = JSON.stringify(data);
      expect(blob).not.toContain(SENTINEL_VALUE);
      expect(blob).not.toContain(SENTINEL_DB_URL);
      // The key itself stays findable (redacted view), not silently dropped.
      expect(data.matches.length).toBeGreaterThan(0);
      expect(data.matches[0].file).toBe('.env');
      expect(data.matches[0].match).toContain('API_KEY');
    });

    it('redacts dotenv basenames even when the row language is not env', () => {
      const store2 = createTestStore();
      fs.writeFileSync(path.join(tmpDir, '.env.local'), `TOKEN=${SENTINEL_VALUE}\n`);
      store2.insertFile('.env.local', 'plaintext', 'h-local', 100);
      const result = searchText(store2, tmpDir, { query: SENTINEL_VALUE });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().matches).toHaveLength(0);
    });
  });

  describe('packContext source section', () => {
    function createPackStore(): Store {
      const files = [
        { id: 1, path: '.env', language: 'env' },
        { id: 2, path: 'src/app.ts', language: 'typescript' },
      ];
      return {
        getAllFiles: () => files,
        getFileById: (id: number) => files.find((f) => f.id === id) ?? null,
        getSymbolsByFile: (id: number) =>
          id === 2
            ? [
                {
                  name: 'app',
                  kind: 'variable',
                  fqn: 'app',
                  signature: 'const app = 1',
                  line_start: 1,
                  line_end: 1,
                },
              ]
            : [],
        getAllRoutes: () => [],
        db: { prepare: () => ({ all: () => [], get: () => null }) },
      } as unknown as Store;
    }

    function createMockRegistry(): PluginRegistry {
      return {
        getAllFrameworkPlugins: () => [],
        getAllLanguagePlugins: () => [],
      } as unknown as PluginRegistry;
    }

    beforeEach(() => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.env'), `API_KEY=${SENTINEL_VALUE}\n`);
      fs.writeFileSync(path.join(tmpDir, 'src/app.ts'), 'export const app = 1;\n');
    });

    it.each([false, true])('redacts .env source with compress=%s', (compress) => {
      const result = packContext(createPackStore(), createMockRegistry(), {
        scope: 'project',
        format: 'markdown',
        maxTokens: 50000,
        include: ['source'],
        compress,
        projectRoot: tmpDir,
      });
      expect(result.sections).toContain('source');
      expect(result.content).not.toContain(SENTINEL_VALUE);
      // Keys + structure stay visible — the section is redacted, not dropped.
      expect(result.content).toContain('API_KEY');
    });
  });

  describe('scanNonCodeFiles', () => {
    it('redacts values when the renamed symbol is a key', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.env'),
        [`OLD_KEY_NAME=${SENTINEL_VALUE}`, `OTHER=plain`, ''].join('\n'),
      );
      const mentions = scanNonCodeFiles(tmpDir, 'OLD_KEY_NAME', 'NEW_KEY_NAME');
      expect(mentions.length).toBeGreaterThan(0);
      const blob = JSON.stringify(mentions);
      expect(blob).not.toContain(SENTINEL_VALUE);
      // Line numbers stay accurate (redaction preserves line layout).
      expect(mentions[0].line).toBe(1);
      expect(mentions[0].suggestion).toContain('NEW_KEY_NAME');
    });

    it('reports no raw value when the symbol only appears inside a value', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), `SOME_KEY=prefix-OLD_TOKEN-suffix\n`);
      const mentions = scanNonCodeFiles(tmpDir, 'OLD_TOKEN', 'NEW_TOKEN');
      // After redaction the value is `<string>` — nothing left to match,
      // and critically the raw value never reaches the output.
      expect(JSON.stringify(mentions)).not.toContain('prefix-OLD_TOKEN-suffix');
    });
  });
});
