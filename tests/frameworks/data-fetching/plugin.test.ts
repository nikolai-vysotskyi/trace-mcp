import { describe, it, expect, beforeEach } from 'vitest';
import {
  DataFetchingPlugin,
  extractDataFetchingHooks,
} from '../../../src/indexer/plugins/integration/data-fetching/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('DataFetchingPlugin', () => {
  let plugin: DataFetchingPlugin;

  beforeEach(() => {
    plugin = new DataFetchingPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has @tanstack/react-query', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { '@tanstack/react-query': '^5.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has swr', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { swr: '^2.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when swr is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { devDependencies: { swr: '^2.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for unrelated project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { axios: '^1.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns fetches_endpoint edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('fetches_endpoint');
    });

    it('all edge types have data-fetching category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('data-fetching');
      }
    });
  });

  describe('extractDataFetchingHooks()', () => {
    it('extracts useQuery with object syntax and fetch', () => {
      const source = `
        const { data } = useQuery({
          queryKey: ['users'],
          queryFn: () => fetch('/api/users').then(r => r.json()),
        });
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].hook).toBe('useQuery');
      expect(hooks[0].endpoint).toBe('/api/users');
      expect(hooks[0].method).toBe('FETCH');
    });

    it('extracts useQuery with array key syntax', () => {
      const source = `
        const { data } = useQuery(['users'], () => fetch('/api/users').then(r => r.json()));
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].hook).toBe('useQuery');
      expect(hooks[0].endpoint).toBe('/api/users');
    });

    it('extracts useMutation with POST method', () => {
      const source = `
        const mutation = useMutation({
          mutationFn: (data) => fetch('/api/users', { method: 'POST', body: JSON.stringify(data) }),
        });
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].hook).toBe('useMutation');
      expect(hooks[0].endpoint).toBe('/api/users');
      expect(hooks[0].method).toBe('POST');
    });

    it('extracts useMutation defaulting to POST when no method specified', () => {
      const source = `
        const mutation = useMutation({
          mutationFn: (data) => fetch('/api/items'),
        });
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].method).toBe('POST');
    });

    it('extracts useSWR with string key', () => {
      const source = `
        const { data } = useSWR('/api/users', fetcher);
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].hook).toBe('useSWR');
      expect(hooks[0].endpoint).toBe('/api/users');
      expect(hooks[0].method).toBe('FETCH');
    });

    it('extracts useSWR with arrow function key', () => {
      const source = `
        const { data } = useSWR(() => '/api/users/123', fetcher);
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].hook).toBe('useSWR');
      expect(hooks[0].endpoint).toBe('/api/users/123');
    });

    it('extracts useInfiniteQuery', () => {
      const source = `
        const { data } = useInfiniteQuery({
          queryKey: ['items'],
          queryFn: () => fetch('/api/items').then(r => r.json()),
        });
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
      expect(hooks[0].hook).toBe('useInfiniteQuery');
      expect(hooks[0].endpoint).toBe('/api/items');
    });

    it('extracts multiple hooks from same file', () => {
      const source = `
        const { data: users } = useSWR('/api/users', fetcher);
        const { data: posts } = useSWR('/api/posts', fetcher);
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(2);
      const endpoints = hooks.map((h) => h.endpoint);
      expect(endpoints).toContain('/api/users');
      expect(endpoints).toContain('/api/posts');
    });

    it('deduplicates identical hooks', () => {
      const source = `
        const { data } = useSWR('/api/users', fetcher);
        const { data: d2 } = useSWR('/api/users', otherFetcher);
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks.length).toBe(1);
    });

    it('returns empty array for non-data-fetching code', () => {
      const source = `
        const x = 42;
        function hello() { return 'world'; }
      `;
      const hooks = extractDataFetchingHooks(source);
      expect(hooks).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('sets data_fetching role and creates routes', () => {
      const source = `
        const { data } = useSWR('/api/users', fetcher);
      `;
      const result = plugin.extractNodes('hooks/useUsers.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('data_fetching');
      expect(parsed.routes!.length).toBe(1);
      expect(parsed.routes![0].method).toBe('FETCH');
      expect(parsed.routes![0].uri).toBe('/api/users');
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.css', Buffer.from(''), 'css');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('does not set frameworkRole when no hooks found', () => {
      const source = `const x = 42;`;
      const result = plugin.extractNodes('util.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('data-fetching');
      expect(plugin.manifest.priority).toBe(30);
    });
  });
});
