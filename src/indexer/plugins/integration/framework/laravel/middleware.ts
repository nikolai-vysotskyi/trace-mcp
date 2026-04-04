/**
 * Laravel middleware extraction.
 *
 * Supports two styles:
 * - Laravel 6–10: app/Http/Kernel.php ($middleware, $middlewareGroups, $routeMiddleware)
 * - Laravel 11+:  bootstrap/app.php (->withMiddleware() callback with alias/web/api methods)
 */

import { escapeRegExp } from '../../../../../utils/security.js';

export interface MiddlewareConfig {
  /** Global middleware applied to every request. */
  global: string[];

  /** Named middleware groups (e.g. 'web', 'api'). */
  groups: Record<string, string[]>;

  /** Route middleware aliases (e.g. 'auth' -> class FQN). */
  aliases: Record<string, string>;

  /** Source style: 'kernel' (L6-10) or 'bootstrap' (L11+). */
  source: 'kernel' | 'bootstrap';
}

/**
 * Parse middleware configuration from Kernel.php (Laravel 6–10).
 */
export function parseKernelMiddleware(source: string): MiddlewareConfig {
  return {
    global: extractPropertyArray(source, '$middleware'),
    groups: extractPropertyGroups(source, '$middlewareGroups'),
    aliases: {
      ...extractPropertyMap(source, '$routeMiddleware'),
      ...extractPropertyMap(source, '$middlewareAliases'), // L10+ alternative name
    },
    source: 'kernel',
  };
}

/**
 * Parse middleware configuration from bootstrap/app.php (Laravel 11+).
 */
export function parseBootstrapMiddleware(source: string): MiddlewareConfig {
  const config: MiddlewareConfig = {
    global: [],
    groups: {},
    aliases: {},
    source: 'bootstrap',
  };

  // Extract the withMiddleware callback body
  const mwBodyRegex = /->withMiddleware\s*\(\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)/;
  const bodyMatch = source.match(mwBodyRegex);
  if (!bodyMatch) return config;

  const body = bodyMatch[1];

  // Parse $middleware->alias([...])
  config.aliases = extractCallMap(body, 'alias');

  // Parse $middleware->web(append: [...]) and $middleware->api(prepend: [...])
  const webItems = extractCallArray(body, 'web');
  if (webItems.length > 0) {
    config.groups['web'] = webItems;
  }

  const apiItems = extractCallArray(body, 'api');
  if (apiItems.length > 0) {
    config.groups['api'] = apiItems;
  }

  return config;
}

/**
 * Extract a property that is a flat array of class references.
 * e.g. protected $middleware = [ \App\Http\Middleware\X::class, ... ];
 */
function extractPropertyArray(source: string, propName: string): string[] {
  const escaped = escapeRegExp(propName);
  const regex = new RegExp(
    `protected\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\];`,
  );
  const match = source.match(regex);
  if (!match) return [];
  return extractClassReferences(match[1]);
}

/**
 * Extract a property that is a map of group name -> array of class references.
 * e.g. protected $middlewareGroups = [ 'web' => [...], 'api' => [...] ];
 */
function extractPropertyGroups(
  source: string,
  propName: string,
): Record<string, string[]> {
  const escaped = escapeRegExp(propName);
  const regex = new RegExp(
    `protected\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\];`,
  );
  const match = source.match(regex);
  if (!match) return {};

  const body = match[1];
  const groups: Record<string, string[]> = {};

  // Match 'groupName' => [ ... ]
  const groupRegex = /['"](\w+)['"]\s*=>\s*\[([\s\S]*?)\]/g;
  let gMatch: RegExpExecArray | null;
  while ((gMatch = groupRegex.exec(body)) !== null) {
    groups[gMatch[1]] = extractClassReferences(gMatch[2]);
  }

  return groups;
}

/**
 * Extract a property that is a map of alias name -> class reference.
 * e.g. protected $routeMiddleware = [ 'auth' => \App\Http\Middleware\Authenticate::class, ... ];
 */
function extractPropertyMap(
  source: string,
  propName: string,
): Record<string, string> {
  const escaped = escapeRegExp(propName);
  const regex = new RegExp(
    `protected\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\];`,
  );
  const match = source.match(regex);
  if (!match) return {};

  return extractAliasMap(match[1]);
}

/**
 * Extract alias map from $middleware->alias([...]) call in bootstrap/app.php.
 */
function extractCallMap(body: string, methodName: string): Record<string, string> {
  const regex = new RegExp(
    `\\$middleware->${escapeRegExp(methodName)}\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
  );
  const match = body.match(regex);
  if (!match) return {};
  return extractAliasMap(match[1]);
}

/**
 * Extract class array from $middleware->web(append: [...]) or $middleware->api(prepend: [...]).
 */
function extractCallArray(body: string, methodName: string): string[] {
  const regex = new RegExp(
    `\\$middleware->${escapeRegExp(methodName)}\\s*\\((?:append|prepend):\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
  );
  const match = body.match(regex);
  if (!match) return [];
  return extractClassReferences(match[1]);
}

/**
 * Extract class references from a PHP array body.
 * Handles both \Full\Class::class and 'string:param' forms.
 */
function extractClassReferences(body: string): string[] {
  const refs: string[] = [];

  // Match ::class references
  const classRegex = /\\?([\w\\]+)::class/g;
  let m: RegExpExecArray | null;
  while ((m = classRegex.exec(body)) !== null) {
    refs.push(m[1]);
  }

  // Match string references like 'throttle:60,1' or 'throttle:api'
  const stringRegex = /['"](\w+[:\w,]*)['"]/g;
  while ((m = stringRegex.exec(body)) !== null) {
    // Skip if it's a group name key (followed by =>)
    const afterMatch = body.substring(m.index + m[0].length).trimStart();
    if (afterMatch.startsWith('=>')) continue;
    refs.push(m[1]);
  }

  return refs;
}

/**
 * Extract alias mappings from PHP array body: 'name' => \Class::class
 */
function extractAliasMap(body: string): Record<string, string> {
  const map: Record<string, string> = {};
  const regex = /['"](\w+)['"]\s*=>\s*\\?([\w\\]+)::class/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    map[m[1]] = m[2];
  }
  return map;
}

/**
 * Extract RouteServiceProvider namespace (Laravel 6-8).
 * Returns the $namespace property value.
 */
export function parseRouteServiceProviderNamespace(source: string): string | null {
  const match = source.match(/protected\s+\$namespace\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/**
 * Extract withRouting() config from bootstrap/app.php (Laravel 11+).
 * Returns which route files are configured.
 */
export function parseBootstrapRouting(source: string): Record<string, string> {
  const routes: Record<string, string> = {};
  const routingRegex = /->withRouting\s*\(([\s\S]*?)\)/;
  const match = source.match(routingRegex);
  if (!match) return routes;

  const body = match[1];
  // Match named params: web: __DIR__.'/../routes/web.php'
  const paramRegex = /(\w+):\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = paramRegex.exec(body)) !== null) {
    const key = m[1];
    let value = m[2];
    // Normalize: remove leading /../ or ../ or / patterns
    value = value.replace(/^\/?\.\.\//, '').replace(/^\//, '');
    routes[key] = value;
  }

  return routes;
}
