import { describe, it, expect, beforeEach } from 'vitest';
import {
  ZodPlugin,
  extractZodSchemas,
  extractZodInferences,
} from '../../../src/indexer/plugins/integration/zod/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('ZodPlugin', () => {
  let plugin: ZodPlugin;

  beforeEach(() => {
    plugin = new ZodPlugin();
  });

  describe('detect()', () => {
    it('returns true when packageJson has zod in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { zod: '^3.22.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when zod is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { devDependencies: { zod: '^3.22.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-Zod project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-12345',
        packageJson: { dependencies: { yup: '^1.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns zod_schema edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes.map((e) => e.name);
      expect(names).toContain('zod_schema');
    });

    it('all edge types have zod category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes) {
        expect(et.category).toBe('zod');
      }
    });
  });

  describe('extractZodSchemas()', () => {
    it('extracts a simple z.object schema with fields', () => {
      const source = `
        const userSchema = z.object({
          name: z.string(),
          email: z.string(),
          age: z.number(),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].name).toBe('userSchema');
      expect(schemas[0].fields.length).toBe(3);
      expect(schemas[0].fields[0]).toEqual({ name: 'name', type: 'string' });
      expect(schemas[0].fields[1]).toEqual({ name: 'email', type: 'string' });
      expect(schemas[0].fields[2]).toEqual({ name: 'age', type: 'number' });
    });

    it('extracts boolean fields', () => {
      const source = `
        const settingsSchema = z.object({
          active: z.boolean(),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].fields[0]).toEqual({ name: 'active', type: 'boolean' });
    });

    it('extracts optional fields', () => {
      const source = `
        const schema = z.object({
          nickname: z.string().optional(),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].fields[0].type).toBe('string?');
    });

    it('extracts nullable fields', () => {
      const source = `
        const schema = z.object({
          avatar: z.string().nullable(),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].fields[0].type).toBe('string | null');
    });

    it('extracts array fields', () => {
      const source = `
        const schema = z.object({
          tags: z.array(z.string()),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].fields[0].type).toBe('array');
    });

    it('extracts enum fields', () => {
      const source = `
        const schema = z.object({
          role: z.enum(['admin', 'user']),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].fields[0].type).toBe('enum');
    });

    it('extracts exported schemas', () => {
      const source = `
        export const createUserInput = z.object({
          name: z.string(),
          email: z.string(),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(1);
      expect(schemas[0].name).toBe('createUserInput');
    });

    it('extracts multiple schemas from same file', () => {
      const source = `
        const userSchema = z.object({
          name: z.string(),
        });
        const postSchema = z.object({
          title: z.string(),
          body: z.string(),
        });
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas.length).toBe(2);
      expect(schemas[0].name).toBe('userSchema');
      expect(schemas[1].name).toBe('postSchema');
    });

    it('returns empty array for non-Zod code', () => {
      const source = `
        const x = 42;
        function hello() { return 'world'; }
      `;
      const schemas = extractZodSchemas(source);
      expect(schemas).toHaveLength(0);
    });
  });

  describe('extractZodInferences()', () => {
    it('extracts z.infer type', () => {
      const source = `
        type User = z.infer<typeof userSchema>;
      `;
      const inferences = extractZodInferences(source);
      expect(inferences.length).toBe(1);
      expect(inferences[0].typeName).toBe('User');
      expect(inferences[0].schemaName).toBe('userSchema');
    });

    it('extracts multiple inferences', () => {
      const source = `
        type User = z.infer<typeof userSchema>;
        type Post = z.infer<typeof postSchema>;
      `;
      const inferences = extractZodInferences(source);
      expect(inferences.length).toBe(2);
    });

    it('returns empty for non-inference code', () => {
      const source = `const x = 42;`;
      const inferences = extractZodInferences(source);
      expect(inferences).toHaveLength(0);
    });
  });

  describe('extractNodes()', () => {
    it('sets zod_schema role and creates routes', () => {
      const source = `
        const userSchema = z.object({
          name: z.string(),
          email: z.string(),
        });
      `;
      const result = plugin.extractNodes('schemas/user.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('zod_schema');
      expect(parsed.routes!.length).toBe(1);
      expect(parsed.routes![0].method).toBe('SCHEMA');
      expect(parsed.routes![0].uri).toBe('zod:userSchema');
    });

    it('skips non-JS/TS files', () => {
      const result = plugin.extractNodes('test.css', Buffer.from(''), 'css');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('does not set frameworkRole when no schemas found', () => {
      const source = `const x = 42;`;
      const result = plugin.extractNodes('util.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().frameworkRole).toBeUndefined();
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('zod');
      expect(plugin.manifest.priority).toBe(30);
    });
  });
});
