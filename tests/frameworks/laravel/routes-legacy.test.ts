/**
 * Tests for Laravel route extraction — legacy and extended patterns.
 * Covers string controller syntax (L6-8), invokable controllers,
 * Route::namespace(), Route::controller() groups.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractRoutes } from '../../../src/indexer/plugins/framework/laravel/routes.js';

const L6_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-6');
const L8_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-8');
const L11_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-11');

describe('Laravel 6 route extraction (string syntax)', () => {
  const source = fs.readFileSync(
    path.join(L6_FIXTURE, 'routes/web.php'),
    'utf-8',
  );
  const { routes } = extractRoutes(source, 'routes/web.php');

  it('extracts string controller syntax: Controller@method', () => {
    const home = routes.find((r) => r.uri === '/' && r.method === 'GET');
    expect(home).toBeDefined();
    expect(home!.controllerSymbolId).toBe('HomeController::index');
    expect(home!.name).toBe('home');
  });

  it('extracts string controller with middleware', () => {
    const profile = routes.find(
      (r) => r.uri === '/profile' && r.method === 'GET',
    );
    expect(profile).toBeDefined();
    expect(profile!.controllerSymbolId).toBe('UserController::profile');
    expect(profile!.middleware).toContain('auth');
  });

  it('extracts string-based Route::resource', () => {
    const postRoutes = routes.filter((r) => r.uri.startsWith('/posts'));
    expect(postRoutes.length).toBe(7);
    // All should reference PostController
    for (const r of postRoutes) {
      expect(r.controllerSymbolId).toContain('PostController');
    }
  });

  it('extracts routes from Route::namespace group', () => {
    const dashboard = routes.find(
      (r) => r.uri === '/admin/dashboard' && r.method === 'GET',
    );
    expect(dashboard).toBeDefined();
    expect(dashboard!.controllerSymbolId).toBe('Admin\\DashboardController::index');
    expect(dashboard!.name).toBe('admin.dashboard');
  });

  it('applies prefix from namespace group', () => {
    const adminUsers = routes.filter((r) => r.uri.startsWith('/admin/users'));
    expect(adminUsers.length).toBe(7); // resource generates 7 routes
  });

  it('applies middleware from namespace group', () => {
    const dashboard = routes.find(
      (r) => r.uri === '/admin/dashboard',
    );
    expect(dashboard).toBeDefined();
    expect(dashboard!.middleware).toContain('admin');
  });

  describe('api.php routes', () => {
    const apiSource = fs.readFileSync(
      path.join(L6_FIXTURE, 'routes/api.php'),
      'utf-8',
    );
    const { routes: apiRoutes } = extractRoutes(apiSource, 'routes/api.php');

    it('extracts string controller in api routes', () => {
      const userMe = apiRoutes.find(
        (r) => r.uri === '/user' && r.method === 'GET',
      );
      expect(userMe).toBeDefined();
      expect(userMe!.controllerSymbolId).toBe('Api\\UserController::me');
    });

    it('extracts string-based apiResource', () => {
      const postRoutes = apiRoutes.filter((r) => r.uri.startsWith('/posts'));
      expect(postRoutes.length).toBe(5); // apiResource = 5 routes
    });

    it('applies middleware group from Route::middleware', () => {
      const grouped = apiRoutes.filter(
        (r) => r.middleware && r.middleware.includes('auth:api'),
      );
      expect(grouped.length).toBeGreaterThan(0);
    });
  });
});

describe('Laravel 8 route extraction (mixed syntax)', () => {
  const source = fs.readFileSync(
    path.join(L8_FIXTURE, 'routes/web.php'),
    'utf-8',
  );
  const { routes } = extractRoutes(source, 'routes/web.php');

  it('extracts class array syntax (L8 default)', () => {
    const usersIndex = routes.find(
      (r) => r.uri === '/users' && r.method === 'GET',
    );
    expect(usersIndex).toBeDefined();
    expect(usersIndex!.controllerSymbolId).toContain('UserController');
    expect(usersIndex!.controllerSymbolId).toContain('index');
  });

  it('extracts invokable controller', () => {
    const dashboard = routes.find(
      (r) => r.uri === '/dashboard' && r.method === 'GET',
    );
    expect(dashboard).toBeDefined();
    expect(dashboard!.controllerSymbolId).toContain('DashboardController::__invoke');
    expect(dashboard!.name).toBe('dashboard');
    expect(dashboard!.middleware).toContain('auth');
  });

  it('still parses deprecated string syntax in L8', () => {
    const legacy = routes.find(
      (r) => r.uri === '/legacy' && r.method === 'GET',
    );
    expect(legacy).toBeDefined();
    expect(legacy!.controllerSymbolId).toBe('LegacyController::show');
    expect(legacy!.name).toBe('legacy.show');
  });

  it('extracts Route::resource with class syntax', () => {
    const postRoutes = routes.filter((r) => r.uri.startsWith('/posts'));
    expect(postRoutes.length).toBe(7);
  });

  it('applies middleware array group', () => {
    const settings = routes.find(
      (r) => r.uri === '/settings' && r.method === 'GET',
    );
    expect(settings).toBeDefined();
    expect(settings!.middleware).toContain('auth');
    expect(settings!.middleware).toContain('verified');
  });
});

describe('Laravel 11 route extraction (controller groups)', () => {
  const source = fs.readFileSync(
    path.join(L11_FIXTURE, 'routes/web.php'),
    'utf-8',
  );
  const { routes } = extractRoutes(source, 'routes/web.php');

  it('extracts routes from Route::controller() group', () => {
    const usersIndex = routes.find(
      (r) => r.uri === '/users' && r.method === 'GET' && r.name === 'users.index',
    );
    expect(usersIndex).toBeDefined();
    expect(usersIndex!.controllerSymbolId).toContain('UserController');
    expect(usersIndex!.controllerSymbolId).toContain('index');
  });

  it('extracts all routes from controller group', () => {
    const usersStore = routes.find(
      (r) => r.uri === '/users' && r.method === 'POST',
    );
    expect(usersStore).toBeDefined();
    expect(usersStore!.controllerSymbolId).toContain('UserController');
    expect(usersStore!.controllerSymbolId).toContain('store');

    const usersShow = routes.find(
      (r) => r.uri === '/users/{user}' && r.method === 'GET',
    );
    expect(usersShow).toBeDefined();
    expect(usersShow!.controllerSymbolId).toContain('show');
  });

  it('extracts invokable controller', () => {
    const dashboard = routes.find(
      (r) => r.uri === '/dashboard' && r.method === 'GET',
    );
    expect(dashboard).toBeDefined();
    expect(dashboard!.controllerSymbolId).toContain('DashboardController::__invoke');
    expect(dashboard!.middleware).toContain('auth');
  });

  it('extracts resource with chained middleware', () => {
    const postRoutes = routes.filter((r) =>
      r.uri.startsWith('/posts') && r.controllerSymbolId?.includes('PostController'),
    );
    expect(postRoutes.length).toBe(7);
    for (const r of postRoutes) {
      expect(r.middleware).toContain('auth');
    }
  });

  it('applies middleware array group', () => {
    const profileEdit = routes.find(
      (r) => r.uri === '/profile' && r.method === 'GET',
    );
    expect(profileEdit).toBeDefined();
    expect(profileEdit!.middleware).toContain('auth');
    expect(profileEdit!.middleware).toContain('verified');
  });
});
