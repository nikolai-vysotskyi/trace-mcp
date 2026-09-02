/**
 * Integration: ORM association → graph edge resolution.
 * Verifies that Prisma, TypeORM, Drizzle, Mongoose, and Sequelize
 * associations are correctly mapped to ORM-specific edge types.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { MongoosePlugin } from '../../src/indexer/plugins/integration/orm/mongoose/index.js';
import {
  PrismaLanguagePlugin,
  PrismaPlugin,
} from '../../src/indexer/plugins/integration/orm/prisma/index.js';
import { SequelizePlugin } from '../../src/indexer/plugins/integration/orm/sequelize/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';

function makeConfig(
  fixturePath: string,
  include: string[],
): ReturnType<typeof TraceMcpConfigSchema.parse> {
  return TraceMcpConfigSchema.parse({ include, exclude: ['node_modules/**'] });
}

/** Count Post → User `mongoose_references` edges, by model name. */
function postToUserEdges(store: ReturnType<typeof createTestStore>): number {
  const byId = new Map(store.getAllOrmModels().map((m) => [m.id, m.name]));
  const nodeToModel = new Map<number, string>();
  for (const [id, name] of byId) {
    const nodeId = store.getNodeId('orm_model', id);
    if (nodeId != null) nodeToModel.set(nodeId, name);
  }
  return store
    .getEdgesByType('mongoose_references')
    .filter(
      (e) =>
        nodeToModel.get(e.source_node_id) === 'Post' &&
        nodeToModel.get(e.target_node_id) === 'User',
    ).length;
}

describe('ORM edge type resolution', () => {
  describe('Mongoose → mongoose_references edges', () => {
    it('creates mongoose_references edges for ref fields', async () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/mongoose-8');
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new MongoosePlugin());

      const pipeline = new IndexingPipeline(
        store,
        registry,
        makeConfig(fixturePath, ['**/*.ts']),
        fixturePath,
      );
      await pipeline.indexAll();

      const edges = store.getEdgesByType('mongoose_references');
      expect(edges.length).toBeGreaterThan(0);

      // Verify no sequelize_* edge types were accidentally created
      expect(store.getEdgesByType('sequelize_has_many')).toHaveLength(0);
    });
  });

  describe('cross-file associations survive an incremental reindex', () => {
    it('re-links a mongoose_references edge after the target model file is reindexed', async () => {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new MongoosePlugin());

      // Real fixture: models/post.ts holds `ref: 'User'`, models/user.ts
      // defines User — the cross-file shape TRA-663 crashed on. Copied so the
      // test can touch a file without dirtying the fixture.
      const tmpDir = createTmpDir('mongoose-incremental-');
      fs.cpSync(path.resolve(__dirname, '../fixtures/mongoose-8'), tmpDir, { recursive: true });
      const userPath = path.join(tmpDir, 'models/user.ts');

      try {
        const pipeline = new IndexingPipeline(
          store,
          registry,
          makeConfig(tmpDir, ['**/*.ts']),
          tmpDir,
        );
        await pipeline.indexAll();
        expect(postToUserEdges(store)).toBeGreaterThan(0);

        // Reindex only the *target* file — post.ts's association points at it.
        fs.appendFileSync(userPath, '// touched\n');
        await pipeline.indexFiles([userPath]);

        expect(postToUserEdges(store)).toBeGreaterThan(0);
      } finally {
        removeTmpDir(tmpDir);
      }
    });
  });

  describe('Sequelize → sequelize_* edges', () => {
    it('creates sequelize-specific edges for associations', async () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/sequelize-6');
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new SequelizePlugin());

      const pipeline = new IndexingPipeline(
        store,
        registry,
        makeConfig(fixturePath, ['**/*.ts']),
        fixturePath,
      );
      await pipeline.indexAll();

      const hasManyEdges = store.getEdgesByType('sequelize_has_many');
      const belongsToEdges = store.getEdgesByType('sequelize_belongs_to');
      expect(hasManyEdges.length + belongsToEdges.length).toBeGreaterThan(0);

      // Verify no prisma_* edges leaked
      expect(store.getEdgesByType('prisma_relation')).toHaveLength(0);
    });
  });

  describe('Prisma → prisma_relation edges', () => {
    it('creates prisma_relation edges for model relations', async () => {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new PrismaLanguagePlugin());
      registry.registerFrameworkPlugin(new PrismaPlugin());

      // Create a minimal fixture inline
      const schema = `
model User {
  id    Int    @id @default(autoincrement())
  posts Post[]
}

model Post {
  id       Int  @id @default(autoincrement())
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}
`;
      const tmpDir = createTmpDir('prisma-test-');
      writeFixtureFile(tmpDir, 'prisma/schema.prisma', schema);

      try {
        const pipeline = new IndexingPipeline(
          store,
          registry,
          makeConfig(tmpDir, ['**/*.prisma']),
          tmpDir,
        );
        await pipeline.indexAll();

        const models = store.getAllOrmModels();
        const names = models.map((m) => m.name);
        expect(names).toContain('User');
        expect(names).toContain('Post');

        const prismaEdges = store.getEdgesByType('prisma_relation');
        expect(prismaEdges.length).toBeGreaterThan(0);

        // Must NOT create sequelize edges
        expect(store.getEdgesByType('sequelize_has_many')).toHaveLength(0);
        expect(store.getEdgesByType('sequelize_belongs_to')).toHaveLength(0);
      } finally {
        removeTmpDir(tmpDir);
      }
    });
  });
});
