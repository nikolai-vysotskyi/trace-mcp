/**
 * Behavioural coverage for `getRequestFlow()` (the `get_request_flow` MCP tool).
 *
 * Seeds a fixture without running a real framework plugin: a `routes` row
 * pointing at a controller symbol, then asserts the URL -> route -> controller
 * step chain, the NOT_FOUND envelope for unknown URLs, and that the HTTP
 * method filter is respected.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getRequestFlow } from '../../../src/tools/framework/flow.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();

  // Controller file + class + method.
  const ctrlFileId = store.insertFile('app/Http/UserController.php', 'php', 'h-ctrl', 400);
  const ctrlClassRow = store.insertSymbol(ctrlFileId, {
    symbolId: 'app/Http/UserController.php::App\\Http\\UserController#class',
    name: 'UserController',
    kind: 'class',
    fqn: 'App\\Http\\UserController',
    byteStart: 0,
    byteEnd: 200,
    lineStart: 1,
    lineEnd: 30,
  });
  store.insertSymbol(ctrlFileId, {
    symbolId: 'app/Http/UserController.php::App\\Http\\UserController::store#method',
    name: 'store',
    kind: 'method',
    fqn: 'App\\Http\\UserController::store',
    byteStart: 100,
    byteEnd: 180,
    lineStart: 12,
    lineEnd: 20,
  });

  // Routes file (just needs a file id for the routes row).
  const routesFileId = store.insertFile('routes/web.php', 'php', 'h-routes', 200);

  // POST /users -> UserController@store with one middleware.
  store.insertRoute(
    {
      method: 'POST',
      uri: '/users',
      name: 'users.store',
      controllerSymbolId: 'App\\Http\\UserController::store',
      middleware: ['auth'],
      line: 10,
    },
    routesFileId,
  );

  // GET /users -> UserController@index — distinct method on same URI so we can
  // confirm the method filter narrows correctly.
  store.insertRoute(
    {
      method: 'GET',
      uri: '/users',
      name: 'users.index',
      controllerSymbolId: 'App\\Http\\UserController::index',
      line: 8,
    },
    routesFileId,
  );

  // Silence unused warning — the controller class row is part of the seeded
  // graph shape even though the tool resolves by FQN string.
  void ctrlClassRow;

  return { store };
}

describe('getRequestFlow() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns ok envelope with url, method, steps for a known route', () => {
    const result = getRequestFlow(ctx.store, '/users', 'POST');
    expect(result.isOk()).toBe(true);
    const flow = result._unsafeUnwrap();
    expect(flow.url).toBe('/users');
    expect(flow.method).toBe('POST');
    expect(Array.isArray(flow.steps)).toBe(true);
    expect(flow.steps.length).toBeGreaterThan(0);
  });

  it('flow begins with a route step describing the matched route', () => {
    const result = getRequestFlow(ctx.store, '/users', 'POST');
    expect(result.isOk()).toBe(true);
    const flow = result._unsafeUnwrap();
    const routeStep = flow.steps.find((s) => s.type === 'route');
    expect(routeStep).toBeDefined();
    expect(routeStep!.name).toBeTypeOf('string');
    expect(routeStep!.details).toBeDefined();
    // Details echo back the routing primitives.
    expect((routeStep!.details as { method?: string }).method).toBe('POST');
    expect((routeStep!.details as { uri?: string }).uri).toBe('/users');
  });

  it('includes middleware + controller steps after the route step', () => {
    const result = getRequestFlow(ctx.store, '/users', 'POST');
    expect(result.isOk()).toBe(true);
    const flow = result._unsafeUnwrap();
    const mwStep = flow.steps.find((s) => s.type === 'middleware');
    const ctrlStep = flow.steps.find((s) => s.type === 'controller');
    expect(mwStep).toBeDefined();
    expect(mwStep!.name).toBe('auth');
    expect(ctrlStep).toBeDefined();
    // Controller step records the FQN + action through name/fqn fields.
    expect(ctrlStep!.name).toContain('UserController');
  });

  it('uppercases the method (case-insensitive lookup) and respects filter', () => {
    // Lowercase "post" should resolve to the POST route, NOT the GET one.
    const result = getRequestFlow(ctx.store, '/users', 'post');
    expect(result.isOk()).toBe(true);
    const flow = result._unsafeUnwrap();
    expect(flow.method).toBe('POST');
    const routeStep = flow.steps.find((s) => s.type === 'route');
    expect((routeStep!.details as { method?: string }).method).toBe('POST');
  });

  it('unknown route surfaces NOT_FOUND error', () => {
    const result = getRequestFlow(ctx.store, '/no-such-url', 'GET');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
