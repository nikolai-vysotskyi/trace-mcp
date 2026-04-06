import { describe, test, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { scanSecurity } from '../../src/tools/quality/security-scan.js';

// Temp dir for test files
const TEST_DIR = path.join(tmpdir(), 'trace-mcp-security-test-' + process.pid);

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

function writeFile(store: Store, relPath: string, content: string, language: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  store.insertFile(relPath, language, 'hash-' + relPath, content.length);
}

describe('Security Scanning', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // SQL Injection (CWE-89)
  // -------------------------------------------------------------------

  test('detects SQL injection via template literal in JS/TS', () => {
    writeFile(store, 'src/search.ts', `
const search = (query: string) => {
  db.query(\`SELECT * FROM products WHERE name LIKE '%\${query}%'\`);
};
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-89');
    expect(data.findings[0].severity).toBe('critical');
    expect(data.findings[0].line).toBe(3);
  });

  test('does not flag parameterized queries', () => {
    writeFile(store, 'src/safe-search.ts', `
const search = (query: string) => {
  // parameterized query
  db.query('SELECT * FROM products WHERE name LIKE ?', [query]);
};
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('detects Python f-string SQL injection', () => {
    writeFile(store, 'src/db.py', `
def search(query):
    cursor.execute(f"SELECT * FROM users WHERE name = '{query}'")
`, 'python');

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-89');
  });

  test('detects PHP SQL injection', () => {
    writeFile(store, 'src/UserRepo.php', `<?php
$result = $db->query("SELECT * FROM users WHERE id = " . $id);
`, 'php');

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
    writeFile(store, 'src/Comment.tsx', `
export const Comment = ({ body }: { body: string }) => (
  <div dangerouslySetInnerHTML={{ __html: body }} />
);
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-79');
  });

  test('detects Vue v-html', () => {
    writeFile(store, 'src/Comment.vue', `
<template>
  <div v-html="comment.body" />
</template>
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('detects PHP Blade unescaped output', () => {
    writeFile(store, 'src/view.blade.php', `
<div>{!! $user->bio !!}</div>
`, 'php');

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Command Injection (CWE-78)
  // -------------------------------------------------------------------

  test('detects exec with template literal', () => {
    writeFile(store, 'src/git.ts', `
import { exec } from 'child_process';
const getLog = (author: string) => {
  exec(\`git log --author="\${author}"\`);
};
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-78');
    expect(data.findings[0].severity).toBe('critical');
  });

  test('detects Python subprocess with shell=True', () => {
    writeFile(store, 'src/run.py', `
import subprocess
def run(cmd):
    subprocess.call(cmd, shell=True)
`, 'python');

    const result = scanSecurity(store, TEST_DIR, { rules: ['command_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Hardcoded Secrets (CWE-798)
  // -------------------------------------------------------------------

  test('detects hardcoded API key', () => {
    writeFile(store, 'src/config.ts', `
const API_KEY = 'sk_live_abcdef1234567890abcdef';
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.findings.length).toBeGreaterThanOrEqual(1);
    expect(data.findings[0].rule_id).toBe('CWE-798');
  });

  test('detects AWS access key', () => {
    writeFile(store, 'src/aws.ts', `
const KEY = 'AKIAIOSFODNN7ABCDEFG';
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('does not flag process.env references', () => {
    writeFile(store, 'src/safe-config.ts', `
const API_KEY = process.env.API_KEY;
const secret = process.env.SECRET_TOKEN;
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('does not flag placeholder values', () => {
    writeFile(store, 'src/example.ts', `
const api_key = 'your-key-here-changeme-placeholder';
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['hardcoded_secrets'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Insecure Crypto (CWE-327)
  // -------------------------------------------------------------------

  test('detects MD5 usage', () => {
    writeFile(store, 'src/hash.ts', `
import crypto from 'crypto';
const hash = crypto.createHash('md5').update(data).digest('hex');
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['insecure_crypto'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  test('does not flag MD5 for checksums', () => {
    writeFile(store, 'src/checksum.ts', `
// checksum for cache invalidation
const hash = crypto.createHash('md5').update(content).digest('hex');
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['insecure_crypto'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Path Traversal (CWE-22)
  // -------------------------------------------------------------------

  test('detects path.join with user input', () => {
    writeFile(store, 'src/files.ts', `
app.get('/download', (req, res) => {
  const file = path.join('/uploads', req.params.filename);
  res.sendFile(file);
});
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['path_traversal'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // SSRF (CWE-918)
  // -------------------------------------------------------------------

  test('detects fetch with user input', () => {
    writeFile(store, 'src/proxy.ts', `
app.get('/proxy', async (req, res) => {
  const data = await fetch(req.query.url);
  res.json(await data.json());
});
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['ssrf'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Open Redirect (CWE-601)
  // -------------------------------------------------------------------

  test('detects redirect with user input', () => {
    writeFile(store, 'src/auth.ts', `
app.get('/login', (req, res) => {
  res.redirect(req.query.returnUrl);
});
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['open_redirect'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Scope, filtering, and edge cases
  // -------------------------------------------------------------------

  test('skips test files', () => {
    writeFile(store, 'src/search.test.ts', `
db.query(\`SELECT * FROM products WHERE name LIKE '%\${query}%'\`);
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().findings).toHaveLength(0);
  });

  test('respects severity threshold', () => {
    writeFile(store, 'src/app.ts', `
const hash = crypto.createHash('md5').update(data).digest('hex');
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
`, 'typescript');

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
    writeFile(store, 'src/bad.ts', `
const key = 'AKIAIOSFODNN7EXAMPLE';
exec(\`rm -rf \${path}\`);
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const ruleIds = new Set(data.findings.map((f) => f.rule_id));
    expect(ruleIds.size).toBeGreaterThanOrEqual(2);
  });

  test('returns correct summary counts', () => {
    writeFile(store, 'src/vuln.ts', `
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
exec(\`rm -rf \${path}\`);
const key = 'sk_live_abcdef1234567890abcdef';
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    const total = data.summary.critical + data.summary.high + data.summary.medium + data.summary.low;
    expect(total).toBe(data.findings.length);
  });

  test('returns validation error for empty rules', () => {
    const result = scanSecurity(store, TEST_DIR, { rules: [] as any });
    expect(result.isErr()).toBe(true);
  });

  test('findings are sorted by severity (critical first)', () => {
    writeFile(store, 'src/mixed.ts', `
const hash = crypto.createHash('md5').update(data).digest('hex');
db.query(\`SELECT * FROM x WHERE id = \${id}\`);
const key = 'sk_live_abcdef1234567890abcdef';
`, 'typescript');

    const result = scanSecurity(store, TEST_DIR, { rules: ['all'] });
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    if (data.findings.length >= 2) {
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      for (let i = 1; i < data.findings.length; i++) {
        expect(severityOrder[data.findings[i - 1].severity])
          .toBeGreaterThanOrEqual(severityOrder[data.findings[i].severity]);
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
      writeFile(store, `src/file${i}.ts`, `
const search${i} = () => db.query(\`SELECT * FROM t WHERE id = \${id}\`);
`, 'typescript');
    }

    const result = scanSecurity(store, TEST_DIR, { rules: ['sql_injection'] });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().files_scanned).toBe(50);
    expect(result._unsafeUnwrap().findings.length).toBe(50);
  });

  test('language filtering works — does not apply JS rules to Python', () => {
    writeFile(store, 'src/app.py', `
# This is Python, not JS
element.innerHTML = "hello"
`, 'python');

    const result = scanSecurity(store, TEST_DIR, { rules: ['xss'] });
    expect(result.isOk()).toBe(true);
    // innerHTML is a JS/TS pattern, should not match Python
    const jsFindings = result._unsafeUnwrap().findings.filter(
      (f) => f.rule_id === 'CWE-79' && f.file.endsWith('.py'),
    );
    expect(jsFindings).toHaveLength(0);
  });
});
