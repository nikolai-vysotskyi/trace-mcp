import { describe, it, expect } from 'vitest';
import { DrizzlePlugin } from '../../../src/indexer/plugins/integration/orm/drizzle/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

describe('DrizzlePlugin', () => {
  const plugin = new DrizzlePlugin();

  describe('detect()', () => {
    it('returns true when drizzle-orm is in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { 'drizzle-orm': '^0.29.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when drizzle-orm is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { devDependencies: { 'drizzle-orm': '^0.29.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when drizzle-orm is not in deps', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { prisma: '^5.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns drizzle_relation edge type', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);
      expect(edgeNames).toContain('drizzle_relation');
    });

    it('has drizzle category', () => {
      const schema = plugin.registerSchema();
      const drizzleEdge = schema.edgeTypes!.find((e) => e.name === 'drizzle_relation');
      expect(drizzleEdge!.category).toBe('drizzle');
    });
  });

  describe('manifest', () => {
    it('has correct name', () => {
      expect(plugin.manifest.name).toBe('drizzle');
    });
  });
});

describe('Drizzle extractNodes', () => {
  const plugin = new DrizzlePlugin();

  describe('pgTable', () => {
    const source = `
import { pgTable, integer, text, varchar, boolean, timestamp } from 'drizzle-orm/pg-core';

export const usersTable = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: varchar('email', { length: 255 }).unique(),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').notNull(),
});
`;

    it('extracts ormModels with correct name and orm', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.ormModels).toBeDefined();
      expect(data.ormModels!.length).toBe(1);
      expect(data.ormModels![0].name).toBe('User');
      expect(data.ormModels![0].orm).toBe('drizzle');
    });

    it('extracts collectionOrTable', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.ormModels![0].collectionOrTable).toBe('users');
    });

    it('extracts fields', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      const fields = data.ormModels![0].fields as Record<string, unknown>[];
      expect(fields.length).toBeGreaterThan(0);

      const idField = fields.find((f) => f.name === 'id');
      expect(idField).toBeDefined();
      expect(idField!.type).toBe('integer');
      expect(idField!.primaryKey).toBe(true);

      const nameField = fields.find((f) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect(nameField!.type).toBe('text');
      expect(nameField!.notNull).toBe(true);

      const emailField = fields.find((f) => f.name === 'email');
      expect(emailField).toBeDefined();
      expect(emailField!.type).toBe('varchar');
      expect(emailField!.unique).toBe(true);
    });

    it('extracts default values', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      const fields = data.ormModels![0].fields as Record<string, unknown>[];
      const activeField = fields.find((f) => f.name === 'active');
      expect(activeField).toBeDefined();
      expect(activeField!.default).toBe('true');
    });

    it('sets frameworkRole to drizzle_schema', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.frameworkRole).toBe('drizzle_schema');
    });
  });

  describe('mysqlTable', () => {
    const source = `
import { mysqlTable, int, varchar } from 'drizzle-orm/mysql-core';

export const posts = mysqlTable('posts', {
  id: int('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
});
`;

    it('extracts model from mysqlTable', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.ormModels).toBeDefined();
      expect(data.ormModels!.length).toBe(1);
      expect(data.ormModels![0].name).toBe('Post');
      expect(data.ormModels![0].collectionOrTable).toBe('posts');
      expect(data.ormModels![0].orm).toBe('drizzle');
    });
  });

  describe('sqliteTable', () => {
    const source = `
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
`;

    it('extracts model from sqliteTable', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.ormModels).toBeDefined();
      expect(data.ormModels!.length).toBe(1);
      expect(data.ormModels![0].name).toBe('Categorie');
      expect(data.ormModels![0].collectionOrTable).toBe('categories');
    });
  });

  describe('non-drizzle TypeScript file', () => {
    it('returns empty result', () => {
      const source = `export class Foo { bar() {} }`;
      const result = plugin.extractNodes('foo.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      expect(data.symbols).toEqual([]);
      expect(data.ormModels).toBeUndefined();
    });
  });

  describe('non-typescript file', () => {
    it('returns empty result', () => {
      const source = `export const users = pgTable('users', { id: integer('id') });`;
      const result = plugin.extractNodes('schema.py', Buffer.from(source), 'python');
      const data = result._unsafeUnwrap();
      expect(data.symbols).toEqual([]);
    });
  });

  describe('column with references', () => {
    const source = `
import { pgTable, integer, text } from 'drizzle-orm/pg-core';

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
});
`;

    it('extracts references', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      const fields = data.ormModels![0].fields as Record<string, unknown>[];
      const authorField = fields.find((f) => f.name === 'authorId');
      expect(authorField).toBeDefined();
      expect(authorField!.references).toBe('users.id');
    });
  });

  describe('relations', () => {
    const source = `
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(profiles),
  posts: many(posts),
}));
`;

    it('extracts one() as belongsTo association', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      const assocs = data.ormAssociations!;
      const profileAssoc = assocs.find((a) => a.targetModelName === 'Profile');
      expect(profileAssoc).toBeDefined();
      expect(profileAssoc!.sourceModelName).toBe('User');
      expect(profileAssoc!.kind).toBe('belongsTo');
    });

    it('extracts many() as hasMany association', () => {
      const result = plugin.extractNodes('schema.ts', Buffer.from(source), 'typescript');
      const data = result._unsafeUnwrap();
      const assocs = data.ormAssociations!;
      const postsAssoc = assocs.find((a) => a.targetModelName === 'Post');
      expect(postsAssoc).toBeDefined();
      expect(postsAssoc!.sourceModelName).toBe('User');
      expect(postsAssoc!.kind).toBe('hasMany');
    });
  });
});

describe('toModelName conversion', () => {
  const plugin = new DrizzlePlugin();

  it('converts usersTable to User', () => {
    const source = `
import { pgTable, integer } from 'drizzle-orm/pg-core';
export const usersTable = pgTable('users', { id: integer('id').primaryKey() });
`;
    const result = plugin.extractNodes('s.ts', Buffer.from(source), 'typescript');
    expect(result._unsafeUnwrap().ormModels![0].name).toBe('User');
  });

  it('converts posts to Post', () => {
    const source = `
import { pgTable, integer } from 'drizzle-orm/pg-core';
export const posts = pgTable('posts', { id: integer('id').primaryKey() });
`;
    const result = plugin.extractNodes('s.ts', Buffer.from(source), 'typescript');
    expect(result._unsafeUnwrap().ormModels![0].name).toBe('Post');
  });

  it('converts categories to Categorie', () => {
    const source = `
import { pgTable, integer } from 'drizzle-orm/pg-core';
export const categories = pgTable('categories', { id: integer('id').primaryKey() });
`;
    const result = plugin.extractNodes('s.ts', Buffer.from(source), 'typescript');
    expect(result._unsafeUnwrap().ormModels![0].name).toBe('Categorie');
  });
});
