import { beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_PACKAGES } from '../../../src/analytics/known-packages.js';
import {
  extractReactTableSummary,
  ReactTablePlugin,
} from '../../../src/indexer/plugins/integration/view/react-table/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

describe('ReactTablePlugin', () => {
  let plugin: ReactTablePlugin;

  beforeEach(() => {
    plugin = new ReactTablePlugin();
  });

  describe('detect()', () => {
    it('detects @tanstack/react-table', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { '@tanstack/react-table': '^8.21.3' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('detects @tanstack/vue-table', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { '@tanstack/vue-table': '^8.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('detects legacy react-table v7 (no @tanstack scope)', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { 'react-table': '^7.8.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('detects @tanstack/solid-table and @tanstack/svelte-table', () => {
      const ctxSolid: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { '@tanstack/solid-table': '^8.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctxSolid)).toBe(true);
      const ctxSvelte: ProjectContext = {
        rootPath: '/tmp/x',
        packageJson: { dependencies: { '@tanstack/svelte-table': '^8.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctxSvelte)).toBe(true);
    });

    it('returns false for unrelated project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-zzzz',
        packageJson: { dependencies: { react: '^18.0.0' } },
        configFiles: [],
        detectedVersions: [],
        allDependencies: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('extractReactTableSummary()', () => {
    it('extracts createColumnHelper with row type', () => {
      const source = `const columnHelper = createColumnHelper<User>();`;
      const summary = extractReactTableSummary(source);
      expect(summary.helpers).toEqual([{ variable: 'columnHelper', rowType: 'User' }]);
    });

    it('extracts string accessor columns', () => {
      const source = `
        const columnHelper = createColumnHelper<User>();
        const columns = [
          columnHelper.accessor('email', { header: 'Email' }),
          columnHelper.accessor('name', { header: 'Name' }),
        ];
      `;
      const summary = extractReactTableSummary(source);
      const accessors = summary.columns.map((c) => c.accessor);
      expect(accessors).toEqual(['email', 'name']);
      expect(summary.columns.every((c) => c.kind === 'accessor')).toBe(true);
    });

    it('extracts function accessor columns', () => {
      const source = `
        const columnHelper = createColumnHelper<User>();
        const c = columnHelper.accessor((row) => row.profile.email, { id: 'email' });
      `;
      const summary = extractReactTableSummary(source);
      expect(summary.columns).toHaveLength(1);
      expect(summary.columns[0].accessorFn).toBe('row.profile.email');
    });

    it('extracts display and group columns', () => {
      const source = `
        const columnHelper = createColumnHelper<User>();
        const cols = [
          columnHelper.display({ id: 'actions' }),
          columnHelper.group({ id: 'address', columns: [] }),
        ];
      `;
      const summary = extractReactTableSummary(source);
      const kinds = summary.columns.map((c) => c.kind).sort();
      expect(kinds).toEqual(['display', 'group']);
    });

    it('extracts useReactTable instances and row models', () => {
      const source = `
        const table = useReactTable({
          data: users,
          columns,
          getCoreRowModel: getCoreRowModel(),
          getSortedRowModel: getSortedRowModel(),
          getPaginationRowModel: getPaginationRowModel(),
        });
      `;
      const summary = extractReactTableSummary(source);
      expect(summary.tables).toHaveLength(1);
      expect(summary.tables[0].rowModels.sort()).toEqual([
        'getCoreRowModel',
        'getPaginationRowModel',
        'getSortedRowModel',
      ]);
      expect(summary.tables[0].dataRef).toBe('users');
      expect(summary.tables[0].columnsRef).toBe('columns');
    });

    it('ignores useReactTable inside a comment', () => {
      const summary = extractReactTableSummary(`
        // example: const t = useReactTable({ data, columns });
        const x = 1;
      `);
      expect(summary.tables).toHaveLength(0);
      expect(summary.helpers).toHaveLength(0);
    });

    it('ignores createColumnHelper inside a JSDoc block', () => {
      const summary = extractReactTableSummary(`
        /**
         * Usage:
         *   const helper = createColumnHelper<User>();
         */
        const real = createColumnHelper<Real>();
      `);
      expect(summary.helpers).toHaveLength(1);
      expect(summary.helpers[0]).toEqual({ variable: 'real', rowType: 'Real' });
    });

    it('returns empty summary for unrelated source', () => {
      const summary = extractReactTableSummary('const x = 1;');
      expect(summary.helpers).toHaveLength(0);
      expect(summary.columns).toHaveLength(0);
      expect(summary.tables).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('emits TABLE_HELPER + TABLE_COLUMN routes', () => {
      const source = `
        const columnHelper = createColumnHelper<User>();
        const cols = [columnHelper.accessor('email', {})];
      `;
      const result = plugin.extractNodes('table.tsx', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      const methods = parsed.routes!.map((r) => r.method);
      expect(methods).toContain('TABLE_HELPER');
      expect(methods).toContain('TABLE_COLUMN');
      expect(parsed.frameworkRole).toBe('react_table_columns');
    });

    it('flags react_table_view when useReactTable is present', () => {
      const source = `
        const t = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
      `;
      const result = plugin.extractNodes('grid.tsx', Buffer.from(source), 'typescript');
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('react_table_view');
      expect(parsed.routes!.some((r) => r.method === 'TABLE_INSTANCE')).toBe(true);
    });

    it('skips files without react-table signals', () => {
      const result = plugin.extractNodes(
        'plain.tsx',
        Buffer.from('export const x = 1;'),
        'typescript',
      );
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('a.go', Buffer.from(''), 'go');
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has expected name and category', () => {
      expect(plugin.manifest.name).toBe('react-table');
      expect(plugin.manifest.category).toBe('view');
    });
  });

  describe('catalog wiring', () => {
    it.each([
      '@tanstack/react-table',
      '@tanstack/vue-table',
      '@tanstack/table-core',
      '@tanstack/solid-table',
      '@tanstack/svelte-table',
      'react-table',
    ])('%s is mapped to the react-table plugin', (pkg) => {
      expect(KNOWN_PACKAGES[pkg]?.plugin).toBe('react-table');
    });
  });

  describe('useReactTable options with nested {} (state, meta)', () => {
    it('parses options with nested object literals correctly', () => {
      const summary = extractReactTableSummary(`
        const t = useReactTable({
          data: users,
          columns: cols,
          state: { sorting, pagination, columnVisibility },
          meta: { foo: () => 1 },
          getCoreRowModel: getCoreRowModel(),
          getSortedRowModel: getSortedRowModel(),
        });
      `);
      expect(summary.tables).toHaveLength(1);
      expect(summary.tables[0].dataRef).toBe('users');
      expect(summary.tables[0].columnsRef).toBe('cols');
      expect(summary.tables[0].rowModels.sort()).toEqual(['getCoreRowModel', 'getSortedRowModel']);
    });
  });

  describe('resolveEdges()', () => {
    it('emits react_table_instance edge for components using useReactTable', () => {
      const src = `
        export function UsersGrid() {
          const t = useReactTable({
            data,
            columns,
            getCoreRowModel: getCoreRowModel(),
          });
          return null;
        }
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'grid.tsx', language: 'typescript' }],
        getSymbolsByFile: () => [
          { id: 50, symbolId: 'g', name: 'UsersGrid', kind: 'function', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const instance = edges.filter((e) => e.edgeType === 'react_table_instance');
      expect(instance).toHaveLength(1);
      expect(instance[0].sourceRefId).toBe(50);
      expect((instance[0].metadata as { rowModels: string[] }).rowModels).toContain(
        'getCoreRowModel',
      );
    });

    it('emits ONE aggregated react_table_column self-loop with all columns in metadata', () => {
      // Aggregation matters: edges has UNIQUE(src,tgt,type), so per-column
      // self-loops would collapse and silently lose every column except one.
      const src = `
        const columnHelper = createColumnHelper<User>();
        export const cols = [
          columnHelper.accessor('email', {}),
          columnHelper.accessor('name', {}),
          columnHelper.display({ id: 'actions' }),
        ];
      `;
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'cols.ts', language: 'typescript' }],
        getSymbolsByFile: () => [
          // first symbol must be class/function for owner detection
          { id: 60, symbolId: 'fn', name: 'cols', kind: 'function', fqn: null },
        ],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => src,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      const cols = edges.filter((e) => e.edgeType === 'react_table_column');
      expect(cols).toHaveLength(1);
      const meta = cols[0].metadata as {
        count: number;
        columns: { kind: string; accessor?: string }[];
      };
      expect(meta.count).toBe(3);
      expect(meta.columns.map((c) => c.accessor ?? '<display>')).toEqual([
        'email',
        'name',
        '<display>',
      ]);
      expect(meta.columns.find((c) => c.kind === 'display')).toBeTruthy();
    });

    it('does not emit edges for files without a class/function owner', () => {
      const ctx: ResolveContext = {
        rootPath: '/x',
        getAllFiles: () => [{ id: 1, path: 'x.ts', language: 'typescript' }],
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => `const t = useReactTable({ data, columns });`,
      } as unknown as ResolveContext;

      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      expect(edges).toHaveLength(0);
    });
  });
});
