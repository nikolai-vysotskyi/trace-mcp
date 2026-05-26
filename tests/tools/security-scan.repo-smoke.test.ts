/**
 * Real-repo smoke test for scanSecurity.
 *
 * Opens the project's persisted SQLite index (if present) and runs
 * scanSecurity against all files. Asserts that the 11 false-positive
 * critical findings audited in the task brief are gone:
 *
 *   - src/cli/visualize.ts          execSync(`open "${filePath}"`)
 *   - src/cli/visualize.ts          execSync(`start "" "${filePath}"`)
 *   - src/cli/visualize.ts          execSync(`xdg-open "${filePath}"`)
 *   - src/daemon/lifecycle.ts       execSync(`taskkill /PID ${pid}`)
 *   - src/lsp/config.ts             execSync(`which ${command}`)
 *
 * If the index DB is not present (e.g. fresh clone), the test is skipped.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../../src/db/store.js';
import { getDbPath } from '../../src/global.js';
import { scanSecurity } from '../../src/tools/quality/security-scan.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = getDbPath(REPO_ROOT);

describe.runIf(existsSync(DB_PATH))('scanSecurity: real-repo smoke', () => {
  test('no critical findings inside known-safe execSync call sites', () => {
    const db = new Database(DB_PATH, { readonly: true });
    const store = new Store(db);

    const result = scanSecurity(store, REPO_ROOT, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();

    const critical = data.findings.filter((f) => f.severity === 'critical');
    const high = data.findings.filter((f) => f.severity === 'high');
    // Diagnostic output — visible when running this test directly.
    console.log(
      `[smoke] files_scanned=${data.files_scanned} critical=${critical.length} high=${high.length}`,
    );
    for (const f of critical) {
      console.log(`  CRITICAL ${f.file}:${f.line}  [${f.rule_id}] ${f.snippet.slice(0, 100)}`);
    }
    for (const f of high) {
      console.log(`  HIGH     ${f.file}:${f.line}  [${f.rule_id}] ${f.snippet.slice(0, 100)}`);
    }
    const auditedSafeFiles = new Set([
      'src/cli/visualize.ts',
      'src/daemon/lifecycle.ts',
      'src/lsp/config.ts',
    ]);
    const offending = critical.filter((f) => auditedSafeFiles.has(f.file));

    if (offending.length > 0) {
      console.error(
        'Audited-safe files still report critical findings:',
        offending.map((f) => `${f.file}:${f.line} [${f.rule_id}] ${f.snippet.slice(0, 80)}`),
      );
    }
    expect(offending).toHaveLength(0);

    // Sanity: confidence field is set for every finding.
    for (const f of data.findings) {
      expect(['low', 'medium', 'high']).toContain(f.confidence);
    }
  });
});
