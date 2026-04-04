import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SequelizePlugin,
  extractSequelizeModel,
  extractSequelizeMigration,
} from '../../../src/indexer/plugins/integration/orm/sequelize/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const S6_FIXTURE = path.resolve(__dirname, '../../fixtures/sequelize-6');

describe('SequelizePlugin', () => {
  const plugin = new SequelizePlugin();

  describe('detect()', () => {
    it('returns true for sequelize project', () => {
      const ctx: ProjectContext = {
        rootPath: S6_FIXTURE,
        packageJson: { dependencies: { sequelize: '^6.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true for sequelize-typescript project', () => {
      const ctx: ProjectContext = {
        rootPath: S6_FIXTURE,
        packageJson: { dependencies: { 'sequelize-typescript': '^2.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-sequelize project', () => {
      const ctx: ProjectContext = {
        rootPath: '/nonexistent/path',
        packageJson: { dependencies: { mongoose: '^8.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects from disk', () => {
      const ctx: ProjectContext = {
        rootPath: S6_FIXTURE,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  describe('registerSchema()', () => {
    it('returns all expected edge types', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);
      expect(edgeNames).toContain('sequelize_has_many');
      expect(edgeNames).toContain('sequelize_belongs_to');
      expect(edgeNames).toContain('sequelize_belongs_to_many');
      expect(edgeNames).toContain('sequelize_has_one');
      expect(edgeNames).toContain('sequelize_has_hook');
      expect(edgeNames).toContain('sequelize_has_scope');
      expect(edgeNames).toContain('sequelize_migrates');
    });
  });
});

describe('Sequelize model extraction', () => {
  describe('User model (class-based)', () => {
    const source = fs.readFileSync(
      path.join(S6_FIXTURE, 'models/user.ts'),
      'utf-8',
    );
    const result = extractSequelizeModel(source, 'models/user.ts');

    it('extracts model', () => {
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('User');
      expect(result!.model.orm).toBe('sequelize');
    });

    it('extracts table name', () => {
      expect(result!.model.collectionOrTable).toBe('users');
    });

    it('extracts fields', () => {
      const fields = result!.model.fields!;
      expect(fields.length).toBeGreaterThan(0);

      const nameField = fields.find((f: any) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect((nameField as any).type).toBe('STRING');
      expect((nameField as any).allowNull).toBe(false);

      const emailField = fields.find((f: any) => f.name === 'email');
      expect(emailField).toBeDefined();
      expect((emailField as any).unique).toBe(true);
    });

    it('extracts associations', () => {
      expect(result!.associations.length).toBe(4);

      const hasMany = result!.associations.find((a) => a.kind === 'hasMany');
      expect(hasMany).toBeDefined();
      expect(hasMany!.targetModelName).toBe('Post');
      expect(hasMany!.options?.foreignKey).toBe('userId');

      const belongsTo = result!.associations.find((a) => a.kind === 'belongsTo');
      expect(belongsTo).toBeDefined();
      expect(belongsTo!.targetModelName).toBe('Role');

      const belongsToMany = result!.associations.find((a) => a.kind === 'belongsToMany');
      expect(belongsToMany).toBeDefined();
      expect(belongsToMany!.targetModelName).toBe('Project');
      expect(belongsToMany!.options?.through).toBe('UserProjects');

      const hasOne = result!.associations.find((a) => a.kind === 'hasOne');
      expect(hasOne).toBeDefined();
      expect(hasOne!.targetModelName).toBe('Profile');
    });

    it('extracts hooks', () => {
      const meta = result!.model.metadata as any;
      expect(meta.hooks).toContain('beforeCreate');
    });

    it('extracts paranoid option', () => {
      expect((result!.model.options as any).paranoid).toBe(true);
    });

    it('extracts style metadata', () => {
      expect((result!.model.metadata as any).style).toBe('class-based');
    });
  });

  describe('Post model', () => {
    const source = fs.readFileSync(
      path.join(S6_FIXTURE, 'models/post.ts'),
      'utf-8',
    );
    const result = extractSequelizeModel(source, 'models/post.ts');

    it('extracts model', () => {
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('Post');
      expect(result!.model.collectionOrTable).toBe('posts');
    });

    it('extracts belongsTo association', () => {
      const belongsTo = result!.associations.find((a) => a.kind === 'belongsTo');
      expect(belongsTo).toBeDefined();
      expect(belongsTo!.targetModelName).toBe('User');
    });
  });

  describe('sequelize-typescript decorators', () => {
    it('extracts decorated model', () => {
      const source = `
import { Table, Column, Model, HasMany, BelongsTo, DataType } from 'sequelize-typescript';

@Table({ tableName: 'items', paranoid: true })
export class Item extends Model {
  @Column({ type: DataType.STRING, allowNull: false }) name: string;
  @Column({ type: DataType.INTEGER }) quantity: number;
  @HasMany(() => Tag) tags: Tag[];
  @BelongsTo(() => Category) category: Category;
}
`;
      const result = extractSequelizeModel(source, 'item.model.ts');
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('Item');
      expect(result!.model.collectionOrTable).toBe('items');
      expect((result!.model.options as any).paranoid).toBe(true);
      expect((result!.model.metadata as any).style).toBe('sequelize-typescript');

      expect(result!.associations.length).toBe(2);
      const hasMany = result!.associations.find((a) => a.kind === 'hasMany');
      expect(hasMany?.targetModelName).toBe('Tag');
      const belongsTo = result!.associations.find((a) => a.kind === 'belongsTo');
      expect(belongsTo?.targetModelName).toBe('Category');
    });
  });

  describe('sequelize.define (v4-5)', () => {
    it('extracts define model', () => {
      const source = `
const sequelize = require('sequelize');
const User = sequelize.define('User', {
  name: DataTypes.STRING,
  email: { type: DataTypes.STRING, unique: true },
});
`;
      const result = extractSequelizeModel(source, 'user.js');
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('User');
      expect((result!.model.metadata as any).style).toBe('define');
    });
  });
});

describe('Sequelize migration extraction', () => {
  it('extracts createTable from migration', () => {
    const source = fs.readFileSync(
      path.join(S6_FIXTURE, 'migrations/20240101-create-users.ts'),
      'utf-8',
    );
    const result = extractSequelizeMigration(source, 'migrations/20240101-create-users.ts');
    expect(result).not.toBeNull();
    expect(result!.models.length).toBeGreaterThan(0);

    const usersTable = result!.models.find((m) => m.name === 'users');
    expect(usersTable).toBeDefined();
    expect(usersTable!.collectionOrTable).toBe('users');
    expect((usersTable!.metadata as any).operation).toBe('createTable');

    const fields = usersTable!.fields!;
    const idField = fields.find((f: any) => f.name === 'id');
    expect(idField).toBeDefined();
    expect((idField as any).primaryKey).toBe(true);

    const nameField = fields.find((f: any) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect((nameField as any).allowNull).toBe(false);

    // Foreign key reference
    const roleIdField = fields.find((f: any) => f.name === 'roleId');
    expect(roleIdField).toBeDefined();
    expect((roleIdField as any).references).toBe('roles');
  });

  it('returns null for non-migration file', () => {
    const source = `export class Foo {}`;
    expect(extractSequelizeMigration(source, 'foo.ts')).toBeNull();
  });
});
