import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { scanSecurity } from '../../src/tools/quality/security-scan.js';
import { createTestStore } from '../test-utils.js';

// Temp dir for test files
const TEST_DIR = path.join(tmpdir(), `trace-mcp-security-test-${process.pid}`);

function writeFile(store: Store, relPath: string, content: string, language: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  store.insertFile(relPath, language, `hash-${relPath}`, content.length);
}

describe('Security Scanning', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // SQL Injection (CWE-89)
  // -------------------------------------------------------------------

  test('detects SQL injection via template literal in JS/TS', () => {
    writeFile(
      store,
      'src/search.ts',
      `
const search = (query: string) => {
  db.query(\`SELECT * FROM products WHERE name LIKE '%\${query}%'\`);
};
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-89');
    expect(data.findings[0].severity).toBe('critical');
    expect(data.findings[0].line).toBe(3);
  });

  test('does not flag parameterized queries', () => {
    writeFile(
      store,
      'src/safe-search.ts',
      `
const search = (query: string) => {
  // parameterized query
  db.query('SELECT * FROM products WHERE name LIKE ?', [query]);
};
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('detects Python f-string SQL injection', () => {
    writeFile(
      store,
      'src/db.py',
      `
def search(query):
    cursor.execute(f"SELECT * FROM users WHERE name = '{query}'")
`,
      'python',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-89');
  });

  test('detects PHP SQL injection', () => {
    writeFile(
      store,
      'src/UserRepo.php',
      `<?php
$result = $db->query("SELECT * FROM users WHERE id = " . $id);
`,
      'php',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-89');
  });

  // -------------------------------------------------------------------
  // XSS (CWE-79)
  // -------------------------------------------------------------------

  test('detects dangerouslySetInnerHTML', () => {
    writeFile(
      store,
      'src/Comment.tsx',
      `
export const Comment = ({ body }: { body: string }) => (
  <div dangerouslySetInnerHTML={{ __html: body }} />
);
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-79');
  });

  test('detects Vue v-html', () => {
    writeFile(
      store,
      'src/Comment.vue',
      `
<template>
  <div v-html="comment.body" />
</template>
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('detects PHP Blade unescaped output', () => {
    writeFile(
      store,
      'src/view.blade.php',
      `
<div>{!! $user->bio !!}</div>
`,
      'php',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Command Injection (CWE-78)
  // -------------------------------------------------------------------

  test('detects exec with template literal', () => {
    writeFile(
      store,
      'src/git.ts',
      `
import { exec } from 'child_process';
const getLog = (author: string) => {
  exec(\`git log --author="\${author}"\`);
};
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-78');
    expect(data.findings[0].severity).toBe('critical');
  });

  test('detects Python subprocess with shell=True', () => {
    writeFile(
      store,
      'src/run.py',
      `
import subprocess
def run(cmd):
    subprocess.call(cmd, shell=True)
`,
      'python',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Hardcoded Secrets (CWE-798)
  // -------------------------------------------------------------------

  test('detects hardcoded API key', () => {
    writeFile(
      store,
      'src/config.ts',
      `
const API_KEY = 'sk_live_abcdef1234567890abcdef';
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-798');
  });

  test('detects AWS access key', () => {
    writeFile(
      store,
      'src/aws.ts',
      `
const KEY = 'AKIAIOSFODNN7ABCDEFG';
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('does not flag process.env references', () => {
    writeFile(
      store,
      'src/safe-config.ts',
      `
const API_KEY = process.env.API_KEY;
const secret = process.env.SECRET_TOKEN;
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('does not flag placeholder values', () => {
    writeFile(
      store,
      'src/example.ts',
      `
const api_key = 'your-key-here-changeme-placeholder';
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Insecure Crypto (CWE-327)
  // -------------------------------------------------------------------

  test('detects MD5 usage in security-adjacent path', () => {
    // File path contains "password" — heuristic flags weak hashes only in
    // security-adjacent contexts (auth/password/token/signing/etc).
    writeFile(
      store,
      'src/auth/password-hash.ts',
      `
import crypto from 'crypto';
const hash = crypto.createHash('md5').update(data).digest('hex');
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['insecure_crypto'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('detects SHA-1 when output flows into an equality compare', () => {
    writeFile(
      store,
      'src/verify.ts',
      `
import crypto from 'crypto';
function verifySignature(input: string, stored: string) {
  const digest = crypto.createHash('sha1').update(input).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(stored));
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['insecure_crypto'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].evidence).toBeDefined();
  });

  test('does not flag SHA-1 used as a content-addressable hash', () => {
    // Plain hash usage without a security context — content-addressable cache key.
    writeFile(
      store,
      'src/cache/ast-clones.ts',
      `
import { createHash } from 'crypto';
function fingerprint(content: string) {
  return createHash('sha1').update(content).digest('hex');
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['insecure_crypto'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('does not flag MD5 for checksums', () => {
    writeFile(
      store,
      'src/checksum.ts',
      `
// checksum for cache invalidation
const hash = crypto.createHash('md5').update(content).digest('hex');
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['insecure_crypto'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Path Traversal (CWE-22)
  // -------------------------------------------------------------------

  test('detects path.join with user input', () => {
    writeFile(
      store,
      'src/files.ts',
      `
app.get('/download', (req, res) => {
  const file = path.join('/uploads', req.params.filename);
  res.sendFile(file);
});
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['path_traversal'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // SSRF (CWE-918)
  // -------------------------------------------------------------------

  test('detects fetch with user input', () => {
    writeFile(
      store,
      'src/proxy.ts',
      `
app.get('/proxy', async (req, res) => {
  const data = await fetch(req.query.url);
  res.json(await data.json());
});
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Open Redirect (CWE-601)
  // -------------------------------------------------------------------

  test('detects redirect with user input', () => {
    writeFile(
      store,
      'src/auth.ts',
      `
app.get('/login', (req, res) => {
  res.redirect(req.query.returnUrl);
});
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['open_redirect'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Scope, filtering, and edge cases
  // -------------------------------------------------------------------

  test('skips test files', () => {
    writeFile(
      store,
      'src/search.test.ts',
      `
db.query(\`SELECT * FROM products WHERE name LIKE '%\${query}%'\`);
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('respects severity threshold', () => {
    writeFile(
      store,
      'src/app.ts',
      `
const hash = crypto.createHash('md5').update(data).digest('hex');
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, {
      rules: ['all'],
      severityThreshold: 'critical',
    });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    // Only critical findings (SQL injection), not medium (insecure crypto)
    for (const f of data.findings) {
      expect(f.severity).toBe('critical');
    }
  });

  test('respects scope filter', () => {
    writeFile(store, 'src/a.ts', `db.query(\`SELECT * FROM x WHERE id = \${id}\`);`, 'typescript');
    writeFile(store, 'lib/b.ts', `db.query(\`SELECT * FROM x WHERE id = \${id}\`);`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'], scope: 'src/' });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBe(1);
    expect(data.findings[0].file).toBe('src/a.ts');
  });

  test('scans all rules with "all"', () => {
    writeFile(
      store,
      'src/bad.ts',
      `
const key = 'AKIAIOSFODNN7EXAMPLE';
exec(\`rm -rf \${path}\`);
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const ruleIds = new Set(data.findings.map((f) => f.rule_id));
    expect(ruleIds.size).toBeGreaterThanOrEqual(2);
  });

  test('returns correct summary counts', () => {
    writeFile(
      store,
      'src/vuln.ts',
      `
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
exec(\`rm -rf \${path}\`);
const key = 'sk_live_abcdef1234567890abcdef';
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const total =
      data.summary.critical + data.summary.high + data.summary.medium + data.summary.low;
    expect(total).toBe(data.findings.length);
  });

  test('returns validation error for empty rules', () => {
    const result = scanSecurity(store, TEST_DIR, { rules: [] as any });
    expect(result.isErr()).toBe(true);
  });

  test('findings are sorted by severity (critical first)', () => {
    writeFile(
      store,
      'src/mixed.ts',
      `
const hash = crypto.createHash('md5').update(data).digest('hex');
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
const key = 'sk_live_abcdef1234567890abcdef';
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    if (data.findings.length >= 2) {
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      for (let i = 1; i < data.findings.length; i++) {
        expect(severityOrder[data.findings[i - 1].severity]).toBeGreaterThanOrEqual(
          severityOrder[data.findings[i].severity],
        );
      }
    }
  });

  test('handles missing files gracefully', () => {
    // Insert file into DB but don't create it on disk
    store.insertFile('src/ghost.ts', 'typescript', 'hash', 100);
    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().files_scanned).toBe(0);
  });

  test('snippet is truncated at 200 chars', () => {
    const longLine = `db.query(\`SELECT * FROM products WHERE ${'x'.repeat(300)} = \${id}\`);`;
    writeFile(store, 'src/long.ts', longLine, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    if (data.findings.length > 0) {
      expect(data.findings[0].snippet.length).toBeLessThanOrEqual(203); // 200 + '...'
    }
  });

  test('no memory leak: can scan many files', () => {
    // Create 50 files
    for (let i = 0; i < 50; i++) {
      writeFile(
        store,
        `src/file${i}.ts`,
        `
const search${i} = () => db.query(\`SELECT * FROM t WHERE id = \${id}\`);
`,
        'typescript',
      );
    }

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().files_scanned).toBe(50);
    expect(result._unsafeUnwrap().findings.length).toBe(50);
  });

  // -------------------------------------------------------------------
  // Constant-interpolation reaching-defs (FP suppression)
  // -------------------------------------------------------------------

  test('SSRF: does not flag fetch with literal const URL base', () => {
    writeFile(
      store,
      'src/ai/anthropic.ts',
      `
const BASE_URL = 'https://api.anthropic.com';
async function send() {
  return fetch(\`\${BASE_URL}/v1/messages\`);
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('SSRF: does not flag fetch against localhost', () => {
    writeFile(
      store,
      'src/daemon/client.ts',
      `
async function ping(port: number) {
  return fetch(\`http://127.0.0.1:\${port}/health\`);
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('SSRF: still flags fetch with req.query.url (true positive)', () => {
    writeFile(
      store,
      'src/proxy.ts',
      `
app.get('/proxy', async (req, res) => {
  const data = await fetch(req.query.url);
  res.json(await data.json());
});
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('command_injection: does not flag execSync with literal const arg', () => {
    writeFile(
      store,
      'src/cli/daemon.ts',
      `
import { execSync } from 'node:child_process';
const PLIST_LABEL = 'com.trace-mcp.server';
function isPlistLoaded() {
  const out = execSync(\`launchctl list \${PLIST_LABEL} 2>&1\`, { encoding: 'utf-8' });
  return !out.includes('Could not find service');
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('command_injection: still flags exec with function-parameter arg (true positive note)', () => {
    writeFile(
      store,
      'src/git.ts',
      `
import { execSync } from 'node:child_process';
function getLog(author: string) {
  return execSync(\`git log --author="\${author}"\`);
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].interpolation_source).toBe('non_constant');
  });

  test('language filtering works — does not apply JS rules to Python', () => {
    writeFile(
      store,
      'src/app.py',
      `
# This is Python, not JS
element.innerHTML = "hello"
`,
      'python',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    // innerHTML is a JS/TS pattern, should not match Python
    const jsFindings = result
      ._unsafeUnwrap()
      .findings.filter((f) => f.rule_id === 'CWE-79' && f.file.endsWith('.py'));
    expect(jsFindings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Comment stripping — patterns inside /* */ or // must not match
  // -------------------------------------------------------------------

  test('does not flag patterns inside a /* JSDoc */ block comment', () => {
    writeFile(
      store,
      'src/example.ts',
      `
/**
 * Example shape:
 * fetch(\`/api/users/\${id}\`) → '/api/users/:param'
 */
export const noop = () => {};
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('does not flag patterns inside a // line comment', () => {
    writeFile(
      store,
      'src/example2.ts',
      `
// db.query(\`SELECT * FROM x WHERE id = \${id}\`); — example only
export const noop = () => {};
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // XSS — innerHTML safe shapes
  // -------------------------------------------------------------------

  test('XSS: innerHTML = empty string is not flagged', () => {
    writeFile(
      store,
      'src/clear.ts',
      `
function reset(container: HTMLElement) {
  container.innerHTML = '';
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('XSS: innerHTML = static string literal is not flagged', () => {
    writeFile(
      store,
      'src/static.ts',
      `
function reset(container: HTMLElement) {
  container.innerHTML = "<div>static literal</div>";
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('XSS: innerHTML = sanitizer(x) on RHS is not flagged', () => {
    writeFile(
      store,
      'src/safe-html.ts',
      `
function setLabel(el: HTMLElement, n: { label: string }) {
  el.innerHTML = esc(n.label);
}
function set2(el: HTMLElement, s: string) {
  el.innerHTML = DOMPurify.sanitize(s);
}
function set3(el: HTMLElement, s: string) {
  el.innerHTML = encodeURIComponent(s);
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('XSS: innerHTML = raw concat is still flagged', () => {
    writeFile(
      store,
      'src/bad-html.ts',
      `
function setLabel(el: HTMLElement, name: string) {
  el.innerHTML = '<strong>' + name + '</strong>';
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Path Traversal — known root anchors downgraded
  // -------------------------------------------------------------------

  test('Path traversal: path.resolve(projectRoot, x) is downgraded to low', () => {
    writeFile(
      store,
      'src/move.ts',
      `
import path from 'node:path';
function moveSymbol(projectRoot: string, params: { target_file: string }) {
  const targetAbsPath = path.resolve(projectRoot, params.target_file);
  return targetAbsPath;
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['path_traversal'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const highOrAbove = data.findings.filter(
      (f) => f.severity === 'critical' || f.severity === 'high',
    );
    expect(highOrAbove).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // SSRF — BASE/url localhost constant downgraded or dropped
  // -------------------------------------------------------------------

  test('SSRF: fetch with BASE bound to localhost is dropped', () => {
    writeFile(
      store,
      'src/electron/api.ts',
      `
const BASE = 'http://localhost:3001';
async function load() {
  return fetch(\`\${BASE}/api/things\`);
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('SSRF: fetch with daemonUrl base ident (unresolved) is downgraded, not high', () => {
    writeFile(
      store,
      'src/electron/api2.ts',
      `
async function load(daemonUrl: string) {
  return fetch(\`\${daemonUrl}/api/things\`);
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    for (const f of data.findings) {
      expect(['low', 'medium']).toContain(f.severity);
    }
  });

  // -------------------------------------------------------------------
  // Command injection — open / which / taskkill safe shapes
  // -------------------------------------------------------------------

  test('command_injection: execSync(`open "${filePath}"`) is downgraded to medium', () => {
    writeFile(
      store,
      'src/cli/open.ts',
      `
import { execSync } from 'node:child_process';
function openInBrowser(filePath: string) {
  execSync(\`open "\${filePath}"\`);
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const critical = data.findings.filter((f) => f.severity === 'critical');
    expect(critical).toHaveLength(0);
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].severity).toBe('medium');
  });

  test('command_injection: execSync(`which ${cmd}`) is downgraded to low', () => {
    writeFile(
      store,
      'src/lsp/which.ts',
      `
import { execSync } from 'node:child_process';
function isAvailable(command: string) {
  execSync(\`which \${command}\`);
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const critical = data.findings.filter((f) => f.severity === 'critical');
    expect(critical).toHaveLength(0);
    // Severity threshold for low: 'low'. By default scanner returns ALL findings
    // including 'low', so we just check no critical.
  });

  test('command_injection: execSync(`taskkill /PID ${pid}`) with numeric pid is downgraded', () => {
    writeFile(
      store,
      'src/daemon/kill.ts',
      `
import { execSync } from 'node:child_process';
function readDaemonPid(): number { return 1234; }
function stop() {
  const pid = readDaemonPid();
  execSync(\`taskkill /PID \${pid} /T /F\`);
}
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const critical = data.findings.filter((f) => f.severity === 'critical');
    expect(critical).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Confidence field
  // -------------------------------------------------------------------

  test('every finding has a confidence field', () => {
    writeFile(
      store,
      'src/vuln-conf.ts',
      `
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
`,
      'typescript',
    );
    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    for (const f of data.findings) {
      expect(['low', 'medium', 'high']).toContain(f.confidence);
    }
  });

  // -------------------------------------------------------------------
  // Smoke test on real repo files — must produce 0 critical findings
  // for the audited-safe call sites in visualize.ts, lifecycle.ts, config.ts.
  // -------------------------------------------------------------------

  test('smoke: real repo files known-safe call sites produce no critical findings', () => {
    // Re-create the exact shapes from src/cli/visualize.ts,
    // src/daemon/lifecycle.ts and src/lsp/config.ts. We use synthetic
    // file paths to avoid depending on the actual indexed repo.
    writeFile(
      store,
      'src/cli/visualize.ts',
      `
import { execSync } from 'node:child_process';
function openInBrowser(filePath: string): void {
  const platform = process.platform;
  try {
    if (platform === 'darwin') execSync(\`open "\${filePath}"\`);
    else if (platform === 'win32') execSync(\`start "" "\${filePath}"\`);
    else execSync(\`xdg-open "\${filePath}"\`);
  } catch {}
}
`,
      'typescript',
    );
    writeFile(
      store,
      'src/daemon/lifecycle.ts',
      `
import { execSync } from 'node:child_process';
function readDaemonPid(): number | null { return null; }
function stopDaemonByPid(): void {
  const pid = readDaemonPid();
  if (pid === null) return;
  try {
    execSync(\`taskkill /PID \${pid} /T /F\`, { stdio: 'pipe' });
  } catch {}
}
`,
      'typescript',
    );
    writeFile(
      store,
      'src/lsp/config.ts',
      `
import { execSync } from 'node:child_process';
function isCommandAvailable(command: string): boolean {
  try {
    execSync(\`which \${command}\`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
`,
      'typescript',
    );

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const critical = data.findings.filter((f) => f.severity === 'critical');
    expect(critical).toHaveLength(0);
  });
});
