/**
 * Tests for Livewire v3 component extraction.
 * Covers: component detection, view resolution, events (dispatch/#[On]),
 * Form objects, wire: directives, and Blade usages.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractLivewireComponent,
  extractLivewireBladeUsages,
  extractWireDirectives,
  isLivewireForm,
  resolveComponentName,
} from '../../../src/indexer/plugins/integration/framework/laravel/livewire.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/livewire-v3');

function read(rel: string) {
  return fs.readFileSync(path.join(FIXTURE, rel), 'utf-8');
}

// ─── Counter component (simple, explicit render()) ──────────────────────────

describe('Livewire v3 — Counter component', () => {
  const source = read('app/Livewire/Counter.php');
  const info = extractLivewireComponent(source, 'app/Livewire/Counter.php');

  it('detects the component', () => {
    expect(info).not.toBeNull();
  });

  it('extracts class name and FQN', () => {
    expect(info!.className).toBe('Counter');
    expect(info!.fqn).toBe('App\\Livewire\\Counter');
    expect(info!.namespace).toBe('App\\Livewire');
  });

  it('detects version 3', () => {
    expect(info!.version).toBe(3);
  });

  it('extracts explicit view name', () => {
    expect(info!.viewName).toBe('livewire.counter');
  });

  it('computes convention view path', () => {
    expect(info!.conventionViewPath).toBe(
      'resources/views/livewire/counter.blade.php',
    );
  });

  it('extracts public properties', () => {
    const names = info!.properties.map((p) => p.name);
    expect(names).toContain('count');
  });

  it('extracts typed property type', () => {
    const count = info!.properties.find((p) => p.name === 'count');
    expect(count?.type).toBe('int');
  });

  it('extracts public actions', () => {
    expect(info!.actions).toContain('increment');
    expect(info!.actions).toContain('decrement');
  });

  it('excludes lifecycle methods from actions', () => {
    expect(info!.actions).not.toContain('render');
    expect(info!.actions).not.toContain('mount');
  });

  it('has no dispatches', () => {
    expect(info!.dispatches).toHaveLength(0);
  });

  it('has no listeners', () => {
    expect(info!.listeners).toHaveLength(0);
  });
});

// ─── OrderForm component (dispatch, #[On], Form property) ───────────────────

describe('Livewire v3 — OrderForm component', () => {
  const source = read('app/Livewire/OrderForm.php');
  const info = extractLivewireComponent(source, 'app/Livewire/OrderForm.php');

  it('detects the component', () => {
    expect(info).not.toBeNull();
  });

  it('extracts FQN', () => {
    expect(info!.fqn).toBe('App\\Livewire\\OrderForm');
  });

  it('extracts dispatched events', () => {
    const names = info!.dispatches.map((d) => d.eventName);
    expect(names).toContain('order-created');
    expect(names).toContain('order-cancelled');
  });

  it('maps dispatch to its method', () => {
    const orderCreated = info!.dispatches.find(
      (d) => d.eventName === 'order-created',
    );
    expect(orderCreated?.method).toBe('submit');
  });

  it('extracts #[On] listeners', () => {
    expect(info!.listeners).toHaveLength(1);
    expect(info!.listeners[0].eventName).toBe('cart-updated');
    expect(info!.listeners[0].handlerMethod).toBe('refreshCart');
  });

  it('extracts Form property', () => {
    expect(info!.formProperty).not.toBeNull();
    expect(info!.formProperty!.propertyName).toBe('form');
    expect(info!.formProperty!.formClass).toBe('App\\Livewire\\Forms\\OrderFormData');
  });

  it('extracts Order model property', () => {
    const modelProps = info!.properties.filter(
      (p) => p.type && /Models/.test(p.type),
    );
    expect(modelProps.length).toBeGreaterThan(0);
    const orderProp = modelProps.find((p) => p.name === 'order');
    expect(orderProp).toBeDefined();
  });
});

// ─── Form class detection ────────────────────────────────────────────────────

describe('Livewire v3 — Form class detection', () => {
  const source = read('app/Livewire/Forms/OrderFormData.php');

  it('detects Form class', () => {
    expect(isLivewireForm(source)).toBe(true);
  });

  it('does not flag a component as a Form', () => {
    const counterSrc = read('app/Livewire/Counter.php');
    expect(isLivewireForm(counterSrc)).toBe(false);
  });
});

// ─── Blade-side extraction ───────────────────────────────────────────────────

describe('Livewire v3 — order-form Blade usages', () => {
  const source = read('resources/views/livewire/order-form.blade.php');

  it('detects <livewire:tag> syntax', () => {
    const usages = extractLivewireBladeUsages(source);
    expect(usages.length).toBeGreaterThan(0);
    const tag = usages.find((u) => u.componentName === 'order-summary');
    expect(tag).toBeDefined();
    expect(tag?.syntax).toBe('tag');
  });

  it('extracts wire:submit directive', () => {
    const directives = extractWireDirectives(source);
    const submit = directives.find((d) => d.directive === 'submit');
    expect(submit).toBeDefined();
    expect(submit?.value).toBe('submit');
  });

  it('extracts wire:click directive', () => {
    const directives = extractWireDirectives(source);
    const click = directives.find((d) => d.directive === 'click');
    expect(click).toBeDefined();
    expect(click?.value).toBe('cancel');
  });

  it('extracts wire:model directives', () => {
    const directives = extractWireDirectives(source);
    const models = directives.filter((d) => d.directive === 'model');
    expect(models.length).toBeGreaterThanOrEqual(2);
    const props = models.map((d) => d.value);
    expect(props).toContain('form.notes');
    expect(props).toContain('form.total');
  });
});

describe('Livewire v3 — counter Blade wire directives', () => {
  const source = read('resources/views/livewire/counter.blade.php');

  it('extracts both wire:click directives', () => {
    const directives = extractWireDirectives(source);
    const clicks = directives.filter((d) => d.directive === 'click');
    expect(clicks).toHaveLength(2);
    const methods = clicks.map((d) => d.value);
    expect(methods).toContain('increment');
    expect(methods).toContain('decrement');
  });
});

// ─── resolveComponentName ────────────────────────────────────────────────────

describe('resolveComponentName', () => {
  it('resolves v3 kebab-case to App\\Livewire\\', () => {
    expect(resolveComponentName('order-form', 3)).toBe('App\\Livewire\\OrderForm');
    expect(resolveComponentName('counter', 3)).toBe('App\\Livewire\\Counter');
  });

  it('resolves v2 kebab-case to App\\Http\\Livewire\\', () => {
    expect(resolveComponentName('order-list', 2)).toBe(
      'App\\Http\\Livewire\\OrderList',
    );
    expect(resolveComponentName('search-bar', 2)).toBe(
      'App\\Http\\Livewire\\SearchBar',
    );
  });

  it('handles dot-separated names', () => {
    expect(resolveComponentName('admin.user-list', 3)).toBe(
      'App\\Livewire\\AdminUserList',
    );
  });
});
