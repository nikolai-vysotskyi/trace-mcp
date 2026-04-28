/**
 * Integration: Laravel middleware resolution through full pipeline.
 * Tests both L6-10 (Kernel.php) and L11+ (bootstrap/app.php) styles.
 */
import { describe, expect, it } from 'vitest';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import {
  parseBootstrapMiddleware,
  parseBootstrapRouting,
  parseKernelMiddleware,
  parseRouteServiceProviderNamespace,
} from '../../src/indexer/plugins/integration/framework/laravel/middleware.js';

describe('Laravel middleware parsing', () => {
  it('parses Kernel.php middleware (Laravel 8 style)', () => {
    const source = `<?php
namespace App\\Http;

use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;

class Kernel extends HttpKernel
{
    protected $middleware = [
        \\App\\Http\\Middleware\\TrustProxies::class,
        \\App\\Http\\Middleware\\PreventRequestsDuringMaintenance::class,
    ];

    protected $middlewareGroups = [
        'web' => [
            \\App\\Http\\Middleware\\EncryptCookies::class,
            \\Illuminate\\Session\\Middleware\\StartSession::class,
            \\Illuminate\\View\\Middleware\\ShareErrorsFromSession::class,
        ],
        'api' => [
            'throttle:api',
            \\Illuminate\\Routing\\Middleware\\SubstituteBindings::class,
        ],
    ];

    protected $routeMiddleware = [
        'auth' => \\App\\Http\\Middleware\\Authenticate::class,
        'verified' => \\Illuminate\\Auth\\Middleware\\EnsureEmailIsVerified::class,
        'can' => \\Illuminate\\Auth\\Middleware\\Authorize::class,
    ];
}`;

    const config = parseKernelMiddleware(source);

    expect(config.source).toBe('kernel');
    expect(config.global).toHaveLength(2);
    expect(config.global[0]).toContain('TrustProxies');

    expect(config.groups.web).toHaveLength(3);
    expect(config.groups.api).toHaveLength(2);
    expect(config.groups.api).toContain('throttle:api');

    expect(config.aliases.auth).toContain('Authenticate');
    expect(config.aliases.verified).toContain('EnsureEmailIsVerified');
    expect(config.aliases.can).toContain('Authorize');
  });

  it('parses bootstrap/app.php middleware (Laravel 11 style)', () => {
    const source = `<?php
use Illuminate\\Foundation\\Application;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->alias([
            'auth' => \\App\\Http\\Middleware\\Authenticate::class,
            'verified' => \\App\\Http\\Middleware\\EnsureEmailIsVerified::class,
        ]);

        $middleware->web(append: [
            \\App\\Http\\Middleware\\HandleInertiaRequests::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        //
    })->create();`;

    const mwConfig = parseBootstrapMiddleware(source);
    expect(mwConfig.source).toBe('bootstrap');
    expect(mwConfig.aliases.auth).toContain('Authenticate');
    expect(mwConfig.aliases.verified).toContain('EnsureEmailIsVerified');
    expect(mwConfig.groups.web).toContain('App\\Http\\Middleware\\HandleInertiaRequests');

    const routing = parseBootstrapRouting(source);
    expect(routing.web).toBe('routes/web.php');
    expect(routing.api).toBe('routes/api.php');
  });

  it('parses RouteServiceProvider namespace (Laravel 6-8)', () => {
    const source = `<?php
namespace App\\Providers;

class RouteServiceProvider extends ServiceProvider
{
    protected $namespace = 'App\\Http\\Controllers';

    public function boot()
    {
        $this->routes(function () {
            Route::namespace($this->namespace)->group(base_path('routes/web.php'));
        });
    }
}`;

    const ns = parseRouteServiceProviderNamespace(source);
    expect(ns).toBe('App\\Http\\Controllers');
  });

  it('handles missing middleware config gracefully', () => {
    const source = `<?php
class Kernel extends HttpKernel
{
    // No middleware properties defined
}`;
    const config = parseKernelMiddleware(source);
    expect(config.global).toHaveLength(0);
    expect(Object.keys(config.groups)).toHaveLength(0);
    expect(Object.keys(config.aliases)).toHaveLength(0);
  });
});

describe('LaravelPlugin middleware resolution', () => {
  it('resolves middleware aliases', () => {
    const plugin = new LaravelPlugin();

    // Before parsing, aliases are empty
    expect(plugin.resolveMiddlewareAlias('auth')).toBe('auth');

    // Simulate parsing a Kernel.php with middleware
    // (In real pipeline, extractNodes would be called)
    const source = `<?php
class Kernel extends HttpKernel {
    protected $routeMiddleware = [
        'auth' => \\App\\Http\\Middleware\\Authenticate::class,
    ];
}`;
    // Call extractNodes to populate middleware config
    plugin.extractNodes('app/Http/Kernel.php', Buffer.from(source), 'php');

    const config = plugin.getMiddlewareConfig();
    expect(config).not.toBeNull();
    expect(config!.aliases.auth).toContain('Authenticate');
    expect(plugin.resolveMiddlewareAlias('auth')).toContain('Authenticate');
  });

  it('builds middleware chain resolving aliases', () => {
    const plugin = new LaravelPlugin();

    const source = `<?php
class Kernel extends HttpKernel {
    protected $routeMiddleware = [
        'auth' => \\App\\Http\\Middleware\\Authenticate::class,
        'throttle' => \\Illuminate\\Routing\\Middleware\\ThrottleRequests::class,
    ];
}`;
    plugin.extractNodes('app/Http/Kernel.php', Buffer.from(source), 'php');

    const chain = plugin.getMiddlewareChain(['auth', 'throttle:60']);
    expect(chain[0]).toContain('Authenticate');
    // throttle:60 should become ThrottleRequests:60
    expect(chain[1]).toContain('ThrottleRequests');
    expect(chain[1]).toContain(':60');
  });
});
