import { describe, it, expect } from 'vitest';
import { diffSchemas, diffEndpoints } from '../../src/subproject/schema-diff.js';

describe('diffSchemas', () => {
  it('detects removed fields', () => {
    const old = { properties: { email: { type: 'string' }, name: { type: 'string' } } };
    const next = { properties: { name: { type: 'string' } } };
    const diffs = diffSchemas(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('field_removed');
    expect(diffs[0].path).toBe('email');
    expect(diffs[0].breaking).toBe(true);
  });

  it('detects added fields (non-breaking)', () => {
    const old = { properties: { name: { type: 'string' } } };
    const next = { properties: { name: { type: 'string' }, age: { type: 'number' } } };
    const diffs = diffSchemas(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('field_added');
    expect(diffs[0].path).toBe('age');
    expect(diffs[0].breaking).toBe(false);
  });

  it('detects type changes', () => {
    const old = { properties: { count: { type: 'string' } } };
    const next = { properties: { count: { type: 'number' } } };
    const diffs = diffSchemas(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('type_changed');
    expect(diffs[0].oldValue).toBe('string');
    expect(diffs[0].newValue).toBe('number');
    expect(diffs[0].breaking).toBe(true);
  });

  it('detects renamed fields via Levenshtein heuristic', () => {
    const old = { properties: { email: { type: 'string' } } };
    const next = { properties: { emailAddress: { type: 'string' } } };
    const diffs = diffSchemas(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('field_renamed');
    expect(diffs[0].oldValue).toBe('email');
    expect(diffs[0].newValue).toBe('emailAddress');
    expect(diffs[0].breaking).toBe(true);
    expect(diffs[0].confidence).toBeGreaterThan(0.3);
  });

  it('detects newly required fields as breaking', () => {
    const old = { properties: { name: { type: 'string' } } };
    const next = { properties: { name: { type: 'string' }, token: { type: 'string' } }, required: ['token'] };
    const diffs = diffSchemas(old, next);
    expect(diffs.some((d) => d.type === 'required_added' && d.path === 'token' && d.breaking)).toBe(true);
  });

  it('recurses into nested objects', () => {
    const old = {
      properties: {
        user: { type: 'object', properties: { email: { type: 'string' } } },
      },
    };
    const next = {
      properties: {
        user: { type: 'object', properties: {} },
      },
    };
    const diffs = diffSchemas(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('field_removed');
    expect(diffs[0].path).toBe('user.email');
  });

  it('recurses into array items', () => {
    const old = {
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } },
      },
    };
    const next = {
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    };
    const diffs = diffSchemas(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('type_changed');
    expect(diffs[0].path).toBe('items[].id');
  });

  it('returns empty for identical schemas', () => {
    const schema = { properties: { a: { type: 'string' }, b: { type: 'number' } } };
    expect(diffSchemas(schema, schema)).toHaveLength(0);
  });

  it('handles empty schemas gracefully', () => {
    expect(diffSchemas({}, {})).toHaveLength(0);
    expect(diffSchemas({ properties: {} }, { properties: {} })).toHaveLength(0);
  });
});

describe('diffEndpoints', () => {
  it('detects schema changes for matching endpoints', () => {
    const old = [{
      method: 'GET',
      path: '/api/users',
      responseSchema: JSON.stringify({
        properties: { email: { type: 'string' }, name: { type: 'string' } },
      }),
    }];
    const next = [{
      method: 'GET',
      path: '/api/users',
      responseSchema: JSON.stringify({
        properties: { emailAddress: { type: 'string' }, name: { type: 'string' } },
      }),
    }];

    const diffs = diffEndpoints(old, next);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].endpoint.path).toBe('/api/users');
    expect(diffs[0].breaking).toBe(true);
    expect(diffs[0].responseChanges.length).toBeGreaterThan(0);
  });

  it('ignores endpoints that only exist in one set', () => {
    const old = [{ method: 'GET', path: '/api/v1/users' }];
    const next = [{ method: 'GET', path: '/api/v2/users' }];
    expect(diffEndpoints(old, next)).toHaveLength(0);
  });

  it('returns empty when no schema changes', () => {
    const ep = [{
      method: 'POST',
      path: '/api/login',
      requestSchema: JSON.stringify({ properties: { username: { type: 'string' } } }),
    }];
    expect(diffEndpoints(ep, ep)).toHaveLength(0);
  });
});
