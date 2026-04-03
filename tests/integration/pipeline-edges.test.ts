/**
 * Integration test: Does the full pipeline actually create edges in DB?
 * This tests Pass 1 + Pass 2 on real fixture projects and verifies
 * that edges, routes, migrations are stored and queryable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue.js';
import { LaravelPlugin } from '../../src/indexer/plugins/framework/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/framework/vue/index.js';
import { InertiaPlugin } from '../../src/indexer/plugins/framework/inertia/index.js';

function setupPipeline(fixturePath: string) {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();

  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
  registry.registerFrameworkPlugin(new LaravelPlugin());
  registry.registerFrameworkPlugin(new VueFrameworkPlugin());
  registry.registerFrameworkPlugin(new InertiaPlugin());

  const config = TraceMcpConfigSchema.parse({
    include: ['**/*.php', '**/*.ts', '**/*.vue'],
    exclude: ['vendor/**', 'node_modules/**'],
  });

  const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
  return { db, store, pipeline, registry };
}

describe('pipeline edge creation (laravel-10)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/laravel-10');
  let store: Store;

  beforeEach(async () => {
    const setup = setupPipeline(fixturePath);
    store = setup.store;
    await setup.pipeline.indexAll();
  });

  it('creates routes from route files', () => {
    const routes = store.getAllRoutes();
    expect(routes.length).toBeGreaterThan(0);

    const getUsersRoute = routes.find((r) => r.uri === '/users' && r.method === 'GET');
    expect(getUsersRoute).toBeDefined();
    expect(getUsersRoute!.name).toBe('users.index');
  });

  it('creates migrations from migration files', () => {
    const migrations = store.getAllMigrations();
    expect(migrations.length).toBeGreaterThan(0);

    const usersMig = migrations.find((m) => m.table_name === 'users');
    expect(usersMig).toBeDefined();
    expect(usersMig!.operation).toBe('create');

    // Verify columns are extracted
    const columns = JSON.parse(usersMig!.columns ?? '[]');
    expect(columns.length).toBeGreaterThan(0);
  });

  it('creates Eloquent relationship edges in Pass 2', () => {
    // User hasMany Post — should create a has_many edge
    const hasManyEdges = store.getEdgesByType('has_many');
    expect(hasManyEdges.length).toBeGreaterThan(0);

    // Post belongsTo User — should create a belongs_to edge
    const belongsToEdges = store.getEdgesByType('belongs_to');
    expect(belongsToEdges.length).toBeGreaterThan(0);
  });

  it('creates validates_with edges for FormRequest usage', () => {
    // UserController::store(StoreUserRequest $request) → validates_with edge
    const edges = store.getEdgesByType('validates_with');
    expect(edges.length).toBeGreaterThan(0);

    // Verify the edge connects to the right symbol
    const edge = edges[0];
    const targetNode = store.getNodeByNodeId(edge.target_node_id);
    expect(targetNode).toBeDefined();
    expect(targetNode!.node_type).toBe('symbol');

    const targetSym = store.getSymbolById(targetNode!.ref_id);
    expect(targetSym).toBeDefined();
    expect(targetSym!.fqn).toContain('StoreUserRequest');
  });

  it('creates event listener edges from EventServiceProvider', () => {
    const edges = store.getEdgesByType('listens_to');
    expect(edges.length).toBeGreaterThan(0);

    // Verify it connects SendUserNotification → UserCreated
    const edge = edges[0];
    const sourceNode = store.getNodeByNodeId(edge.source_node_id);
    const targetNode = store.getNodeByNodeId(edge.target_node_id);
    expect(sourceNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const sourceSym = store.getSymbolById(sourceNode!.ref_id);
    const targetSym = store.getSymbolById(targetNode!.ref_id);
    expect(sourceSym!.name).toBe('SendUserNotification');
    expect(targetSym!.name).toBe('UserCreated');
  });

  it('creates dispatches edges from event() calls', () => {
    const edges = store.getEdgesByType('dispatches');
    expect(edges.length).toBeGreaterThan(0);

    // UserController dispatches UserCreated
    const edge = edges[0];
    const targetNode = store.getNodeByNodeId(edge.target_node_id);
    const targetSym = store.getSymbolById(targetNode!.ref_id);
    expect(targetSym!.name).toBe('UserCreated');
  });

  it('total edge count is non-trivial', () => {
    const stats = store.getStats();
    // Should have Eloquent edges + event edges + FormRequest edges
    expect(stats.totalEdges).toBeGreaterThanOrEqual(3);
  });
});

describe('pipeline edge creation (inertia-laravel-vue)', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/inertia-laravel-vue');
  let store: Store;

  beforeEach(async () => {
    const setup = setupPipeline(fixturePath);
    store = setup.store;
    await setup.pipeline.indexAll();
  });

  it('indexes both PHP and Vue files', () => {
    const stats = store.getStats();
    expect(stats.totalFiles).toBeGreaterThanOrEqual(5); // routes, controller, model, 2 vue pages

    const files = store.getAllFiles();
    const phpFiles = files.filter((f) => f.language === 'php');
    const vueFiles = files.filter((f) => f.language === 'vue');
    expect(phpFiles.length).toBeGreaterThan(0);
    expect(vueFiles.length).toBeGreaterThan(0);
  });

  it('creates routes pointing to controllers', () => {
    const routes = store.getAllRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(2);

    const indexRoute = routes.find((r) => r.uri === '/users' && r.method === 'GET');
    expect(indexRoute).toBeDefined();
  });

  it('creates inertia_renders edges from PHP controller to Vue page', () => {
    const edges = store.getEdgesByType('inertia_renders');
    expect(edges.length).toBeGreaterThan(0);

    // Verify edge connects controller → Vue page component
    const edge = edges[0];
    const sourceNode = store.getNodeByNodeId(edge.source_node_id);
    const targetNode = store.getNodeByNodeId(edge.target_node_id);
    expect(sourceNode).toBeDefined();
    expect(targetNode).toBeDefined();
    expect(sourceNode!.node_type).toBe('symbol');
    expect(targetNode!.node_type).toBe('symbol');

    const sourceSym = store.getSymbolById(sourceNode!.ref_id);
    const targetSym = store.getSymbolById(targetNode!.ref_id);
    // Source is the method that calls Inertia::render, not the class
    expect(sourceSym!.fqn).toContain('UserController');

    // Target should be a Vue page component
    const targetFile = store.getFileById(targetSym!.file_id);
    expect(targetFile!.path).toContain('Pages/Users/');
    expect(targetFile!.path).toContain('.vue');
  });

  it('creates passes_props edges with prop names', () => {
    const edges = store.getEdgesByType('passes_props');
    expect(edges.length).toBeGreaterThan(0);

    const edge = edges[0];
    const meta = JSON.parse(edge.metadata ?? '{}');
    expect(meta.propNames).toBeDefined();
    expect(Array.isArray(meta.propNames)).toBe(true);
    expect(meta.propNames.length).toBeGreaterThan(0);
  });

  it('Vue page symbols exist and have props metadata', () => {
    const files = store.getAllFiles();
    const indexVue = files.find((f) => f.path.includes('Users/Index.vue'));
    expect(indexVue).toBeDefined();

    const symbols = store.getSymbolsByFile(indexVue!.id);
    const component = symbols.find((s) => s.kind === 'class');
    expect(component).toBeDefined();

    // Should have props metadata from defineProps
    const meta = component!.metadata ? JSON.parse(component!.metadata) : {};
    expect(meta.props || meta.sfc).toBeDefined();
  });
});
