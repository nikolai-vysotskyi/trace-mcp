/**
 * Tests for Laravel middleware configuration parsing.
 * Covers Kernel.php (L6-10) and bootstrap/app.php (L11+).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseKernelMiddleware,
  parseBootstrapMiddleware,
  parseRouteServiceProviderNamespace,
  parseBootstrapRouting,
} from '../../../src/indexer/plugins/framework/laravel/middleware.js';

const L6_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-6');
const L8_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-8');
const L11_FIXTURE = path.resolve(__dirname, '../../fixtures/laravel-11');

describe('Kernel.php middleware parsing (Laravel 6)', () => {
  const source = fs.readFileSync(
    path.join(L6_FIXTURE, 'app/Http/Kernel.php'),
    'utf-8',
  );
  const config = parseKernelMiddleware(source);

  it('identifies source as kernel', () => {
    expect(config.source).toBe('kernel');
  });

  it('extracts global middleware', () => {
    expect(config.global.length).toBeGreaterThan(0);
    expect(config.global).toContain('App\\Http\\Middleware\\TrustProxies');
    expect(config.global).toContain('App\\Http\\Middleware\\TrimStrings');
  });

  it('extracts middleware groups', () => {
    expect(config.groups['web']).toBeDefined();
    expect(config.groups['api']).toBeDefined();
    expect(config.groups['web'].length).toBeGreaterThan(0);
    expect(config.groups['web']).toContain('App\\Http\\Middleware\\EncryptCookies');
  });

  it('extracts api group with string middleware', () => {
    expect(config.groups['api']).toContain('throttle:60,1');
  });

  it('extracts route middleware aliases', () => {
    expect(config.aliases['auth']).toBe('App\\Http\\Middleware\\Authenticate');
    expect(config.aliases['guest']).toBe('App\\Http\\Middleware\\RedirectIfAuthenticated');
    expect(config.aliases['verified']).toBe('Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified');
    expect(config.aliases['admin']).toBe('App\\Http\\Middleware\\AdminMiddleware');
  });
});

describe('Kernel.php middleware parsing (Laravel 8)', () => {
  const source = fs.readFileSync(
    path.join(L8_FIXTURE, 'app/Http/Kernel.php'),
    'utf-8',
  );
  const config = parseKernelMiddleware(source);

  it('extracts global middleware', () => {
    expect(config.global).toContain('App\\Http\\Middleware\\TrustProxies');
    expect(config.global).toContain('Illuminate\\Http\\Middleware\\HandleCors');
  });

  it('extracts api group with Sanctum middleware', () => {
    expect(config.groups['api']).toContain(
      'Laravel\\Sanctum\\Http\\Middleware\\EnsureFrontendRequestsAreStateful',
    );
  });

  it('extracts route middleware with throttle', () => {
    expect(config.aliases['throttle']).toBe(
      'Illuminate\\Routing\\Middleware\\ThrottleRequests',
    );
  });
});

describe('bootstrap/app.php middleware parsing (Laravel 11)', () => {
  const source = fs.readFileSync(
    path.join(L11_FIXTURE, 'bootstrap/app.php'),
    'utf-8',
  );
  const config = parseBootstrapMiddleware(source);

  it('identifies source as bootstrap', () => {
    expect(config.source).toBe('bootstrap');
  });

  it('extracts middleware aliases', () => {
    expect(config.aliases['role']).toBe('App\\Http\\Middleware\\CheckRole');
    expect(config.aliases['verified']).toBe(
      'Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified',
    );
  });

  it('extracts web group additions', () => {
    expect(config.groups['web']).toBeDefined();
    expect(config.groups['web']).toContain(
      'App\\Http\\Middleware\\HandleInertiaRequests',
    );
  });

  it('extracts api group additions', () => {
    expect(config.groups['api']).toBeDefined();
    expect(config.groups['api']).toContain(
      'Laravel\\Sanctum\\Http\\Middleware\\EnsureFrontendRequestsAreStateful',
    );
  });
});

describe('RouteServiceProvider namespace parsing', () => {
  it('extracts namespace from Laravel 6 RouteServiceProvider', () => {
    const source = fs.readFileSync(
      path.join(L6_FIXTURE, 'app/Providers/RouteServiceProvider.php'),
      'utf-8',
    );
    const ns = parseRouteServiceProviderNamespace(source);
    expect(ns).toBe('App\\Http\\Controllers');
  });

  it('returns null when no namespace property', () => {
    const source = `<?php
namespace App\\Providers;
class RouteServiceProvider extends ServiceProvider {
    public function boot() {}
}`;
    expect(parseRouteServiceProviderNamespace(source)).toBeNull();
  });
});

describe('bootstrap/app.php routing parsing', () => {
  it('extracts route file paths from withRouting()', () => {
    const source = fs.readFileSync(
      path.join(L11_FIXTURE, 'bootstrap/app.php'),
      'utf-8',
    );
    const routing = parseBootstrapRouting(source);
    expect(routing['web']).toContain('routes/web.php');
    expect(routing['api']).toContain('routes/api.php');
    expect(routing['commands']).toContain('routes/console.php');
    expect(routing['health']).toBe('up');
  });

  it('returns empty for file without withRouting', () => {
    const source = `<?php return Application::configure()->create();`;
    const routing = parseBootstrapRouting(source);
    expect(Object.keys(routing).length).toBe(0);
  });
});
