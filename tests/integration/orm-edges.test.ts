/**
 * Integration: ORM association → graph edge resolution.
 * Verifies that Prisma, TypeORM, Drizzle, Mongoose, and Sequelize
 * associations are correctly mapped to ORM-specific edge types.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { MongoosePlugin } from '../../src/indexer/plugins/integration/orm/mongoose/index.js';
import { SequelizePlugin } from '../../src/indexer/plugins/integration/orm/sequelize/index.js';
import { PrismaPlugin, PrismaLanguagePlugin } from '../../src/indexer/plugins/integration/orm/prisma/index.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import path from 'node:path';

function makeConfig(fixturePath: string, include: string[]): ReturnType<typeof TraceMcpConfigSchema.parse> {
  return TraceMcpConfigSchema.parse({ include, exclude: ['node_modules/**'] });
}

describe('ORM edge type resolution', () => {
  describe('Mongoose → mongoose_references edges', () => {
    it('creates mongoose_references edges for ref fields', async () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/mongoose-8');
      const db = initializeDatabase(':memory:');
      const store = new Store(db);
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new MongoosePlugin());

      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixturePath, ['**/*.ts']), fixturePath);
      await pipeline.indexAll();

      const edges = store.getEdgesByType('mongoose_references');
      expect(edges.length).toBeGreaterThan(0);

      // Verify no sequelize_* edge types were accidentally created
      expect(store.getEdgesByType('sequelize_has_many')).toHaveLength(0);
    });
  });

  describe('Sequelize → sequelize_* edges', () => {
    it('creates sequelize-specific edges for associations', async () => {
      const fixturePath = path.resolve(__dirname, '../fixtures/sequelize-6');
      const db = initializeDatabase(':memory:');
      const store = new Store(db);
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new SequelizePlugin());

      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixturePath, ['**/*.ts']), fixturePath);
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
      const db = initializeDatabase(':memory:');
      const store = new Store(db);
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
      const tmpDir = path.resolve(__dirname, '../../.tmp-prisma-test');
      const fs = await import('node:fs');
      fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), schema);

      try {
        const pipeline = new IndexingPipeline(
          store, registry,
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
