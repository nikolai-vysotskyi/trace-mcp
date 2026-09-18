/**
 * TRA-1660: navigation tools must accept the inputs agents naturally send —
 * absolute paths (all Read/Grep/hooks return those) and `file::Name` without
 * the `#kind` suffix — instead of NOT_FOUND + fallback to Read/Grep.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../db/store.js';
import { formatToolError, notFound } from '../../../errors.js';
import { normalizeToProjectRelative } from '../../../utils/security.js';
import { createTestStore } from '../../../../tests/test-utils.js';
import { getContextBundle } from '../context-bundle.js';
import { getFileOutline, getSymbol } from '../navigation.js';
import { resolveSymbolFlexible } from '../../shared/resolve.js';

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-natural-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

const AUTH_TS = `export class AuthService {
  login(): void {}
}

export interface Auth {
  token: string;
}

export type Auth = { token: string };
`;

const USER_TS = `export class Config {
  debug = false;
}
`;

function span(content: string, snippet: string): { start: number; end: number } {
  const start = content.indexOf(snippet);
  if (start < 0) throw new Error(`snippet not found: ${snippet}`);
  return { start, end: start + snippet.length };
}

function seed(store: Store): void {
  const authClass = span(AUTH_TS, 'export class AuthService');
  const authIface = span(AUTH_TS, 'export interface Auth');
  const authType = span(AUTH_TS, 'export type Auth');
  const config = span(USER_TS, 'export class Config');

  const authFile = store.insertFile('src/auth.ts', 'typescript', null, null);
  store.insertSymbol(authFile, {
    symbolId: 'src/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'auth.AuthService',
    signature: 'class AuthService',
    byteStart: authClass.start,
    byteEnd: AUTH_TS.length,
    lineStart: 1,
    lineEnd: 9,
  });
  store.insertSymbol(authFile, {
    symbolId: 'src/auth.ts::Auth#interface',
    name: 'Auth',
    kind: 'interface',
    fqn: 'auth.Auth',
    signature: 'interface Auth',
    byteStart: authIface.start,
    byteEnd: authIface.end,
    lineStart: 5,
    lineEnd: 7,
  });
  store.insertSymbol(authFile, {
    symbolId: 'src/auth.ts::Auth#type',
    name: 'Auth',
    kind: 'type',
    fqn: 'auth.Auth',
    signature: 'type Auth',
    byteStart: authType.start,
    byteEnd: authType.end,
    lineStart: 9,
    lineEnd: 9,
  });
  const userFile = store.insertFile('src/user.ts', 'typescript', null, null);
  store.insertSymbol(userFile, {
    symbolId: 'src/user.ts::Config#class',
    name: 'Config',
    kind: 'class',
    fqn: 'Config',
    signature: 'class Config',
    byteStart: config.start,
    byteEnd: USER_TS.length,
    lineStart: 1,
    lineEnd: 3,
  });
}

function setup(): { store: Store; root: string } {
  const root = makeProject({ 'src/auth.ts': AUTH_TS, 'src/user.ts': USER_TS });
  const store = createTestStore();
  seed(store);
  return { store, root };
}

// ─── normalizeToProjectRelative ─────────────────────────────────────────────

describe('normalizeToProjectRelative', () => {
  it('folds an absolute path inside the root to relative', () => {
    expect(normalizeToProjectRelative('/proj/src/auth.ts', '/proj')).toBe('src/auth.ts');
  });

  it('leaves already-relative paths canonically unchanged', () => {
    expect(normalizeToProjectRelative('src/auth.ts', '/proj')).toBe('src/auth.ts');
    expect(normalizeToProjectRelative('./src/auth.ts', '/proj')).toBe('src/auth.ts');
  });

  it('leaves paths outside the root untouched for the guard to reject', () => {
    expect(normalizeToProjectRelative('/other/src/auth.ts', '/proj')).toBe('/other/src/auth.ts');
    expect(normalizeToProjectRelative('../evil.ts', '/proj')).toBe('../evil.ts');
  });
});

// ─── getSymbol ──────────────────────────────────────────────────────────────

describe('getSymbol — natural inputs (TRA-1660)', () => {
  it('still resolves the exact symbol_id', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'src/auth.ts::AuthService#class' });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().symbol.name).toBe('AuthService');
  });

  it('resolves an absolute file part inside the project root', () => {
    const { store, root } = setup();
    const abs = path.join(root, 'src/auth.ts');
    const r = getSymbol(store, root, { symbolId: `${abs}::AuthService#class` });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().symbol.symbol_id).toBe('src/auth.ts::AuthService#class');
  });

  it('resolves an absolute + kind-less id when unique', () => {
    const { store, root } = setup();
    const abs = path.join(root, 'src/auth.ts');
    const r = getSymbol(store, root, { symbolId: `${abs}::AuthService` });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().symbol.symbol_id).toBe('src/auth.ts::AuthService#class');
  });

  it('resolves kind-less file::Name when it names one symbol', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'src/auth.ts::AuthService' });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().symbol.symbol_id).toBe('src/auth.ts::AuthService#class');
  });

  it('returns candidates when kind-less file::Name is ambiguous', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'src/auth.ts::Auth' });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err.code).toBe('NOT_FOUND');
    if (err.code !== 'NOT_FOUND') throw new Error('unreachable');
    expect(err.reason).toBe('unknown_symbol');
    expect(err.candidates ?? []).toContain('src/auth.ts::Auth#interface');
    expect(err.candidates ?? []).toContain('src/auth.ts::Auth#type');
  });

  it('resolves a basename file part via the suffix rule', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'auth.ts::AuthService#class' });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().symbol.symbol_id).toBe('src/auth.ts::AuthService#class');
  });

  it('resolves a unique bare name', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'AuthService' });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().symbol.symbol_id).toBe('src/auth.ts::AuthService#class');
  });

  it('returns candidates for an ambiguous bare name instead of an arbitrary row', () => {
    const { store, root } = setup();
    // `Auth` bare matches interface + type (+ nothing else).
    const r = resolveSymbolFlexible(store, root, 'Auth');
    expect(r.status).toBe('ambiguous');
    if (r.status !== 'ambiguous') throw new Error('unreachable');
    expect(r.candidates).toContain('src/auth.ts::Auth#interface');
    expect(r.candidates).toContain('src/auth.ts::Auth#type');
  });

  it('still misses genuinely unknown symbols', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'src/auth.ts::Ghost#class' });
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('misses carry unknown_symbol so the rendered help names the #kind form', () => {
    const { store, root } = setup();
    const r = getSymbol(store, root, { symbolId: 'src/auth.ts::Ghost' });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err.code).toBe('NOT_FOUND');
    if (err.code !== 'NOT_FOUND') throw new Error('unreachable');
    expect(err.reason).toBe('unknown_symbol');
    expect(JSON.stringify(formatToolError(err))).toContain('#kind');
  });
});

// ─── getFileOutline ─────────────────────────────────────────────────────────

describe('getFileOutline — absolute paths (TRA-1660)', () => {
  it('resolves an absolute path with projectRoot', async () => {
    const { store, root } = setup();
    const r = await getFileOutline(store, path.join(root, 'src/auth.ts'), { projectRoot: root });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().path).toBe('src/auth.ts');
    expect(r._unsafeUnwrap().symbols.length).toBeGreaterThan(0);
  });

  it('resolves an absolute path even without projectRoot', async () => {
    const { store, root } = setup();
    const r = await getFileOutline(store, path.join(root, 'src/auth.ts'));
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().path).toBe('src/auth.ts');
  });
});

// ─── getContextBundle ───────────────────────────────────────────────────────

describe('getContextBundle — natural inputs (TRA-1660)', () => {
  it('resolves kind-less symbol ids', () => {
    const { store, root } = setup();
    const r = getContextBundle(store, root, { symbolIds: ['src/auth.ts::AuthService'] });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().primary[0]?.symbol_id).toBe('src/auth.ts::AuthService#class');
  });

  it('resolves absolute symbol ids', () => {
    const { store, root } = setup();
    const abs = path.join(root, 'src/user.ts');
    const r = getContextBundle(store, root, { symbolIds: [`${abs}::Config#class`] });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().primary[0]?.symbol_id).toBe('src/user.ts::Config#class');
  });

  it('returns candidates for ambiguous kind-less ids', () => {
    const { store, root } = setup();
    const r = getContextBundle(store, root, { symbolIds: ['src/auth.ts::Auth'] });
    expect(r.isErr()).toBe(true);
    const err = r._unsafeUnwrapErr();
    expect(err.code).toBe('NOT_FOUND');
    if (err.code !== 'NOT_FOUND') throw new Error('unreachable');
    expect(err.candidates?.length ?? 0).toBeGreaterThan(1);
  });
});

// ─── error help ─────────────────────────────────────────────────────────────

describe('unknown_symbol help (TRA-1660)', () => {
  it('names the #kind form with an example', () => {
    const text = JSON.stringify(
      formatToolError(notFound('src/auth.ts::Auth', undefined, 'unknown_symbol')),
    );
    expect(text).toContain('#kind');
    expect(text).toContain('src/auth.ts::AuthService#class');
  });

  it('tells the caller to pick from suggestions when candidates exist', () => {
    const text = JSON.stringify(
      formatToolError(
        notFound('src/auth.ts::Auth', ['src/auth.ts::Auth#interface'], 'unknown_symbol'),
      ),
    );
    expect(text).toContain('path/to/file.ts::Name#kind');
  });
});
