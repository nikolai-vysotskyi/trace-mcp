/**
 * PytestPlugin — Framework plugin for pytest (Python).
 *
 * Detects 'pytest' in Python dependencies and extracts:
 * - Test functions (test_*, parametrize markers)
 * - Test classes (Test*)
 * - Fixtures (@pytest.fixture) with scope metadata
 * - conftest.py fixture discovery
 * - pytest.mark decorators (skip, xfail, parametrize, etc.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawSymbol,
  RawEdge,
  ResolveContext,
  EdgeTypeDeclaration,
} from '../../../../../plugin-api/types.js';
import { getParser } from '../../../../../parser/tree-sitter.js';

type TSNode = import('tree-sitter').SyntaxNode;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPythonDep(ctx: ProjectContext, pkg: string): boolean {
  const lowerPkg = pkg.toLowerCase();
  if (ctx.pyprojectToml) {
    const deps = ctx.pyprojectToml._parsedDeps as string[] | undefined;
    if (deps?.includes(lowerPkg)) return true;
  }
  if (ctx.requirementsTxt?.includes(lowerPkg)) return true;
  try {
    const pyprojectPath = path.join(ctx.rootPath, 'pyproject.toml');
    const content = fs.readFileSync(pyprojectPath, 'utf-8');
    const re = new RegExp(`["']${escapeRegExp(pkg)}[>=<\\[!~\\s"']`, 'i');
    if (re.test(content)) return true;
  } catch {
    /* not found */
  }
  try {
    const reqPath = path.join(ctx.rootPath, 'requirements.txt');
    const content = fs.readFileSync(reqPath, 'utf-8');
    const re = new RegExp(`^${escapeRegExp(pkg)}\\b`, 'im');
    if (re.test(content)) return true;
  } catch {
    /* not found */
  }
  // Also check requirements-dev.txt and requirements-test.txt
  for (const alt of ['requirements-dev.txt', 'requirements-test.txt', 'test-requirements.txt']) {
    try {
      const content = fs.readFileSync(path.join(ctx.rootPath, alt), 'utf-8');
      const re = new RegExp(`^${escapeRegExp(pkg)}\\b`, 'im');
      if (re.test(content)) return true;
    } catch {
      /* not found */
    }
  }
  return false;
}

/** Known pytest marker names. */
const KNOWN_MARKERS = new Set([
  'skip',
  'skipif',
  'xfail',
  'parametrize',
  'usefixtures',
  'filterwarnings',
  'timeout',
  'slow',
  'integration',
  'e2e',
  'asyncio',
  'django_db',
  'benchmark',
]);

/** Fixture scope values. */
type FixtureScope = 'function' | 'class' | 'module' | 'package' | 'session';

interface PytestFixture {
  name: string;
  scope: FixtureScope;
  autouse: boolean;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

interface PytestTest {
  name: string;
  className?: string;
  markers: string[];
  parametrize?: string;
  isAsync: boolean;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

// ============================================================
// AST extraction helpers
// ============================================================

function getNodeName(node: TSNode): string | undefined {
  return node.childForFieldName('name')?.text;
}

function getDecorators(node: TSNode): TSNode[] {
  const decorators: TSNode[] = [];
  // If the node is wrapped in decorated_definition, scan its children
  const parent = node.parent;
  if (parent?.type === 'decorated_definition') {
    for (const child of parent.namedChildren) {
      if (child.type === 'decorator') decorators.push(child);
    }
  }
  return decorators;
}

function getDecoratorText(decorator: TSNode): string {
  const expr = decorator.namedChildren[0];
  if (!expr) return '';
  if (expr.type === 'identifier') return expr.text;
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function');
    return fn?.text ?? '';
  }
  if (expr.type === 'attribute') return expr.text;
  return expr.text;
}

function getDecoratorArgs(decorator: TSNode): TSNode | null {
  const expr = decorator.namedChildren[0];
  if (!expr || expr.type !== 'call') return null;
  return expr.childForFieldName('arguments');
}

function isPytestFixture(decorators: TSNode[]): { scope: FixtureScope; autouse: boolean } | null {
  for (const dec of decorators) {
    const text = getDecoratorText(dec);
    if (text !== 'pytest.fixture' && text !== 'fixture') continue;

    let scope: FixtureScope = 'function';
    let autouse = false;

    const args = getDecoratorArgs(dec);
    if (args) {
      for (const child of args.namedChildren) {
        if (child.type === 'keyword_argument') {
          const key = child.childForFieldName('name')?.text;
          const val = child.childForFieldName('value')?.text;
          if (key === 'scope' && val) {
            const s = val.replace(/['"]/g, '');
            if (['function', 'class', 'module', 'package', 'session'].includes(s)) {
              scope = s as FixtureScope;
            }
          }
          if (key === 'autouse' && val === 'True') autouse = true;
        }
      }
    }

    return { scope, autouse };
  }
  return null;
}

function extractPytestMarkers(decorators: TSNode[]): string[] {
  const markers: string[] = [];
  for (const dec of decorators) {
    const text = getDecoratorText(dec);
    // @pytest.mark.skip, @pytest.mark.parametrize(...)
    const match = text.match(/^pytest\.mark\.(\w+)/);
    if (match) markers.push(match[1]);
    // @mark.skip (if imported)
    const match2 = text.match(/^mark\.(\w+)/);
    if (match2) markers.push(match2[1]);
  }
  return markers;
}

function extractParametrizeArgs(decorators: TSNode[]): string | undefined {
  for (const dec of decorators) {
    const text = getDecoratorText(dec);
    if (!text.includes('parametrize')) continue;
    const args = getDecoratorArgs(dec);
    if (!args) continue;
    // First argument is the parameter name(s)
    const firstArg = args.namedChildren[0];
    if (firstArg?.type === 'string') {
      return firstArg.text.replace(/['"]/g, '');
    }
  }
  return undefined;
}

function extractFixtures(root: TSNode): PytestFixture[] {
  const fixtures: PytestFixture[] = [];

  for (const node of root.namedChildren) {
    let funcNode: TSNode | null = null;
    let outerNode: TSNode = node;

    if (node.type === 'decorated_definition') {
      funcNode = node.namedChildren.find((c) => c.type === 'function_definition') ?? null;
      outerNode = node;
    } else if (node.type === 'function_definition') {
      funcNode = node;
    }

    if (!funcNode) continue;
    const decorators = getDecorators(funcNode);
    const fixtureInfo = isPytestFixture(decorators);
    if (!fixtureInfo) continue;

    const name = getNodeName(funcNode);
    if (!name) continue;

    fixtures.push({
      name,
      scope: fixtureInfo.scope,
      autouse: fixtureInfo.autouse,
      lineStart: outerNode.startPosition.row + 1,
      lineEnd: outerNode.endPosition.row + 1,
      byteStart: outerNode.startIndex,
      byteEnd: outerNode.endIndex,
    });
  }

  return fixtures;
}

function extractTests(root: TSNode): PytestTest[] {
  const tests: PytestTest[] = [];

  // Top-level test functions
  for (const node of root.namedChildren) {
    let funcNode: TSNode | null = null;
    let outerNode: TSNode = node;

    if (node.type === 'decorated_definition') {
      funcNode = node.namedChildren.find((c) => c.type === 'function_definition') ?? null;
      outerNode = node;
    } else if (node.type === 'function_definition') {
      funcNode = node;
    }

    if (funcNode) {
      const name = getNodeName(funcNode);
      if (name?.startsWith('test_') || name?.startsWith('test')) {
        const decorators = getDecorators(funcNode);
        const markers = extractPytestMarkers(decorators);
        const parametrize = extractParametrizeArgs(decorators);
        const isAsync = funcNode.text.trimStart().startsWith('async');

        tests.push({
          name,
          markers,
          parametrize,
          isAsync,
          lineStart: outerNode.startPosition.row + 1,
          lineEnd: outerNode.endPosition.row + 1,
          byteStart: outerNode.startIndex,
          byteEnd: outerNode.endIndex,
        });
      }
    }

    // Test classes
    let classDef: TSNode | null = null;
    if (node.type === 'class_definition') classDef = node;
    else if (node.type === 'decorated_definition') {
      classDef = node.namedChildren.find((c) => c.type === 'class_definition') ?? null;
    }

    if (classDef) {
      const className = getNodeName(classDef);
      if (className?.startsWith('Test')) {
        const body = classDef.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            let methodNode: TSNode | null = null;
            let methodOuter: TSNode = child;

            if (child.type === 'decorated_definition') {
              methodNode =
                child.namedChildren.find((c) => c.type === 'function_definition') ?? null;
              methodOuter = child;
            } else if (child.type === 'function_definition') {
              methodNode = child;
            }

            if (!methodNode) continue;
            const methodName = getNodeName(methodNode);
            if (!methodName?.startsWith('test_') && !methodName?.startsWith('test')) continue;

            const decorators = getDecorators(methodNode);
            const markers = extractPytestMarkers(decorators);
            const parametrize = extractParametrizeArgs(decorators);
            const isAsync = methodNode.text.trimStart().startsWith('async');

            tests.push({
              name: methodName,
              className,
              markers,
              parametrize,
              isAsync,
              lineStart: methodOuter.startPosition.row + 1,
              lineEnd: methodOuter.endPosition.row + 1,
              byteStart: methodOuter.startIndex,
              byteEnd: methodOuter.endIndex,
            });
          }
        }
      }
    }
  }

  return tests;
}

// ============================================================
// Plugin
// ============================================================

export class PytestPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'pytest',
    version: '1.0.0',
    priority: 50,
    category: 'testing',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'pytest');
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'pytest_fixture_used',
          category: 'pytest',
          description: 'Test function uses a pytest fixture',
        },
        {
          name: 'pytest_parametrize',
          category: 'pytest',
          description: 'Test parametrized with @pytest.mark.parametrize',
        },
      ] satisfies EdgeTypeDeclaration[],
    };
  }

  async extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
    if (language !== 'python') return ok({ status: 'ok', symbols: [] });

    const isConftest = filePath.endsWith('conftest.py');
    const isTestFile =
      !isConftest &&
      (/(?:^|\/|\\)(?:test_[^/\\]+|[^/\\]+_test)\.py$/.test(filePath) ||
        /(?:^|\/|\\)tests?\//.test(filePath));

    if (!isTestFile && !isConftest) return ok({ status: 'ok', symbols: [] });

    const parser = await getParser('python');
    const source = content.toString('utf-8');
    const tree = parser.parse(source);
    const root = tree.rootNode;

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
    };

    // conftest.py: extract fixtures
    if (isConftest) {
      result.frameworkRole = 'conftest';
      const fixtures = extractFixtures(root);
      for (const fix of fixtures) {
        result.symbols!.push({
          symbolId: `${filePath}::${fix.name}#function`,
          name: fix.name,
          kind: 'function',
          signature: `@pytest.fixture(scope="${fix.scope}")`,
          byteStart: fix.byteStart,
          byteEnd: fix.byteEnd,
          lineStart: fix.lineStart,
          lineEnd: fix.lineEnd,
          metadata: {
            pytest_fixture: true,
            scope: fix.scope,
            autouse: fix.autouse || undefined,
          },
        });
      }
    }

    // Test files: extract tests and inline fixtures
    if (isTestFile) {
      result.frameworkRole = 'pytest_test';

      const tests = extractTests(root);
      const fixtures = extractFixtures(root);

      for (const test of tests) {
        const meta: Record<string, unknown> = {
          pytest_test: true,
        };
        if (test.className) meta.testClass = test.className;
        if (test.markers.length > 0) meta.markers = test.markers;
        if (test.parametrize) meta.parametrize = test.parametrize;
        if (test.isAsync) meta.async = true;
        if (test.markers.includes('skip')) meta.skipped = true;
        if (test.markers.includes('xfail')) meta.expectedFailure = true;

        const symbolName = test.className ? `${test.className}.${test.name}` : test.name;
        result.symbols!.push({
          symbolId: `${filePath}::${symbolName}#function`,
          name: test.name,
          kind: 'function',
          signature: test.className
            ? `def ${test.className}.${test.name}(self, ...)`
            : `def ${test.name}(...)`,
          byteStart: test.byteStart,
          byteEnd: test.byteEnd,
          lineStart: test.lineStart,
          lineEnd: test.lineEnd,
          metadata: meta,
        });
      }

      // Also extract inline fixtures
      for (const fix of fixtures) {
        result.symbols!.push({
          symbolId: `${filePath}::${fix.name}#function`,
          name: fix.name,
          kind: 'function',
          signature: `@pytest.fixture(scope="${fix.scope}")`,
          byteStart: fix.byteStart,
          byteEnd: fix.byteEnd,
          lineStart: fix.lineStart,
          lineEnd: fix.lineEnd,
          metadata: {
            pytest_fixture: true,
            scope: fix.scope,
            autouse: fix.autouse || undefined,
          },
        });
      }
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
