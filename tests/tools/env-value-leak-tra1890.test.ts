/**
 * TRA-1890 regression: secret values must not be reachable via `search_text`
 * or the rename-time non-code scan, despite the keys-only env design.
 *
 * All tokens below are fake fixtures — never real secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { searchText } from '../../src/tools/navigation/search-text.js';
import { scanNonCodeFiles } from '../../src/tools/refactoring/non-code-scanner.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

const FAKE_VALUE = 'fak_tok_TRA1890_9f8e7d6c5b4a';
const FAKE_VALUE_2 = 'fak_tok_TRA1890_neighbour_112233';
const KEY = 'TRA1890_SECRET_KEY';
const NEIGHBOUR_KEY = 'TRA1890_NEIGHBOUR';

describe('TRA-1890: env secret values stay out of search_text', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
    tmpDir = createTmpDir('tra1890-env-leak-');

    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        '# fixture (fake tokens only)',
        `${KEY}=${FAKE_VALUE}`,
        `${NEIGHBOUR_KEY}=${FAKE_VALUE_2}`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'app.ts'),
      `// references ${KEY} by name only — no secret here\nexport const keyName = '${KEY}';\n`,
    );

    store.insertFile('.env', 'env', 'h-env', 100);
    store.insertFile('app.ts', 'typescript', 'h-ts', 80);
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('search by key never returns the secret value', () => {
    const result = searchText(store, tmpDir, { query: KEY, contextLines: 2 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE);
    expect(data.matches.every((m) => m.file !== '.env')).toBe(true);
  });

  it('search by value substring returns no .env content', () => {
    const result = searchText(store, tmpDir, {
      query: 'fak_tok_TRA1890',
      contextLines: 2,
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE_2);
    expect(data.matches.every((m) => m.file !== '.env')).toBe(true);
  });

  it('context_lines cannot widen exposure to neighbouring secrets', () => {
    const result = searchText(store, tmpDir, { query: NEIGHBOUR_KEY, contextLines: 5 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE_2);
  });

  it('explicit language=env query still returns no values', () => {
    const result = searchText(store, tmpDir, { query: KEY, language: 'env' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE);
    expect(data.matches).toHaveLength(0);
  });

  it('skips *-suffix .env files even when indexed under another language', () => {
    const rel = 'config/prod.env';
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, rel), `${KEY}=${FAKE_VALUE}\n`);
    store.insertFile(rel, 'ini', 'h-prodenv', 60);

    const result = searchText(store, tmpDir, { query: KEY, contextLines: 2 });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(JSON.stringify(data)).not.toContain(FAKE_VALUE);
    expect(data.matches.every((m) => m.file !== rel)).toBe(true);
  });
});

describe('TRA-1890: env secret values stay out of scanNonCodeFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('tra1890-noncode-');
    fs.writeFileSync(path.join(tmpDir, '.env'), `${KEY}=${FAKE_VALUE}\n`);
    fs.writeFileSync(path.join(tmpDir, '.env.local'), `${KEY}=${FAKE_VALUE}\n`);
    // A non-env file mentioning the key must still be suggested (no over-blocking).
    fs.writeFileSync(path.join(tmpDir, 'deploy.yaml'), `envFrom: ${KEY}\n`);
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('never emits .env lines (raw or substituted)', () => {
    const mentions = scanNonCodeFiles(tmpDir, KEY, 'RENAMED_KEY');
    expect(JSON.stringify(mentions)).not.toContain(FAKE_VALUE);
    expect(mentions.every((m) => !path.basename(m.file).startsWith('.env'))).toBe(true);
    expect(mentions.every((m) => !m.file.endsWith('.env'))).toBe(true);
  });

  it('still suggests mentions in non-env files', () => {
    const mentions = scanNonCodeFiles(tmpDir, KEY, 'RENAMED_KEY');
    expect(mentions.some((m) => m.file === 'deploy.yaml')).toBe(true);
  });
});
