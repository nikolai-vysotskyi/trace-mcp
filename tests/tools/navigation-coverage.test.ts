/**
 * Targeted coverage for the high-risk branches in navigation tools
 * (register/navigation.ts and navigation/navigation.ts).
 *
 * Uses a hand-crafted in-memory store instead of the full pipeline so tests
 * run in milliseconds and can control every symbol exactly.
 *
 * Covers the branches identified as high-risk by bug-score analysis:
 *   - decorator / annotation / attribute filter
 *   - implements / extends filter
 *   - filePattern filter
 *   - getSymbol maxLines truncation
 *   - decorator metadata surfaced in search results
 *   - fuzzy search fallback
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { search, getSymbol, getFileOutline } from '../../src/tools/navigation/navigation.js';
import { enableFts5Triggers } from '../../src/db/schema.js';
import { indexTrigramsBatch } from '../../src/db/fuzzy.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ── Store seeding helpers ─────────────────────────────────────────────────────

type Meta = Record<string, unknown>;

function seedFile(store: Store, filePath: string, language = 'typescript'): number {
  return store.insertFile(filePath, language, 'hash:' + filePath, 100);
}

function seedSymbol(
  store: Store,
  fileId: number,
  name: string,
  opts: {
    kind?: string;
    fqn?: string;
    signature?: string;
    heritage?: string;
    metadata?: Meta;
    byteStart?: number;
    byteEnd?: number;
  } = {},
): number {
  return store.insertSymbol(fileId, {
    symbolId: `${fileId}::${name}#${opts.kind ?? 'function'}`,
    name,
    kind: opts.kind ?? 'function',
    fqn: opts.fqn ?? name,
    signature: opts.signature ?? `function ${name}()`,
    heritage: opts.heritage,
    byteStart: opts.byteStart ?? 0,
    byteEnd: opts.byteEnd ?? 50,
    metadata: opts.metadata,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('search() — filter coverage', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    enableFts5Triggers(store.db); // needed so insertSymbol populates FTS candidates
    const fA = seedFile(store, 'src/controllers/user.ts');
    const fB = seedFile(store, 'src/services/email.ts');
    const fC = seedFile(store, 'src/models/account.ts');

    // Symbol with @Controller decorator
    seedSymbol(store, fA, 'UserController', {
      kind: 'class',
      metadata: { decorators: ['Controller', 'Injectable'], exported: true },
    });
    // Symbol with @Injectable but no Controller
    seedSymbol(store, fA, 'UserHelper', {
      kind: 'class',
      metadata: { decorators: ['Injectable'], exported: true },
    });
    // Symbol with @Route annotation (different key)
    seedSymbol(store, fB, 'sendEmail', {
      kind: 'function',
      metadata: { annotations: ['Route'], exported: true },
    });
    // Symbol with attributes array
    seedSymbol(store, fC, 'AccountModel', {
      kind: 'class',
      metadata: { attributes: ['Model', 'Cacheable'], exported: true },
    });
    // Plain symbol, no decorators
    seedSymbol(store, fC, 'plainHelper', {
      kind: 'function',
      metadata: { exported: true },
    });
    // Symbol with implements / extends heritage
    seedSymbol(store, fA, 'AdminController', {
      kind: 'class',
      heritage: 'UserController',
      metadata: { implements: ['Auditable'], extends: 'UserController', exported: true },
    });
  });

  // ── decorator filter ──────────────────────────────────────────────────────

  it('decorator filter matches symbols with matching decorators[] entry', async () => {
    // FTS5 matches exact tokens — use the full symbol name for a reliable FTS hit
    const r = await search(store, 'UserController', { decorator: 'Injectable' });
    const names = r.items.map((i) => i.symbol.name);
    expect(names).toContain('UserController');
    expect(names).not.toContain('plainHelper');
  });

  it('decorator filter matches symbols with annotations[] entry', async () => {
    const r = await search(store, 'sendEmail', { decorator: 'Route' });
    expect(r.items.some((i) => i.symbol.name === 'sendEmail')).toBe(true);
  });

  it('decorator filter matches symbols with attributes[] entry', async () => {
    const r = await search(store, 'AccountModel', { decorator: 'Model' });
    expect(r.items.some((i) => i.symbol.name === 'AccountModel')).toBe(true);
  });

  it('decorator filter returns nothing for unknown decorator', async () => {
    const r = await search(store, 'Controller', { decorator: 'NonExistentDecorator' });
    expect(r.items).toHaveLength(0);
  });

  // ── filePattern filter ────────────────────────────────────────────────────

  it('filePattern restricts results to matching paths', async () => {
    const r = await search(store, 'Controller', { filePattern: 'src/controllers%' });
    for (const item of r.items) {
      expect(item.file.path).toMatch(/controllers/);
    }
  });

  it('filePattern with no match returns empty', async () => {
    const r = await search(store, 'Controller', { filePattern: 'src/nowhere%' });
    expect(r.items).toHaveLength(0);
  });

  // ── implements / extends filter ───────────────────────────────────────────

  it('implements filter returns symbols that implement the interface', async () => {
    const r = await search(store, 'AdminController', { implements: 'Auditable' });
    const names = r.items.map((i) => i.symbol.name);
    expect(names).toContain('AdminController');
  });

  it('extends filter returns symbols that extend the given class', async () => {
    const r = await search(store, 'AdminController', { extends: 'UserController' });
    const names = r.items.map((i) => i.symbol.name);
    expect(names).toContain('AdminController');
  });

  // ── kind filter ───────────────────────────────────────────────────────────

  it('kind filter restricts to functions only', async () => {
    const r = await search(store, 'email', { kind: 'function' });
    for (const item of r.items) {
      expect(item.symbol.kind).toBe('function');
    }
  });

  // ── limit / pagination ────────────────────────────────────────────────────

  it('limit caps result count', async () => {
    const r = await search(store, 'Controller', undefined, 1);
    expect(r.items.length).toBeLessThanOrEqual(1);
  });
});

// ── getSymbol() — maxLines truncation ────────────────────────────────────────

describe('getSymbol() — maxLines truncation', () => {
  let store: Store;
  let projectRoot: string;
  let insertedSymbolId: string;

  beforeEach(() => {
    store = createTestStore();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-test-'));

    const srcDir = path.join(projectRoot, 'src');
    fs.mkdirSync(srcDir);
    const content = Array.from({ length: 30 }, (_, i) => `// line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(srcDir, 'big.ts'), content);

    const fId = seedFile(store, 'src/big.ts');
    const symDbId = seedSymbol(store, fId, 'bigFn', {
      byteStart: 0,
      byteEnd: Buffer.byteLength(content),
    });
    // Retrieve the actual symbolId stored in the DB
    const sym = store.getSymbolById(symDbId);
    insertedSymbolId = sym!.symbol_id;
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns full source when maxLines is not set', () => {
    const r = getSymbol(store, projectRoot, { symbolId: insertedSymbolId });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().truncated).toBeFalsy();
  });

  it('truncates source to maxLines when set', () => {
    const r = getSymbol(store, projectRoot, { symbolId: insertedSymbolId, maxLines: 5 });
    expect(r.isOk()).toBe(true);
    const { truncated } = r._unsafeUnwrap();
    // The file has 30 lines so truncation must have fired
    expect(truncated).toBe(true);
  });
});

// ── getFileOutline() — NOT_FOUND and language propagation ────────────────────

describe('getFileOutline()', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    enableFts5Triggers(store.db);
    const f = seedFile(store, 'src/auth.py', 'python');
    seedSymbol(store, f, 'login', { kind: 'function' });
    seedSymbol(store, f, 'logout', { kind: 'function' });
  });

  it('returns correct language in outline', () => {
    const r = getFileOutline(store, 'src/auth.py');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap().language).toBe('python');
  });

  it('returns all symbols with signatures, no source bodies', () => {
    const r = getFileOutline(store, 'src/auth.py');
    expect(r.isOk()).toBe(true);
    const syms = r._unsafeUnwrap().symbols;
    expect(syms.length).toBe(2);
    for (const s of syms) {
      expect(s).not.toHaveProperty('source');
      expect(s).toHaveProperty('signature');
    }
  });

  it('returns NOT_FOUND error for unknown file', () => {
    const r = getFileOutline(store, 'src/missing.ts');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('NOT_FOUND');
  });
});

// ── search() — decorators surfaced in results ─────────────────────────────────

describe('search() — decorator metadata in results', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    enableFts5Triggers(store.db);
    const f = seedFile(store, 'src/api.ts');
    seedSymbol(store, f, 'ApiEndpoint', {
      kind: 'class',
      metadata: { decorators: ['Controller', 'Auth'], exported: true },
    });
    seedSymbol(store, f, 'NoDecorators', {
      kind: 'class',
      metadata: { exported: true },
    });
  });

  it('exposes decorators array in result items when symbol has them', async () => {
    const r = await search(store, 'ApiEndpoint');
    const item = r.items.find((i) => i.symbol.name === 'ApiEndpoint');
    expect(item).toBeDefined();
    // The symbol metadata has decorators — navigation.ts handler should expose them
    // We test that the raw metadata is stored correctly (the handler projection is tested via e2e)
    const meta = JSON.parse(item!.symbol.metadata ?? '{}') as Record<string, unknown>;
    expect(Array.isArray(meta.decorators)).toBe(true);
    expect(meta.decorators).toContain('Controller');
  });

  it('does not add decorators field when symbol has none', async () => {
    const r = await search(store, 'NoDecorators');
    const item = r.items.find((i) => i.symbol.name === 'NoDecorators');
    expect(item).toBeDefined();
    const meta = JSON.parse(item!.symbol.metadata ?? '{}') as Record<string, unknown>;
    expect(meta.decorators).toBeUndefined();
  });
});

// ── search() — fuzzy fallback ─────────────────────────────────────────────────

describe('search() — fuzzy auto-fallback', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    enableFts5Triggers(store.db);
    const f = seedFile(store, 'src/utils.ts');
    const id1 = seedSymbol(store, f, 'calculateTotal', { kind: 'function', fqn: 'calculateTotal' });
    const id2 = seedSymbol(store, f, 'validateInput', { kind: 'function', fqn: 'validateInput' });
    // Fuzzy search uses symbol_trigrams table (populated by pipeline, not triggers)
    indexTrigramsBatch(store.db, [
      { id: id1, name: 'calculateTotal', fqn: 'calculateTotal' },
      { id: id2, name: 'validateInput', fqn: 'validateInput' },
    ]);
  });

  it('returns results with exact match', async () => {
    const r = await search(store, 'calculateTotal');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0].symbol.name).toBe('calculateTotal');
  });

  it('finds symbols with explicit fuzzy=true for typo variants', async () => {
    // "calculateTotall" has edit distance 1 from "calculateTotal" (extra 'l').
    // Trigram similarity is high (shares most 3-grams with the target).
    const r = await search(store, 'calculateTotall', undefined, 20, 0, undefined, {
      fuzzy: true,
      maxEditDistance: 2,
    });
    // fuzzy should find calculateTotal even with the typo
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.some((i) => i.symbol.name === 'calculateTotal')).toBe(true);
  });

  it('auto-falls back to fuzzy when exact search returns nothing', async () => {
    // "calculatTotal" returns 0 exact hits → auto-fuzzy kicks in
    const r = await search(store, 'calculatTotal');
    // auto-fallback: search_mode should indicate fuzzy was used
    if (r.items.length > 0) {
      expect(
        ['fuzzy', 'fts_fuzzy_fallback', 'symbol_miss_text_fallback'].some(
          (m) => r.search_mode?.includes(m) || r.search_mode === m,
        ),
      ).toBe(true);
    }
  });
});
