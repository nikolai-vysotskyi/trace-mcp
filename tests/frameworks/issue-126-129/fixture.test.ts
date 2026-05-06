/**
 * End-to-end smoke tests for issues #126–#129. Feeds a real multi-file fixture
 * (NestJS gateway, DTOs with class-validator + class-transformer, passport
 * strategy + AuthGuard consumer, react-table grid) through each plugin's
 * extractNodes / detect surface AND through the full IndexingPipeline to
 * assert that the resulting graph edges land in SQLite as expected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAllIntegrationPlugins } from '../../../src/indexer/plugins/integration/all.js';
import { ClassValidatorPlugin } from '../../../src/indexer/plugins/integration/validation/class-validator/index.js';
import { NestJSPlugin } from '../../../src/indexer/plugins/integration/framework/nestjs/index.js';
import { PassportPlugin } from '../../../src/indexer/plugins/integration/framework/passport/index.js';
import { ReactTablePlugin } from '../../../src/indexer/plugins/integration/view/react-table/index.js';
import { TypeScriptLanguagePlugin } from '../../../src/indexer/plugins/language/typescript/index.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';
import { createTestStore } from '../../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/issue-126-129');

function readFile(rel: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE, rel));
}

const ctx: ProjectContext = {
  rootPath: FIXTURE,
  configFiles: [],
  detectedVersions: [],
  allDependencies: [],
};

describe('issue-126-129 fixture — end-to-end', () => {
  describe('detect()', () => {
    it('all four plugins detect the fixture', () => {
      expect(new NestJSPlugin().detect(ctx)).toBe(true);
      expect(new ClassValidatorPlugin().detect(ctx)).toBe(true);
      expect(new PassportPlugin().detect(ctx)).toBe(true);
      expect(new ReactTablePlugin().detect(ctx)).toBe(true);
    });
  });

  describe('NestJS gateway (#126)', () => {
    it('parses ChatGateway with namespace + cors + multiple events', () => {
      const plugin = new NestJSPlugin();
      const result = plugin.extractNodes(
        path.join(FIXTURE, 'src/chat/chat.gateway.ts'),
        readFile('src/chat/chat.gateway.ts'),
        'typescript',
      );
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('nest_gateway');
      const ns = parsed.routes!.find((r) => r.method === 'NAMESPACE');
      expect(ns?.uri).toBe('/chat');
      const wsEvents = parsed.routes!.filter((r) => r.method === 'WS').map((r) => r.uri);
      expect(wsEvents.sort()).toEqual(['message', 'typing']);
    });
  });

  describe('class-validator DTOs (#127)', () => {
    it('parses CreateUserDto with all 4 fields and ValidateNested target', () => {
      const plugin = new ClassValidatorPlugin();
      const result = plugin.extractNodes(
        path.join(FIXTURE, 'src/users/create-user.dto.ts'),
        readFile('src/users/create-user.dto.ts'),
        'typescript',
      );
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('class_validator_dto');
      const dtos = (parsed.metadata as { dtos: { name: string; fields: { name: string }[] }[] })
        .dtos;
      expect(dtos).toHaveLength(1);
      expect(dtos[0].name).toBe('CreateUserDto');
      expect(dtos[0].fields.map((f) => f.name).sort()).toEqual([
        'address',
        'email',
        'name',
        'nickname',
      ]);
    });

    it('parses AddressDto', () => {
      const plugin = new ClassValidatorPlugin();
      const result = plugin.extractNodes(
        path.join(FIXTURE, 'src/users/address.dto.ts'),
        readFile('src/users/address.dto.ts'),
        'typescript',
      );
      const parsed = result._unsafeUnwrap();
      const dtos = (parsed.metadata as { dtos: { name: string }[] }).dtos;
      expect(dtos[0].name).toBe('AddressDto');
    });
  });

  describe('passport strategy + consumer (#128)', () => {
    it('parses JwtStrategy with NestJS extends-style', () => {
      const plugin = new PassportPlugin();
      const result = plugin.extractNodes(
        path.join(FIXTURE, 'src/auth/jwt.strategy.ts'),
        readFile('src/auth/jwt.strategy.ts'),
        'typescript',
      );
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('passport_strategy');
      const strat = parsed.routes!.find((r) => r.method === 'STRATEGY');
      expect(strat?.uri).toBe('passport:jwt');
    });

    it('parses UsersController as AuthGuard consumer', () => {
      const plugin = new PassportPlugin();
      const result = plugin.extractNodes(
        path.join(FIXTURE, 'src/users/users.controller.ts'),
        readFile('src/users/users.controller.ts'),
        'typescript',
      );
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('passport_consumer');
      const guard = parsed.routes!.find((r) => r.method === 'GUARD');
      expect(guard?.uri).toBe('passport:jwt');
    });
  });

  describe('react-table grid (#129)', () => {
    it('parses UsersGrid with helper, columns, and useReactTable instance', () => {
      const plugin = new ReactTablePlugin();
      const result = plugin.extractNodes(
        path.join(FIXTURE, 'src/grid/users-grid.tsx'),
        readFile('src/grid/users-grid.tsx'),
        'typescript',
      );
      const parsed = result._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('react_table_view');

      const helperRoute = parsed.routes!.find((r) => r.method === 'TABLE_HELPER');
      expect(helperRoute?.uri).toBe('react-table:columnHelper');

      const colRoutes = parsed.routes!.filter((r) => r.method === 'TABLE_COLUMN');
      expect(colRoutes).toHaveLength(3);

      const inst = parsed.routes!.find((r) => r.method === 'TABLE_INSTANCE');
      expect(inst).toBeTruthy();
      const meta = inst!.metadata as { rowModels: string[]; dataRef?: string; columnsRef?: string };
      expect(meta.rowModels.sort()).toEqual([
        'getCoreRowModel',
        'getPaginationRowModel',
        'getSortedRowModel',
      ]);
      expect(meta.dataRef).toBe('data');
      expect(meta.columnsRef).toBe('userColumns');
    });
  });

  describe('full IndexingPipeline run on fixture (graph edges land in SQLite)', () => {
    it('emits aggregated edges for all four plugins, queryable via SQL', async () => {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      for (const p of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(p);

      const config = {
        root: FIXTURE,
        include: ['src/**/*.{ts,tsx}'],
        exclude: [],
        db: { path: ':memory:' },
        plugins: [],
        ignore: { directories: [], patterns: [] },
        watch: { enabled: false, debounceMs: 2000 },
      } as unknown as Parameters<typeof IndexingPipeline.prototype.constructor>[2];

      const pipeline = new IndexingPipeline(store, registry, config, FIXTURE);
      const result = await pipeline.indexAll();
      expect(result.errors).toBe(0);

      const db = store.db;

      const countByType = (type: string): number =>
        (
          db
            .prepare(
              'SELECT COUNT(*) AS c FROM edges e JOIN edge_types t ON e.edge_type_id = t.id WHERE t.name = ?',
            )
            .get(type) as { c: number }
        ).c;

      const findEdge = (type: string, srcName: string) =>
        db
          .prepare(
            `SELECT e.metadata FROM edges e
             JOIN edge_types t ON e.edge_type_id = t.id
             JOIN nodes n ON e.source_node_id = n.id
             JOIN symbols s ON n.node_type = 'symbol' AND n.ref_id = s.id
             WHERE t.name = ? AND s.name = ?`,
          )
          .get(type, srcName) as { metadata: string } | undefined;

      // NestJS gateway events — aggregated self-loop per gateway class
      // listing every @SubscribeMessage handler.
      expect(countByType('nest_gateway_event')).toBe(1);
      const gwEdge = findEdge('nest_gateway_event', 'ChatGateway');
      expect(gwEdge).toBeTruthy();
      const gwMeta = JSON.parse(gwEdge!.metadata) as {
        count: number;
        events: string[];
        namespace?: string;
      };
      expect(gwMeta.count).toBe(2);
      expect(gwMeta.events.sort()).toEqual(['message', 'typing']);
      expect(gwMeta.namespace).toBe('/chat');

      // class-validator: ONE aggregated edge per DTO class.
      expect(countByType('class_validator_field')).toBe(2);
      const userDtoEdge = findEdge('class_validator_field', 'CreateUserDto');
      expect(userDtoEdge).toBeTruthy();
      const userDtoMeta = JSON.parse(userDtoEdge!.metadata) as {
        fields: { name: string; validators: string[] }[];
      };
      expect(userDtoMeta.fields.map((f) => f.name).sort()).toEqual([
        'address',
        'email',
        'name',
        'nickname',
      ]);

      // ValidateNested edge: CreateUserDto → AddressDto.
      expect(countByType('class_validator_nested')).toBe(1);

      // passport: strategy self-loop + consumer edge to strategy class.
      expect(countByType('passport_strategy')).toBe(1);
      expect(countByType('passport_authenticates')).toBe(1);

      // react-table: aggregated column edge (3 columns) + instance edge.
      expect(countByType('react_table_column')).toBe(1);
      const colEdge = findEdge('react_table_column', 'UsersGrid');
      const colMeta = JSON.parse(colEdge!.metadata) as { count: number };
      expect(colMeta.count).toBe(3);
      expect(countByType('react_table_instance')).toBe(1);
    });
  });
});
