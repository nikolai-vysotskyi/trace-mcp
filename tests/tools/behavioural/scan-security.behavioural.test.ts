/**
 * Behavioural coverage for the `scan_security` MCP tool. The existing
 * tests/tools/security-scan.test.ts has per-rule unit coverage; this file
 * complements it by asserting the cross-cutting contract a caller relies on:
 *
 *  - SQL injection fixture (`db.query(req.params.x)`) produces a finding
 *    tagged with CWE-89 and a non-zero line number.
 *  - Hardcoded secrets fixture (literal `password = "..."`) produces a
 *    CWE-798 finding.
 *  - `severityThreshold='high'` filters out low/medium severity findings.
 *  - `rules: ['all']` activates the full rule suite — a fixture that mixes
 *    SQL injection and hardcoded secrets yields both rule IDs.
 *  - The `summary` envelope reports counts that match `findings.length`.
 *
 *  scan_security reads files from disk, so each test writes a fixture file
 *  into a tmp directory and registers it with the in-memory store.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { scanSecurity } from '../../../src/tools/quality/security-scan.js';
import { createTestStore } from '../../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-scan-sec-behav-${process.pid}`);

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

describe('scan_security — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = createTestStore();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('SQL injection rule flags db.query interpolation with CWE-89', () => {
    writeFixture(
      store,
      'src/route.ts',
      [
        'function handler(req: any) {',
        '  db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);',
        '}',
      ].join('\n'),
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings.some((f) => f.rule_id === 'CWE-89')).toBe(true);
    const sqlFinding = data.findings.find((f) => f.rule_id === 'CWE-89')!;
    expect(sqlFinding.file).toBe('src/route.ts');
    expect(sqlFinding.line).toBeGreaterThan(0);
    expect(typeof sqlFinding.snippet).toBe('string');
  });

  it('hardcoded secrets rule flags literal password assignment with CWE-798', () => {
    // Use a clearly-fake token. False-positive filters drop the line if
    // anything looks like a placeholder, so the literal here is plain
    // alphanumerics with no "example"/"changeme"/"test" markers.
    writeFixture(
      store,
      'src/config.ts',
      ['export const password = "aZ9bQ7mY3kP1xR2sLv";'].join('\n'),
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings.some((f) => f.rule_id === 'CWE-798')).toBe(true);
  });

  it('severityThreshold="high" filters out medium and low findings', () => {
    // CWE-89 (sql_injection) is critical, CWE-327 (insecure_crypto) is medium.
    writeFixture(
      store,
      'src/mix.ts',
      [
        'function go(req: any) {',
        '  db.query(`SELECT * FROM t WHERE x = ${req.params.x}`);',
        '  const h = crypto.createHash("md5");',
        '}',
      ].join('\n'),
    );

    const all = scanSecurity(store, TEST_DIR, {
      rules: ['sql_injection', 'insecure_crypto'],
    });
    const highOnly = scanSecurity(store, TEST_DIR, {
      rules: ['sql_injection', 'insecure_crypto'],
      severityThreshold: 'high',
    });
    expect(all.isOk()).toBe(true);
    expect(highOnly.isOk()).toBe(true);
    const allData = all._unsafeUnwrap();
    const highData = highOnly._unsafeUnwrap();
    // 'high' threshold keeps critical and high severities — drops medium/low.
    expect(highData.findings.every((f) => f.severity === 'critical' || f.severity === 'high')).toBe(
      true,
    );
    // 'all' invocation should have at least as many findings as high-only.
    expect(allData.findings.length).toBeGreaterThanOrEqual(highData.findings.length);
  });

  it('rules: ["all"] enables every rule and surfaces multiple rule IDs', () => {
    writeFixture(
      store,
      'src/everything.ts',
      [
        'function go(req: any) {',
        '  db.query(`SELECT * FROM t WHERE x = ${req.params.x}`);',
        '  const password = "aZ9bQ7mY3kP1xR2sLv";',
        '  return password;',
        '}',
      ].join('\n'),
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const ruleIds = new Set(data.findings.map((f) => f.rule_id));
    expect(ruleIds.has('CWE-89')).toBe(true);
    expect(ruleIds.has('CWE-798')).toBe(true);
  });

  it('summary counts match findings.length per severity', () => {
    writeFixture(
      store,
      'src/sql.ts',
      [
        'function go(req: any) {',
        '  db.query(`SELECT * FROM t WHERE x = ${req.params.x}`);',
        '}',
      ].join('\n'),
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const total =
      data.summary.critical + data.summary.high + data.summary.medium + data.summary.low;
    expect(total).toBe(data.findings.length);
    expect(typeof data.files_scanned).toBe('number');
    expect(data.files_scanned).toBeGreaterThanOrEqual(1);
  });
});
