import { describe, it, expect, beforeEach } from 'vitest';
import {
  TestingPlugin,
  detectTestFramework,
  extractTestedRoutes,
  extractTestedComponents,
  extractTestNames,
} from '../../../src/indexer/plugins/integration/testing/testing/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('TestingPlugin', () => {
  let plugin: TestingPlugin;

  beforeEach(() => {
    plugin = new TestingPlugin();
  });

  // ── detect() ────────────────────────────────────────────────────────

  describe('detect()', () => {
    it('returns true when packageJson has @playwright/test', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp',
        packageJson: { devDependencies: { '@playwright/test': '^1.40.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has cypress', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp',
        packageJson: { devDependencies: { cypress: '^13.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has jest', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp',
        packageJson: { devDependencies: { jest: '^29.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has vitest', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp',
        packageJson: { devDependencies: { vitest: '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has mocha', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp',
        packageJson: { devDependencies: { mocha: '^10.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for project with no test frameworks', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-99999',
        packageJson: { dependencies: { express: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  // ── registerSchema() ───────────────────────────────────────────────

  describe('registerSchema()', () => {
    it('returns 3 edge types', () => {
      const schema = plugin.registerSchema();
      expect(schema.edgeTypes).toHaveLength(3);
    });

    it('contains test_covers_route edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('test_covers_route');
    });

    it('contains test_covers_component edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('test_covers_component');
    });

    it('contains test_imports_module edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('test_imports_module');
    });

    it('all edge types have testing category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('testing');
      }
    });
  });

  // ── detectTestFramework() ──────────────────────────────────────────

  describe('detectTestFramework()', () => {
    it('detects playwright from import', () => {
      const source = `import { test, expect } from '@playwright/test';`;
      expect(detectTestFramework(source, 'e2e/login.spec.ts')).toBe('playwright');
    });

    it('detects cypress from cy.visit', () => {
      const source = `
        describe('Login', () => {
          it('loads page', () => {
            cy.visit('/login');
          });
        });
      `;
      expect(detectTestFramework(source, 'cypress/e2e/login.cy.ts')).toBe('cypress');
    });

    it('detects vitest from import', () => {
      const source = `import { describe, it, expect } from 'vitest';`;
      expect(detectTestFramework(source, 'src/__tests__/utils.test.ts')).toBe('vitest');
    });

    it('detects jest from @jest import', () => {
      const source = `import { jest } from '@jest/globals';`;
      expect(detectTestFramework(source, 'src/__tests__/foo.test.ts')).toBe('jest');
    });

    it('detects mocha from import', () => {
      const source = `import { describe, it } from 'mocha';`;
      expect(detectTestFramework(source, 'test/unit.test.ts')).toBe('mocha');
    });

    it('detects mocha from require', () => {
      const source = `const { describe, it } = require('mocha');`;
      expect(detectTestFramework(source, 'test/unit.test.js')).toBe('mocha');
    });

    it('returns null for non-test source', () => {
      const source = `export function add(a: number, b: number) { return a + b; }`;
      expect(detectTestFramework(source, 'src/utils.ts')).toBeNull();
    });
  });

  // ── extractTestedRoutes() ──────────────────────────────────────────

  describe('extractTestedRoutes()', () => {
    it('extracts page.goto routes', () => {
      const source = `
        test('homepage loads', async ({ page }) => {
          await page.goto('/dashboard');
          await page.goto('/settings');
        });
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(2);
      expect(routes[0]).toEqual({ path: '/dashboard', method: 'GET' });
      expect(routes[1]).toEqual({ path: '/settings', method: 'GET' });
    });

    it('extracts cy.visit routes', () => {
      const source = `
        it('visits login', () => {
          cy.visit('/login');
        });
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ path: '/login', method: 'GET' });
    });

    it('extracts request.get and request.post', () => {
      const source = `
        test('api', async ({ request }) => {
          const res = await request.get('/api/users');
          await request.post('/api/users');
        });
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(2);
      expect(routes[0]).toEqual({ path: '/api/users', method: 'GET' });
      expect(routes[1]).toEqual({ path: '/api/users', method: 'POST' });
    });

    it('extracts cy.request with method', () => {
      const source = `
        it('creates user', () => {
          cy.request('POST', '/api/users');
        });
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ path: '/api/users', method: 'POST' });
    });

    it('extracts cy.request without method', () => {
      const source = `
        it('gets health', () => {
          cy.request('/api/health');
        });
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ path: '/api/health', method: undefined });
    });

    it('extracts fetch calls', () => {
      const source = `
        it('fetches users', async () => {
          const res = await fetch('/api/users');
        });
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ path: '/api/users', method: undefined });
    });

    it('deduplicates identical routes', () => {
      const source = `
        page.goto('/home');
        page.goto('/home');
      `;
      const routes = extractTestedRoutes(source);
      expect(routes).toHaveLength(1);
    });
  });

  // ── extractTestedComponents() ──────────────────────────────────────

  describe('extractTestedComponents()', () => {
    it('extracts render(<Foo />)', () => {
      const source = `render(<Foo bar="baz" />);`;
      const components = extractTestedComponents(source);
      expect(components).toContain('Foo');
    });

    it('extracts mount(Foo)', () => {
      const source = `const wrapper = mount(Foo);`;
      const components = extractTestedComponents(source);
      expect(components).toContain('Foo');
    });

    it('extracts cy.mount(<Bar />)', () => {
      const source = `cy.mount(<Bar />);`;
      const components = extractTestedComponents(source);
      expect(components).toContain('Bar');
    });

    it('extracts multiple unique components', () => {
      const source = `
        render(<Header />);
        render(<Footer />);
        mount(Sidebar);
      `;
      const components = extractTestedComponents(source);
      expect(components).toHaveLength(3);
      expect(components).toContain('Header');
      expect(components).toContain('Footer');
      expect(components).toContain('Sidebar');
    });

    it('deduplicates same component', () => {
      const source = `
        render(<App />);
        render(<App />);
      `;
      const components = extractTestedComponents(source);
      expect(components).toHaveLength(1);
    });
  });

  // ── extractTestNames() ─────────────────────────────────────────────

  describe('extractTestNames()', () => {
    it('extracts test() names', () => {
      const source = `test('should add numbers', () => {});`;
      const names = extractTestNames(source);
      expect(names).toContainEqual({ name: 'should add numbers', type: 'test' });
    });

    it('extracts it() names', () => {
      const source = `it('renders correctly', () => {});`;
      const names = extractTestNames(source);
      expect(names).toContainEqual({ name: 'renders correctly', type: 'test' });
    });

    it('extracts describe() names', () => {
      const source = `describe('UserService', () => {});`;
      const names = extractTestNames(source);
      expect(names).toContainEqual({ name: 'UserService', type: 'describe' });
    });

    it('extracts test.describe() names (Playwright)', () => {
      const source = `test.describe('Login flow', () => {});`;
      const names = extractTestNames(source);
      expect(names).toContainEqual({ name: 'Login flow', type: 'describe' });
    });

    it('extracts multiple test/describe names', () => {
      const source = `
        describe('Math', () => {
          it('adds', () => {});
          it('subtracts', () => {});
          test('multiplies', () => {});
        });
      `;
      const names = extractTestNames(source);
      expect(names.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ── extractNodes() ─────────────────────────────────────────────────

  describe('extractNodes()', () => {
    it('sets e2e_test role for Playwright test with page.goto', () => {
      const source = `
        import { test, expect } from '@playwright/test';
        test('loads home', async ({ page }) => {
          await page.goto('/home');
        });
      `;
      const result = plugin.extractNodes('e2e/home.spec.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('e2e_test');
    });

    it('sets cypress_test role for Cypress component test', () => {
      const source = `
        cy.mount(<MyComponent />);
      `;
      const result = plugin.extractNodes('cypress/component/my.cy.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('cypress_test');
    });

    it('sets e2e_test role for Cypress with cy.visit', () => {
      const source = `
        cy.visit('/login');
        cy.get('#email').type('user@test.com');
      `;
      const result = plugin.extractNodes('cypress/e2e/login.cy.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('e2e_test');
    });

    it('sets unit_test role for vitest file', () => {
      const source = `
        import { describe, it, expect } from 'vitest';
        describe('utils', () => {
          it('works', () => {
            expect(1 + 1).toBe(2);
          });
        });
      `;
      const result = plugin.extractNodes('src/__tests__/utils.test.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('unit_test');
    });

    it('populates routes for tested routes', () => {
      const source = `
        import { test, expect } from '@playwright/test';
        test('api test', async ({ request }) => {
          await request.get('/api/users');
          await page.goto('/dashboard');
        });
      `;
      const result = plugin.extractNodes('e2e/api.spec.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const testRoutes = parsed.routes!.filter((r) => r.method === 'TEST_ROUTE');
      expect(testRoutes.length).toBeGreaterThanOrEqual(2);
      expect(testRoutes.some((r) => r.uri === '/api/users')).toBe(true);
      expect(testRoutes.some((r) => r.uri === '/dashboard')).toBe(true);
    });

    it('populates routes for tested components', () => {
      const source = `
        import { describe, it, expect } from 'vitest';
        import { render } from '@testing-library/react';
        describe('Button', () => {
          it('renders', () => {
            render(<Button label="Click" />);
          });
        });
      `;
      const result = plugin.extractNodes('src/__tests__/Button.test.tsx', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const compRoutes = parsed.routes!.filter((r) => r.method === 'TEST_COMPONENT');
      expect(compRoutes).toHaveLength(1);
      expect(compRoutes[0].uri).toBe('Button');
    });

    it('populates routes for test names', () => {
      const source = `
        import { describe, it, expect } from 'vitest';
        describe('Calculator', () => {
          it('adds numbers', () => {});
          test('subtracts numbers', () => {});
        });
      `;
      const result = plugin.extractNodes('src/__tests__/calc.test.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const testEntries = parsed.routes!.filter((r) => r.method === 'TEST');
      expect(testEntries.length).toBeGreaterThanOrEqual(3);
    });

    it('returns empty for non-test file', () => {
      const source = `export function add(a: number, b: number) { return a + b; }`;
      const result = plugin.extractNodes('src/utils.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.symbols).toHaveLength(0);
      expect(parsed.routes ?? []).toHaveLength(0);
    });

    it('returns empty for non-TS/JS language', () => {
      const source = `<?php test('foo');`;
      const result = plugin.extractNodes('test.php', Buffer.from(source), 'php');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.symbols).toHaveLength(0);
    });
  });

  // ── manifest ───────────────────────────────────────────────────────

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('testing');
      expect(plugin.manifest.priority).toBe(50);
    });
  });
});
