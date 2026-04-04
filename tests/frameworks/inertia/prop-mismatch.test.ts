import { describe, it, expect } from 'vitest';
import { detectPropMismatches } from '../../../src/indexer/plugins/integration/inertia/index.js';

describe('Inertia prop mismatch detection', () => {
  it('detects when PHP passes props that Vue does not expect', () => {
    const renders = [
      { pageName: 'Users/Index', propNames: ['users', 'filters', 'extra'] },
    ];
    const vuePages = new Map<string, string[]>([
      ['Users/Index', ['users', 'filters']],
    ]);

    const mismatches = detectPropMismatches(renders, vuePages);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].missingInVue).toEqual(['extra']);
    expect(mismatches[0].missingInPhp).toEqual([]);
  });

  it('detects when Vue expects props that PHP does not pass', () => {
    const renders = [
      { pageName: 'Users/Index', propNames: ['users'] },
    ];
    const vuePages = new Map<string, string[]>([
      ['Users/Index', ['users', 'items']],
    ]);

    const mismatches = detectPropMismatches(renders, vuePages);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].missingInPhp).toEqual(['items']);
    expect(mismatches[0].missingInVue).toEqual([]);
  });

  it('returns empty when props match exactly', () => {
    const renders = [
      { pageName: 'Users/Index', propNames: ['users', 'filters'] },
    ];
    const vuePages = new Map<string, string[]>([
      ['Users/Index', ['users', 'filters']],
    ]);

    const mismatches = detectPropMismatches(renders, vuePages);
    expect(mismatches).toHaveLength(0);
  });

  it('skips pages not found in Vue map', () => {
    const renders = [
      { pageName: 'Missing/Page', propNames: ['data'] },
    ];
    const vuePages = new Map<string, string[]>();

    const mismatches = detectPropMismatches(renders, vuePages);
    expect(mismatches).toHaveLength(0);
  });

  it('detects bidirectional mismatches', () => {
    const renders = [
      { pageName: 'Users/Show', propNames: ['user', 'extra'] },
    ];
    const vuePages = new Map<string, string[]>([
      ['Users/Show', ['user', 'posts']],
    ]);

    const mismatches = detectPropMismatches(renders, vuePages);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].missingInVue).toEqual(['extra']);
    expect(mismatches[0].missingInPhp).toEqual(['posts']);
  });
});
