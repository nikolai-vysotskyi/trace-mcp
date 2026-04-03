/**
 * Tests for Livewire v2 component extraction.
 * Covers: $listeners property, emit() calls, v2 namespace, convention view path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractLivewireComponent,
  extractLivewireBladeUsages,
  extractWireDirectives,
} from '../../../src/indexer/plugins/framework/laravel/livewire.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/livewire-v2');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── OrderList component ($listeners, convention view) ───────────────────────

describe('Livewire v2 — OrderList component', () => {
  const source = read('app/Http/Livewire/OrderList.php');
  const info = extractLivewireComponent(source, 'app/Http/Livewire/OrderList.php');

  it('detects the component', () => {
    expect(info).not.toBeNull();
  });

  it('extracts FQN from v2 namespace', () => {
    expect(info!.fqn).toBe('App\\Http\\Livewire\\OrderList');
    expect(info!.namespace).toBe('App\\Http\\Livewire');
  });

  it('detects version 2 from namespace', () => {
    expect(info!.version).toBe(2);
  });

  it('extracts explicit view name', () => {
    expect(info!.viewName).toBe('livewire.order-list');
  });

  it('computes convention view path', () => {
    expect(info!.conventionViewPath).toBe(
      'resources/views/livewire/order-list.blade.php',
    );
  });

  it('extracts $listeners as listeners', () => {
    expect(info!.listeners.length).toBeGreaterThan(0);
    const orderCreated = info!.listeners.find(
      (l) => l.eventName === 'order-created',
    );
    expect(orderCreated).toBeDefined();
    expect(orderCreated!.handlerMethod).toBe('refreshList');
  });

  it('extracts second listener entry', () => {
    const cancelled = info!.listeners.find(
      (l) => l.eventName === 'orderCancelled',
    );
    expect(cancelled).toBeDefined();
    expect(cancelled!.handlerMethod).toBe('handleCancel');
  });

  it('has no dispatches (only listens)', () => {
    expect(info!.dispatches).toHaveLength(0);
  });

  it('extracts public actions', () => {
    expect(info!.actions).toContain('refreshList');
    expect(info!.actions).toContain('handleCancel');
  });

  it('excludes lifecycle methods', () => {
    expect(info!.actions).not.toContain('mount');
    expect(info!.actions).not.toContain('render');
  });
});

// ─── SearchBar component (emit()) ────────────────────────────────────────────

describe('Livewire v2 — SearchBar component', () => {
  const source = read('app/Http/Livewire/SearchBar.php');
  const info = extractLivewireComponent(source, 'app/Http/Livewire/SearchBar.php');

  it('detects the component', () => {
    expect(info).not.toBeNull();
  });

  it('extracts version 2', () => {
    expect(info!.version).toBe(2);
  });

  it('extracts emit() as dispatches', () => {
    const names = info!.dispatches.map((d) => d.eventName);
    expect(names).toContain('search-executed');
    expect(names).toContain('search-cleared');
  });

  it('maps emit to its method', () => {
    const searchExecuted = info!.dispatches.find(
      (d) => d.eventName === 'search-executed',
    );
    expect(searchExecuted?.method).toBe('search');
  });

  it('has no listeners', () => {
    expect(info!.listeners).toHaveLength(0);
  });

  it('has no form property', () => {
    expect(info!.formProperty).toBeNull();
  });
});

// ─── Blade-side: @livewire() directive ──────────────────────────────────────

describe('Livewire v2 — order-list Blade usages', () => {
  const source = read('resources/views/livewire/order-list.blade.php');

  it('detects @livewire() directive', () => {
    const usages = extractLivewireBladeUsages(source);
    expect(usages.length).toBeGreaterThan(0);
    const searchBar = usages.find((u) => u.componentName === 'search-bar');
    expect(searchBar).toBeDefined();
    expect(searchBar?.syntax).toBe('directive');
  });

  it('extracts wire:click directive', () => {
    const directives = extractWireDirectives(source);
    const click = directives.find((d) => d.directive === 'click');
    expect(click).toBeDefined();
    expect(click?.value).toBe('refreshList');
  });
});

// ─── Non-Livewire files return null ──────────────────────────────────────────

describe('extractLivewireComponent — non-component files', () => {
  it('returns null for plain PHP class', () => {
    const source = `<?php\nnamespace App\\Models;\nclass Order extends Model {}`;
    expect(extractLivewireComponent(source, 'app/Models/Order.php')).toBeNull();
  });

  it('returns null for empty source', () => {
    expect(extractLivewireComponent('', 'app/Livewire/Empty.php')).toBeNull();
  });
});
