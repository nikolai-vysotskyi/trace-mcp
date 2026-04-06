import { describe, it, expect, beforeEach } from 'vitest';
import { ReactPlugin } from '../../../src/indexer/plugins/integration/view/react/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('ReactPlugin', () => {
  let plugin: ReactPlugin;

  beforeEach(() => {
    plugin = new ReactPlugin();
  });

  // ============================================================
  // Detection
  // ============================================================

  describe('detect()', () => {
    it('returns true when react is in deps without next or react-native', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake-react-app',
        packageJson: { dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when next is also in deps', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake-next-app',
        packageJson: { dependencies: { react: '^18.2.0', next: '^14.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('returns false when react-native is in deps', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake-rn-app',
        packageJson: { dependencies: { react: '^18.2.0', 'react-native': '^0.73.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('returns false when react is not in deps', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake-vue-app',
        packageJson: { dependencies: { vue: '^3.4.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  // ============================================================
  // Schema
  // ============================================================

  describe('registerSchema()', () => {
    it('returns all expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('react_renders');
      expect(names).toContain('react_context_provides');
      expect(names).toContain('react_context_consumes');
      expect(names).toContain('react_lazy_loads');
      expect(names).toContain('react_custom_hook_uses');
      expect(names).toContain('react_use_client');
      expect(names).toContain('react_use_server');
    });

    it('all edge types have react category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('react');
      }
    });
  });

  // ============================================================
  // JSX child component rendering
  // ============================================================

  describe('JSX child component rendering', () => {
    it('detects PascalCase JSX self-closing elements', async () => {
      const source = `
        import React from 'react';
        import { UserCard } from './UserCard';

        export function Dashboard() {
          return (
            <div>
              <UserCard />
              <ProfileBadge size="lg" />
            </div>
          );
        }
      `;
      const result = await plugin.extractNodes!('Dashboard.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const renderEdges = parsed.edges!.filter((e) => e.edgeType === 'react_renders');
      const componentNames = renderEdges.map((e) => e.metadata?.componentName);
      expect(componentNames).toContain('UserCard');
      expect(componentNames).toContain('ProfileBadge');
    });

    it('detects JSX elements with children (non-self-closing)', async () => {
      const source = `
        export function App() {
          return (
            <Layout>
              <Sidebar />
              <p>hello</p>
            </Layout>
          );
        }
      `;
      const result = await plugin.extractNodes!('App.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const renderEdges = parsed.edges!.filter((e) => e.edgeType === 'react_renders');
      const names = renderEdges.map((e) => e.metadata?.componentName);
      expect(names).toContain('Layout');
      expect(names).toContain('Sidebar');
      // Should NOT include <p> or <div>
      expect(names).not.toContain('p');
      expect(names).not.toContain('div');
    });
  });

  // ============================================================
  // useContext edge extraction
  // ============================================================

  describe('useContext / use() consumption', () => {
    it('detects useContext(ThemeContext)', async () => {
      const source = `
        import { useContext } from 'react';
        import { ThemeContext } from './ThemeContext';

        export function ThemedButton() {
          const theme = useContext(ThemeContext);
          return <button style={{ color: theme.primary }}>Click</button>;
        }
      `;
      const result = await plugin.extractNodes!('ThemedButton.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const contextEdges = parsed.edges!.filter((e) => e.edgeType === 'react_context_consumes');
      expect(contextEdges).toHaveLength(1);
      expect(contextEdges[0].metadata?.contextName).toBe('ThemeContext');
    });

    it('detects use(ThemeContext) — React 19', async () => {
      const source = `
        import { use } from 'react';

        export function ThemedButton() {
          const theme = use(ThemeContext);
          return <button>Click</button>;
        }
      `;
      const result = await plugin.extractNodes!('ThemedButton.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const contextEdges = parsed.edges!.filter((e) => e.edgeType === 'react_context_consumes');
      expect(contextEdges).toHaveLength(1);
      expect(contextEdges[0].metadata?.contextName).toBe('ThemeContext');
    });
  });

  // ============================================================
  // Context.Provider detection
  // ============================================================

  describe('Context.Provider', () => {
    it('detects <ThemeContext.Provider> JSX', async () => {
      const source = `
        export function ThemeProvider({ children }: { children: React.ReactNode }) {
          const theme = { primary: '#007bff' };
          return (
            <ThemeContext.Provider value={theme}>
              {children}
            </ThemeContext.Provider>
          );
        }
      `;
      const result = await plugin.extractNodes!('ThemeProvider.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const providerEdges = parsed.edges!.filter((e) => e.edgeType === 'react_context_provides');
      expect(providerEdges).toHaveLength(1);
      expect(providerEdges[0].metadata?.contextName).toBe('ThemeContext');
    });
  });

  // ============================================================
  // 'use client' / 'use server' directives
  // ============================================================

  describe("'use client' / 'use server' directives", () => {
    it("detects 'use client' directive", async () => {
      const source = `'use client';

        import { useState } from 'react';

        export function Counter() {
          const [count, setCount] = useState(0);
          return <button onClick={() => setCount(count + 1)}>{count}</button>;
        }
      `;
      const result = await plugin.extractNodes!('Counter.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('client-component');
      const clientEdges = parsed.edges!.filter((e) => e.edgeType === 'react_use_client');
      expect(clientEdges).toHaveLength(1);
    });

    it("detects 'use server' directive", async () => {
      const source = `"use server";

        export async function submitForm(data: FormData) {
          // server action
        }
      `;
      const result = await plugin.extractNodes!('actions.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('server-action');
      const serverEdges = parsed.edges!.filter((e) => e.edgeType === 'react_use_server');
      expect(serverEdges).toHaveLength(1);
    });

    it("detects directive after leading comments", async () => {
      const source = `// Copyright 2024
/* license block */
'use client';

        export function Widget() {
          return <div />;
        }
      `;
      const result = await plugin.extractNodes!('Widget.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('client-component');
    });
  });

  // ============================================================
  // React.lazy detection
  // ============================================================

  describe('React.lazy()', () => {
    it('detects React.lazy with dynamic import', async () => {
      const source = `
        import React from 'react';

        const LazyDashboard = React.lazy(() => import('./Dashboard'));

        export function App() {
          return (
            <React.Suspense fallback={<div>Loading...</div>}>
              <LazyDashboard />
            </React.Suspense>
          );
        }
      `;
      const result = await plugin.extractNodes!('App.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const lazyEdges = parsed.edges!.filter((e) => e.edgeType === 'react_lazy_loads');
      expect(lazyEdges).toHaveLength(1);
      expect(lazyEdges[0].metadata?.importPath).toBe('./Dashboard');
    });

    it('detects bare lazy() import (named import)', async () => {
      const source = `
        import { lazy } from 'react';

        const Settings = lazy(() => import('./Settings'));
      `;
      const result = await plugin.extractNodes!('routes.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const lazyEdges = parsed.edges!.filter((e) => e.edgeType === 'react_lazy_loads');
      expect(lazyEdges).toHaveLength(1);
      expect(lazyEdges[0].metadata?.importPath).toBe('./Settings');
    });
  });

  // ============================================================
  // Custom hook usage detection
  // ============================================================

  describe('Custom hook usage', () => {
    it('detects custom hook calls', async () => {
      const source = `
        import { useAuth } from './useAuth';
        import { useTheme } from './useTheme';

        export function Profile() {
          const auth = useAuth();
          const theme = useTheme();
          return <div style={{ color: theme.fg }}>{auth.user.name}</div>;
        }
      `;
      const result = await plugin.extractNodes!('Profile.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const hookEdges = parsed.edges!.filter((e) => e.edgeType === 'react_custom_hook_uses');
      const hookNames = hookEdges.map((e) => e.metadata?.hookName);
      expect(hookNames).toContain('useAuth');
      expect(hookNames).toContain('useTheme');
    });

    it('does NOT flag built-in hooks as custom', async () => {
      const source = `
        import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

        export function Counter() {
          const [count, setCount] = useState(0);
          const ref = useRef(null);
          const doubled = useMemo(() => count * 2, [count]);
          const inc = useCallback(() => setCount(c => c + 1), []);
          useEffect(() => { document.title = String(count); }, [count]);
          return <div ref={ref}>{doubled}</div>;
        }
      `;
      const result = await plugin.extractNodes!('Counter.tsx', Buffer.from(source), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const hookEdges = parsed.edges!.filter((e) => e.edgeType === 'react_custom_hook_uses');
      expect(hookEdges).toHaveLength(0);
    });
  });

  // ============================================================
  // Context creation
  // ============================================================

  describe('Context creation', () => {
    it('detects createContext() and stores as component', async () => {
      const source = `
        import { createContext } from 'react';

        export const ThemeContext = createContext({ primary: '#000' });
      `;
      const result = await plugin.extractNodes!('ThemeContext.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const contexts = parsed.components!.filter((c) => c.kind === 'context');
      expect(contexts).toHaveLength(1);
      expect(contexts[0].name).toBe('ThemeContext');
      expect(contexts[0].framework).toBe('react');
    });
  });

  // ============================================================
  // Manifest
  // ============================================================

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('react');
      expect(plugin.manifest.priority).toBe(20);
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================

  describe('edge cases', () => {
    it('skips non-JS/TS languages', async () => {
      const result = await plugin.extractNodes!('style.css', Buffer.from('body {}'), 'css');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('handles empty files', async () => {
      const result = await plugin.extractNodes!('empty.tsx', Buffer.from(''), 'typescriptreact');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });
});
