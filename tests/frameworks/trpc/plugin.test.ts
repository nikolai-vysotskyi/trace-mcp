import { describe, it, expect, beforeEach } from 'vitest';
import {
  TrpcPlugin,
  extractTrpcProcedures,
} from '../../../src/indexer/plugins/integration/api/trpc/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('TrpcPlugin', () => {
  let plugin: TrpcPlugin;

  beforeEach(() => {
    plugin = new TrpcPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has @trpc/server', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { dependencies: { '@trpc/server': '^10.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when @trpc/server is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent',
        packageJson: { devDependencies: { '@trpc/server': '^10.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-tRPC project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { express: '^4.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('trpc_procedure');
    });

    it('all edge types have trpc category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('trpc');
      }
    });
  });

  describe('extractTrpcProcedures()', () => {
    it('extracts a query procedure', () => {
      // The regex expects: name: <word>Procedure[.chain(simpleArgs)]*.query(
      // Keep chained calls on one line with simple (no nested parens) args
      const source = `
        export const appRouter = t.router({
          getUser: publicProcedure.input(schema).query(async ({ input }) => {
              return db.user.findUnique({ where: { id: input } });
            }),
        });
      `;
      const procs = extractTrpcProcedures(source);
      expect(procs).toHaveLength(1);
      expect(procs[0].name).toBe('getUser');
      expect(procs[0].type).toBe('query');
    });

    it('extracts a mutation procedure', () => {
      const source = `
        export const appRouter = t.router({
          createUser: publicProcedure.input(schema).mutation(async ({ input }) => {
              return db.user.create({ data: input });
            }),
        });
      `;
      const procs = extractTrpcProcedures(source);
      expect(procs).toHaveLength(1);
      expect(procs[0].name).toBe('createUser');
      expect(procs[0].type).toBe('mutation');
    });

    it('extracts a subscription procedure', () => {
      const source = `
        export const appRouter = t.router({
          onMessage: publicProcedure.subscription(() => {
              return observable((emit) => {});
            }),
        });
      `;
      const procs = extractTrpcProcedures(source);
      expect(procs).toHaveLength(1);
      expect(procs[0].name).toBe('onMessage');
      expect(procs[0].type).toBe('subscription');
    });

    it('extracts multiple procedures from a nested router', () => {
      const source = `
        export const userRouter = t.router({
          list: publicProcedure.query(async () => []),
          create: protectedProcedure.input(schema).mutation(async ({ input }) => {}),
          onUpdate: publicProcedure.subscription(() => observable(() => {})),
        });
      `;
      const procs = extractTrpcProcedures(source);
      expect(procs).toHaveLength(3);
      const types = procs.map((p) => p.type);
      expect(types).toContain('query');
      expect(types).toContain('mutation');
      expect(types).toContain('subscription');
    });

    it('returns empty array for source with no procedures', () => {
      const source = `
        const express = require('express');
        const app = express();
        app.get('/', (req, res) => res.send('hello'));
      `;
      const procs = extractTrpcProcedures(source);
      expect(procs).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('sets frameworkRole to trpc_router when router and procedures exist', () => {
      const source = `
        export const appRouter = t.router({
          hello: publicProcedure.query(() => 'world'),
        });
      `;
      const result = plugin.extractNodes('router.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('trpc_router');
      expect(parsed.routes).toHaveLength(1);
      expect(parsed.routes![0].method).toBe('QUERY');
      expect(parsed.routes![0].uri).toBe('hello');
    });

    it('sets frameworkRole to trpc_procedure when procedures exist without router()', () => {
      // Procedures use object property syntax (name: procedure.query(...))
      // but without a t.router({}) wrapper
      const source = `
        const procedures = {
          getUser: publicProcedure.input(schema).query(async ({ input }) => {}),
        };
      `;
      const result = plugin.extractNodes('proc.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('trpc_procedure');
    });

    it('populates routes with procedure type as method', () => {
      const source = `
        export const router = t.router({
          listUsers: publicProcedure.query(() => []),
          addUser: protectedProcedure.input(schema).mutation(async () => {}),
        });
      `;
      const result = plugin.extractNodes('router.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.routes).toHaveLength(2);

      const methods = parsed.routes!.map((r) => r.method);
      expect(methods).toContain('QUERY');
      expect(methods).toContain('MUTATION');
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.py', Buffer.from(''), 'python');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('trpc');
      expect(plugin.manifest.priority).toBe(25);
    });
  });
});
