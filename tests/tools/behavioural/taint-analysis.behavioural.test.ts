/**
 * Behavioural coverage for the `taint_analysis` MCP tool.
 *
 * Asserts the cross-cutting contract a caller relies on:
 *  - `req.params.x` flowing into `db.query(`...${x}`)` produces an
 *    unsanitized SQL flow tagged with CWE-89.
 *  - `sinks: ['sql_query']` filter narrows results to SQL sinks.
 *  - `sources: ['http_param']` filter narrows results to HTTP params.
 *  - A no-flow fixture returns an empty flows array.
 *  - The flow shape carries `cwe` on the sink.
 *
 * taintAnalysis reads files from disk; each test writes fixtures and
 * registers the file in the in-memory store.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { taintAnalysis } from '../../../src/tools/quality/taint-analysis.js';
import { createTestStore } from '../../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-taint-behav-${process.pid}`);

function writeFixture(
  store: Store,
  relPath: string,
  content: string,
  language = 'typescript',
): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  store.insertFile(relPath, language, `h_${relPath}`, content.length);
}

describe('taint_analysis — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createTestStore();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('req.params flowing to db.query produces an unsanitized SQL flow', () => {
    writeFixture(
      store,
      'src/route.ts',
      [
        'function handler(req, res) {',
        '  const id = req.params.id;',
        '  db.query(`SELECT * FROM users WHERE id = ${id}`);',
        '}',
      ].join('\n'),
    );

    const result = taintAnalysis(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.flows.length).toBeGreaterThanOrEqual(1);
    const sqlFlow = data.flows.find((f) => f.sink.kind === 'sql_query');
    expect(sqlFlow).toBeDefined();
    expect(sqlFlow!.sanitized).toBe(false);
    expect(sqlFlow!.sink.cwe).toBe('CWE-89');
    expect(sqlFlow!.source.kind).toBe('http_param');
  });

  it('sinks: ["sql_query"] filter narrows results to SQL sinks only', () => {
    writeFixture(
      store,
      'src/mix.ts',
      [
        'function handler(req, res) {',
        '  const id = req.params.id;',
        '  db.query(`SELECT * FROM users WHERE id = ${id}`);',
        '  res.send(id);',
        '}',
      ].join('\n'),
    );

    const result = taintAnalysis(store, TEST_DIR, { sinks: ['sql_query'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    for (const f of data.flows) {
      expect(f.sink.kind).toBe('sql_query');
    }
  });

  it('sources: ["http_param"] filter narrows results to HTTP param sources only', () => {
    writeFixture(
      store,
      'src/env.ts',
      [
        'function handler(req, res) {',
        '  const fromEnv = process.env.SECRET;',
        '  const fromParam = req.params.id;',
        '  db.query(`SELECT * FROM users WHERE id = ${fromParam}`);',
        '  db.query(`SELECT * FROM secrets WHERE k = ${fromEnv}`);',
        '}',
      ].join('\n'),
    );

    const result = taintAnalysis(store, TEST_DIR, { sources: ['http_param'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    for (const f of data.flows) {
      expect(f.source.kind).toBe('http_param');
    }
  });

  it('a no-flow fixture returns an empty flows array', () => {
    writeFixture(
      store,
      'src/pure.ts',
      ['export function add(a: number, b: number): number {', '  return a + b;', '}'].join('\n'),
    );

    const result = taintAnalysis(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.flows).toEqual([]);
    expect(data.summary.total).toBe(0);
  });

  it('flow output carries documented shape with cwe and path fields', () => {
    writeFixture(
      store,
      'src/shape.ts',
      [
        'function handler(req, res) {',
        '  const id = req.params.id;',
        '  db.query(`SELECT * FROM t WHERE x = ${id}`);',
        '}',
      ].join('\n'),
    );

    const result = taintAnalysis(store, TEST_DIR, {});
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.flows.length).toBeGreaterThanOrEqual(1);
    const flow = data.flows[0];
    expect(typeof flow.source.kind).toBe('string');
    expect(typeof flow.source.line).toBe('number');
    expect(typeof flow.sink.kind).toBe('string');
    expect(typeof flow.sink.cwe).toBe('string');
    expect(flow.sink.cwe.startsWith('CWE-')).toBe(true);
    expect(Array.isArray(flow.path)).toBe(true);
    expect(typeof flow.sanitized).toBe('boolean');
    expect(['high', 'medium', 'low']).toContain(flow.confidence);
    expect(typeof flow.file).toBe('string');
  });
});
