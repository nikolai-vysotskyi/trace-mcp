/**
 * TestingPlugin -- detects test frameworks (Playwright, Cypress, Jest, Vitest, Mocha)
 * and extracts test-to-code relationships: tested routes, tested components, and test names.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../plugin-api/types.js';
import { globalRe } from '../../../../utils/regex.js';

// --- Regex patterns ---

// Route visits: page.goto('/path'), cy.visit('/path')
const PAGE_GOTO_RE = /page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/g;
const CY_VISIT_RE = /cy\.visit\s*\(\s*['"`]([^'"`]+)['"`]/g;

// API requests: request.get('/api/...'), request.post('/api/...'), request.put, request.delete, request.patch
const REQUEST_METHOD_RE = /request\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// cy.request('METHOD', '/path') or cy.request('/path')
const CY_REQUEST_METHOD_RE =
  /cy\.request\s*\(\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g;
const CY_REQUEST_SIMPLE_RE = /cy\.request\s*\(\s*['"`](\/[^'"`]+)['"`]\s*\)/g;

// fetch('/api/...')
const FETCH_RE = /fetch\s*\(\s*['"`](\/[^'"`]+)['"`]/g;

// Component rendering: render(<Foo />), mount(Foo), cy.mount(<Bar />)
const RENDER_JSX_RE = /render\s*\(\s*<\s*([A-Z][A-Za-z0-9]*)/g;
const MOUNT_RE = /mount\s*\(\s*([A-Z][A-Za-z0-9]*)/g;
const CY_MOUNT_RE = /cy\.mount\s*\(\s*<\s*([A-Z][A-Za-z0-9]*)/g;

// Test names: test('name', ...), it('name', ...), describe('name', ...)
const TEST_NAME_RE = /(?:^|[;\s])test\s*\(\s*['"`]([^'"`]+)['"`]/g;
const IT_NAME_RE = /(?:^|[;\s])it\s*\(\s*['"`]([^'"`]+)['"`]/g;
const DESCRIBE_NAME_RE = /(?:^|[;\s])describe\s*\(\s*['"`]([^'"`]+)['"`]/g;
const TEST_DESCRIBE_RE = /test\.describe\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Framework detection via imports
const PLAYWRIGHT_IMPORT_RE = /from\s+['"`]@playwright\/test['"`]/;
const CYPRESS_GLOBAL_RE = /\bcy\s*\.\s*(?:visit|request|mount|get|contains|intercept)\b/;
const VITEST_IMPORT_RE = /from\s+['"`]vitest['"`]/;
const JEST_IMPORT_RE = /from\s+['"`]@jest\b/;
const JEST_GLOBALS_RE = /from\s+['"`]@jest\/globals['"`]/;
const MOCHA_IMPORT_RE = /from\s+['"`]mocha['"`]/;
const MOCHA_REQUIRE_RE = /require\s*\(\s*['"`]mocha['"`]\s*\)/;

// E2E markers
const PLAYWRIGHT_E2E_RE = /page\s*\.\s*(?:goto|click|fill|locator|getByRole|getByText)\b/;
const CY_E2E_RE = /cy\s*\.\s*(?:get|contains|intercept|wait)\b/;

/** Detect which test framework a source file uses. */
export function detectTestFramework(
  source: string,
  _filePath: string,
): 'playwright' | 'cypress' | 'jest' | 'vitest' | 'mocha' | null {
  if (PLAYWRIGHT_IMPORT_RE.test(source)) return 'playwright';
  if (CYPRESS_GLOBAL_RE.test(source)) return 'cypress';
  if (VITEST_IMPORT_RE.test(source)) return 'vitest';
  if (JEST_IMPORT_RE.test(source) || JEST_GLOBALS_RE.test(source)) return 'jest';
  if (MOCHA_IMPORT_RE.test(source) || MOCHA_REQUIRE_RE.test(source)) return 'mocha';
  return null;
}

/** Extract routes tested by navigation or API calls. */
export function extractTestedRoutes(source: string): { path: string; method?: string }[] {
  const routes: { path: string; method?: string }[] = [];
  const seen = new Set<string>();

  function add(p: string, method?: string) {
    const key = `${method ?? ''}:${p}`;
    if (!seen.has(key)) {
      seen.add(key);
      routes.push({ path: p, method });
    }
  }

  // page.goto
  let m: RegExpExecArray | null;
  const gotoRe = globalRe(PAGE_GOTO_RE);
  while ((m = gotoRe.exec(source)) !== null) add(m[1], 'GET');

  // cy.visit
  const visitRe = globalRe(CY_VISIT_RE);
  while ((m = visitRe.exec(source)) !== null) add(m[1], 'GET');

  // request.get/post/...
  const reqRe = globalRe(REQUEST_METHOD_RE);
  while ((m = reqRe.exec(source)) !== null) add(m[2], m[1].toUpperCase());

  // cy.request('METHOD', '/path')
  const cyReqMethodRe = globalRe(CY_REQUEST_METHOD_RE);
  while ((m = cyReqMethodRe.exec(source)) !== null) add(m[2], m[1].toUpperCase());

  // cy.request('/path')
  const cyReqSimpleRe = globalRe(CY_REQUEST_SIMPLE_RE);
  while ((m = cyReqSimpleRe.exec(source)) !== null) add(m[1]);

  // fetch('/api/...')
  const fetchRe = globalRe(FETCH_RE);
  while ((m = fetchRe.exec(source)) !== null) add(m[1]);

  return routes;
}

/** Extract component names tested via render/mount. */
export function extractTestedComponents(source: string): string[] {
  const components: string[] = [];
  const seen = new Set<string>();

  function add(name: string) {
    if (!seen.has(name)) {
      seen.add(name);
      components.push(name);
    }
  }

  let m: RegExpExecArray | null;

  const renderRe = globalRe(RENDER_JSX_RE);
  while ((m = renderRe.exec(source)) !== null) add(m[1]);

  const mountRe = globalRe(MOUNT_RE);
  while ((m = mountRe.exec(source)) !== null) add(m[1]);

  const cyMountRe = globalRe(CY_MOUNT_RE);
  while ((m = cyMountRe.exec(source)) !== null) add(m[1]);

  return components;
}

/** Extract test and describe block names. */
export function extractTestNames(source: string): { name: string; type: 'test' | 'describe' }[] {
  const names: { name: string; type: 'test' | 'describe' }[] = [];

  let m: RegExpExecArray | null;

  const testRe = globalRe(TEST_NAME_RE);
  while ((m = testRe.exec(source)) !== null) names.push({ name: m[1], type: 'test' });

  const itRe = globalRe(IT_NAME_RE);
  while ((m = itRe.exec(source)) !== null) names.push({ name: m[1], type: 'test' });

  const describeRe = globalRe(DESCRIBE_NAME_RE);
  while ((m = describeRe.exec(source)) !== null) names.push({ name: m[1], type: 'describe' });

  const testDescRe = globalRe(TEST_DESCRIBE_RE);
  while ((m = testDescRe.exec(source)) !== null) names.push({ name: m[1], type: 'describe' });

  return names;
}

const TESTING_DEPS = ['@playwright/test', 'cypress', 'jest', 'vitest', 'mocha'];

export class TestingPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'testing',
    version: '1.0.0',
    priority: 50,
    category: 'testing',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const dep of TESTING_DEPS) {
        if (dep in deps) return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const dep of TESTING_DEPS) {
        if (dep in deps) return true;
      }
    } catch {
      // no package.json or parse error
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'test_covers_route',
          category: 'testing',
          description: 'Test file visits/requests an API route',
        },
        {
          name: 'test_covers_component',
          category: 'testing',
          description: 'Test file mounts/renders a component',
        },
        {
          name: 'test_imports_module',
          category: 'testing',
          description: 'Test file imports the module under test',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const framework = detectTestFramework(source, filePath);
    if (!framework) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    // Determine framework role
    const isE2e =
      PLAYWRIGHT_E2E_RE.test(source) ||
      CY_E2E_RE.test(source) ||
      PAGE_GOTO_RE.test(source) ||
      CY_VISIT_RE.test(source);

    if (framework === 'playwright') {
      result.frameworkRole = isE2e ? 'e2e_test' : 'playwright_test';
    } else if (framework === 'cypress') {
      result.frameworkRole = isE2e ? 'e2e_test' : 'cypress_test';
    } else {
      result.frameworkRole = 'unit_test';
    }

    // Extract tested routes
    const routes = extractTestedRoutes(source);
    for (const route of routes) {
      result.routes!.push({
        method: 'TEST_ROUTE',
        uri: route.path,
        metadata: route.method ? { httpMethod: route.method } : undefined,
      });
    }

    // Extract tested components
    const components = extractTestedComponents(source);
    for (const name of components) {
      result.routes!.push({
        method: 'TEST_COMPONENT',
        uri: name,
      });
    }

    // Extract test names
    const testNames = extractTestNames(source);
    for (const t of testNames) {
      result.routes!.push({
        method: 'TEST',
        uri: t.name,
        metadata: { testType: t.type },
      });
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
