/**
 * Behavioural coverage for the `scan_code_smells` MCP tool.
 *
 * Asserts the cross-cutting contract a caller relies on:
 *  - `todo_comment` category fires on a `// TODO:` line and tags it.
 *  - `hardcoded_value` category fires on an obvious hardcoded IP literal.
 *  - `debug_artifact` category fires on a `console.log(...)` line.
 *  - `empty_function` category fires when a function body is empty.
 *  - `category` filter narrows the result to only requested detectors.
 *
 * scanCodeSmells reads files from disk; each test writes fixtures and
 * registers the file in the in-memory store.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { scanCodeSmells } from '../../../src/tools/quality/code-smells.js';
import { createTestStore } from '../../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-smells-behav-${process.pid}`);

function writeFixture(
  store: Store,
  relPath: string,
  content: string,
  language = 'typescript',
): number {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  return store.insertFile(relPath, language, `h_${relPath}`, content.length);
}

describe('scan_code_smells — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createTestStore();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('todo_comment detector flags // TODO: lines with the TODO tag', () => {
    writeFixture(
      store,
      'src/todo.ts',
      [
        'export function go() {',
        '  // TODO: rewrite this once the API stabilizes',
        '  return 1;',
        '}',
      ].join('\n'),
    );

    const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const todos = data.findings.filter((f) => f.category === 'todo_comment');
    expect(todos.length).toBeGreaterThanOrEqual(1);
    expect(todos[0].file).toBe('src/todo.ts');
    expect(todos[0].line).toBeGreaterThan(0);
    expect(todos[0].tag).toBe('TODO');
  });

  it('hardcoded_value detector flags a hardcoded public IP literal', () => {
    // 1.2.3.4 is a public IP, not loopback/localhost, so should fire.
    writeFixture(store, 'src/net.ts', ['export const host = "1.2.3.4";'].join('\n'));

    const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const hits = data.findings.filter((f) => f.category === 'hardcoded_value');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].file).toBe('src/net.ts');
  });

  it('debug_artifact detector flags console.log() statements', () => {
    writeFixture(
      store,
      'src/debug.ts',
      ['export function go() {', '  console.log("hello");', '  return 1;', '}'].join('\n'),
    );

    const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const hits = data.findings.filter((f) => f.category === 'debug_artifact');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].file).toBe('src/debug.ts');
    expect(hits[0].tag).toBe('console_log');
  });

  it('empty_function detector flags a function with an empty body', () => {
    const body = ['export function noop() {}', ''].join('\n');
    const fileId = writeFixture(store, 'src/empty.ts', body);
    // Empty-function detection reads from symbols table; insert a matching symbol row.
    store.insertSymbol(fileId, {
      symbolId: 'src/empty.ts::noop#function',
      name: 'noop',
      kind: 'function',
      fqn: 'noop',
      byteStart: 0,
      byteEnd: body.length,
      lineStart: 1,
      lineEnd: 1,
      signature: 'function noop()',
    });

    const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const hits = data.findings.filter((f) => f.category === 'empty_function');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].symbol).toBe('noop');
  });

  it('category filter narrows scope to requested detectors only', () => {
    writeFixture(
      store,
      'src/mixed.ts',
      [
        'export function go() {',
        '  // TODO: refactor',
        '  console.log("x");',
        '  return 1;',
        '}',
      ].join('\n'),
    );

    const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    // All findings must be of the requested category — no debug_artifact leakage.
    for (const f of data.findings) {
      expect(f.category).toBe('todo_comment');
    }
    expect(data.total).toBe(data.findings.length);
  });
});
