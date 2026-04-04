import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractRoutes } from '../../../src/indexer/plugins/integration/laravel/routes.js';

const L10_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');

describe('Laravel route extraction', () => {
  describe('web.php routes', () => {
    const source = fs.readFileSync(
      path.join(L10_FIXTURE, 'routes/web.php'),
      'utf-8',
    );
    const { routes } = extractRoutes(source, 'routes/web.php');

    it('extracts Route::get with controller', () => {
      const usersIndex = routes.find(
        (r) => r.uri === '/users' && r.method === 'GET',
      );
      expect(usersIndex).toBeDefined();
      expect(usersIndex!.controllerSymbolId).toContain('UserController');
      expect(usersIndex!.controllerSymbolId).toContain('index');
      expect(usersIndex!.name).toBe('users.index');
    });

    it('extracts Route::post with controller', () => {
      const usersStore = routes.find(
        (r) => r.uri === '/users' && r.method === 'POST',
      );
      expect(usersStore).toBeDefined();
      expect(usersStore!.controllerSymbolId).toContain('store');
      expect(usersStore!.name).toBe('users.store');
    });

    it('extracts middleware from chained calls', () => {
      const usersStore = routes.find(
        (r) => r.uri === '/users' && r.method === 'POST',
      );
      expect(usersStore).toBeDefined();
      expect(usersStore!.middleware).toContain('auth');
    });

    it('extracts Route::resource routes', () => {
      const postRoutes = routes.filter((r) => r.uri.startsWith('/posts'));
      expect(postRoutes.length).toBe(7); // index, create, store, show, edit, update, destroy

      const postIndex = postRoutes.find(
        (r) => r.method === 'GET' && r.uri === '/posts',
      );
      expect(postIndex).toBeDefined();
      expect(postIndex!.name).toBe('posts.index');

      const postStore = postRoutes.find((r) => r.method === 'POST');
      expect(postStore).toBeDefined();
      expect(postStore!.name).toBe('posts.store');
    });

    it('extracts route with parameter', () => {
      const userShow = routes.find(
        (r) => r.uri === '/users/{user}' && r.method === 'GET',
      );
      expect(userShow).toBeDefined();
      expect(userShow!.name).toBe('users.show');
    });
  });

  describe('api.php routes', () => {
    const source = fs.readFileSync(
      path.join(L10_FIXTURE, 'routes/api.php'),
      'utf-8',
    );
    const { routes } = extractRoutes(source, 'routes/api.php');

    it('extracts Route::apiResource routes (5 methods, no create/edit)', () => {
      const userApiRoutes = routes.filter(
        (r) => r.uri.startsWith('/users'),
      );
      expect(userApiRoutes.length).toBe(5);

      // Should not have create/edit
      const actions = userApiRoutes.map((r) => r.name).filter(Boolean);
      expect(actions).not.toContain('users.create');
      expect(actions).not.toContain('users.edit');
      expect(actions).toContain('users.index');
      expect(actions).toContain('users.store');
      expect(actions).toContain('users.show');
      expect(actions).toContain('users.update');
      expect(actions).toContain('users.destroy');
    });

    it('applies middleware from group', () => {
      // All routes inside middleware group should have auth:sanctum
      const grouped = routes.filter(
        (r) => r.middleware && r.middleware.includes('auth:sanctum'),
      );
      expect(grouped.length).toBeGreaterThan(0);
    });
  });
});
