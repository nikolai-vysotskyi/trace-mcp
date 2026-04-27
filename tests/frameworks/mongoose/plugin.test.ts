import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MongoosePlugin,
  extractMongooseSchema,
} from '../../../src/indexer/plugins/integration/orm/mongoose/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const M8_FIXTURE = path.resolve(__dirname, '../../fixtures/mongoose-8');

describe('MongoosePlugin', () => {
  const plugin = new MongoosePlugin();

  describe('detect()', () => {
    it('returns true for mongoose project', () => {
      const ctx: ProjectContext = {
        rootPath: M8_FIXTURE,
        packageJson: { dependencies: { mongoose: '^8.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-mongoose project', () => {
      const ctx: ProjectContext = {
        rootPath: '/nonexistent/path',
        packageJson: { dependencies: { express: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects from disk when packageJson not in context', () => {
      const ctx: ProjectContext = {
        rootPath: M8_FIXTURE,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  describe('registerSchema()', () => {
    it('returns all expected edge types', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);
      expect(edgeNames).toContain('mongoose_references');
      expect(edgeNames).toContain('mongoose_has_virtual');
      expect(edgeNames).toContain('mongoose_has_middleware');
      expect(edgeNames).toContain('mongoose_has_method');
      expect(edgeNames).toContain('mongoose_has_static');
      expect(edgeNames).toContain('mongoose_discriminates');
      expect(edgeNames).toContain('mongoose_has_index');
      expect(edgeNames).toContain('mongoose_uses_plugin');
    });
  });

  describe('manifest', () => {
    it('has correct name', () => {
      expect(plugin.manifest.name).toBe('mongoose');
    });
  });
});

describe('Mongoose schema extraction', () => {
  describe('User model (full-featured)', () => {
    const source = fs.readFileSync(path.join(M8_FIXTURE, 'models/user.ts'), 'utf-8');
    const result = extractMongooseSchema(source, 'models/user.ts');

    it('extracts model', () => {
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('User');
      expect(result!.model.orm).toBe('mongoose');
    });

    it('extracts collection name', () => {
      expect(result!.model.collectionOrTable).toBe('users');
    });

    it('extracts fields with types', () => {
      const fields = result!.model.fields!;
      expect(fields.length).toBeGreaterThan(0);

      const nameField = fields.find((f: any) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect((nameField as any).type).toBe('String');
      expect((nameField as any).required).toBe(true);

      const emailField = fields.find((f: any) => f.name === 'email');
      expect(emailField).toBeDefined();
      expect((emailField as any).unique).toBe(true);
      expect((emailField as any).index).toBe(true);
    });

    it('extracts enum field', () => {
      const fields = result!.model.fields!;
      const roleField = fields.find((f: any) => f.name === 'role');
      expect(roleField).toBeDefined();
      expect((roleField as any).enum).toContain('user');
      expect((roleField as any).enum).toContain('admin');
    });

    it('extracts ObjectId refs as associations', () => {
      expect(result!.associations.length).toBeGreaterThan(0);
      const postRef = result!.associations.find((a) => a.targetModelName === 'Post');
      expect(postRef).toBeDefined();
      expect(postRef!.kind).toBe('ref');

      const profileRef = result!.associations.find((a) => a.targetModelName === 'Profile');
      expect(profileRef).toBeDefined();
    });

    it('extracts virtuals', () => {
      const meta = result!.model.metadata as any;
      expect(meta.virtuals).toContain('fullName');
      expect(meta.virtuals).toContain('recentPosts');
    });

    it('extracts middleware (pre/post hooks)', () => {
      const meta = result!.model.metadata as any;
      expect(meta.middleware.length).toBeGreaterThan(0);
      expect(meta.middleware).toContainEqual({ hook: 'pre', event: 'save' });
      expect(meta.middleware).toContainEqual({ hook: 'post', event: 'save' });
    });

    it('extracts methods and statics', () => {
      const meta = result!.model.metadata as any;
      expect(meta.methods).toContain('comparePassword');
      expect(meta.statics).toContain('findByEmail');
    });

    it('extracts plugins', () => {
      const meta = result!.model.metadata as any;
      expect(meta.plugins).toContain('mongoosePaginate');
    });

    it('extracts indexes', () => {
      const meta = result!.model.metadata as any;
      expect(meta.indexes.length).toBeGreaterThan(0);
    });

    it('has timestamps option', () => {
      expect(result!.model.options).toBeDefined();
      expect((result!.model.options as any).timestamps).toBe(true);
    });
  });

  describe('Post model', () => {
    const source = fs.readFileSync(path.join(M8_FIXTURE, 'models/post.ts'), 'utf-8');
    const result = extractMongooseSchema(source, 'models/post.ts');

    it('extracts model', () => {
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('Post');
    });

    it('extracts author ref', () => {
      const authorRef = result!.associations.find((a) => a.targetModelName === 'User');
      expect(authorRef).toBeDefined();
      expect(authorRef!.kind).toBe('ref');
    });

    it('extracts pre-find middleware', () => {
      const meta = result!.model.metadata as any;
      expect(meta.middleware).toContainEqual({ hook: 'pre', event: 'find' });
    });
  });

  describe('@nestjs/mongoose decorated schema', () => {
    it('extracts decorated class', () => {
      const source = `
import { Schema, Prop, SchemaFactory } from '@nestjs/mongoose';
import mongoose from 'mongoose';

@Schema({ collection: 'cats' })
export class Cat {
  @Prop({ required: true }) name: string;
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Owner' }) owner: Owner;
}
`;
      const result = extractMongooseSchema(source, 'cat.schema.ts');
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('Cat');
      expect(result!.model.collectionOrTable).toBe('cats');
      expect((result!.model.metadata as any).style).toBe('nestjs-mongoose');

      const fields = result!.model.fields!;
      const nameField = fields.find((f: any) => f.name === 'name');
      expect(nameField).toBeDefined();
      expect((nameField as any).required).toBe(true);

      // Ref association
      const ownerRef = result!.associations.find((a) => a.targetModelName === 'Owner');
      expect(ownerRef).toBeDefined();
    });
  });

  describe('Typegoose decorated schema', () => {
    it('extracts typegoose class', () => {
      const source = `
import { modelOptions, prop, Ref } from '@typegoose/typegoose';

@modelOptions({ schemaOptions: { collection: 'dogs' } })
export class Dog {
  @prop({ required: true }) public name!: string;
  @prop({ ref: () => Owner }) public owner!: Ref<Owner>;
}
`;
      const result = extractMongooseSchema(source, 'dog.model.ts');
      expect(result).not.toBeNull();
      expect(result!.model.name).toBe('Dog');
      expect(result!.model.collectionOrTable).toBe('dogs');
      expect((result!.model.metadata as any).style).toBe('typegoose');

      const ownerRef = result!.associations.find((a) => a.targetModelName === 'Owner');
      expect(ownerRef).toBeDefined();
    });
  });

  describe('non-mongoose file', () => {
    it('returns null', () => {
      const source = `export class Foo { bar() {} }`;
      expect(extractMongooseSchema(source, 'foo.ts')).toBeNull();
    });
  });
});
