import { describe, it, expect } from 'vitest';
import {
  PrismaPlugin,
  PrismaLanguagePlugin,
  parsePrismaSchema,
} from '../../../src/indexer/plugins/integration/orm/prisma/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

// ── parsePrismaSchema ─────────────────────────────────────────────────────────

describe('parsePrismaSchema', () => {
  describe('basic model', () => {
    const source = `
model User {
  id   Int    @id
  name String
  email String @unique
}
`;
    const { models, associations } = parsePrismaSchema(source);

    it('extracts model with name=User', () => {
      expect(models).toHaveLength(1);
      expect(models[0].name).toBe('User');
    });

    it('sets orm=prisma', () => {
      expect(models[0].orm).toBe('prisma');
    });

    it('@id field has id=true', () => {
      const idField = models[0].fields!.find((f: any) => f.name === 'id') as any;
      expect(idField).toBeDefined();
      expect(idField.id).toBe(true);
    });

    it('@unique field has unique=true', () => {
      const emailField = models[0].fields!.find((f: any) => f.name === 'email') as any;
      expect(emailField).toBeDefined();
      expect(emailField.unique).toBe(true);
    });

    it('non-annotated field has no id/unique flags', () => {
      const nameField = models[0].fields!.find((f: any) => f.name === 'name') as any;
      expect(nameField).toBeDefined();
      expect(nameField.id).toBeUndefined();
      expect(nameField.unique).toBeUndefined();
    });
  });

  describe('@@map table name', () => {
    const source = `
model User {
  id Int @id

  @@map("users")
}
`;
    const { models } = parsePrismaSchema(source);

    it('sets collectionOrTable from @@map', () => {
      expect(models[0].collectionOrTable).toBe('users');
    });
  });

  describe('@default attribute', () => {
    const source = `
model Setting {
  id    Int    @id @default(autoincrement())
  active Boolean @default(true)
}
`;
    const { models } = parsePrismaSchema(source);

    it('sets field.default from @default()', () => {
      const activeField = models[0].fields!.find((f: any) => f.name === 'active') as any;
      expect(activeField).toBeDefined();
      expect(activeField.default).toBe('true');
    });
  });

  describe('optional field', () => {
    const source = `
model Post {
  id      Int     @id
  content String?
}
`;
    const { models } = parsePrismaSchema(source);

    it('optional field has optional=true', () => {
      const contentField = models[0].fields!.find((f: any) => f.name === 'content') as any;
      expect(contentField).toBeDefined();
      expect(contentField.optional).toBe(true);
    });

    it('non-optional field has optional=false', () => {
      const idField = models[0].fields!.find((f: any) => f.name === 'id') as any;
      expect(idField).toBeDefined();
      expect(idField.optional).toBe(false);
    });
  });

  describe('list field', () => {
    const source = `
model User {
  id    Int    @id
  posts Post[]
}
`;
    const { models } = parsePrismaSchema(source);

    it('list field has list=true', () => {
      const postsField = models[0].fields!.find((f: any) => f.name === 'posts') as any;
      expect(postsField).toBeDefined();
      expect(postsField.list).toBe(true);
    });

    it('non-list field has list=false', () => {
      const idField = models[0].fields!.find((f: any) => f.name === 'id') as any;
      expect(idField).toBeDefined();
      expect(idField.list).toBe(false);
    });
  });

  describe('@relation — owning side (with fields:)', () => {
    const source = `
model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}

model User {
  id    Int    @id
  posts Post[]
}
`;
    const { models, associations } = parsePrismaSchema(source);

    it('creates association with kind=belongsTo for owning side', () => {
      const assoc = associations.find(
        (a) => a.sourceModelName === 'Post' && a.targetModelName === 'User',
      );
      expect(assoc).toBeDefined();
      expect(assoc!.kind).toBe('belongsTo');
    });

    it('owning side association has fields and references', () => {
      const assoc = associations.find(
        (a) => a.sourceModelName === 'Post' && a.targetModelName === 'User',
      );
      expect((assoc!.options as any).fields).toContain('authorId');
      expect((assoc!.options as any).references).toContain('id');
    });
  });

  describe('@relation — non-owning side (no fields:)', () => {
    const source = `
model User {
  id    Int    @id
  posts Post[] @relation("PostAuthor")
}

model Post {
  id       Int  @id
  authorId Int
  author   User @relation("PostAuthor", fields: [authorId], references: [id])
}
`;
    const { associations } = parsePrismaSchema(source);

    it('does not create association for non-owning side (no fields:)', () => {
      const nonOwning = associations.find(
        (a) => a.sourceModelName === 'User' && a.targetModelName === 'Post',
      );
      expect(nonOwning).toBeUndefined();
    });

    it('creates association only for owning side (Post→User)', () => {
      const owning = associations.find(
        (a) => a.sourceModelName === 'Post' && a.targetModelName === 'User',
      );
      expect(owning).toBeDefined();
    });
  });

  describe('@@index attribute', () => {
    const source = `
model User {
  id    Int    @id
  email String @unique

  @@index([email])
}
`;
    const { models } = parsePrismaSchema(source);

    it('captures @@index in metadata.indices', () => {
      const meta = models[0].metadata as any;
      expect(meta.indices).toBeDefined();
      expect(meta.indices.length).toBeGreaterThan(0);
      expect(meta.indices[0]).toContain('@@index');
    });
  });

  describe('enum block', () => {
    const source = `
enum Role {
  ADMIN
  USER
  MODERATOR
}
`;
    const { models } = parsePrismaSchema(source);

    it('extracts enum as a model', () => {
      expect(models).toHaveLength(1);
      expect(models[0].name).toBe('Role');
    });

    it('sets orm=prisma on enum', () => {
      expect(models[0].orm).toBe('prisma');
    });

    it('sets metadata.kind=enum', () => {
      const meta = models[0].metadata as any;
      expect(meta.kind).toBe('enum');
    });

    it('populates metadata.values with enum members', () => {
      const meta = models[0].metadata as any;
      expect(meta.values).toBeDefined();
      expect(meta.values).toContain('ADMIN');
      expect(meta.values).toContain('USER');
      expect(meta.values).toContain('MODERATOR');
    });
  });

  describe('multiple models', () => {
    const source = `
model User {
  id Int @id
}

model Post {
  id Int @id
}

model Comment {
  id Int @id
}
`;
    const { models } = parsePrismaSchema(source);

    it('extracts all three models', () => {
      expect(models).toHaveLength(3);
    });

    it('contains User, Post, Comment', () => {
      const names = models.map((m) => m.name);
      expect(names).toContain('User');
      expect(names).toContain('Post');
      expect(names).toContain('Comment');
    });
  });
});

// ── PrismaPlugin ──────────────────────────────────────────────────────────────

describe('PrismaPlugin', () => {
  const plugin = new PrismaPlugin();

  describe('detect()', () => {
    it('returns true when @prisma/client is in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { '@prisma/client': '^5.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when prisma is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { devDependencies: { prisma: '^5.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when neither prisma nor @prisma/client present', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-999',
        packageJson: { dependencies: { mongoose: '^8.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('has prisma_relation edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('prisma_relation');
    });

    it('has prisma_implicit_m2m edge type', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('prisma_implicit_m2m');
    });

    it('all edge types have category=prisma', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('prisma');
      }
    });
  });

  describe('extractNodes()', () => {
    it('returns ormModels for prisma language files', () => {
      const source = `
model User {
  id   Int    @id
  name String
}
`;
      const result = plugin.extractNodes('schema.prisma', Buffer.from(source), 'prisma');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.ormModels).toBeDefined();
      expect(parsed.ormModels!.length).toBe(1);
      expect(parsed.ormModels![0].name).toBe('User');
      expect(parsed.frameworkRole).toBe('prisma_schema');
    });

    it('returns empty result for typescript language', () => {
      const result = plugin.extractNodes(
        'app.ts',
        Buffer.from('export class Foo {}'),
        'typescript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.ormModels ?? []).toHaveLength(0);
      expect(parsed.frameworkRole).toBeUndefined();
    });

    it('returns empty result for javascript language', () => {
      const result = plugin.extractNodes(
        'app.js',
        Buffer.from('module.exports = {}'),
        'javascript',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.ormModels ?? []).toHaveLength(0);
    });
  });
});

// ── PrismaLanguagePlugin ──────────────────────────────────────────────────────

describe('PrismaLanguagePlugin', () => {
  const languagePlugin = new PrismaLanguagePlugin();

  it('has .prisma in supportedExtensions', () => {
    expect(languagePlugin.supportedExtensions).toContain('.prisma');
  });

  describe('extractSymbols()', () => {
    const source = `
model User {
  id Int @id
}
`;
    const result = languagePlugin.extractSymbols('schema.prisma', Buffer.from(source));

    it('returns ok result', () => {
      expect(result.isOk()).toBe(true);
    });

    it('sets language=prisma', () => {
      const parsed = result._unsafeUnwrap();
      expect(parsed.language).toBe('prisma');
    });

    it('returns status=ok', () => {
      const parsed = result._unsafeUnwrap();
      expect(parsed.status).toBe('ok');
    });

    it('returns empty symbols array', () => {
      const parsed = result._unsafeUnwrap();
      expect(parsed.symbols).toHaveLength(0);
    });
  });
});
