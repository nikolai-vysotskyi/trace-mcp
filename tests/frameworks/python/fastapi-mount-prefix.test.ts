/**
 * Regression: FastAPI cross-file `app.include_router(router, prefix="/api/v1")`
 * must compose the mount prefix onto the mounted router's route URIs, even when
 * the router (and its @router.get(...) decorators) live in a different file.
 *
 * Before: within-file `APIRouter(prefix=...)` was composed during extraction,
 * but the cross-file mount prefix was lost — routes were stored bare (`/items`),
 * so get_request_flow("/api/v1/items") and the cross-service topology missed
 * them. The pass-2 resolver resolveFastapiRouterMounts now resolves the mounted
 * router to its defining file via the Python import graph and rewrites the URIs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { FastAPIPlugin } from '../../../src/indexer/plugins/integration/framework/fastapi/index.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../../test-utils.js';

describe('FastAPI cross-file include_router(prefix=...) composition', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-fastapi-mount-');
    writeFixtureFile(
      tmpDir,
      'pyproject.toml',
      '[project]\nname = "x"\ndependencies = ["fastapi"]\n',
    );

    // Router with NO own prefix — mount prefix is the only one.
    writeFixtureFile(
      tmpDir,
      'routers/users.py',
      [
        'from fastapi import APIRouter',
        '',
        'router = APIRouter()',
        '',
        '@router.get("/items")',
        'def list_items():',
        '    return []',
        '',
        '@router.post("/items")',
        'def create_item():',
        '    return {}',
      ].join('\n'),
    );

    // Router WITH its own prefix — mount prefix must stack on top of it.
    writeFixtureFile(
      tmpDir,
      'routers/orders.py',
      [
        'from fastapi import APIRouter',
        '',
        'router = APIRouter(prefix="/orders")',
        '',
        '@router.get("/{order_id}")',
        'def get_order(order_id: int):',
        '    return {}',
      ].join('\n'),
    );

    writeFixtureFile(
      tmpDir,
      'main.py',
      [
        'from fastapi import FastAPI',
        'from routers.users import router as users_router',
        'from routers.orders import router as orders_router',
        '',
        'app = FastAPI()',
        'app.include_router(users_router, prefix="/api/v1")',
        'app.include_router(orders_router, prefix="/api/v1")',
      ].join('\n'),
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new FastAPIPlugin());
    const config = {
      root: tmpDir,
      include: ['**/*.py'],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  afterAll(() => removeTmpDir(tmpDir));

  function routeUris(): string[] {
    return (store.getAllRoutes() as Array<{ method: string; uri: string }>)
      .map((r) => `${r.method} ${r.uri}`)
      .sort();
  }

  it('prepends the cross-file mount prefix to a prefix-less router', () => {
    const uris = routeUris();
    expect(uris).toContain('GET /api/v1/items');
    expect(uris).toContain('POST /api/v1/items');
    // The bare, un-mounted paths must NOT remain.
    expect(uris).not.toContain('GET /items');
    expect(uris).not.toContain('POST /items');
  });

  it("stacks the mount prefix on top of the router's own APIRouter(prefix=)", () => {
    const uris = routeUris();
    expect(uris).toContain('GET /api/v1/orders/{order_id}');
    expect(uris).not.toContain('GET /orders/{order_id}');
  });
});
