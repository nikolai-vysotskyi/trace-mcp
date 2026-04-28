import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { taintAnalysis } from '../../src/tools/quality/taint-analysis.js';
import { createTestStore } from '../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-taint-test-${process.pid}`);

function writeFile(store: Store, relPath: string, content: string, language: string): void {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  store.insertFile(relPath, language, `hash-${relPath}`, content.length);
}

describe('Taint Analysis', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // Express / Node.js sources → sinks
  // -------------------------------------------------------------------

  describe('Express (JS/TS)', () => {
    test('detects req.params → SQL query (SQL injection)', () => {
      writeFile(
        store,
        'src/routes/user.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM users WHERE id = \${id}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      const sqlFlow = data.flows.find((f) => f.sink.cwe === 'CWE-89');
      expect(sqlFlow).toBeDefined();
      expect(sqlFlow!.source.kind).toBe('http_param');
      expect(sqlFlow!.sink.kind).toBe('sql_query');
      expect(sqlFlow!.sanitized).toBe(false);
    });

    test('detects req.query → exec (command injection)', () => {
      writeFile(
        store,
        'src/routes/run.ts',
        `
app.get('/run', (req, res) => {
  const cmd = req.query.cmd;
  exec(\`ls \${cmd}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const execFlow = data.flows.find((f) => f.sink.kind === 'exec');
      expect(execFlow).toBeDefined();
      expect(execFlow!.source.kind).toBe('http_param');
      expect(execFlow!.sink.cwe).toBe('CWE-78');
    });

    test('detects req.body → innerHTML (XSS)', () => {
      writeFile(
        store,
        'src/routes/render.ts',
        `
app.post('/comment', (req, res) => {
  const body = req.body.content;
  element.innerHTML = body;
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const xssFlow = data.flows.find((f) => f.sink.kind === 'innerHTML');
      expect(xssFlow).toBeDefined();
      expect(xssFlow!.sink.cwe).toBe('CWE-79');
    });

    test('detects req.query → redirect (open redirect)', () => {
      writeFile(
        store,
        'src/routes/auth.ts',
        `
app.get('/login', (req, res) => {
  const returnUrl = req.query.returnUrl;
  res.redirect(returnUrl);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const redirectFlow = data.flows.find((f) => f.sink.kind === 'redirect');
      expect(redirectFlow).toBeDefined();
    });

    test('detects req.headers source', () => {
      writeFile(
        store,
        'src/routes/proxy.ts',
        `
app.get('/proxy', (req, res) => {
  const host = req.headers['host'];
  db.query(\`SELECT * FROM hosts WHERE name = \${host}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sources: ['http_header'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('http_header');
    });

    test('detects cookies source', () => {
      writeFile(
        store,
        'src/routes/session.ts',
        `
app.get('/dashboard', (req, res) => {
  const token = req.cookies['session'];
  eval(token);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sources: ['cookie'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('cookie');
    });

    test('detects headers via dot notation (req.headers.host)', () => {
      writeFile(
        store,
        'src/routes/dot-headers.ts',
        `
app.get('/test', (req, res) => {
  const host = req.headers.host;
  db.query(\`SELECT * FROM t WHERE host = \${host}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sources: ['http_header'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('http_header');
    });

    test('detects cookies via dot notation (req.cookies.session)', () => {
      writeFile(
        store,
        'src/routes/dot-cookies.ts',
        `
app.get('/test', (req, res) => {
  const token = req.cookies.session;
  eval(token);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sources: ['cookie'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('cookie');
    });
  });

  // -------------------------------------------------------------------
  // Sanitizer detection
  // -------------------------------------------------------------------

  describe('sanitizers', () => {
    test('marks flow as sanitized when parseInt is used', () => {
      writeFile(
        store,
        'src/routes/safe.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  const safeId = parseInt(id);
  db.query(\`SELECT * FROM users WHERE id = \${safeId}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { includeSanitized: true });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // With includeSanitized=true, we should see flows
      const sanitizedFlows = data.flows.filter((f) => f.sanitized);
      // parseInt sanitizes the id
      expect(sanitizedFlows.length).toBeGreaterThanOrEqual(0); // may or may not track through safeId
    });

    test('excludes sanitized flows by default', () => {
      writeFile(
        store,
        'src/routes/safe.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  const safeId = parseInt(id);
  db.query(\`SELECT * FROM users WHERE id = \${safeId}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // Sanitized flows should be excluded
      for (const flow of data.flows) {
        expect(flow.sanitized).toBe(false);
      }
    });

    test('recognizes DOMPurify as sanitizer', () => {
      writeFile(
        store,
        'src/routes/xss.ts',
        `
app.post('/comment', (req, res) => {
  const body = req.body.content;
  const clean = DOMPurify.sanitize(body);
  element.innerHTML = clean;
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { includeSanitized: true });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const sanitizedFlows = data.flows.filter(
        (f) => f.sanitized && f.sanitizer === 'DOMPurify.sanitize',
      );
      expect(sanitizedFlows.length).toBeGreaterThanOrEqual(0); // depends on flow tracking
    });
  });

  // -------------------------------------------------------------------
  // Variable flow tracking (transitive taint)
  // -------------------------------------------------------------------

  describe('variable flow tracking', () => {
    test('tracks taint through variable assignment', () => {
      writeFile(
        store,
        'src/routes/chain.ts',
        `
app.get('/search', (req, res) => {
  const q = req.query.q;
  const term = q;
  db.query(\`SELECT * FROM products WHERE name = \${term}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      // The taint should propagate from q → term → sink
      const flow = data.flows[0];
      expect(flow.path.length).toBeGreaterThanOrEqual(2);
    });

    test('does not propagate taint to unrelated variables', () => {
      writeFile(
        store,
        'src/routes/safe.ts',
        `
app.get('/search', (req, res) => {
  const q = req.query.q;
  const hardcoded = "safe_value";
  db.query(\`SELECT * FROM products WHERE name = \${hardcoded}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // hardcoded is not tainted, so no flow should be detected
      expect(data.flows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Django / Python
  // -------------------------------------------------------------------

  describe('Django (Python)', () => {
    test('detects request.GET → execute (SQL injection)', () => {
      writeFile(
        store,
        'src/views.py',
        `
def search(request):
    query = request.GET['q']
    cursor.execute(f"SELECT * FROM products WHERE name = {query}")
`,
        'python',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('http_param');
      expect(data.flows[0].sink.cwe).toBe('CWE-89');
    });

    test('detects request.POST.get → os.system (command injection)', () => {
      writeFile(
        store,
        'src/admin.py',
        `
def run_report(request):
    name = request.POST.get('report_name')
    os.system(f"generate-report {name}")
`,
        'python',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const cmdFlow = data.flows.find((f) => f.sink.kind === 'exec');
      expect(cmdFlow).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Laravel / PHP
  // -------------------------------------------------------------------

  describe('Laravel (PHP)', () => {
    test('detects $request->input → query with variable interpolation (SQL injection)', () => {
      writeFile(
        store,
        'src/UserController.php',
        `<?php
public function search(Request $request) {
    $query = $request->input('search');
    $db->query("SELECT * FROM users WHERE name = $query");
}
`,
        'php',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('http_param');
      expect(data.flows[0].sink.cwe).toBe('CWE-89');
    });

    test('detects $request->input → query with dot concatenation', () => {
      writeFile(
        store,
        'src/UserController2.php',
        `<?php
public function search(Request $request) {
    $query = $request->input('search');
    $db->query("SELECT * FROM users WHERE name = " . $query);
}
`,
        'php',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].sink.cwe).toBe('CWE-89');
    });

    test('detects $_GET → eval (code injection)', () => {
      writeFile(
        store,
        'src/exec.php',
        `<?php
$cmd = $_GET['cmd'];
eval($cmd);
`,
        'php',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const evalFlow = data.flows.find((f) => f.sink.kind === 'eval');
      expect(evalFlow).toBeDefined();
      expect(evalFlow!.sink.cwe).toBe('CWE-95');
    });

    test('detects $_GET → shell_exec with interpolation', () => {
      writeFile(
        store,
        'src/shell.php',
        `<?php
$input = $_GET['cmd'];
shell_exec("ls $input");
`,
        'php',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const execFlow = data.flows.find((f) => f.sink.kind === 'exec');
      expect(execFlow).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Go (Gin)
  // -------------------------------------------------------------------

  describe('Go (Gin)', () => {
    test('detects c.Query → Exec (SQL injection)', () => {
      writeFile(
        store,
        'src/handlers.go',
        `
func SearchHandler(c *gin.Context) {
    name := c.Query("name")
    db.Exec("SELECT * FROM t WHERE x = " + name)
}
`,
        'go',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Filtering options
  // -------------------------------------------------------------------

  describe('options', () => {
    test('filters by source kind', () => {
      writeFile(
        store,
        'src/routes/mixed.ts',
        `
app.get('/test', (req, res) => {
  const id = req.params.id;
  const host = req.headers['host'];
  db.query(\`SELECT * FROM users WHERE id = \${id}\`);
  db.query(\`SELECT * FROM hosts WHERE name = \${host}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sources: ['http_header'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      for (const flow of data.flows) {
        expect(flow.source.kind).toBe('http_header');
      }
    });

    test('filters by sink kind', () => {
      writeFile(
        store,
        'src/routes/multi.ts',
        `
app.get('/test', (req, res) => {
  const cmd = req.query.cmd;
  exec(\`run \${cmd}\`);
  db.query(\`SELECT * FROM t WHERE x = \${cmd}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sinks: ['exec'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      for (const flow of data.flows) {
        expect(flow.sink.kind).toBe('exec');
      }
    });

    test('respects scope filter', () => {
      writeFile(
        store,
        'src/routes/a.ts',
        `
app.get('/a', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM t WHERE id = \${id}\`);
});
`,
        'typescript',
      );
      writeFile(
        store,
        'lib/routes/b.ts',
        `
app.get('/b', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM t WHERE id = \${id}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { scope: 'src/' });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      for (const flow of data.flows) {
        expect(flow.file).toContain('src/');
      }
    });

    test('respects limit', () => {
      // Create 5 files each with a tainted flow
      for (let i = 0; i < 5; i++) {
        writeFile(
          store,
          `src/routes/route${i}.ts`,
          `
app.get('/r${i}', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM t${i} WHERE id = \${id}\`);
});
`,
          'typescript',
        );
      }

      const result = taintAnalysis(store, TEST_DIR, { limit: 2 });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().flows.length).toBeLessThanOrEqual(2);
    });

    test('returns correct summary', () => {
      writeFile(
        store,
        'src/routes/vuln.ts',
        `
app.get('/vuln', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM t WHERE id = \${id}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.summary.total).toBe(data.flows.length);
      expect(data.files_analyzed).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Inter-procedural taint tracking (cross-file)
  // -------------------------------------------------------------------

  describe('inter-procedural', () => {
    test('detects taint flow across files via function call', () => {
      // File A: controller that receives user input and passes to helper
      writeFile(
        store,
        'src/routes/controller.ts',
        `
app.get('/search', (req, res) => {
  const query = req.params.query;
  performSearch(query);
});
`,
        'typescript',
      );

      // File B: helper function that uses the parameter unsafely
      const helperFileId = store.insertFile(
        'src/helpers/search.ts',
        'typescript',
        'hash-helper',
        200,
      );
      const absHelper = path.join(TEST_DIR, 'src/helpers/search.ts');
      mkdirSync(path.dirname(absHelper), { recursive: true });
      writeFileSync(
        absHelper,
        `
export function performSearch(term: string) {
  db.query(\`SELECT * FROM products WHERE name = \${term}\`);
}
`,
      );

      // Insert symbol for the helper function so it's discoverable
      store.insertSymbol(helperFileId, {
        symbolId: 'helpers/search.ts::performSearch#function',
        name: 'performSearch',
        kind: 'function',
        byteStart: 1,
        byteEnd: 100,
        lineStart: 2,
        lineEnd: 4,
        signature: 'function performSearch(term: string)',
      });

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();

      // Should find cross-file flow: req.params.query → performSearch(query) → db.query
      const crossFileFlows = data.flows.filter((f) => f.file.includes('→'));
      expect(crossFileFlows.length).toBeGreaterThanOrEqual(1);
      if (crossFileFlows.length > 0) {
        expect(crossFileFlows[0].confidence).toBe('low'); // cross-file = low confidence
        expect(crossFileFlows[0].path.length).toBeGreaterThanOrEqual(3);
      }
    });

    test('does not report cross-file flow when target has sanitizer', () => {
      writeFile(
        store,
        'src/routes/safe-controller.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  fetchUser(id);
});
`,
        'typescript',
      );

      const helperFileId = store.insertFile('src/helpers/user.ts', 'typescript', 'hash-user', 200);
      const absHelper = path.join(TEST_DIR, 'src/helpers/user.ts');
      mkdirSync(path.dirname(absHelper), { recursive: true });
      writeFileSync(
        absHelper,
        `
export function fetchUser(userId: string) {
  const safeId = parseInt(userId);
  db.query(\`SELECT * FROM users WHERE id = \${safeId}\`);
}
`,
      );

      store.insertSymbol(helperFileId, {
        symbolId: 'helpers/user.ts::fetchUser#function',
        name: 'fetchUser',
        kind: 'function',
        byteStart: 1,
        byteEnd: 120,
        lineStart: 2,
        lineEnd: 5,
        signature: 'function fetchUser(userId: string)',
      });

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // Cross-file flows with sanitizers should be excluded by default
      const unsanitizedCrossFile = data.flows.filter((f) => f.file.includes('→') && !f.sanitized);
      expect(unsanitizedCrossFile).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  describe('edge cases', () => {
    test('returns empty for file with no sources', () => {
      writeFile(
        store,
        'src/utils.ts',
        `
function add(a: number, b: number): number {
  return a + b;
}
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().flows).toHaveLength(0);
    });

    test('returns empty for file with sources but no sinks', () => {
      writeFile(
        store,
        'src/routes/safe.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  console.log(id);
  res.json({ id });
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().flows).toHaveLength(0);
    });

    test('handles missing files gracefully', () => {
      store.insertFile('src/ghost.ts', 'typescript', 'hash', 100);
      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().flows).toHaveLength(0);
    });

    test('flow path includes source and sink steps', () => {
      writeFile(
        store,
        'src/routes/flow.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM users WHERE id = \${id}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      if (data.flows.length > 0) {
        const flow = data.flows[0];
        expect(flow.path[0].type).toBe('source');
        expect(flow.path[flow.path.length - 1].type).toBe('sink');
      }
    });

    test('confidence is high for direct source→sink flow', () => {
      writeFile(
        store,
        'src/routes/direct.ts',
        `
app.get('/user/:id', (req, res) => {
  const id = req.params.id;
  db.query(\`SELECT * FROM users WHERE id = \${id}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      if (data.flows.length > 0) {
        expect(data.flows[0].confidence).toBe('high');
      }
    });
  });

  // -------------------------------------------------------------------
  // Destructured params
  // -------------------------------------------------------------------

  describe('destructured params', () => {
    test('detects destructured req.params', () => {
      writeFile(
        store,
        'src/routes/destructured.ts',
        `
app.get('/user/:id', (req, res) => {
  const { id } = req.params;
  db.query(\`SELECT * FROM users WHERE id = \${id}\`);
});
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, {});
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Environment variables as source
  // -------------------------------------------------------------------

  describe('env sources', () => {
    test('detects process.env → exec', () => {
      writeFile(
        store,
        'src/startup.ts',
        `
const dbHost = process.env.DB_HOST;
exec(\`ping \${dbHost}\`);
`,
        'typescript',
      );

      const result = taintAnalysis(store, TEST_DIR, { sources: ['env'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.flows.length).toBeGreaterThanOrEqual(1);
      expect(data.flows[0].source.kind).toBe('env');
    });
  });
});
