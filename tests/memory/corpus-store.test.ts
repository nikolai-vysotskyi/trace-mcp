import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CorpusManifest,
  CorpusStore,
  CorpusValidationError,
  validateCorpusName,
} from '../../src/memory/corpus-store.js';

function makeManifest(overrides: Partial<CorpusManifest> = {}): CorpusManifest {
  return {
    name: 'auth',
    projectRoot: '/repo',
    scope: 'feature',
    featureQuery: 'authentication flow',
    tokenBudget: 4_000,
    symbolCount: 12,
    fileCount: 4,
    estimatedTokens: 3_500,
    packStrategy: 'most_relevant',
    createdAt: '2026-05-09T10:00:00Z',
    updatedAt: '2026-05-09T10:00:00Z',
    description: 'Auth slice',
    ...overrides,
  };
}

describe('validateCorpusName', () => {
  it('accepts alphanumeric, dash, underscore', () => {
    expect(() => validateCorpusName('auth')).not.toThrow();
    expect(() => validateCorpusName('user-service')).not.toThrow();
    expect(() => validateCorpusName('module_42')).not.toThrow();
  });

  it('rejects empty / non-string', () => {
    expect(() => validateCorpusName('')).toThrow(CorpusValidationError);
    // @ts-expect-error — testing runtime guard
    expect(() => validateCorpusName(null)).toThrow(CorpusValidationError);
  });

  it('rejects path-traversal attempts', () => {
    expect(() => validateCorpusName('../etc/passwd')).toThrow(CorpusValidationError);
    expect(() => validateCorpusName('a/b')).toThrow(CorpusValidationError);
    expect(() => validateCorpusName('a\\b')).toThrow(CorpusValidationError);
    expect(() => validateCorpusName('.hidden')).toThrow(CorpusValidationError);
    expect(() => validateCorpusName('-leading')).toThrow(CorpusValidationError);
  });

  it('rejects names that are too long', () => {
    const huge = 'a'.repeat(65);
    expect(() => validateCorpusName(huge)).toThrow(CorpusValidationError);
  });
});

describe('CorpusStore', () => {
  let tmpRoot: string;
  let store: CorpusStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
    store = new CorpusStore({ rootDir: tmpRoot });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('save() persists manifest + packed body and updates timestamp', () => {
    const before = makeManifest({ updatedAt: '2026-01-01T00:00:00Z' });
    const out = store.save(before, '# packed\nhello world');
    expect(out.name).toBe('auth');
    // updatedAt overwritten on save
    expect(out.updatedAt).not.toBe('2026-01-01T00:00:00Z');

    const onDisk = fs.readFileSync(path.join(tmpRoot, 'auth.json'), 'utf-8');
    expect(JSON.parse(onDisk).name).toBe('auth');
    expect(fs.readFileSync(path.join(tmpRoot, 'auth.pack.md'), 'utf-8')).toContain('hello world');
  });

  it('exists() reports correct state', () => {
    expect(store.exists('auth')).toBe(false);
    store.save(makeManifest(), 'body');
    expect(store.exists('auth')).toBe(true);
  });

  it('load() round-trips a saved manifest', () => {
    store.save(makeManifest(), 'body');
    const reloaded = store.load('auth');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.featureQuery).toBe('authentication flow');
    expect(reloaded!.scope).toBe('feature');
  });

  it('load() returns null for missing corpus', () => {
    expect(store.load('missing')).toBeNull();
  });

  it('loadPackedBody() returns the packed text', () => {
    store.save(makeManifest(), '# code dump');
    expect(store.loadPackedBody('auth')).toContain('# code dump');
    expect(store.loadPackedBody('missing')).toBeNull();
  });

  it('list() enumerates and sorts manifests', () => {
    store.save(makeManifest({ name: 'beta' }), 'b');
    store.save(makeManifest({ name: 'alpha' }), 'a');
    store.save(makeManifest({ name: 'gamma' }), 'g');
    const names = store.list().map((m) => m.name);
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('list() ignores stray non-corpus files', () => {
    store.save(makeManifest({ name: 'real' }), 'x');
    fs.writeFileSync(path.join(tmpRoot, '.DS_Store.json'), 'noise'); // hidden
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), 'noise'); // wrong ext
    fs.writeFileSync(path.join(tmpRoot, '../escape.json'), 'noise'); // outside dir
    const names = store.list().map((m) => m.name);
    expect(names).toEqual(['real']);
  });

  it('delete() removes manifest + body', () => {
    store.save(makeManifest(), 'body');
    expect(store.delete('auth')).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'auth.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'auth.pack.md'))).toBe(false);
    expect(store.delete('auth')).toBe(false);
  });

  it('save() rejects invalid names before touching disk', () => {
    // Make sure no file was written when validation fails.
    expect(() => store.save(makeManifest({ name: '../escape' }), 'body')).toThrow(
      CorpusValidationError,
    );
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it('save() chmods 0600 on POSIX', () => {
    if (process.platform === 'win32') return;
    store.save(makeManifest({ name: 'permcheck' }), 'body');
    const mode = fs.statSync(path.join(tmpRoot, 'permcheck.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the root dir on first save', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    expect(fs.existsSync(tmpRoot)).toBe(false);
    store.save(makeManifest({ name: 'fresh' }), 'body');
    expect(fs.existsSync(tmpRoot)).toBe(true);
  });
});
