/**
 * Precision tests for scanSecurity — the false-positive shapes audited in TRA-340.
 *
 * Every "drops" test is paired with a "still detects" test on the same shape with
 * the safety signal removed, so a precision fix cannot silently cost recall.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { type RuleName, scanSecurity } from '../../src/tools/quality/security-scan.js';
import { createTestStore } from '../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-security-precision-${process.pid}`);

function writeFile(store: Store, relPath: string, content: string, language: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  store.insertFile(relPath, language, `hash-${relPath}`, content.length);
}

describe('scanSecurity precision (TRA-340)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  function scan(rules: RuleName[], opts: { includeLow?: boolean } = {}) {
    const result = scanSecurity(store, TEST_DIR, {
      rules,
      includeLowConfidence: opts.includeLow,
    });
    expect(result.isOk()).toBe(true);
    return result._unsafeUnwrap();
  }

  // -------------------------------------------------------------------
  // 1. Backward guard scan
  // -------------------------------------------------------------------

  test('drops a SQL sink guarded by an assert* call above it', () => {
    writeFile(
      store,
      'src/vec.ts',
      `
class Vec {
  clear(): void {
    assertSafeSqliteIdentifier(this.table);
    this.db.exec(\`DROP TABLE IF EXISTS \${this.table}\`);
  }
}
`,
      'typescript',
    );
    expect(scan(['sql_injection']).findings).toHaveLength(0);
  });

  test('still detects the same SQL sink when the assert* guard is absent', () => {
    writeFile(
      store,
      'src/vec.ts',
      `
class Vec {
  clear(): void {
    this.db.exec(\`DROP TABLE IF EXISTS \${this.table}\`);
  }
}
`,
      'typescript',
    );
    const findings = scan(['sql_injection']).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  test('drops a path sink guarded by an early-return type check above it', () => {
    writeFile(
      store,
      'src/lifecycle.ts',
      `
export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf-8');
  return stat;
}
`,
      'typescript',
    );
    expect(scan(['path_traversal']).findings).toHaveLength(0);
  });

  test('still detects the same path sink when the early-return guard is absent', () => {
    writeFile(
      store,
      'src/lifecycle.ts',
      `
export function captureProcessStartToken(pid: number): string | null {
  const stat = fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf-8');
  return stat;
}
`,
      'typescript',
    );
    expect(scan(['path_traversal']).findings).toHaveLength(1);
  });

  test('does not accept a guard on a different value as a guard on the sink', () => {
    writeFile(
      store,
      'src/other.ts',
      `
export function read(pid: number, other: string): string {
  if (!Number.isInteger(other)) throw new Error('bad');
  return fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf-8');
}
`,
      'typescript',
    );
    expect(scan(['path_traversal']).findings).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // 2. Escaper recognition across a full concatenation
  // -------------------------------------------------------------------

  test('drops innerHTML whose every non-literal operand is escaped', () => {
    writeFile(
      store,
      'src/tooltip.ts',
      `
function render(n) {
  tooltip.innerHTML = '<strong>' + esc(n.label) + '</strong><br>'
    + '<span>' + esc(n.id) + '</span><br>'
    + esc(n.type);
}
`,
      'typescript',
    );
    expect(scan(['xss']).findings).toHaveLength(0);
  });

  test('still detects innerHTML when one operand is unescaped', () => {
    writeFile(
      store,
      'src/tooltip.ts',
      `
function render(n) {
  tooltip.innerHTML = '<strong>' + esc(n.label) + '</strong><br>'
    + '<span>' + n.id + '</span>';
}
`,
      'typescript',
    );
    const findings = scan(['xss']).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });

  // -------------------------------------------------------------------
  // 3. SSRF: fixed authority, and config-derived origin
  // -------------------------------------------------------------------

  test('drops fetch whose host is a constant and only the path is interpolated', () => {
    writeFile(
      store,
      'src/gemini.ts',
      `
const BASE_URL = 'https://generativelanguage.googleapis.com';
async function listModels() {
  const resp = await fetch(\`\${BASE_URL}/v1beta/models?key=\${this.config.apiKey}\`, {});
  return resp;
}
`,
      'typescript',
    );
    expect(scan(['ssrf']).findings).toHaveLength(0);
  });

  test('still detects fetch when the interpolation reaches the host', () => {
    writeFile(
      store,
      'src/proxy.ts',
      `
async function call(target: string) {
  const resp = await fetch(\`https://\${target}/v1/data\`, {});
  return resp;
}
`,
      'typescript',
    );
    expect(scan(['ssrf']).findings.length).toBeGreaterThanOrEqual(1);
  });

  test('demotes a URL built from a config-derived helper to low confidence', () => {
    writeFile(
      store,
      'src/vertex.ts',
      `
class Vertex {
  async stream() {
    const resp = await fetch(\`\${modelUrl(this.cfg, this.model, 'x')}?alt=sse\`, {});
    return resp;
  }
}
`,
      'typescript',
    );
    expect(scan(['ssrf']).findings).toHaveLength(0);
    const kept = scan(['ssrf'], { includeLow: true }).findings;
    expect(kept).toHaveLength(1);
    expect(kept[0].confidence).toBe('low');
  });

  // -------------------------------------------------------------------
  // 4. SQL: loop variable over a locally derived array
  // -------------------------------------------------------------------

  test('demotes a SQL sink fed by a loop over a locally derived array', () => {
    writeFile(
      store,
      'src/wipe.ts',
      `
function wipe(db) {
  const rows = db.prepare('SELECT name FROM sqlite_master').all();
  const targets = rows.map((r) => r.name).filter((name) => !PRESERVE.has(name));
  for (const name of targets) {
    db.exec(\`DELETE FROM "\${name}"\`);
  }
}
`,
      'typescript',
    );
    expect(scan(['sql_injection']).findings).toHaveLength(0);
    const kept = scan(['sql_injection'], { includeLow: true }).findings;
    expect(kept).toHaveLength(1);
    expect(kept[0].confidence).toBe('low');
  });

  test('still detects a SQL sink fed by a loop over request data', () => {
    writeFile(
      store,
      'src/wipe.ts',
      `
function wipe(db, req) {
  const targets = req.body.tables;
  for (const name of targets) {
    db.exec(\`DELETE FROM "\${name}"\`);
  }
}
`,
      'typescript',
    );
    const findings = scan(['sql_injection']).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  // -------------------------------------------------------------------
  // 5. Comment stripping survives regex literals containing quotes
  // -------------------------------------------------------------------

  test('strips a block comment that follows a regex literal containing quotes', () => {
    writeFile(
      store,
      'src/patterns.ts',
      `
const RE = /\\buseSWR\\s*\\(\\s*['"\`](\\/[^'"\`$]*?)['"\`]/g;

/**
 * Template literal fetch patterns with interpolation.
 * e.g., fetch(\`/api/users/\${id}\`) -> '/api/users/:param'
 */
export const OTHER = 1;
`,
      'typescript',
    );
    expect(scan(['ssrf']).findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Recall: the one true positive this repo actually had (fixed in #489)
  // -------------------------------------------------------------------

  test('still detects execSync with an interpolated output path', () => {
    writeFile(
      store,
      'src/cli/visualize.ts',
      `
export function openReport(outputPath: string): void {
  execSync(\`trace-mcp visualize --output \${outputPath}\`);
}
`,
      'typescript',
    );
    const findings = scan(['command_injection']).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].rule_id).toBe('CWE-78');
    expect(findings[0].severity).toBe('critical');
  });

  // -------------------------------------------------------------------
  // 6. Low-confidence findings are opt-in, and counted when suppressed
  // -------------------------------------------------------------------

  test('suppresses low-confidence findings by default and reports the count', () => {
    writeFile(
      store,
      'src/move.ts',
      `
function move(params) {
  const targetAbsPath = path.resolve(projectRoot, params.target_file);
  return targetAbsPath;
}
`,
      'typescript',
    );
    const def = scan(['path_traversal']);
    expect(def.findings).toHaveLength(0);
    expect(def.suppressed_low_confidence).toBe(1);

    const all = scan(['path_traversal'], { includeLow: true });
    expect(all.findings).toHaveLength(1);
    expect(all.findings[0].confidence).toBe('low');
    expect(all.suppressed_low_confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Whole-repo precision baseline
// ---------------------------------------------------------------------------

/**
 * TRA-340 audited every scan_security finding on this repo one by one: 16
 * pattern hits, all false positives (the single true positive was fixed in
 * PR #489). The default output must therefore be empty — but the scanner must
 * still be live, which the suppressed-count assertion below proves.
 *
 * A failure here is not "loosen the test": it is either a real finding to fix
 * or a new false-positive shape to teach the scanner.
 *
 * The file list comes from git rather than the index DB so this runs on a fresh
 * clone (the repo-smoke test needs an indexed DB and is skipped in CI).
 */
describe('scanSecurity: whole-repo precision baseline (TRA-340)', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..');

  test('reports nothing by default, and holds its low-confidence findings', () => {
    const tracked = execSync('git ls-files "src/**" "packages/**"', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter((p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));
    expect(tracked.length).toBeGreaterThan(100);

    const store = createTestStore();
    for (const rel of tracked) {
      store.insertFile(rel, rel.endsWith('x') ? 'typescript' : 'typescript', `h-${rel}`, 1);
    }

    const def = scanSecurity(store, REPO_ROOT, { rules: ['all'] })._unsafeUnwrap();
    const all = scanSecurity(store, REPO_ROOT, {
      rules: ['all'],
      includeLowConfidence: true,
    })._unsafeUnwrap();

    if (def.findings.length > 0) {
      console.error(
        'Unexpected scan_security findings:',
        def.findings.map((f) => `${f.file}:${f.line} [${f.rule_id}] ${f.snippet.slice(0, 80)}`),
      );
    }
    expect(def.findings).toHaveLength(0);
    expect(all.findings.length).toBeGreaterThan(0);
    expect(def.suppressed_low_confidence).toBe(all.findings.length);
  });
});
