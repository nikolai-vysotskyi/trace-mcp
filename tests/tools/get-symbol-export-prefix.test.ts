/**
 * Regression for P2-1: get_symbol source slicer off-by-N.
 *
 * Tree-sitter records the inner `function_declaration` node's byte range,
 * which excludes the surrounding `export_statement` and modifiers like
 * `async` / `default` / visibility keywords. The reader must extend the
 * slice back to include those leading modifiers on the same line — otherwise
 * an exported function reads back as "t function foo(" instead of
 * "export function foo(".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getSymbol } from '../../src/tools/navigation/navigation.js';
import { createTestStore } from '../test-utils.js';

function seedSymbolFor(
  store: Store,
  filePath: string,
  fileContent: string,
  innerDeclarationText: string,
  symbolName: string,
): string {
  const fileId = store.insertFile(filePath, 'typescript', `hash:${filePath}`, fileContent.length);
  // Locate the inner `function …` declaration — this mimics what tree-sitter
  // records for `export function …` (the outer `export_statement` wraps it).
  const innerStart = fileContent.indexOf(innerDeclarationText);
  if (innerStart < 0) throw new Error(`fixture missing: ${innerDeclarationText}`);
  const innerEnd = innerStart + innerDeclarationText.length;
  const dbId = store.insertSymbol(fileId, {
    symbolId: `${filePath}::${symbolName}#function`,
    name: symbolName,
    kind: 'function',
    byteStart: innerStart,
    byteEnd: innerEnd,
    metadata: {},
  });
  return store.getSymbolById(dbId)!.symbol_id;
}

describe('getSymbol — leading-modifier reconstruction (P2-1)', () => {
  let projectRoot: string;
  let store: Store;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'get-symbol-prefix-'));
    store = createTestStore();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('includes `export` prefix for exported function', () => {
    const file = 'src/exported.ts';
    const inner = 'function getProjectMap() { return 42; }';
    const content = `export ${inner}\n`;
    fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, file), content);

    const symId = seedSymbolFor(store, file, content, inner, 'getProjectMap');
    const r = getSymbol(store, projectRoot, { symbolId: symId });
    expect(r.isOk()).toBe(true);
    const { source } = r._unsafeUnwrap();
    expect(source.startsWith('export function getProjectMap(')).toBe(true);
  });

  it('includes `export async` prefix for exported async function', () => {
    const file = 'src/exported-async.ts';
    const inner = 'function fetchData() { return Promise.resolve(1); }';
    const content = `export async ${inner}\n`;
    fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, file), content);

    const symId = seedSymbolFor(store, file, content, inner, 'fetchData');
    const r = getSymbol(store, projectRoot, { symbolId: symId });
    expect(r.isOk()).toBe(true);
    const { source } = r._unsafeUnwrap();
    expect(source.startsWith('export async function fetchData(')).toBe(true);
  });

  it('includes `export default` prefix for default-exported function', () => {
    const file = 'src/exported-default.ts';
    const inner = 'function main() { return 0; }';
    const content = `export default ${inner}\n`;
    fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, file), content);

    const symId = seedSymbolFor(store, file, content, inner, 'main');
    const r = getSymbol(store, projectRoot, { symbolId: symId });
    expect(r.isOk()).toBe(true);
    const { source } = r._unsafeUnwrap();
    expect(source.startsWith('export default function main(')).toBe(true);
  });

  it('leaves a non-exported function untouched', () => {
    const file = 'src/private.ts';
    const inner = 'function privateHelper() { return 1; }';
    const content = `${inner}\n`;
    fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, file), content);

    const symId = seedSymbolFor(store, file, content, inner, 'privateHelper');
    const r = getSymbol(store, projectRoot, { symbolId: symId });
    expect(r.isOk()).toBe(true);
    const { source } = r._unsafeUnwrap();
    expect(source.startsWith('function privateHelper(')).toBe(true);
    // The reader must NOT inject a non-existent prefix.
    expect(source.startsWith('export ')).toBe(false);
  });

  it('does not absorb arbitrary text from previous line', () => {
    // Previous line ends with something that is not a modifier — the slice
    // must stay on the symbol's own line.
    const file = 'src/mixed.ts';
    const inner = 'function isolated() { return 1; }';
    const content = `const sentinel = 42;\n${inner}\n`;
    fs.mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, file), content);

    const symId = seedSymbolFor(store, file, content, inner, 'isolated');
    const r = getSymbol(store, projectRoot, { symbolId: symId });
    expect(r.isOk()).toBe(true);
    const { source } = r._unsafeUnwrap();
    expect(source.startsWith('function isolated(')).toBe(true);
    expect(source.includes('sentinel')).toBe(false);
  });
});
