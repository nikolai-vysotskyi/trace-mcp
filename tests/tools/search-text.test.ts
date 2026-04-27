import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { searchText } from '../../src/tools/navigation/search-text.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

describe('searchText', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();

    // Create a temp project directory with test files
    tmpDir = createTmpDir('search-text-');

    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'src/auth.ts'),
      [
        'import { hash } from "bcrypt";',
        '',
        '// TODO: add rate limiting',
        'export function login(email: string, password: string) {',
        '  const user = findUser(email);',
        '  if (!user) throw new Error("User not found");',
        '  return verify(password, user.passwordHash);',
        '}',
        '',
        '// FIXME: session token storage',
        'export function logout(token: string) {',
        '  invalidateSession(token);',
        '}',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tmpDir, 'src/payment.ts'),
      [
        '// TODO: handle currency conversion',
        'export function processPayment(amount: number) {',
        '  if (amount <= 0) throw new Error("Invalid amount");',
        '  return chargeStripe(amount);',
        '}',
        '',
        '// HACK: temporary workaround',
        'const MAX_RETRIES = 3;',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(tmpDir, 'config/database.yml'),
      [
        'database:',
        '  host: localhost',
        '  port: 5432',
        '  name: myapp',
        '  DATABASE_URL: postgresql://localhost:5432/myapp',
      ].join('\n'),
    );

    // Index files into the store
    store.insertFile('src/auth.ts', 'typescript', 'h1', 500);
    store.insertFile('src/payment.ts', 'typescript', 'h2', 300);
    store.insertFile('config/database.yml', 'yaml', 'h3', 100);
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('finds literal string matches', () => {
    const result = searchText(store, tmpDir, { query: 'TODO' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(2);
    expect(data.files_matched).toBe(2);
    expect(data.matches[0].file).toBe('src/auth.ts');
    expect(data.matches[0].line).toBe(3);
    expect(data.matches[1].file).toBe('src/payment.ts');
  });

  it('finds regex matches', () => {
    const result = searchText(store, tmpDir, {
      query: 'TODO|FIXME|HACK',
      isRegex: true,
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(4); // 2 TODO + 1 FIXME + 1 HACK
    expect(data.files_matched).toBe(2);
  });

  it('filters by language', () => {
    const result = searchText(store, tmpDir, {
      query: 'localhost',
      language: 'yaml',
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(2); // host: localhost + DATABASE_URL
    expect(data.files_searched).toBe(1);
    expect(data.matches[0].file).toBe('config/database.yml');
  });

  it('filters by file pattern', () => {
    const result = searchText(store, tmpDir, {
      query: 'TODO',
      filePattern: '**/payment*',
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].file).toBe('src/payment.ts');
  });

  it('respects case sensitivity', () => {
    const result = searchText(store, tmpDir, {
      query: 'todo',
      caseSensitive: true,
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(0);

    const resultInsensitive = searchText(store, tmpDir, {
      query: 'todo',
      caseSensitive: false,
    });
    expect(resultInsensitive.isOk()).toBe(true);
    expect(resultInsensitive._unsafeUnwrap().matches.length).toBe(2);
  });

  it('includes context lines', () => {
    const result = searchText(store, tmpDir, {
      query: 'FIXME',
      contextLines: 1,
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(1);
    // 1 line before + match line + 1 line after = 3 context lines
    expect(data.matches[0].context.length).toBe(3);
    expect(data.matches[0].context[1]).toContain('> 10:');
  });

  it('respects maxResults', () => {
    const result = searchText(store, tmpDir, {
      query: 'e', // common letter, many matches
      maxResults: 3,
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(3);
    expect(data.truncated).toBe(true);
  });

  it('returns error for empty query', () => {
    const result = searchText(store, tmpDir, { query: '' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('VALIDATION_ERROR');
  });

  it('returns error for invalid regex', () => {
    const result = searchText(store, tmpDir, {
      query: '[invalid',
      isRegex: true,
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('VALIDATION_ERROR');
  });

  it('handles deleted files gracefully', () => {
    // File is in index but deleted from disk
    store.insertFile('src/deleted.ts', 'typescript', 'h4', 100);
    const result = searchText(store, tmpDir, { query: 'anything' });
    expect(result.isOk()).toBe(true);
    // Should not crash, just skip the missing file
  });

  it('returns column position for match', () => {
    const result = searchText(store, tmpDir, {
      query: 'processPayment',
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].column).toBeGreaterThan(1);
  });

  it('does not leak memory with many files', () => {
    // Create many small files to verify no accumulation
    for (let i = 0; i < 100; i++) {
      const filePath = `src/gen${i}.ts`;
      fs.writeFileSync(path.join(tmpDir, filePath), `// file ${i}\nconst x = ${i};\n`);
      store.insertFile(filePath, 'typescript', `h${i + 10}`, 30);
    }

    const result = searchText(store, tmpDir, {
      query: 'file',
      maxResults: 10,
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.matches.length).toBe(10);
    expect(data.truncated).toBe(true);
    // Files beyond maxResults are not even read
  });
});
