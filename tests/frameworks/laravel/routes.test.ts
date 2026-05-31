import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRoutes } from '../../../src/indexer/plugins/integration/framework/laravel/routes.js';

const L10_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-10');

describe('Laravel route extraction', () => {
  describe('web.php routes', () => {
    const source = fs.readFileSync(path.join(L10_FIXTURE, 'routes/web.php'), 'utf-8');
    const { routes } = extractRoutes(source, 'routes/web.php');

    it('extracts Route::get with controller', () => {
      const usersIndex = routes.find((r) => r.uri === '/users' && r.method === 'GET');
      expect(usersIndex).toBeDefined();
      expect(usersIndex!.controllerSymbolId).toContain('UserController');
      expect(usersIndex!.controllerSymbolId).toContain('index');
      expect(usersIndex!.name).toBe('users.index');
    });

    it('extracts Route::post with controller', () => {
      const usersStore = routes.find((r) => r.uri === '/users' && r.method === 'POST');
      expect(usersStore).toBeDefined();
      expect(usersStore!.controllerSymbolId).toContain('store');
      expect(usersStore!.name).toBe('users.store');
    });

    it('extracts middleware from chained calls', () => {
      const usersStore = routes.find((r) => r.uri === '/users' && r.method === 'POST');
      expect(usersStore).toBeDefined();
      expect(usersStore!.middleware).toContain('auth');
    });

    it('extracts Route::resource routes', () => {
      const postRoutes = routes.filter((r) => r.uri.startsWith('/posts'));
      expect(postRoutes.length).toBe(7); // index, create, store, show, edit, update, destroy

      const postIndex = postRoutes.find((r) => r.method === 'GET' && r.uri === '/posts');
      expect(postIndex).toBeDefined();
      expect(postIndex!.name).toBe('posts.index');

      const postStore = postRoutes.find((r) => r.method === 'POST');
      expect(postStore).toBeDefined();
      expect(postStore!.name).toBe('posts.store');
    });

    it('extracts route with parameter', () => {
      const userShow = routes.find((r) => r.uri === '/users/{user}' && r.method === 'GET');
      expect(userShow).toBeDefined();
      expect(userShow!.name).toBe('users.show');
    });
  });

  describe('api.php routes', () => {
    const source = fs.readFileSync(path.join(L10_FIXTURE, 'routes/api.php'), 'utf-8');
    const { routes } = extractRoutes(source, 'routes/api.php');

    it('extracts Route::apiResource routes (5 methods, no create/edit)', () => {
      const userApiRoutes = routes.filter((r) => r.uri.startsWith('/users'));
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
      const grouped = routes.filter((r) => r.middleware?.includes('auth:sanctum'));
      expect(grouped.length).toBeGreaterThan(0);
    });
  });

  describe('inline-chained and closure routes', () => {
    const source = `<?php
use App\\Http\\Controllers\\DashController;

Route::get('/closure', function () { return response()->json([]); });

Route::middleware(['auth:sanctum'])->post('/toggle-lenta', function (Request $request) {
    return $request->user();
});

Route::middleware('auth')->prefix('admin')->get('/dashboard', [DashController::class, 'index']);

Route::middleware(['auth:sanctum', 'verified'])->post('/favorited/media/{media}', function (Request $request, Media $media) {
    return $media;
})->name('media.fav');
`;
    const { routes } = extractRoutes(source, 'routes/api.php');

    it('extracts closure routes (no controller, endpoint still registered)', () => {
      const closure = routes.find((r) => r.uri === '/closure' && r.method === 'GET');
      expect(closure).toBeDefined();
      expect(closure!.controllerSymbolId).toBeUndefined();
    });

    it('extracts inline-chained closure routes with middleware', () => {
      const toggle = routes.find((r) => r.uri === '/toggle-lenta' && r.method === 'POST');
      expect(toggle).toBeDefined();
      expect(toggle!.middleware).toContain('auth:sanctum');
    });

    it('composes an inline prefix(...) into the URI and resolves the controller', () => {
      const dash = routes.find((r) => r.uri === '/admin/dashboard' && r.method === 'GET');
      expect(dash).toBeDefined();
      expect(dash!.controllerSymbolId).toContain('DashController');
      expect(dash!.controllerSymbolId).toContain('index');
      expect(dash!.middleware).toContain('auth');
    });

    it('registers a parameterized closure endpoint (method + uri) for matching', () => {
      // The endpoint itself must be registered so a frontend call can match it;
      // a trailing ->name() after a multi-line closure body is best-effort.
      const fav = routes.find((r) => r.uri === '/favorited/media/{media}' && r.method === 'POST');
      expect(fav).toBeDefined();
      expect(fav!.middleware).toContain('auth:sanctum');
    });
  });
});
