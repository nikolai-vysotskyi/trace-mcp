import { describe, it, expect } from 'vitest';
import {
  TypeORMPlugin,
  extractTypeORMEntity,
} from '../../../src/indexer/plugins/integration/orm/typeorm/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

// ── extractTypeORMEntity ──────────────────────────────────────────────────────

describe('extractTypeORMEntity', () => {
  describe('@Entity() with class name', () => {
    const source = `
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}
`;
    const result = extractTypeORMEntity(source, 'user.entity.ts');

    it('returns non-null result', () => {
      expect(result).not.toBeNull();
    });

    it('extracts className', () => {
      expect(result!.model.name).toBe('User');
    });

    it('extracts orm=typeorm', () => {
      expect(result!.model.orm).toBe('typeorm');
    });

    it('extracts fields', () => {
      expect(result!.model.fields!.length).toBeGreaterThan(0);
    });

    it('has no tableName override', () => {
      expect(result!.model.collectionOrTable).toBeUndefined();
    });
  });

  describe('@Entity("custom_table") — string argument', () => {
    const source = `
@Entity('custom_table')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;
}
`;
    const result = extractTypeORMEntity(source, 'order.entity.ts');

    it('returns non-null result', () => {
      expect(result).not.toBeNull();
    });

    it('sets collectionOrTable from string argument', () => {
      expect(result!.model.collectionOrTable).toBe('custom_table');
    });

    it('extracts className', () => {
      expect(result!.model.name).toBe('Order');
    });
  });

  describe('@Entity({ tableName: "orders" }) — options object', () => {
    const source = `
@Entity({ tableName: 'orders' })
export class Order {
  @PrimaryGeneratedColumn()
  id: number;
}
`;
    const result = extractTypeORMEntity(source, 'order.entity.ts');

    it('returns non-null result', () => {
      expect(result).not.toBeNull();
    });

    it('sets collectionOrTable from options.tableName', () => {
      expect(result!.model.collectionOrTable).toBe('orders');
    });
  });

  describe('@PrimaryGeneratedColumn field', () => {
    const source = `
@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;
}
`;
    const result = extractTypeORMEntity(source, 'product.entity.ts');

    it('extracts primary key field', () => {
      const idField = result!.model.fields!.find((f: any) => f.name === 'id') as any;
      expect(idField).toBeDefined();
      expect(idField.primaryKey).toBe(true);
      expect(idField.autoIncrement).toBe(true);
    });

    it('extracts regular column', () => {
      const titleField = result!.model.fields!.find((f: any) => f.name === 'title') as any;
      expect(titleField).toBeDefined();
      expect(titleField.primaryKey).toBeUndefined();
    });
  });

  describe('@Column field type', () => {
    const source = `
@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  content: string;
}
`;
    const result = extractTypeORMEntity(source, 'post.entity.ts');

    it('extracts field name', () => {
      const field = result!.model.fields!.find((f: any) => f.name === 'content') as any;
      expect(field).toBeDefined();
    });

    it('extracts field type', () => {
      const field = result!.model.fields!.find((f: any) => f.name === 'content') as any;
      expect(field!.type).toBe('string');
    });
  });

  describe('@CreateDateColumn and @UpdateDateColumn', () => {
    const source = `
@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
`;
    const result = extractTypeORMEntity(source, 'article.entity.ts');

    it('flags @CreateDateColumn with createdAt', () => {
      const field = result!.model.fields!.find((f: any) => f.name === 'createdAt') as any;
      expect(field).toBeDefined();
      expect(field.createdAt).toBe(true);
    });

    it('flags @UpdateDateColumn with updatedAt', () => {
      const field = result!.model.fields!.find((f: any) => f.name === 'updatedAt') as any;
      expect(field).toBeDefined();
      expect(field.updatedAt).toBe(true);
    });
  });

  describe('relation decorators', () => {
    const source = `
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToMany(() => Post, (post) => post.author)
  posts: Post[];

  @ManyToOne(() => Role, (role) => role.users)
  role: Role;

  @OneToOne(() => Profile)
  profile: Profile;

  @ManyToMany(() => Tag)
  tags: Tag[];
}
`;
    const result = extractTypeORMEntity(source, 'user.entity.ts');

    it('@OneToMany produces association with kind=OneToMany', () => {
      const assoc = result!.associations.find((a) => a.kind === 'OneToMany');
      expect(assoc).toBeDefined();
      expect(assoc!.targetModelName).toBe('Post');
      expect(assoc!.sourceModelName).toBe('User');
    });

    it('@ManyToOne produces association with kind=ManyToOne', () => {
      const assoc = result!.associations.find((a) => a.kind === 'ManyToOne');
      expect(assoc).toBeDefined();
      expect(assoc!.targetModelName).toBe('Role');
    });

    it('@OneToOne produces association with kind=OneToOne', () => {
      const assoc = result!.associations.find((a) => a.kind === 'OneToOne');
      expect(assoc).toBeDefined();
      expect(assoc!.targetModelName).toBe('Profile');
    });

    it('@ManyToMany produces association with kind=ManyToMany', () => {
      const assoc = result!.associations.find((a) => a.kind === 'ManyToMany');
      expect(assoc).toBeDefined();
      expect(assoc!.targetModelName).toBe('Tag');
    });
  });

  describe('@Index block decorator', () => {
    const source = `
@Index(['col1', 'col2'])
@Entity()
export class Report {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  col1: string;

  @Column()
  col2: string;
}
`;
    const result = extractTypeORMEntity(source, 'report.entity.ts');

    it('captures indices in metadata', () => {
      const meta = result!.model.metadata as any;
      expect(meta.indices).toBeDefined();
      expect(meta.indices.length).toBeGreaterThan(0);
      expect(meta.indices[0]).toContain('col1');
    });
  });

  describe('non-entity file', () => {
    it('returns null when no @Entity decorator present', () => {
      const source = `
export class UserService {
  findAll() {}
}
`;
      const result = extractTypeORMEntity(source, 'user.service.ts');
      expect(result).toBeNull();
    });
  });
});

// ── TypeORMPlugin ─────────────────────────────────────────────────────────────

describe('TypeORMPlugin', () => {
  const plugin = new TypeORMPlugin();

  describe('detect()', () => {
    it('returns true when typeorm is in dependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { typeorm: '^0.3.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when typeorm is in devDependencies', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { devDependencies: { typeorm: '^0.3.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false when typeorm is not in deps', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: { dependencies: { mongoose: '^8.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('returns false with empty packageJson', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/fake',
        packageJson: {},
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('all 4 relation edge types are present', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('typeorm_one_to_many');
      expect(names).toContain('typeorm_many_to_one');
      expect(names).toContain('typeorm_one_to_one');
      expect(names).toContain('typeorm_many_to_many');
    });

    it('all edge types have category=typeorm', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('typeorm');
      }
    });
  });

  describe('extractNodes()', () => {
    it('produces ormModels for an entity file', () => {
      const source = `
@Entity()
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}
`;
      const result = plugin.extractNodes('category.entity.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.ormModels).toBeDefined();
      expect(parsed.ormModels!.length).toBe(1);
      expect(parsed.ormModels![0].name).toBe('Category');
      expect(parsed.frameworkRole).toBe('typeorm_entity');
    });

    it('returns empty result for non-entity TypeScript file', () => {
      const source = `
export class UserService {
  findAll() { return []; }
}
`;
      const result = plugin.extractNodes('user.service.ts', Buffer.from(source), 'typescript');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.ormModels ?? []).toHaveLength(0);
      expect(parsed.frameworkRole).toBeUndefined();
    });

    it('skips non-TypeScript/JavaScript files', () => {
      const result = plugin.extractNodes(
        'schema.prisma',
        Buffer.from('model User { id Int }'),
        'prisma',
      );
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();
      expect(parsed.symbols).toHaveLength(0);
      expect(parsed.ormModels).toBeUndefined();
    });
  });
});
