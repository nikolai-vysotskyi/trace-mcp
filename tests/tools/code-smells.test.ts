import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { scanCodeSmells } from '../../src/tools/quality/code-smells.js';
import { createTestStore } from '../test-utils.js';

const TEST_DIR = path.join(tmpdir(), `trace-mcp-code-smells-test-${process.pid}`);

function writeFile(store: Store, relPath: string, content: string, language: string): number {
  const absPath = path.join(TEST_DIR, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  return store.insertFile(relPath, language, `hash-${relPath}`, content.length);
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
    symbolId: `test::${opts.name}#${opts.kind}:${opts.lineStart}`,
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

    test('does not flag the word "bug" in running prose', () => {
      writeFile(
        store,
        'src/quality/code-smells.ts',
        `
// This module detects bug patterns and debug artifacts in user code.
// It also handles debugging hooks — not actual BUG-tagged TODOs.
function scan() { return 1; }
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('still flags BUG: as a standalone developer tag', () => {
      writeFile(
        store,
        'src/buggy.ts',
        `
// BUG: counter resets on retry — see issue #123
function counter() { return 0; }
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].tag).toBe('BUG');
    });

    test('still flags BUG(author): style tag', () => {
      writeFile(
        store,
        'src/buggy2.ts',
        `
// BUG(jsmith): off-by-one when input is empty
function foo() { return 1; }
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
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

    test('ignores BUG and TODO tags when enclosed in backticks (e.g. self-documentation) (TRA-1070)', () => {
      writeFile(
        store,
        'src/docs.ts',
        `
// 4. \`:\` or \`(\` immediately after the tag (e.g. \`// BUG:\` or \`// BUG(jsmith):\`)
// developer tag (\`// BUG:\` or \`// BUG(jsmith):\`).
// see \`// TODO:\` in documentation
function sample() {}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('still detects real TODO comments when backticks appear in description (TRA-1070)', () => {
      writeFile(
        store,
        'src/real-todo.ts',
        `
// TODO: fix \`userId\` lookup in user service
function fetchUser() {}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].tag).toBe('TODO');
      expect(data.findings[0].description).toBe('fix \`userId\` lookup in user service');
    });

    test('detects real TODO when another tag appears inside inline backticks on the same line (TRA-1070)', () => {
      writeFile(
        store,
        'src/mixed-todo.ts',
        `
// see \`// BUG: explanation\` in docs; // TODO: fix real bug
function doSomething() {}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['todo_comment'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].tag).toBe('TODO');
      expect(data.findings[0].description).toBe('fix real bug');
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

    test('does not flag TypeScript constructors with parameter properties (TRA-1070)', () => {
      const content = `
class AnthropicInferenceService {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}
}

class InferenceCache {
  constructor(private readonly db: Database) {}
}

class UserProfile {
  constructor(public readonly id: string, protected role: string) {}
}
`;
      const fileId = writeFile(store, 'src/service.ts', content, 'typescript');
      const idx1 = content.indexOf('constructor(\n    private apiKey');
      const end1 = content.indexOf(') {}') + 4;
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx1,
        byteEnd: end1,
        lineStart: 3,
        lineEnd: 6,
        signature: 'constructor(private apiKey: string, private model: string)',
      });

      const idx2 = content.indexOf('constructor(private readonly db');
      const end2 = content.indexOf('Database) {}') + 12;
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx2,
        byteEnd: end2,
        lineStart: 10,
        lineEnd: 10,
        signature: 'constructor(private readonly db: Database)',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
    });

    test('still flags truly empty constructors without parameter properties (TRA-1070)', () => {
      const content = `
class EmptyService {
  constructor() {}
}

class PlainArgService {
  constructor(db: Database) {}
}
`;
      const fileId = writeFile(store, 'src/empty-ctor.ts', content, 'typescript');
      const idx1 = content.indexOf('constructor()');
      const end1 = content.indexOf('constructor() {}') + 16;
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx1,
        byteEnd: end1,
        lineStart: 3,
        lineEnd: 3,
        signature: 'constructor()',
      });

      const idx2 = content.indexOf('constructor(db: Database)');
      const end2 = content.indexOf('Database) {}') + 12;
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx2,
        byteEnd: end2,
        lineStart: 7,
        lineEnd: 7,
        signature: 'constructor(db: Database)',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings).toHaveLength(2);
      expect(findings.every((f) => f.symbol === 'constructor')).toBe(true);
    });

    test('flags empty constructors with explicit access modifier on constructor (TRA-1070)', () => {
      const content = `
class ServiceWithAccessMods {
  public constructor() {}
}

class PrivateCtorService {
  private constructor() {}
}

class ProtectedCtorWithPlainArg {
  protected constructor(db: Database) {}
}

class PublicCtorWithParamProp {
  public constructor(private db: Database) {}
}
`;
      const fileId = writeFile(store, 'src/access-mod-ctor.ts', content, 'typescript');
      const idx1 = content.indexOf('public constructor()');
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx1,
        byteEnd: content.indexOf('public constructor() {}') + 'public constructor() {}'.length,
        lineStart: 3,
        lineEnd: 3,
        signature: 'public constructor()',
      });

      const idx2 = content.indexOf('private constructor()');
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx2,
        byteEnd: content.indexOf('private constructor() {}') + 'private constructor() {}'.length,
        lineStart: 7,
        lineEnd: 7,
        signature: 'private constructor()',
      });

      const idx3 = content.indexOf('protected constructor(db: Database)');
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx3,
        byteEnd:
          content.indexOf('protected constructor(db: Database) {}') +
          'protected constructor(db: Database) {}'.length,
        lineStart: 11,
        lineEnd: 11,
        signature: 'protected constructor(db: Database)',
      });

      const idx4 = content.indexOf('public constructor(private db: Database)');
      insertSymbol(store, fileId, {
        name: 'constructor',
        kind: 'constructor',
        byteStart: idx4,
        byteEnd:
          content.indexOf('public constructor(private db: Database) {}') +
          'public constructor(private db: Database) {}'.length,
        lineStart: 15,
        lineEnd: 15,
        signature: 'public constructor(private db: Database)',
      });

      const result = scanCodeSmells(store, TEST_DIR, { category: ['empty_function'] });
      expect(result.isOk()).toBe(true);
      const findings = result._unsafeUnwrap().findings;
      expect(findings).toHaveLength(3);
      expect(findings.every((f) => f.symbol === 'constructor')).toBe(true);
    });

    test('does not flag abstract methods or .d.ts files (TRA-1070)', () => {
      const dtsContent = `export declare function declareFn(): void;\n`;
      const dtsId = writeFile(store, 'src/types.d.ts', dtsContent, 'typescript');
      insertSymbol(store, dtsId, {
        name: 'declareFn',
        kind: 'function',
        byteStart: 0,
        byteEnd: dtsContent.length,
        lineStart: 1,
        lineEnd: 1,
        signature: 'export declare function declareFn(): void;',
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

    test('does not flag ORM column-type values as credentials', () => {
      writeFile(
        store,
        'src/migrations/users.ts',
        `
const COLUMNS = {
  rememberToken: 'varchar',
  password: 'varchar',
  apiKey: 'text',
};
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const credFindings = result
        ._unsafeUnwrap()
        .findings.filter((f) => f.tag === 'hardcoded_credential');
      expect(credFindings).toHaveLength(0);
    });

    test('does not flag local-LLM placeholder API key', () => {
      writeFile(
        store,
        'src/ai/detect-local.ts',
        `
function localConfig() {
  return { apiKey: 'local-no-key', baseUrl: 'http://localhost:11434' };
}
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const credFindings = result
        ._unsafeUnwrap()
        .findings.filter((f) => f.tag === 'hardcoded_credential');
      expect(credFindings).toHaveLength(0);
    });

    test('does not flag domain-name taxonomy values', () => {
      writeFile(
        store,
        'src/intent/classifier.ts',
        `
const DOMAINS = {
  auth: 'authentication',
  payments: 'billing',
};
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const credFindings = result
        ._unsafeUnwrap()
        .findings.filter((f) => f.tag === 'hardcoded_credential');
      expect(credFindings).toHaveLength(0);
    });

    test('still flags a real-looking API key (true positive)', () => {
      writeFile(
        store,
        'src/api.ts',
        `
const apiKey = 'sk-abcdef0123456789ABCDEF0123456789abcdef01';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const credFindings = result
        ._unsafeUnwrap()
        .findings.filter((f) => f.tag === 'hardcoded_credential');
      expect(credFindings.length).toBeGreaterThanOrEqual(1);
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

    test('does not flag DOCTYPE / DTD URLs (TRA-1070)', () => {
      writeFile(
        store,
        'packages/app/src/main/daemon-plist.ts',
        `
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings).toHaveLength(0);
    });

    test('does not flag placeholder URLs in configuration schemas (TRA-1070)', () => {
      writeFile(
        store,
        'packages/app/src/renderer/tabs/configSchema.ts',
        `
placeholder: 'https://api.openai.com',
placeholder: 'https://api.voyageai.com/v1',
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings).toHaveLength(0);
    });

    test('does not flag localhost / 127.0.0.1 daemon port references (TRA-1070)', () => {
      writeFile(
        store,
        'src/client.ts',
        `
const url = 'http://127.0.0.1:3741/mcp';
const local = 'http://localhost:3741';
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const portFindings = data.findings.filter((f) => f.tag === 'hardcoded_port');
      expect(portFindings).toHaveLength(0);
    });

    test('does not flag URLs in translation files (TRA-1070)', () => {
      writeFile(
        store,
        'locales/en.json',
        `
{ "doc_link": "https://docs.example-product.org/getting-started" }
`,
        'json',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings).toHaveLength(0);
    });

    test('does not flag URLs in translation files with Windows path separators (TRA-1070)', () => {
      writeFile(
        store,
        'locales\\en.json',
        `
{ "doc_link": "https://docs.example-product.org/getting-started" }
`,
        'json',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings).toHaveLength(0);
    });

    test('does not flag placeholder URLs in JSX / HTML attribute syntax (TRA-1070)', () => {
      writeFile(
        store,
        'src/components/Input.tsx',
        `
export const Input = () => <input placeholder="https://api.openai.com/v1" />;
`,
        'typescript',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      const urlFindings = data.findings.filter((f) => f.tag === 'hardcoded_url');
      expect(urlFindings).toHaveLength(0);
    });

    test('does not flag credentials inside a .env file', () => {
      // .env is the externalized-config mechanism — `KEY=value` here IS the
      // recommended fix for the hardcoded-credential smell, not an instance of
      // it. Regression for the "Hardcoded" panel flagging DB passwords in .env.
      // language is 'dotenv' (NOT in NON_CODE_LANGUAGES) so this proves the
      // basename-based skip, not a language-based one.
      writeFile(
        store,
        'thewed/thewed-laravel/.env',
        `
APP_ENV=production
TOP_15_SHOP_DB_PASSWORD='s2^secretValue123'
MAIL_SECRET="abcDEF0123456789xyz"
`,
        'dotenv',
      );

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.findings).toHaveLength(0);
      expect(data.files_scanned).toBe(0);
    });

    test('does not flag credentials in .env.* variants (.local, .backup, ...)', () => {
      writeFile(store, '.env.backup', `DB_PASSWORD='s2^secretValue123'\n`, 'dotenv');
      writeFile(store, '.env.local', `API_KEY='sk-abcdef0123456789ABCDEF'\n`, 'dotenv');
      writeFile(store, '.env.production', `APP_SECRET='superSecretToken9876'\n`, 'dotenv');

      const result = scanCodeSmells(store, TEST_DIR, { category: ['hardcoded_value'] });
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().findings).toHaveLength(0);
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
