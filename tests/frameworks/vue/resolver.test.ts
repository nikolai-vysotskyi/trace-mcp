import { describe, it, expect } from 'vitest';
import {
  resolveComponentTag,
  toKebabCase,
  toPascalCase,
} from '../../../src/indexer/plugins/integration/vue/resolver.js';

describe('toKebabCase', () => {
  it('converts PascalCase to kebab-case', () => {
    expect(toKebabCase('UserCard')).toBe('user-card');
    expect(toKebabCase('MyComponent')).toBe('my-component');
    expect(toKebabCase('App')).toBe('app');
  });

  it('handles multi-word components', () => {
    expect(toKebabCase('BaseInputField')).toBe('base-input-field');
    expect(toKebabCase('VDataTable')).toBe('v-data-table');
  });

  it('handles already kebab-case', () => {
    expect(toKebabCase('user-card')).toBe('user-card');
  });
});

describe('toPascalCase', () => {
  it('converts kebab-case to PascalCase', () => {
    expect(toPascalCase('user-card')).toBe('UserCard');
    expect(toPascalCase('my-component')).toBe('MyComponent');
  });

  it('handles single-word', () => {
    expect(toPascalCase('app')).toBe('App');
  });

  it('handles multi-segment', () => {
    expect(toPascalCase('base-input-field')).toBe('BaseInputField');
  });
});

describe('resolveComponentTag', () => {
  const imports = new Map<string, string>([
    ['UserCard', 'src/components/UserCard.vue'],
    ['BaseButton', 'src/components/BaseButton.vue'],
  ]);

  const componentFiles = new Map<string, string>([
    ['AppHeader', 'src/components/AppHeader.vue'],
    ['AppFooter', 'src/components/AppFooter.vue'],
  ]);

  it('resolves from imports by exact name', () => {
    expect(resolveComponentTag('UserCard', imports, componentFiles)).toBe(
      'src/components/UserCard.vue',
    );
  });

  it('resolves kebab-case tag to PascalCase import', () => {
    expect(resolveComponentTag('user-card', imports, componentFiles)).toBe(
      'src/components/UserCard.vue',
    );
  });

  it('resolves PascalCase tag from auto-registered components', () => {
    expect(resolveComponentTag('AppHeader', imports, componentFiles)).toBe(
      'src/components/AppHeader.vue',
    );
  });

  it('resolves kebab-case tag from auto-registered components', () => {
    expect(resolveComponentTag('app-header', imports, componentFiles)).toBe(
      'src/components/AppHeader.vue',
    );
  });

  it('returns undefined for unknown components', () => {
    expect(resolveComponentTag('UnknownWidget', imports, componentFiles)).toBeUndefined();
  });

  it('imports take priority over auto-registered', () => {
    const localImports = new Map<string, string>([
      ['AppHeader', 'src/pages/AppHeader.vue'],
    ]);
    expect(resolveComponentTag('AppHeader', localImports, componentFiles)).toBe(
      'src/pages/AppHeader.vue',
    );
  });
});
