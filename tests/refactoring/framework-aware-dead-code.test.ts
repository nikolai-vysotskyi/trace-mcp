/**
 * Tests for the framework-aware dead-code filter.
 *
 * CRG v2.3.2 PR #249 surfaced this exact false-positive: every Spring
 * @Controller, NestJS @Injectable, Laravel route handler, etc. shows up as
 * confidence 1.0 dead code under pure import-graph analysis. They're
 * invoked by the framework runtime, not via import.
 *
 * The filter walks symbol metadata for known stereotype decorators or a
 * frameworkRole tag and drops those symbols from the candidate set
 * before scoring. Result must include a warning so callers know the
 * filter ran and could be missing real entry points.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getDeadCodeV2 } from '../../src/tools/refactoring/dead-code.ts';

function seedExportedSymbol(
  store: Store,
  filePath: string,
  name: string,
  metadata: Record<string, unknown>,
): void {
  const fileId = store.insertFile(filePath, 'java', `h-${filePath}`, 100);
  // getExportedSymbols filters on metadata.exported = 1, so the fixture must
  // stamp it inline alongside the framework metadata under test.
  store.insertSymbol(fileId, {
    symbolId: `${filePath}::${name}#class`,
    name,
    kind: 'class',
    fqn: name,
    byteStart: 0,
    byteEnd: 100,
    metadata: { exported: 1, ...metadata },
  });
}

describe('framework-aware dead-code filter', () => {
  it('drops Spring @Service from the candidate set', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    seedExportedSymbol(store, 'src/main/java/OrderService.java', 'OrderService', {
      annotations: ['Service'],
    });
    seedExportedSymbol(store, 'src/main/java/Helper.java', 'Helper', {});

    const result = getDeadCodeV2(store, { threshold: 0 });
    const names = result.dead_symbols.map((d) => d.name);
    expect(names).not.toContain('OrderService');
    expect(names).toContain('Helper');
    expect(result._warnings?.some((w) => w.includes('Framework-aware filter'))).toBe(true);
  });

  it('drops NestJS @Injectable / @Controller / @Module', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    seedExportedSymbol(store, 'src/orders.module.ts', 'OrdersModule', {
      decorators: ['Module'],
    });
    seedExportedSymbol(store, 'src/orders.controller.ts', 'OrdersController', {
      decorators: ['Controller'],
    });
    seedExportedSymbol(store, 'src/orders.service.ts', 'OrdersService', {
      decorators: ['Injectable'],
    });
    seedExportedSymbol(store, 'src/lib/util.ts', 'Util', {});

    const result = getDeadCodeV2(store, { threshold: 0 });
    const names = result.dead_symbols.map((d) => d.name);
    expect(names).not.toContain('OrdersModule');
    expect(names).not.toContain('OrdersController');
    expect(names).not.toContain('OrdersService');
    expect(names).toContain('Util');
  });

  it('drops symbols whose frameworkRole is a known entry-point role', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    seedExportedSymbol(store, 'src/UserController.kt', 'UserController', {
      frameworkRole: 'controller',
    });
    seedExportedSymbol(store, 'src/PaymentRepo.kt', 'PaymentRepo', {
      frameworkRole: 'repository',
    });
    seedExportedSymbol(store, 'src/Helpers.kt', 'Helpers', {});

    const result = getDeadCodeV2(store, { threshold: 0 });
    const names = result.dead_symbols.map((d) => d.name);
    expect(names).not.toContain('UserController');
    expect(names).not.toContain('PaymentRepo');
    expect(names).toContain('Helpers');
  });

  it('matches decorators with leading @ and parenthesized arguments', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    seedExportedSymbol(store, 'src/api.ts', 'GetUsers', {
      decorators: ['@Get("/users")'],
    });
    seedExportedSymbol(store, 'src/listener.ts', 'OrderConsumer', {
      annotations: ['@KafkaListener(topics = "orders")'],
    });

    const result = getDeadCodeV2(store, { threshold: 0 });
    const names = result.dead_symbols.map((d) => d.name);
    expect(names).not.toContain('GetUsers');
    expect(names).not.toContain('OrderConsumer');
  });

  it('does not drop symbols whose decorators are not framework entry points', () => {
    // @Deprecated, @Override, @SuppressWarnings, @Inject (no implicit role) are
    // metadata about the symbol, not signals that the framework will invoke it.
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    seedExportedSymbol(store, 'src/legacy.ts', 'LegacyHelper', {
      decorators: ['Deprecated', 'Override'],
    });

    const result = getDeadCodeV2(store, { threshold: 0 });
    const names = result.dead_symbols.map((d) => d.name);
    expect(names).toContain('LegacyHelper');
  });

  it('produces no warning when no framework symbols were skipped', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    seedExportedSymbol(store, 'src/util.ts', 'doStuff', {});

    const result = getDeadCodeV2(store, { threshold: 0 });
    const fwWarning = result._warnings?.find((w) => w.includes('Framework-aware filter skipped'));
    expect(fwWarning).toBeUndefined();
  });
});
