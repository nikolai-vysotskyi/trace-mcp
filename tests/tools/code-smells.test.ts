import { describe, test, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { scanCodeSmells } from '../../src/tools/quality/code-smells.js';

const TEST_DIR = path.join(tmpdir(), 'trace-mcp-code-smells-test-' + process.pid);

function writeFile(store: Store, relPath: string, content: string, language: string): number {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  return store.insertFile(relPath, language, 'hash-' + relPath, content.length);
}

function insertSymbol(
  store: Store,
  fileId: number,
  opts: {
    name: string;
    kind: string;
    byteStart: number;
    byteEnd: number;
    lineStart: number;
    lineEnd: number;
    signature?: string;
  },
): void {
  store.insertSymbol(fileId, {
    symbolId: `test::${opts.name}#${opts.kind}`,
    name: opts.name,
    kind: opts.kind as any,
    byteStart: opts.byteStart,
    byteEnd: opts.byteEnd,
    lineStart: opts.lineStart,
    lineEnd: opts.lineEnd,
    signature: opts.signature,
  });
}

describe('Code Smells Scanner', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // -------------------------------------------------------------------
  // TODO / FIXME / HACK comments
  // -------------------------------------------------------------------

  describe('todo_comment', () => {
    test('detects TODO comments in JS/TS', () => {
      writeFile(
        store,
        'src/utils.ts',
        `
// TODO: implement caching
function fetchData() {
  return fetch('/api');
}
// FIXME: this breaks on empty arrays
function process(items: any[]) {}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(2);
      expect(data.findings[0].tag).toBe('FIXME');
      expect(data.findings[0].priority).toBe('high');
      expect(data.findings[1].tag).toBe('TODO');
      expect(data.findings[1].priority).toBe('medium');
    });

    test('detects HACK and XXX comments', () => {
      writeFile(
        store,
        'src/hack.py',
        `
# HACK: monkey-patching to work around library bug
import something
# XXX: this needs refactoring
def do_stuff():
    pass
`,
        'python',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(2);
      expect(data.findings.some((f) => f.tag === 'HACK')).toBe(true);
      expect(data.findings.some((f) => f.tag === 'XXX')).toBe(true);
    });

    test('filters by tag', () => {
      writeFile(
        store,
        'src/mixed.ts',
        `
// TODO: add tests
// FIXME: broken
// HACK: workaround
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, {
        category: ['todo_comment'],
        tags: ['FIXME'],
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].tag).toBe('FIXME');
    });

    test('skips test files by default', () => {
      writeFile(
        store,
        'src/app.test.ts',
        `
// TODO: add more assertions
test('basic', () => {});
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('includes test files when opted in', () => {
      writeFile(
        store,
        'src/app.test.ts',
        `
// TODO: add more assertions
test('basic', () => {});
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, {
        category: ['todo_comment'],
        include_tests: true,
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(1);
    });

    test('skips markdown files (CHANGELOG headings must not match BUG tag)', () => {
      writeFile(
        store,
        'CHANGELOG.md',
        `
## [1.29.0] - 2026-04-22

### Bug Fixes

* something was broken
`,
        'markdown',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Empty functions / stubs
  // -------------------------------------------------------------------

  describe('empty_function', () => {
    test('detects empty function body', () => {
      const content = `function doNothing() {\n}\n`;
      const fileId = writeFile(store, 'src/empty.ts', content, 'typescript');
      insertSymbol(store, fileId, {
        name: 'doNothing',
        kind: 'function',
        byteStart: 0,
        byteEnd: content.indexOf('}') + 1,
        lineStart: 1,
        lineEnd: 2,
        signature: 'function doNothing()',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].category).toBe('empty_function');
      expect(data.findings[0].symbol).toBe('doNothing');
      expect(data.findings[0].description).toContain('Empty');
    });

    test('detects stub with throw NotImplementedError', () => {
      const content = `function stub() {\n  throw new Error('not implemented');\n}\n`;
      const fileId = writeFile(store, 'src/stub.ts', content, 'typescript');
      insertSymbol(store, fileId, {
        name: 'stub',
        kind: 'function',
        byteStart: 0,
        byteEnd: content.lastIndexOf('}') + 1,
        lineStart: 1,
        lineEnd: 3,
        signature: 'function stub()',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].description).toContain('Stub');
    });

    test('detects Python pass-only function', () => {
      const content = `def placeholder():\n    pass\n`;
      const fileId = writeFile(store, 'src/stub.py', content, 'python');
      insertSymbol(store, fileId, {
        name: 'placeholder',
        kind: 'function',
        byteStart: 0,
        byteEnd: content.length,
        lineStart: 1,
        lineEnd: 2,
        signature: 'def placeholder()',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].symbol).toBe('placeholder');
    });

    test('does not flag functions with real implementation', () => {
      const content = `function real() {\n  return computeValue(42);\n}\n`;
      const fileId = writeFile(store, 'src/real.ts', content, 'typescript');
      insertSymbol(store, fileId, {
        name: 'real',
        kind: 'function',
        byteStart: 0,
        byteEnd: content.lastIndexOf('}') + 1,
        lineStart: 1,
        lineEnd: 3,
        signature: 'function real()',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Hardcoded values
  // -------------------------------------------------------------------

  describe('hardcoded_value', () => {
    test('detects hardcoded IP address', () => {
      writeFile(
        store,
        'src/config.ts',
        `
const server = '192.168.1.100';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const ipFindings = data.findings.filter((f) => f.tag === 'hardcoded_ip');
      expect(ipFindings.length).toBeGreaterThanOrEqual(1);
    });

    test('detects hardcoded credentials', () => {
      writeFile(
        store,
        'src/db.ts',
        `
const password = 'super_secret_123';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const credFindings = data.findings.filter((f) => f.tag === 'hardcoded_credential');
      expect(credFindings.length).toBeGreaterThanOrEqual(1);
      expect(credFindings[0].priority).toBe('high');
    });

    test('does not flag localhost/127.0.0.1', () => {
      writeFile(
        store,
        'src/dev.ts',
        `
const host = '127.0.0.1';
const bind = '0.0.0.0';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const ipFindings = data.findings.filter((f) => f.tag === 'hardcoded_ip');
      expect(ipFindings).toHaveLength(0);
    });

    test('does not flag credentials in test files', () => {
      writeFile(
        store,
        'src/auth.test.ts',
        `
const password = 'test_password';
`,
        'typescript',
      );

      // test files are skipped by default
      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('detects hardcoded URL', () => {
      writeFile(
        store,
        'src/api.ts',
        `
const endpoint = 'https://api.production-server.com/v2/data';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings.length).toBeGreaterThanOrEqual(1);
    });

    test('does not flag github/npm URLs', () => {
      writeFile(
        store,
        'src/deps.ts',
        `
const repo = 'https://github.com/user/repo';
const pkg = 'https://npmjs.org/package/foo';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Combined scanning & options
  // -------------------------------------------------------------------

  describe('combined', () => {
    test('scans all categories by default', () => {
      const content = `// TODO: finish this
function stub() {
  throw new Error('not implemented');
}
const apiKey = 'sk-1234567890abcdef';
`;
      const fileId = writeFile(store, 'src/combined.ts', content, 'typescript');
      insertSymbol(store, fileId, {
        name: 'stub',
        kind: 'function',
        byteStart: content.indexOf('function'),
        byteEnd: content.indexOf('\n}') + 2,
        lineStart: 2,
        lineEnd: 4,
        signature: 'function stub()',
      });

      const result = scanCodeSmells(store, TEST_DIR);
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.summary.todo_comment).toBeGreaterThanOrEqual(1);
      expect(data.summary.empty_function).toBeGreaterThanOrEqual(1);
    });

    test('respects priority threshold', () => {
      writeFile(
        store,
        'src/priorities.ts',
        `
// TODO: low-ish priority
// FIXME: high priority
// REFACTOR: low priority
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, {
        category: ['todo_comment'],
        priority_threshold: 'high',
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // Only FIXME (high) should appear
      expect(data.findings.every((f) => f.priority === 'high')).toBe(true);
    });

    test('respects scope filter', () => {
      writeFile(store, 'src/app/a.ts', '// TODO: in scope\n', 'typescript');
      writeFile(store, 'lib/b.ts', '// TODO: out of scope\n', 'typescript');

      const result = scanCodeSmells(store, TEST_DIR, {
        category: ['todo_comment'],
        scope: 'src/',
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].file).toContain('src/');
    });

    test('respects limit', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `// TODO: item ${i}`).join('\n');
      writeFile(store, 'src/many.ts', lines, 'typescript');

      const result = scanCodeSmells(store, TEST_DIR, {
        category: ['todo_comment'],
        limit: 5,
      });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(5);
      expect(data.total).toBe(20);
    });

    test('returns correct summary counts', () => {
      writeFile(
        store,
        'src/summary.ts',
        `
// TODO: first
// FIXME: second
// HACK: third
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.summary.todo_comment).toBe(3);
      expect(data.summary.empty_function).toBe(0);
      expect(data.summary.hardcoded_value).toBe(0);
      expect(data.summary.debug_artifact).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Debug artifacts
  // -------------------------------------------------------------------

  describe('debug_artifact', () => {
    test('detects console.log / debugger in TypeScript', () => {
      writeFile(
        store,
        'src/app.ts',
        `
function handler(req) {
  console.log('got request', req);
  debugger;
  return { ok: true };
}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const tags = data.findings.map((f) => f.tag);
      expect(tags).toContain('console_log');
      expect(tags).toContain('debugger_statement');
      expect(data.findings.find((f) => f.tag === 'debugger_statement')?.priority).toBe('high');
    });

    test('detects Python pdb / breakpoint', () => {
      writeFile(
        store,
        'src/debug.py',
        `
import pdb

def run():
    breakpoint()
    pdb.set_trace()
    return 1
`,
        'python',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const tags = data.findings.map((f) => f.tag);
      expect(tags).toContain('breakpoint_call');
      expect(tags).toContain('pdb_set_trace');
      expect(tags).toContain('import_pdb');
    });

    test('detects PHP var_dump / dd / xdebug_break', () => {
      writeFile(
        store,
        'src/debug.php',
        `<?php
function handle($x) {
    var_dump($x);
    dd($x);
    xdebug_break();
    return $x;
}
`,
        'php',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const tags = data.findings.map((f) => f.tag);
      expect(tags).toContain('php_var_dump');
      expect(tags).toContain('laravel_dd_dump');
      expect(tags).toContain('php_xdebug_break');
    });

    test('detects Ruby binding.pry and byebug', () => {
      writeFile(
        store,
        'app/debug.rb',
        `
class Service
  def call
    binding.pry
    byebug
  end
end
`,
        'ruby',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const tags = data.findings.map((f) => f.tag);
      expect(tags).toContain('ruby_pry_irb');
      expect(tags).toContain('ruby_byebug');
    });

    test('detects Rust dbg! macro', () => {
      writeFile(
        store,
        'src/lib.rs',
        `
fn compute(x: i32) -> i32 {
    dbg!(x);
    x * 2
}
`,
        'rust',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings.some((f) => f.tag === 'rust_dbg')).toBe(true);
    });

    test('ignores debug artifacts inside comments', () => {
      writeFile(
        store,
        'src/safe.ts',
        `
// console.log('old debug line, now commented out')
function legit() {
  return 1;
}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(0);
    });

    test('ignores debug artifacts in test files by default', () => {
      writeFile(
        store,
        'src/app.test.ts',
        `
function runTest() {
  console.log('testing', 123);
  debugger;
}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['debug_artifact'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('includes artifacts in test files when include_tests=true', () => {
      writeFile(
        store,
        'src/app.test.ts',
        `
function runTest() {
  debugger;
}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, {
        category: ['debug_artifact'],
        include_tests: true,
      });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings.length).toBeGreaterThan(0);
    });
  });
});
